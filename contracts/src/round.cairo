/// Signal round state machine: Lobby -> Assigned -> Night -> Vote -> Resolved.
///
/// Deliberately has ZERO privacy-pool coupling (see CLAUDE.md). Everything
/// here is public game state: seats, phases, timers, the tally. The private
/// pieces (role notes, the night-kill transfer, vote transfers, payout) all
/// happen inside the STRK20 pool; the only bridge is `SignalEscrow`, which is
/// the sole caller allowed to hit `handle_vote`.
///
/// Unlinkability invariant: a seat has two addresses. `seat_address` is the
/// lobby-join wallet (the one that shielded the buy-in). `session_key` is a
/// locally-held burner EOA that signs all in-round actions. They must differ;
/// `join` enforces that minimally by rejecting `session_key == caller`.

use core::dict::{Felt252Dict, Felt252DictTrait};

/// Derive the hidden team from a combined seed.
///
/// Partial Fisher-Yates over a dict, drawing `k` distinct seats out of `n`,
/// returned ascending (the role commitment hashes the sequence, so the order
/// has to be canonical).
///
/// Free function, not a contract method, so it can be unit-tested directly
/// without spinning up contract state.
pub fn derive_hidden(combined: felt252, n: u32, k: u32) -> Array<u32> {
    sort_ascending(draw_seats(combined, n, k))
}

/// Draw `count` distinct seats in draw order.
///
/// Split out from `derive_hidden` so several roles can be dealt from one seed:
/// drawing `k + s` continues the same Fisher-Yates sequence, so the first `k`
/// picks are byte-identical to drawing `k` alone. That is what lets a seer be
/// added without changing which seats become impostors — and it keeps the
/// TypeScript parity test valid.
pub fn draw_seats(combined: felt252, n: u32, count: u32) -> Array<u32> {
    assert(count <= n, 'k above n');

    // pool[i] = i, then swap-remove as we draw.
    let mut pool: Felt252Dict<u32> = Default::default();
    let mut i: u32 = 0;
    while i != n {
        pool.insert(i.into(), i);
        i += 1;
    }

    let mut chosen: Array<u32> = array![];
    let mut t: u32 = 0;
    while t != count {
        let r = core::poseidon::poseidon_hash_span(array![combined, t.into()].span());
        let r_u256: u256 = r.into();
        let remaining: u32 = n - t;
        let idx: u32 = (r_u256 % remaining.into()).try_into().unwrap();

        chosen.append(Felt252DictTrait::get(ref pool, idx.into()));
        // Swap the last live entry into the hole so every draw stays uniform.
        let last = Felt252DictTrait::get(ref pool, (remaining - 1).into());
        pool.insert(idx.into(), last);
        t += 1;
    }
    pool.squash();
    chosen
}

/// Public wrapper so the contract can sort a partial draw.
pub fn sort_ascending_pub(xs: Array<u32>) -> Array<u32> {
    sort_ascending(xs)
}

/// Selection sort. `k` is at most a handful of seats, so this is fine and is
/// far easier to read than anything cleverer.
fn sort_ascending(xs: Array<u32>) -> Array<u32> {
    let n = xs.len();
    let mut remaining = xs;
    let mut out: Array<u32> = array![];

    let mut placed: u32 = 0;
    while placed != n {
        // find the smallest still in `remaining`
        let mut best: u32 = *remaining.at(0);
        let mut j: u32 = 1;
        while j != remaining.len() {
            let v = *remaining.at(j);
            if v < best {
                best = v;
            }
            j += 1;
        }
        out.append(best);

        // rebuild without one copy of `best`
        let mut next: Array<u32> = array![];
        let mut dropped = false;
        let mut m: u32 = 0;
        while m != remaining.len() {
            let v = *remaining.at(m);
            if v == best && !dropped {
                dropped = true;
            } else {
                next.append(v);
            }
            m += 1;
        }
        remaining = next;
        placed += 1;
    }
    out
}

pub mod phases {
    pub const LOBBY: u8 = 0;
    pub const ASSIGNED: u8 = 1;
    pub const NIGHT: u8 = 2;
    pub const VOTE: u8 = 3;
    pub const RESOLVED: u8 = 4;
}

/// Sentinel meaning "no seat" in fields that store `seat + 1`.
pub const NO_SEAT: u32 = 0;

/// Candidate value meaning "skip" — an abstention rather than an accusation.
///
/// Among Us lets a table decline to eject anyone, and without it every round
/// forces an accusation even when nobody has evidence. Encoded as a sentinel
/// candidate so the escrow's anonymous vote leg needs no second entrypoint:
/// a skip is an ordinary vote that happens to name nobody.
pub const SKIP_VOTE: u32 = 0xffffffff;

/// Hard cap on rounds.
///
/// The host decides when the game is over (the contract cannot check a win
/// condition without learning the roles, which is the whole point of the
/// commitment). `resolve_round` verifies that call was honest — but nothing
/// stops a host simply never calling it, so the loop needs a ceiling.
///
/// Note the arithmetic: `end_vote` asserts `round + 1 < MAX_ROUNDS` and rounds
/// count from 0, so this permits **9** completed rounds and the game comes to
/// rest at `round_number == MAX_ROUNDS - 1`. That resting point is terminal —
/// `resolve_round` accepts it as a crew win — so the ceiling is a real ending
/// rather than a wall the round can get pinned against.
pub const MAX_ROUNDS: u32 = 10;

/// Seconds the crew have to reach the reactor before it melts down.
pub const REACTOR_SECS: u64 = 30;

#[starknet::contract]
pub mod SignalRound {
    use core::num::traits::Zero;
    use core::poseidon::poseidon_hash_span;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_block_timestamp, get_caller_address};
    use super::phases;

    /// RFP bounds. A round configures its own limits inside these.
    pub const FLOOR_PLAYERS: u32 = 3;
    pub const CEIL_PLAYERS: u32 = 15;

    #[storage]
    struct Storage {
        host: ContractAddress,
        escrow: ContractAddress,
        phase: u8,
        // -- variant configuration --
        // The RFP asks for one platform covering Among Us, Secret Hitler,
        // Avalon, Blood on the Clocktower and One Night Werewolf. What those
        // share is the skeleton this contract implements: a hidden minority,
        // a private night action, and an anonymous vote. They differ in table
        // size and how large the hidden team is, so those are constructor
        // configuration rather than forks of the contract.
        min_players: u32,
        max_players: u32,
        hidden_count: u32,
        /// Investigative crew members. The RFP names night actions as
        /// "impostor kills, seer checks", so the seer is drawn from the same
        /// committed seed as the impostors rather than picked by the host.
        seer_count: u32,
        /// Tasks dealt to each player. 0 disables the task win entirely.
        ///
        /// The contract could previously not see a task at all, which left the
        /// crew with exactly one way to win — vote out every impostor. Among Us
        /// gives them a second, and it is the one that rewards playing rather
        /// than arguing.
        tasks_per_player: u32,
        // -- lobby --
        player_count: u32,
        seats: Map<u32, ContractAddress>, // seat -> lobby-join wallet
        session_keys: Map<u32, ContractAddress>, // seat -> burner in-round signer
        session_key_seat: Map<ContractAddress, u32>, // signer -> seat + 1 (0 = none)
        payout_notes: Map<u32, felt252>, // seat -> pre-created STRK20 open-note id
        joined: Map<ContractAddress, bool>,
        // -- fair randomness --
        // Committed by the host in the constructor, i.e. before anyone joins
        // and before any player entropy exists. See `resolve_round`.
        seed_commitment: felt252,
        entropy: Map<u32, felt252>, // seat -> that player's public contribution
        // -- roles --
        role_commitment: felt252, // poseidon(hidden_seats.., salt), posted by host
        // -- night --
        night_duration: u64,
        night_deadline: u64,
        dead: Map<u32, bool>,
        // -- rounds --
        // Per-round values are namespaced by round rather than cleared: a Cairo
        // Map has no "clear", so the alternative would be walking every seat on
        // each boundary.
        round_number: u32,
        // -- reactor --
        // 0 = stable. Set by `sabotage_reactor`, cleared by `fix_reactor`.
        // Both are on-chain so the meltdown outcome is *verifiable*: the
        // contract can see for itself that the deadline passed with no fix,
        // rather than taking a host's word for it.
        reactor_deadline: u64,
        night_victim_of: Map<u32, u32>, // round -> seat + 1, 0 = nobody died
        ejection_of: Map<u32, u32>, // round -> seat + 1, 0 = nobody ejected
        // -- vote --
        vote_duration: u64,
        vote_deadline: u64,
        tallies: Map<(u32, u32), u256>, // (round, seat) -> weight
        skip_tally_of: Map<u32, u256>, // round -> weight
        total_votes_of: Map<u32, u256>, // round -> weight
        // -- emergency meetings --
        called_meeting: Map<u32, bool>, // seat -> has already called one
        // -- resolution --
        ejected: u32, // seat + 1, 0 = tie / nobody ejected
        impostor: u32, // first hidden seat + 1, revealed at resolve
        hidden: Map<u32, bool>, // seat -> on the hidden team, filled at resolve
        seer: Map<u32, bool>, // seat -> is the seer, filled at resolve
        tasks_done: Map<u32, u32>, // seat -> tasks this seat has submitted
        crew_won: bool,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        Joined: Joined,
        RolesAssigned: RolesAssigned,
        NightStarted: NightStarted,
        BodyReported: BodyReported,
        NightSkipped: NightSkipped,
        MeetingCalled: MeetingCalled,
        RoundEnded: RoundEnded,
        ReactorSabotaged: ReactorSabotaged,
        ReactorFixed: ReactorFixed,
        VoteRecorded: VoteRecorded,
        RoundResolved: RoundResolved,
    }

    #[derive(Drop, starknet::Event)]
    struct Joined {
        seat: u32,
        wallet: ContractAddress,
        session_key: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    struct RolesAssigned {
        role_commitment: felt252,
        players: u32,
    }

    #[derive(Drop, starknet::Event)]
    struct NightStarted {
        deadline: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct BodyReported {
        victim_seat: u32,
        vote_deadline: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct NightSkipped {
        vote_deadline: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct ReactorSabotaged {
        deadline: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct ReactorFixed {}

    #[derive(Drop, starknet::Event)]
    struct RoundEnded {
        round: u32,
        ejected_seat_plus_one: u32,
        next_night_deadline: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct MeetingCalled {
        caller_seat: u32,
        vote_deadline: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct VoteRecorded {
        candidate_seat: u32,
        amount: u256,
        new_tally: u256,
    }

    #[derive(Drop, starknet::Event)]
    struct RoundResolved {
        impostor_seat: u32,
        ejected_seat_plus_one: u32,
        crew_won: bool,
    }

    /// `hidden_count` is how many players are on the hidden team: 1 impostor
    /// for Among Us, 2 werewolves for a larger One Night Werewolf table, the
    /// fascist count for Secret Hitler, and so on. It must stay a strict
    /// minority, or the vote cannot be a meaningful check on it.
    #[constructor]
    fn constructor(
        ref self: ContractState,
        host: ContractAddress,
        seed_commitment: felt252,
        min_players: u32,
        max_players: u32,
        hidden_count: u32,
        seer_count: u32,
        tasks_per_player: u32,
        night_duration: u64,
        vote_duration: u64,
    ) {
        assert(host.is_non_zero(), 'host required');
        assert(seed_commitment != 0, 'seed commitment required');
        assert(min_players >= FLOOR_PLAYERS, 'min too small');
        assert(max_players <= CEIL_PLAYERS, 'max too large');
        assert(min_players <= max_players, 'min above max');
        assert(hidden_count >= 1, 'need a hidden team');
        // Strict minority: 2 * hidden < min_players.
        assert(hidden_count * 2 < min_players, 'hidden team too large');
        // Every role has to fit on the smallest legal table.
        assert(hidden_count + seer_count < min_players, 'too many special roles');

        self.host.write(host);
        self.seed_commitment.write(seed_commitment);
        self.phase.write(phases::LOBBY);
        self.min_players.write(min_players);
        self.max_players.write(max_players);
        self.hidden_count.write(hidden_count);
        self.seer_count.write(seer_count);
        self.tasks_per_player.write(tasks_per_player);
        self.night_duration.write(night_duration);
        self.vote_duration.write(vote_duration);
    }

    #[abi(embed_v0)]
    impl SignalRoundEscrowImpl of crate::interfaces::ISignalRound<ContractState> {
        /// Escrow-only. Called once per anonymous vote leg the pool runs
        /// through `SignalEscrow`. The candidate + amount are deliberately
        /// public (RFP wants a publicly computable tally); only the voter's
        /// identity is hidden, inside the pool.
        fn handle_vote(ref self: ContractState, candidate_seat: u32, amount: u256) {
            assert(get_caller_address() == self.escrow.read(), 'only escrow');
            assert(self.phase.read() == phases::VOTE, 'not in vote phase');
            assert(get_block_timestamp() <= self.vote_deadline.read(), 'vote closed');
            assert(amount > 0, 'zero vote');

            // A skip is an ordinary anonymous leg that names nobody, so the
            // escrow path is identical and the tally stays publicly computable.
            let round = self.round_number.read();

            if candidate_seat == super::SKIP_VOTE {
                let new_tally = self.skip_tally_of.read(round) + amount;
                self.skip_tally_of.write(round, new_tally);
                self.total_votes_of.write(round, self.total_votes_of.read(round) + amount);
                self.emit(VoteRecorded { candidate_seat, amount, new_tally });
                return;
            }

            assert(candidate_seat < self.player_count.read(), 'bad candidate');
            assert(!self.dead.read(candidate_seat), 'candidate dead');
            let new_tally = self.tallies.read((round, candidate_seat)) + amount;
            self.tallies.write((round, candidate_seat), new_tally);
            self.total_votes_of.write(round, self.total_votes_of.read(round) + amount);
            self.emit(VoteRecorded { candidate_seat, amount, new_tally });
        }

        fn phase(self: @ContractState) -> u8 {
            self.phase.read()
        }

        fn player_count(self: @ContractState) -> u32 {
            self.player_count.read()
        }

        /// Crew win: every crew seat (dead crew included) is a winner.
        /// Impostor win: only the impostor's seat.
        fn is_winner(self: @ContractState, seat: u32) -> bool {
            if self.phase.read() != phases::RESOLVED {
                return false;
            }
            if seat >= self.player_count.read() {
                return false;
            }
            // Crew win pays every non-hidden seat, dead crew included; a hidden
            // win pays the whole hidden team.
            if self.crew_won.read() {
                !self.hidden.read(seat)
            } else {
                self.hidden.read(seat)
            }
        }

        fn payout_note(self: @ContractState, seat: u32) -> felt252 {
            self.payout_notes.read(seat)
        }

        fn tally(self: @ContractState, seat: u32) -> u256 {
            self.tallies.read((self.round_number.read(), seat))
        }

        /// Returns seat + 1; 0 means tie / nobody ejected.
        fn ejected_seat(self: @ContractState) -> u32 {
            self.ejected.read()
        }

        /// Returns seat + 1; 0 until resolved.
        fn impostor_seat(self: @ContractState) -> u32 {
            self.impostor.read()
        }
    }

    #[abi(embed_v0)]
    impl SignalRoundGameImpl of super::ISignalRoundGame<ContractState> {
        /// Host wiring: escrow is deployed after the round (it needs this
        /// contract's address in its constructor), so it is linked here. Once.
        fn set_escrow(ref self: ContractState, escrow: ContractAddress) {
            self.assert_host();
            assert(self.escrow.read().is_zero(), 'escrow already set');
            assert(escrow.is_non_zero(), 'escrow required');
            self.escrow.write(escrow);
        }

        /// Called by the lobby-join wallet (the one that shielded the buy-in).
        /// `session_key` is the burner EOA that will sign this player's
        /// in-round actions; `payout_note_id` is a pre-created STRK20 open
        /// note (phase 5, CreateOpenNote) the payout will land in.
        fn join(
            ref self: ContractState,
            session_key: ContractAddress,
            payout_note_id: felt252,
            entropy: felt252,
        ) {
            assert(self.phase.read() == phases::LOBBY, 'not in lobby');
            let caller = get_caller_address();
            assert(!self.joined.read(caller), 'already joined');
            assert(session_key.is_non_zero(), 'session key required');
            // Minimal unlinkability guard: the in-round signer must not be the
            // wallet that joined (and paid in). See CLAUDE.md.
            assert(session_key != caller, 'session key = wallet');
            assert(self.session_key_seat.read(session_key) == super::NO_SEAT, 'session key taken');
            assert(payout_note_id != 0, 'payout note required');
            assert(entropy != 0, 'entropy required');
            let seat = self.player_count.read();
            assert(seat < self.max_players.read(), 'lobby full');
            self.seats.write(seat, caller);
            self.session_keys.write(seat, session_key);
            self.session_key_seat.write(session_key, seat + 1);
            self.payout_notes.write(seat, payout_note_id);
            self.entropy.write(seat, entropy);
            self.joined.write(caller, true);
            self.player_count.write(seat + 1);
            self.emit(Joined { seat, wallet: caller, session_key });
        }

        /// Host commits to the (secret) role assignment. The impostor's seat
        /// and a salt are hashed; the actual role notes are delivered
        /// off-chain as encrypted 0-value notes inside the pool, one per
        /// player, that only each holder can decrypt.
        fn assign_roles(ref self: ContractState, role_commitment: felt252) {
            self.assert_host();
            assert(self.phase.read() == phases::LOBBY, 'not in lobby');
            assert(self.player_count.read() >= self.min_players.read(), 'not enough players');
            assert(role_commitment != 0, 'commitment required');
            self.role_commitment.write(role_commitment);
            self.phase.write(phases::ASSIGNED);
            self.emit(RolesAssigned { role_commitment, players: self.player_count.read() });
        }

        fn start_night(ref self: ContractState) {
            self.assert_host();
            assert(self.phase.read() == phases::ASSIGNED, 'roles not assigned');
            let deadline = get_block_timestamp() + self.night_duration.read();
            self.night_deadline.write(deadline);
            self.phase.write(phases::NIGHT);
            self.emit(NightStarted { deadline });
        }

        /// "I died." The night kill is a private transfer of the kill token to
        /// the victim inside the pool; nobody but the victim (and the
        /// impostor) can see it. The victim's SESSION KEY self-reports here,
        /// which opens the vote. Signed by the burner, so it links to a seat,
        /// not to a funding wallet.
        fn report_night_kill(ref self: ContractState) {
            assert(self.phase.read() == phases::NIGHT, 'not night');
            let seat = self.seat_of_session_key(get_caller_address());
            assert(!self.dead.read(seat), 'already dead');
            self.dead.write(seat, true);
            self.night_victim_of.write(self.round_number.read(), seat + 1);
            self.open_vote();
            self.emit(BodyReported { victim_seat: seat, vote_deadline: self.vote_deadline.read() });
        }

        /// Submit one completed task, signed by the caller's SESSION KEY.
        ///
        /// Be honest about what this does and does not prove. The contract
        /// cannot verify a minigame — it has no idea whether the wires were
        /// actually joined. What it *does* enforce is the part that matters for
        /// an honest tally: no seat may claim more than its own allotment, and
        /// at `resolve_round` only seats the derived roles say are crew are
        /// counted. So an impostor spamming this achieves nothing (their
        /// submissions are discarded once the roles open), and no single player
        /// can carry the bar alone.
        ///
        /// A crewmate could still claim a task they did not do. That only helps
        /// their own side win, so it is a game-design tradeoff rather than a
        /// safety hole — and it is the same tradeoff any off-chain minigame has.
        fn submit_task(ref self: ContractState) {
            assert(self.phase.read() == phases::NIGHT, 'not night');
            let seat = self.seat_of_session_key(get_caller_address());
            let cap = self.tasks_per_player.read();
            let done = self.tasks_done.read(seat);
            assert(done < cap, 'task list already done');
            self.tasks_done.write(seat, done + 1);
        }

        /// Any living player may call one emergency meeting per round, signed
        /// by their SESSION KEY.
        ///
        /// Without this the only way to a vote is a body being reported or the
        /// host skipping after the deadline, so a crew member who is certain of
        /// something has no way to act on it. One per seat, so it cannot be
        /// used to stall the round indefinitely.
        fn call_meeting(ref self: ContractState) {
            assert(self.phase.read() == phases::NIGHT, 'not night');
            // A meeting used to be a free "delete the sabotage" button: it moved
            // the phase to VOTE, `resolve_sabotage` only fired during NIGHT, and
            // `end_vote` then wiped the deadline. Among Us blocks the emergency
            // button during a sabotage for exactly this reason.
            assert(self.reactor_deadline.read() == 0, 'fix the reactor first');
            let seat = self.seat_of_session_key(get_caller_address());
            assert(!self.dead.read(seat), 'dead cannot call');
            assert(!self.called_meeting.read(seat), 'meeting already used');
            self.called_meeting.write(seat, true);
            self.open_vote();
            self
                .emit(
                    MeetingCalled {
                        caller_seat: seat, vote_deadline: self.vote_deadline.read(),
                    },
                );
        }

        /// Fallback if no body is reported by the night deadline (impostor
        /// idled, or victim refuses to report): host advances to the vote.
        fn skip_night(ref self: ContractState) {
            self.assert_host();
            assert(self.phase.read() == phases::NIGHT, 'not night');
            assert(get_block_timestamp() > self.night_deadline.read(), 'night not over');
            self.open_vote();
            self.emit(NightSkipped { vote_deadline: self.vote_deadline.read() });
        }

        /// Trigger a reactor meltdown.
        ///
        /// Signed by a session key, like every other in-round action. The
        /// contract cannot tell an impostor from a crew member — that is the
        /// point of the commitment — so it does not try; the client only
        /// offers this to impostors, exactly as it only offers the kill. A
        /// crew member who sabotages is simply playing badly.
        fn sabotage_reactor(ref self: ContractState) {
            assert(self.phase.read() == phases::NIGHT, 'not night');
            let seat = self.seat_of_session_key(get_caller_address());
            assert(!self.dead.read(seat), 'dead cannot sabotage');
            assert(self.reactor_deadline.read() == 0, 'reactor already going');
            let deadline = get_block_timestamp() + super::REACTOR_SECS;
            self.reactor_deadline.write(deadline);
            self.emit(ReactorSabotaged { deadline });
        }

        /// Stop the meltdown. Anyone still alive can do it — the cost is that
        /// they had to drop what they were doing and walk there.
        fn fix_reactor(ref self: ContractState) {
            let seat = self.seat_of_session_key(get_caller_address());
            assert(!self.dead.read(seat), 'dead cannot fix');
            assert(self.reactor_deadline.read() != 0, 'reactor is stable');
            assert(get_block_timestamp() <= self.reactor_deadline.read(), 'too late');
            self.reactor_deadline.write(0);
            self.emit(ReactorFixed {});
        }

        /// The meltdown ran out: the impostors win.
        ///
        /// Unlike `resolve_round` there is no win condition to check — the
        /// contract watched the deadline pass with no `fix_reactor`, so the
        /// outcome is its own evidence. The roles are still opened, because the
        /// payout needs to know who won.
        fn resolve_sabotage(ref self: ContractState, host_seed: felt252, salt: felt252) {
            self.assert_host();
            // NIGHT *or* VOTE: a body reported mid-meltdown must not strand the
            // sabotage in a phase where it can never be resolved.
            let phase = self.phase.read();
            assert(phase == phases::NIGHT || phase == phases::VOTE, 'not in a round');
            let deadline = self.reactor_deadline.read();
            assert(deadline != 0, 'reactor is stable');
            assert(get_block_timestamp() > deadline, 'reactor not blown');

            let (hidden_seats, seer_seats) = self.open_roles(host_seed, salt);
            let mut sx: u32 = 0;
            while sx != seer_seats.len() {
                self.seer.write(*seer_seats.at(sx), true);
                sx += 1;
            }
            let mut j: u32 = 0;
            while j != hidden_seats.len() {
                self.hidden.write(*hidden_seats.at(j), true);
                j += 1;
            }

            self.ejected.write(super::NO_SEAT);
            self.impostor.write(*hidden_seats.at(0) + 1);
            self.crew_won.write(false);
            self.phase.write(phases::RESOLVED);
            self
                .emit(
                    RoundResolved {
                        impostor_seat: *hidden_seats.at(0),
                        ejected_seat_plus_one: super::NO_SEAT,
                        crew_won: false,
                    },
                );
        }

        /// Close this round's vote and open the next night.
        ///
        /// The contract cannot tell whether the game is over — that needs the
        /// roles, which stay sealed until `resolve_round`. So the host chooses:
        /// `end_vote` to play on, `resolve_round` to finish. `resolve_round`
        /// then *verifies* that choice was honest, and `MAX_ROUNDS` stops a
        /// host stalling forever.
        fn end_vote(ref self: ContractState) {
            self.assert_host();
            assert(self.phase.read() == phases::VOTE, 'not in vote phase');
            assert(self.ballot_closed(), 'vote still open');

            // A meltdown that already blew has to be resolved, not rounded
            // past - otherwise ending the vote is another way to delete it.
            let reactor = self.reactor_deadline.read();
            assert(
                reactor == 0 || get_block_timestamp() <= reactor, 'resolve the reactor',
            );

            let round = self.round_number.read();
            assert(round + 1 < super::MAX_ROUNDS, 'too many rounds');

            let ejected = self.compute_ejected();
            self.ejection_of.write(round, ejected);
            if ejected != super::NO_SEAT {
                self.dead.write(ejected - 1, true);
            }

            // Per-round buckets are namespaced, so advancing the counter *is*
            // the reset. Deaths and used meetings deliberately carry over.
            self.round_number.write(round + 1);
            // A new night starts with a stable reactor - an unfixed meltdown
            // does not survive into the next round.
            self.reactor_deadline.write(0);
            let deadline = get_block_timestamp() + self.night_duration.read();
            self.night_deadline.write(deadline);
            self.phase.write(phases::NIGHT);
            self
                .emit(
                    RoundEnded {
                        round, ejected_seat_plus_one: ejected, next_night_deadline: deadline,
                    },
                );
        }

        /// After the vote deadline the host reveals the impostor by opening
        /// the commitment: poseidon(impostor_seat, salt) must equal the value
        /// posted in `assign_roles`. Ejection = strict-max tally; a tie ejects
        /// nobody, so the impostor survives and the crew lose. Provably fair:
        /// the host cannot pick a different impostor after seeing the vote.
        /// Opens the commitment over the whole hidden team.
        ///
        /// `hidden_seats` must be strictly ascending: the commitment is a hash
        /// of the sequence, so without a canonical order the same team would
        /// have many valid preimages and the host could pick whichever one
        /// suited the tally.
        ///
        /// For a one-impostor game this is byte-identical to the old
        /// `poseidon(impostor_seat, salt)`, so existing rounds still open.
        /// Opens the round.
        ///
        /// The hidden team is **derived, not asserted**. The host reveals only
        /// `host_seed`; the contract checks it against the commitment posted in
        /// the constructor, mixes it with every player's entropy, and computes
        /// the team itself.
        ///
        /// That ordering is the whole point. The host commits to their seed
        /// before anyone has joined, so they cannot aim it at a particular
        /// person; each player then contributes entropy the host cannot predict.
        /// Neither side can steer the draw alone, which is what the previous
        /// version — where the host simply named the team — could not claim.
        fn resolve_round(ref self: ContractState, host_seed: felt252, salt: felt252) {
            self.assert_host();
            assert(self.phase.read() == phases::VOTE, 'not in vote phase');
            assert(self.ballot_closed(), 'vote still open');

            // Shared with `resolve_sabotage` - two copies of a reveal is how
            // the two paths quietly drift apart.
            let (hidden_seats, seer_seats) = self.open_roles(host_seed, salt);
            let mut sx: u32 = 0;
            while sx != seer_seats.len() {
                self.seer.write(*seer_seats.at(sx), true);
                sx += 1;
            }

            let mut j: u32 = 0;
            while j != hidden_seats.len() {
                self.hidden.write(*hidden_seats.at(j), true);
                j += 1;
            }

            let round = self.round_number.read();
            let ejected = self.compute_ejected();
            self.ejection_of.write(round, ejected);
            if ejected != super::NO_SEAT {
                self.dead.write(ejected - 1, true);
            }

            // Now the roles are open, count who is left and check the host was
            // entitled to stop here. Without this the host could end the game
            // on whichever round happened to suit them.
            let n = self.player_count.read();
            let mut impostors_alive: u32 = 0;
            let mut crew_alive: u32 = 0;
            let mut seat: u32 = 0;
            while seat != n {
                if !self.dead.read(seat) {
                    if self.hidden.read(seat) {
                        impostors_alive += 1;
                    } else {
                        crew_alive += 1;
                    }
                }
                seat += 1;
            }

            // The crew's own objective. Counted only over seats the freshly
            // opened roles say are crew, which is what makes an impostor's
            // submissions worthless and the tally trustworthy. Ghosts count:
            // a dead crewmate's finished tasks still filled the bar, exactly as
            // they do in Among Us.
            let per_player = self.tasks_per_player.read();
            let mut crew_tasks: u32 = 0;
            let mut crew_seats: u32 = 0;
            let mut t: u32 = 0;
            while t != n {
                if !self.hidden.read(t) {
                    crew_tasks += self.tasks_done.read(t);
                    crew_seats += 1;
                }
                t += 1;
            }
            let target = crew_seats * per_player;
            // `target == 0` means tasks are switched off; without this guard a
            // zero target would be trivially met and the crew would win on
            // round 0.
            let tasks_won = target != 0 && crew_tasks >= target;

            let impostors_won = impostors_alive >= crew_alive;

            // The round cap is itself a terminal condition.
            //
            // Without this the two guards contradicted each other: `end_vote`
            // refuses once `round + 1 == MAX_ROUNDS`, and this assert refused
            // any finish that was not already a win — so a table that reached
            // the cap with the impostors alive but not yet a majority had no
            // legal move left at all, and the escrowed buy-ins stayed locked
            // for good. Reachable with a cautious impostor and a table that
            // keeps skipping; nine rounds is not many when nobody has evidence.
            //
            // Surviving to the cap is a crew win: the impostors had every round
            // the game allows and failed to take the ship.
            let capped = round + 1 >= super::MAX_ROUNDS;
            assert(
                impostors_alive == 0 || impostors_won || tasks_won || capped, 'game not over',
            );

            // Equivalent to `impostors_alive == 0` in the two original cases —
            // the assert above rules out anything else — and it is what decides
            // a capped round.
            // Finishing every task takes precedence over parity: the crew
            // completed the objective the game sets them, and an impostor who
            // let that happen has lost regardless of the head count.
            let crew_won = tasks_won || !impostors_won;

            self.ejected.write(ejected);
            self.impostor.write(*hidden_seats.at(0) + 1);
            self.crew_won.write(crew_won);
            self.phase.write(phases::RESOLVED);
            self
                .emit(
                    RoundResolved {
                        impostor_seat: *hidden_seats.at(0),
                        ejected_seat_plus_one: ejected,
                        crew_won,
                    },
                );
        }

        // -- views --

        fn host(self: @ContractState) -> ContractAddress {
            self.host.read()
        }

        fn escrow(self: @ContractState) -> ContractAddress {
            self.escrow.read()
        }

        fn seat_address(self: @ContractState, seat: u32) -> ContractAddress {
            self.seats.read(seat)
        }

        fn session_key_of(self: @ContractState, seat: u32) -> ContractAddress {
            self.session_keys.read(seat)
        }

        fn is_dead(self: @ContractState, seat: u32) -> bool {
            self.dead.read(seat)
        }

        fn night_victim(self: @ContractState) -> u32 {
            self.night_victim_of.read(self.round_number.read())
        }

        fn role_commitment(self: @ContractState) -> felt252 {
            self.role_commitment.read()
        }

        fn total_votes(self: @ContractState) -> u256 {
            self.total_votes_of.read(self.round_number.read())
        }

        fn skip_tally(self: @ContractState) -> u256 {
            self.skip_tally_of.read(self.round_number.read())
        }

        fn round_number(self: @ContractState) -> u32 {
            self.round_number.read()
        }

        fn reactor_deadline(self: @ContractState) -> u64 {
            self.reactor_deadline.read()
        }

        /// True once the deadline passes or every living player has voted.
        fn ballot_is_closed(self: @ContractState) -> bool {
            self.ballot_closed()
        }

        /// `seat + 1` ejected in `round`; 0 = nobody.
        fn ejection_in(self: @ContractState, round: u32) -> u32 {
            self.ejection_of.read(round)
        }

        fn has_called_meeting(self: @ContractState, seat: u32) -> bool {
            self.called_meeting.read(seat)
        }

        fn deadlines(self: @ContractState) -> (u64, u64) {
            (self.night_deadline.read(), self.vote_deadline.read())
        }

        fn crew_won(self: @ContractState) -> bool {
            self.crew_won.read()
        }

        fn winner_count(self: @ContractState) -> u32 {
            if self.phase.read() != phases::RESOLVED {
                return 0;
            }
            let hidden = self.hidden_count.read();
            if self.crew_won.read() {
                self.player_count.read() - hidden
            } else {
                hidden
            }
        }

        fn min_players(self: @ContractState) -> u32 {
            self.min_players.read()
        }

        fn max_players(self: @ContractState) -> u32 {
            self.max_players.read()
        }

        fn hidden_count(self: @ContractState) -> u32 {
            self.hidden_count.read()
        }

        fn seer_count(self: @ContractState) -> u32 {
            self.seer_count.read()
        }

        fn tasks_per_player(self: @ContractState) -> u32 {
            self.tasks_per_player.read()
        }

        fn tasks_done_by(self: @ContractState, seat: u32) -> u32 {
            self.tasks_done.read(seat)
        }

        /// Only meaningful once resolved; false before then.
        fn is_seer(self: @ContractState, seat: u32) -> bool {
            self.seer.read(seat)
        }

        fn seed_commitment(self: @ContractState) -> felt252 {
            self.seed_commitment.read()
        }

        fn entropy_of(self: @ContractState, seat: u32) -> felt252 {
            self.entropy.read(seat)
        }

        /// Only meaningful once resolved; false before then.
        fn is_hidden(self: @ContractState, seat: u32) -> bool {
            self.hidden.read(seat)
        }
    }

    #[generate_trait]
    impl Internal of InternalTrait {
        fn assert_host(self: @ContractState) {
            assert(get_caller_address() == self.host.read(), 'only host');
        }

        fn seat_of_session_key(self: @ContractState, signer: ContractAddress) -> u32 {
            let seat_plus_one = self.session_key_seat.read(signer);
            assert(seat_plus_one != super::NO_SEAT, 'not a session key');
            seat_plus_one - 1
        }

        /// Verify the host's seed against the commitment and derive the hidden
        /// team from it. Shared by both resolvers so the reveal can only ever
        /// happen one way.
        fn open_roles(
            self: @ContractState, host_seed: felt252, salt: felt252,
        ) -> (Span<u32>, Span<u32>) {
            assert(
                poseidon_hash_span(array![host_seed].span()) == self.seed_commitment.read(),
                'seed mismatch',
            );

            let n = self.player_count.read();
            let k = self.hidden_count.read();
            let mut mix: Array<felt252> = array![host_seed];
            let mut e: u32 = 0;
            while e != n {
                mix.append(self.entropy.read(e));
                e += 1;
            }
            let seers = self.seer_count.read();
            // One draw for every role: the first `k` picks are the impostors,
            // the next `seers` are the seer(s). Continuing the same sequence
            // means adding a seer cannot change who the impostors are.
            let all = super::draw_seats(poseidon_hash_span(mix.span()), n, k + seers);
            let mut hidden_only: Array<u32> = array![];
            let mut d: u32 = 0;
            while d != k {
                hidden_only.append(*all.at(d));
                d += 1;
            }
            let hidden_seats = super::sort_ascending_pub(hidden_only).span();

            let mut data: Array<felt252> = array![];
            let mut i: u32 = 0;
            while i != hidden_seats.len() {
                data.append((*hidden_seats.at(i)).into());
                i += 1;
            }
            data.append(salt);
            assert(
                poseidon_hash_span(data.span()) == self.role_commitment.read(),
                'commitment mismatch',
            );
            let mut seer_seats: Array<u32> = array![];
            let mut q: u32 = k;
            while q != k + seers {
                seer_seats.append(*all.at(q));
                q += 1;
            }

            (hidden_seats, seer_seats.span())
        }

        fn living_count(self: @ContractState) -> u32 {
            let n = self.player_count.read();
            let mut alive: u32 = 0;
            let mut seat: u32 = 0;
            while seat != n {
                if !self.dead.read(seat) {
                    alive += 1;
                }
                seat += 1;
            }
            alive
        }

        /// Whether the ballot may be closed.
        ///
        /// The deadline is one way; everybody having voted is the other, and
        /// waiting out a clock nobody is still using is just dead air.
        ///
        /// Votes are anonymous, so the contract cannot see *who* voted — only
        /// the total weight that arrived. Each player shields exactly one vote
        /// stake, so that total reaching the living count is precisely
        /// "everyone has voted". Nobody can reach it early by voting twice
        /// without a second stake to spend.
        fn ballot_closed(self: @ContractState) -> bool {
            if get_block_timestamp() > self.vote_deadline.read() {
                return true;
            }
            let alive_n = self.living_count();
            // With nobody alive, "everyone has voted" is vacuously true, which
            // is a confusing basis for closing a ballot - and the TypeScript
            // mirror guards on it, so the two would disagree. The deadline
            // still closes it.
            if alive_n == 0 {
                return false;
            }
            let alive: u256 = alive_n.into();
            self.total_votes_of.read(self.round_number.read()) >= alive
        }

        fn open_vote(ref self: ContractState) {
            self.vote_deadline.write(get_block_timestamp() + self.vote_duration.read());
            self.phase.write(phases::VOTE);
        }

        /// Strict argmax over living seats' tallies. Returns seat + 1, or 0 on
        /// a tie for first / all-zero tallies.
        fn compute_ejected(self: @ContractState) -> u32 {
            let n = self.player_count.read();
            let round = self.round_number.read();
            let mut best_seat_plus_one: u32 = 0;
            let mut best: u256 = 0;
            let mut tied = false;
            let mut seat: u32 = 0;
            while seat != n {
                if !self.dead.read(seat) {
                    let t = self.tallies.read((round, seat));
                    if t > best {
                        best = t;
                        best_seat_plus_one = seat + 1;
                        tied = false;
                    } else if t == best && t > 0 {
                        tied = true;
                    }
                }
                seat += 1;
            }
            // A skip that matches or beats the leading accusation ejects
            // nobody - the table declined. Ties between players eject nobody
            // either.
            if tied || best == 0 || self.skip_tally_of.read(round) >= best {
                0
            } else {
                best_seat_plus_one
            }
        }
    }
}

/// Game-flow API (host + players). Split from `ISignalRound` in
/// `interfaces.cairo`, which is the minimal surface the escrow depends on.
#[starknet::interface]
pub trait ISignalRoundGame<T> {
    fn set_escrow(ref self: T, escrow: starknet::ContractAddress);
    fn join(
        ref self: T,
        session_key: starknet::ContractAddress,
        payout_note_id: felt252,
        entropy: felt252,
    );
    fn assign_roles(ref self: T, role_commitment: felt252);
    fn start_night(ref self: T);
    fn report_night_kill(ref self: T);
    fn submit_task(ref self: T);
    fn tasks_per_player(self: @T) -> u32;
    fn tasks_done_by(self: @T, seat: u32) -> u32;
    fn skip_night(ref self: T);
    fn call_meeting(ref self: T);
    fn end_vote(ref self: T);
    fn resolve_round(ref self: T, host_seed: felt252, salt: felt252);
    fn host(self: @T) -> starknet::ContractAddress;
    fn escrow(self: @T) -> starknet::ContractAddress;
    fn seat_address(self: @T, seat: u32) -> starknet::ContractAddress;
    fn session_key_of(self: @T, seat: u32) -> starknet::ContractAddress;
    fn is_dead(self: @T, seat: u32) -> bool;
    fn night_victim(self: @T) -> u32;
    fn role_commitment(self: @T) -> felt252;
    fn total_votes(self: @T) -> u256;
    fn round_number(self: @T) -> u32;
    fn ballot_is_closed(self: @T) -> bool;
    fn reactor_deadline(self: @T) -> u64;
    fn sabotage_reactor(ref self: T);
    fn fix_reactor(ref self: T);
    fn resolve_sabotage(ref self: T, host_seed: felt252, salt: felt252);
    fn ejection_in(self: @T, round: u32) -> u32;
    fn skip_tally(self: @T) -> u256;
    fn has_called_meeting(self: @T, seat: u32) -> bool;
    fn deadlines(self: @T) -> (u64, u64);
    fn crew_won(self: @T) -> bool;
    fn winner_count(self: @T) -> u32;
    fn min_players(self: @T) -> u32;
    fn max_players(self: @T) -> u32;
    fn hidden_count(self: @T) -> u32;
    fn seer_count(self: @T) -> u32;
    fn is_seer(self: @T, seat: u32) -> bool;
    fn seed_commitment(self: @T) -> felt252;
    fn entropy_of(self: @T, seat: u32) -> felt252;
    fn is_hidden(self: @T, seat: u32) -> bool;
}
