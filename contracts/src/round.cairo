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

pub mod phases {
    pub const LOBBY: u8 = 0;
    pub const ASSIGNED: u8 = 1;
    pub const NIGHT: u8 = 2;
    pub const VOTE: u8 = 3;
    pub const RESOLVED: u8 = 4;
}

/// Sentinel meaning "no seat" in fields that store `seat + 1`.
pub const NO_SEAT: u32 = 0;

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

    pub const MIN_PLAYERS: u32 = 5;
    pub const MAX_PLAYERS: u32 = 7;

    #[storage]
    struct Storage {
        host: ContractAddress,
        escrow: ContractAddress,
        phase: u8,
        // -- lobby --
        player_count: u32,
        seats: Map<u32, ContractAddress>, // seat -> lobby-join wallet
        session_keys: Map<u32, ContractAddress>, // seat -> burner in-round signer
        session_key_seat: Map<ContractAddress, u32>, // signer -> seat + 1 (0 = none)
        payout_notes: Map<u32, felt252>, // seat -> pre-created STRK20 open-note id
        joined: Map<ContractAddress, bool>,
        // -- roles --
        role_commitment: felt252, // poseidon(impostor_seat, salt), posted by host
        // -- night --
        night_duration: u64,
        night_deadline: u64,
        dead: Map<u32, bool>,
        night_victim: u32, // seat + 1, 0 = nobody died
        // -- vote --
        vote_duration: u64,
        vote_deadline: u64,
        tallies: Map<u32, u256>,
        total_votes: u256,
        // -- resolution --
        ejected: u32, // seat + 1, 0 = tie / nobody ejected
        impostor: u32, // seat + 1, revealed at resolve
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

    #[constructor]
    fn constructor(
        ref self: ContractState, host: ContractAddress, night_duration: u64, vote_duration: u64,
    ) {
        assert(host.is_non_zero(), 'host required');
        self.host.write(host);
        self.phase.write(phases::LOBBY);
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
            assert(candidate_seat < self.player_count.read(), 'bad candidate');
            assert(!self.dead.read(candidate_seat), 'candidate dead');
            assert(amount > 0, 'zero vote');
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
            let impostor_seat = self.impostor.read() - 1;
            if self.crew_won.read() {
                seat != impostor_seat && seat < self.player_count.read()
            } else {
                seat == impostor_seat
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
        fn join(ref self: ContractState, session_key: ContractAddress, payout_note_id: felt252) {
            assert(self.phase.read() == phases::LOBBY, 'not in lobby');
            let caller = get_caller_address();
            assert(!self.joined.read(caller), 'already joined');
            assert(session_key.is_non_zero(), 'session key required');
            // Minimal unlinkability guard: the in-round signer must not be the
            // wallet that joined (and paid in). See CLAUDE.md.
            assert(session_key != caller, 'session key = wallet');
            assert(self.session_key_seat.read(session_key) == super::NO_SEAT, 'session key taken');
            assert(payout_note_id != 0, 'payout note required');
            let seat = self.player_count.read();
            assert(seat < MAX_PLAYERS, 'lobby full');
            self.seats.write(seat, caller);
            self.session_keys.write(seat, session_key);
            self.session_key_seat.write(session_key, seat + 1);
            self.payout_notes.write(seat, payout_note_id);
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
            assert(self.player_count.read() >= MIN_PLAYERS, 'need 5+ players');
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
        fn resolve_round(ref self: ContractState, impostor_seat: u32, salt: felt252) {
            self.assert_host();
            assert(self.phase.read() == phases::VOTE, 'not in vote phase');
            assert(get_block_timestamp() > self.vote_deadline.read(), 'vote still open');
            assert(impostor_seat < self.player_count.read(), 'bad impostor seat');
            let commitment = poseidon_hash_span(array![impostor_seat.into(), salt].span());
            assert(commitment == self.role_commitment.read(), 'commitment mismatch');

            let ejected = self.compute_ejected();
            let crew_won = ejected == impostor_seat + 1;
            self.ejected.write(ejected);
            self.impostor.write(impostor_seat + 1);
            self.crew_won.write(crew_won);
            self.phase.write(phases::RESOLVED);
            self.emit(RoundResolved { impostor_seat, ejected_seat_plus_one: ejected, crew_won });
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
            if self.crew_won.read() {
                self.player_count.read() - 1
            } else {
                1
            }
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
            if tied || best == 0 {
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
    fn join(ref self: T, session_key: starknet::ContractAddress, payout_note_id: felt252);
    fn assign_roles(ref self: T, role_commitment: felt252);
    fn start_night(ref self: T);
    fn report_night_kill(ref self: T);
    fn skip_night(ref self: T);
    fn resolve_round(ref self: T, impostor_seat: u32, salt: felt252);
    fn host(self: @T) -> starknet::ContractAddress;
    fn escrow(self: @T) -> starknet::ContractAddress;
    fn seat_address(self: @T, seat: u32) -> starknet::ContractAddress;
    fn session_key_of(self: @T, seat: u32) -> starknet::ContractAddress;
    fn is_dead(self: @T, seat: u32) -> bool;
    fn night_victim(self: @T) -> u32;
    fn role_commitment(self: @T) -> felt252;
    fn total_votes(self: @T) -> u256;
    fn deadlines(self: @T) -> (u64, u64);
    fn crew_won(self: @T) -> bool;
    fn winner_count(self: @T) -> u32;
}
