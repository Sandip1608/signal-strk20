/// SignalEscrow: the ONLY contract in this repo that talks to the STRK20
/// pool, via the standard `privacy_invoke` path (phase 7, InvokeExternal).
///
/// Per STRK20's helper convention (docs.starknet.io anonymous-defi,
/// strk20-by-example helpers/privacy-invoke):
///   - it receives tokens the pool withdrew for this one leg,
///   - acts (reports the vote to the round / computes the payout split),
///   - approves the pool to pull the outputs back ("approve, don't transfer"),
///   - returns `Span<OpenNoteDeposit>` telling the pool which open notes to
///     fill.
/// It holds NOTHING between calls — the pot lives inside the pool as an open
/// note, not here.
///
/// Vote leg:   pool -> escrow (vote stake), candidate index carried in
///             `note_id` (OVERLOADED — see CLAUDE.md unverified list; swap to
///             whatever field the SDK actually exposes for helper payloads),
///             tally reported publicly to the round, stake re-deposited into
///             the round's pot note. The voter is anonymous; the tally is not.
/// Payout leg: pool -> escrow (whole pot), split equally across the winners'
///             pre-registered open notes. A shielded credit — never a public
///             transfer to a winner's wallet.
#[starknet::contract]
pub mod SignalEscrow {
    use core::num::traits::Zero;
    use crate::interfaces::{
        IERC20Dispatcher, IERC20DispatcherTrait, ISignalRoundDispatcher,
        ISignalRoundDispatcherTrait, OpenNoteDeposit, SignalOperation,
    };
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address, get_contract_address};

    /// `phases::RESOLVED` in round.cairo — duplicated here as a literal so
    /// this module's only dependency on the round is the dispatcher.
    const ROUND_RESOLVED: u8 = 4;

    #[storage]
    struct Storage {
        /// The STRK20 privacy pool. Sole authorized caller of privacy_invoke.
        pool: ContractAddress,
        /// The SignalRound game contract.
        round: ContractAddress,
        /// Open note (pre-created via phase 5, CreateOpenNote) that
        /// accumulates vote stakes and holds the prize pot inside the pool.
        pot_note_id: felt252,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        VoteLeg: VoteLeg,
        PayoutLeg: PayoutLeg,
    }

    #[derive(Drop, starknet::Event)]
    struct VoteLeg {
        candidate_seat: u32,
        amount: u256,
    }

    #[derive(Drop, starknet::Event)]
    struct PayoutLeg {
        winners: u32,
        pot: u256,
        share: u256,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        pool: ContractAddress,
        round: ContractAddress,
        pot_note_id: felt252,
    ) {
        assert(pool.is_non_zero(), 'pool required');
        assert(round.is_non_zero(), 'round required');
        assert(pot_note_id != 0, 'pot note required');
        self.pool.write(pool);
        self.round.write(round);
        self.pot_note_id.write(pot_note_id);
    }

    #[abi(embed_v0)]
    impl SignalEscrowImpl of crate::interfaces::ISignalEscrow<ContractState> {
        fn privacy_invoke(
            ref self: ContractState,
            operation: SignalOperation,
            in_token: ContractAddress,
            out_token: ContractAddress,
            assets: u256,
            note_id: felt252,
        ) -> Span<OpenNoteDeposit> {
            assert(get_caller_address() == self.pool.read(), 'only pool');
            match operation {
                SignalOperation::Vote => self.handle_vote_leg(in_token, assets, note_id),
                SignalOperation::Payout => self.handle_payout_leg(in_token, assets),
            }
        }
    }

    #[generate_trait]
    impl Internal of InternalTrait {
        /// Measure what the pool actually sent us by balance (delta from zero:
        /// this contract never holds funds between calls), report the public
        /// tally increment, and push the stake into the pot note.
        fn handle_vote_leg(
            ref self: ContractState, in_token: ContractAddress, assets: u256, note_id: felt252,
        ) -> Span<OpenNoteDeposit> {
            // note_id doubles as the candidate seat index for the Vote op.
            // UNVERIFIED encoding — see CLAUDE.md item 2.
            let candidate_seat: u32 = note_id.try_into().expect('bad candidate encoding');

            let token = IERC20Dispatcher { contract_address: in_token };
            let received = token.balance_of(get_contract_address());
            assert(received >= assets, 'leg underfunded');

            ISignalRoundDispatcher { contract_address: self.round.read() }
                .handle_vote(candidate_seat, received);

            // Approve, don't transfer: the pool pulls the stake back into the
            // pot open note.
            token.approve(self.pool.read(), received);
            self.emit(VoteLeg { candidate_seat, amount: received });

            let amount: u128 = received.try_into().expect('amount overflow');
            array![OpenNoteDeposit { note_id: self.pot_note_id.read(), token: in_token, amount }]
                .span()
        }

        /// Split the pot equally across winners' pre-registered open notes.
        /// Integer remainder goes to the lowest winning seat. Shielded credit:
        /// winners receive pool notes, never a public ERC-20 transfer.
        fn handle_payout_leg(
            ref self: ContractState, in_token: ContractAddress, assets: u256,
        ) -> Span<OpenNoteDeposit> {
            let round = ISignalRoundDispatcher { contract_address: self.round.read() };
            assert(round.phase() == ROUND_RESOLVED, 'round not resolved');

            let token = IERC20Dispatcher { contract_address: in_token };
            let pot = token.balance_of(get_contract_address());
            assert(pot >= assets, 'leg underfunded');

            // Count winners first, then build the deposit list.
            let n = round.player_count();
            let mut winners: u32 = 0;
            let mut seat: u32 = 0;
            while seat != n {
                if round.is_winner(seat) {
                    winners += 1;
                }
                seat += 1;
            }
            assert(winners > 0, 'no winners');

            let share = pot / winners.into();
            let mut remainder = pot - share * winners.into();
            assert(share > 0, 'pot too small');

            let mut deposits: Array<OpenNoteDeposit> = array![];
            let mut seat: u32 = 0;
            while seat != n {
                if round.is_winner(seat) {
                    let payout = share + remainder;
                    remainder = 0;
                    let amount: u128 = payout.try_into().expect('amount overflow');
                    deposits
                        .append(
                            OpenNoteDeposit {
                                note_id: round.payout_note(seat), token: in_token, amount,
                            },
                        );
                }
                seat += 1;
            }

            token.approve(self.pool.read(), pot);
            self.emit(PayoutLeg { winners, pot, share });
            deposits.span()
        }
    }
}
