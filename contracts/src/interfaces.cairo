use starknet::ContractAddress;

/// Instruction returned to the STRK20 pool after an external invoke:
/// fill open note `note_id` with `amount` of `token`.
///
/// Field shape per docs.starknet.io/build/starknet-privacy/anonymous-defi and
/// strk20-by-example.org/helpers/privacy-invoke (`amount` is u128 there).
/// UNVERIFIED against starkware-libs/starknet-privacy source — confirm before
/// mainnet deploy.
#[derive(Copy, Drop, Serde)]
pub struct OpenNoteDeposit {
    pub note_id: felt252,
    pub token: ContractAddress,
    pub amount: u128,
}

/// The two legs SignalEscrow can run for the pool.
#[derive(Copy, Drop, Serde)]
pub enum SignalOperation {
    /// Anonymous vote: pool sends the vote stake to the escrow, escrow reports
    /// the (public) candidate + amount to the round contract, stake is
    /// re-deposited into the round's pot note.
    Vote,
    /// End-of-round payout: pool sends the pot to the escrow, escrow splits it
    /// across the winners' pre-registered open notes. Never a public transfer.
    Payout,
}

/// Invoke-helper surface called by the STRK20 pool (phase 7, InvokeExternal).
///
/// Signature mirrors the documented `IVesuLendingHelper` shape. NOTE:
/// strk20-by-example shows a leaner `privacy_invoke(deposits: Span<OpenNoteDeposit>)`
/// variant — confirm the actual mainnet calling convention against the SDK
/// source / the Vesu helper on Voyager before deploying (see CLAUDE.md).
#[starknet::interface]
pub trait ISignalEscrow<T> {
    fn privacy_invoke(
        ref self: T,
        operation: SignalOperation,
        in_token: ContractAddress,
        out_token: ContractAddress,
        assets: u256,
        note_id: felt252,
    ) -> Span<OpenNoteDeposit>;
}

/// Cross-contract surface of the round state machine that the escrow (and the
/// frontend) relies on. Full game API lives in `round.cairo`.
#[starknet::interface]
pub trait ISignalRound<T> {
    // -- escrow-only --
    fn handle_vote(ref self: T, candidate_seat: u32, amount: u256);

    // -- views used for payout & UI --
    fn phase(self: @T) -> u8;
    fn player_count(self: @T) -> u32;
    fn is_winner(self: @T, seat: u32) -> bool;
    fn payout_note(self: @T, seat: u32) -> felt252;
    fn tally(self: @T, seat: u32) -> u256;
    fn ejected_seat(self: @T) -> u32;
    fn impostor_seat(self: @T) -> u32;
}

#[starknet::interface]
pub trait IERC20<T> {
    fn balance_of(self: @T, account: ContractAddress) -> u256;
    fn transfer(ref self: T, recipient: ContractAddress, amount: u256) -> bool;
    fn approve(ref self: T, spender: ContractAddress, amount: u256) -> bool;
}
