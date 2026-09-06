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
    assert(k <= n, 'k above n');

    // pool[i] = i, then swap-remove as we draw.
    let mut pool: Felt252Dict<u32> = Default::default();
    let mut i: u32 = 0;
    while i != n {
        pool.insert(i.into(), i);
        i += 1;
    }

    let mut chosen: Array<u32> = array![];
    let mut t: u32 = 0;
    while t != k {
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

    sort_ascending(chosen)
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
        night_victim: u32, // seat + 1, 0 = nobody died
        // -- vote --
        vote_duration: u64,
        vote_deadline: u64,
        tallies: Map<u32, u256>,
        skip_tally: u256,
        total_votes: u256,
        // -- emergency meetings --
        called_meeting: Map<u32, bool>, // seat -> has already called one
        // -- resolution --
        ejected: u32, // seat + 1, 0 = tie / nobody ejected
        impostor: u32, // first hidden seat + 1, revealed at resolve
        hidden: Map<u32, bool>, // seat -> on the hidden team, filled at resolve
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

        self.host.write(host);
        self.seed_commitment.write(seed_commitment);
        self.phase.write(phases::LOBBY);
        self.min_players.write(min_players);
        self.max_players.write(max_players);
        self.hidden_count.write(hidden_count);
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
            if candidate_seat == super::SKIP_VOTE {
                let new_tally = self.skip_tally.read() + amount;
                self.skip_tally.write(new_tally);
                self.total_votes.write(self.total_votes.read() + amount);
                self.emit(VoteRecorded { candidate_seat, amount, new_tally });
                return;
            }

            assert(candidate_seat < self.player_count.read(), 'bad candidate');
            assert(!self.dead.read(candidate_seat), 'candidate dead');
            let new_tally = self.tallies.read(candidate_seat) + amount;
            self.tallies.write(candidate_seat, new_tally);
            self.total_votes.write(self.total_votes.read() + amount);
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
            self.tallies.read(seat)
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
            self.night_victim.write(seat + 1);
            self.open_vote();
            self.emit(BodyReported { victim_seat: seat, vote_deadline: self.vote_deadline.read() });
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
            assert(get_block_timestamp() > self.vote_deadline.read(), 'vote still open');
            assert(
                poseidon_hash_span(array![host_seed].span()) == self.seed_commitment.read(),
                'seed mismatch',
            );

            let n = self.player_count.read();
            let k = self.hidden_count.read();

            // combined = poseidon(host_seed, entropy_0, .., entropy_{n-1})
            let mut mix: Array<felt252> = array![host_seed];
            let mut e: u32 = 0;
            while e != n {
                mix.append(self.entropy.read(e));
                e += 1;
            }
            let combined = poseidon_hash_span(mix.span());
            let hidden_seats = super::derive_hidden(combined, n, k).span();

            // The role commitment still has to match: it binds the notes the
            // host actually handed out to the team the seed produces.
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

            let mut j: u32 = 0;
            while j != hidden_seats.len() {
                self.hidden.write(*hidden_seats.at(j), true);
                j += 1;
            }

            let ejected = self.compute_ejected();
            // Crew win by ejecting anyone from the hidden team.
            let crew_won = ejected != super::NO_SEAT && self.hidden.read(ejected - 1);
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
            self.night_victim.read()
        }

        fn role_commitment(self: @ContractState) -> felt252 {
            self.role_commitment.read()
        }

        fn total_votes(self: @ContractState) -> u256 {
            self.total_votes.read()
        }

        fn skip_tally(self: @ContractState) -> u256 {
            self.skip_tally.read()
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

        fn open_vote(ref self: ContractState) {
            self.vote_deadline.write(get_block_timestamp() + self.vote_duration.read());
            self.phase.write(phases::VOTE);
        }

        /// Strict argmax over living seats' tallies. Returns seat + 1, or 0 on
        /// a tie for first / all-zero tallies.
        fn compute_ejected(self: @ContractState) -> u32 {
            let n = self.player_count.read();
            let mut best_seat_plus_one: u32 = 0;
            let mut best: u256 = 0;
            let mut tied = false;
            let mut seat: u32 = 0;
            while seat != n {
                if !self.dead.read(seat) {
                    let t = self.tallies.read(seat);
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
            if tied || best == 0 || self.skip_tally.read() >= best {
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
    fn skip_night(ref self: T);
    fn call_meeting(ref self: T);
    fn resolve_round(ref self: T, host_seed: felt252, salt: felt252);
    fn host(self: @T) -> starknet::ContractAddress;
    fn escrow(self: @T) -> starknet::ContractAddress;
    fn seat_address(self: @T, seat: u32) -> starknet::ContractAddress;
    fn session_key_of(self: @T, seat: u32) -> starknet::ContractAddress;
    fn is_dead(self: @T, seat: u32) -> bool;
    fn night_victim(self: @T) -> u32;
    fn role_commitment(self: @T) -> felt252;
    fn total_votes(self: @T) -> u256;
    fn skip_tally(self: @T) -> u256;
    fn has_called_meeting(self: @T, seat: u32) -> bool;
    fn deadlines(self: @T) -> (u64, u64);
    fn crew_won(self: @T) -> bool;
    fn winner_count(self: @T) -> u32;
    fn min_players(self: @T) -> u32;
    fn max_players(self: @T) -> u32;
    fn hidden_count(self: @T) -> u32;
    fn seed_commitment(self: @T) -> felt252;
    fn entropy_of(self: @T, seat: u32) -> felt252;
    fn is_hidden(self: @T, seat: u32) -> bool;
}
