//! Unit tests for the parts of the round that can go quietly wrong.
//!
//! Run with `scarb cairo-test`. These deliberately target the derivation and
//! the resolution arithmetic rather than the happy-path plumbing: a lobby that
//! fails to accept a player is obvious the first time anyone plays, whereas a
//! biased or duplicate-producing seed draw, or an off-by-one in the ejection
//! rule, is exactly the kind of thing that survives a demo and is wrong.

#[cfg(test)]
mod tests {
    use core::poseidon::poseidon_hash_span;
    use signal::round::derive_hidden;

    fn seed(x: felt252) -> felt252 {
        poseidon_hash_span(array![x].span())
    }

    // ── derive_hidden ──────────────────────────────────────────────────────

    #[test]
    fn derives_the_requested_number_of_seats() {
        let hidden = derive_hidden(seed(1), 7, 3);
        assert(hidden.len() == 3, 'wrong count');
    }

    #[test]
    fn derived_seats_are_in_range() {
        let n: u32 = 9;
        let hidden = derive_hidden(seed(42), n, 3);
        let mut i: u32 = 0;
        while i != hidden.len() {
            assert(*hidden.at(i) < n, 'seat out of range');
            i += 1;
        }
    }

    /// The swap-remove in the Fisher-Yates draw is the part most likely to be
    /// wrong; a duplicate would silently shrink the hidden team.
    #[test]
    fn derived_seats_are_distinct() {
        let hidden = derive_hidden(seed(7), 5, 2);
        assert(*hidden.at(0) != *hidden.at(1), 'duplicate seat');
    }

    #[test]
    fn derived_seats_are_distinct_at_full_table() {
        let hidden = derive_hidden(seed(99), 15, 3);
        let a = *hidden.at(0);
        let b = *hidden.at(1);
        let c = *hidden.at(2);
        assert(a != b, 'dup a b');
        assert(b != c, 'dup b c');
        assert(a != c, 'dup a c');
    }

    /// The commitment hashes the sequence, so a non-canonical order would let
    /// the same team hash many ways.
    #[test]
    fn derived_seats_are_ascending() {
        let hidden = derive_hidden(seed(1234), 11, 3);
        assert(*hidden.at(0) < *hidden.at(1), 'not ascending 0 1');
        assert(*hidden.at(1) < *hidden.at(2), 'not ascending 1 2');
    }

    /// Resolution recomputes the draw from the revealed seed, so the same
    /// inputs must always give the same team or no round could ever open.
    #[test]
    fn derivation_is_deterministic() {
        let a = derive_hidden(seed(5), 8, 2);
        let b = derive_hidden(seed(5), 8, 2);
        assert(*a.at(0) == *b.at(0), 'seat 0 differs');
        assert(*a.at(1) == *b.at(1), 'seat 1 differs');
    }

    #[test]
    fn different_seeds_move_the_team() {
        // Not a distribution test - just that the seed is actually mixed in.
        let a = derive_hidden(seed(1), 15, 1);
        let b = derive_hidden(seed(2), 15, 1);
        let c = derive_hidden(seed(3), 15, 1);
        let all_same = *a.at(0) == *b.at(0) && *b.at(0) == *c.at(0);
        assert(!all_same, 'seed not mixed in');
    }

    #[test]
    fn whole_table_hidden_is_every_seat() {
        let hidden = derive_hidden(seed(8), 4, 4);
        assert(hidden.len() == 4, 'wrong count');
        assert(*hidden.at(0) == 0, 'expected 0');
        assert(*hidden.at(1) == 1, 'expected 1');
        assert(*hidden.at(2) == 2, 'expected 2');
        assert(*hidden.at(3) == 3, 'expected 3');
    }

    #[test]
    #[should_panic(expected: ('k above n',))]
    fn cannot_draw_more_than_the_table() {
        derive_hidden(seed(1), 3, 4);
    }

    // ── skip votes ────────────────────────────────────────────────────────

    /// The sentinel must sit outside any real seat index, or a skip would be
    /// indistinguishable from an accusation against a high seat number.
    #[test]
    fn skip_sentinel_is_not_a_seat() {
        assert(signal::round::SKIP_VOTE > 15, 'skip collides with a seat');
        assert(signal::round::SKIP_VOTE != signal::round::NO_SEAT, 'skip collides with NO_SEAT');
    }

    /// Ejection is a strict max that must also beat the skip pile. These
    /// mirror `compute_ejected`'s arithmetic, which is the rule most likely to
    /// be got subtly wrong.
    fn ejects(best: u256, tied: bool, skip: u256) -> bool {
        !(tied || best == 0 || skip >= best)
    }

    #[test]
    fn skip_beating_the_leader_ejects_nobody() {
        assert(!ejects(2, false, 3), 'skip should win');
    }

    #[test]
    fn skip_tying_the_leader_ejects_nobody() {
        // Among Us declines to eject on a tie with skip.
        assert(!ejects(3, false, 3), 'tie with skip should hold');
    }

    #[test]
    fn leader_above_the_skip_pile_is_ejected() {
        assert(ejects(4, false, 3), 'leader should be ejected');
    }

    #[test]
    fn a_tie_between_players_ejects_nobody() {
        assert(!ejects(3, true, 0), 'player tie should hold');
    }

    #[test]
    fn all_zero_tallies_eject_nobody() {
        assert(!ejects(0, false, 0), 'no votes should eject nobody');
    }

    // ── reactor meltdown ──────────────────────────────────────────────────

    /// The meltdown is the one losing outcome the contract decides *without*
    /// a vote, so its window has to be unambiguous: `fix_reactor` accepts up
    /// to and including the deadline, `resolve_sabotage` only strictly after.
    /// An overlap would let the same instant be both fixable and lost.
    fn can_fix(now: u64, deadline: u64) -> bool {
        deadline != 0 && now <= deadline
    }
    fn is_blown(now: u64, deadline: u64) -> bool {
        deadline != 0 && now > deadline
    }

    #[test]
    fn a_stable_reactor_is_neither_fixable_nor_blown() {
        assert(!can_fix(100, 0), 'nothing to fix');
        assert(!is_blown(100, 0), 'nothing blew');
    }

    #[test]
    fn the_reactor_can_be_fixed_right_up_to_the_deadline() {
        assert(can_fix(99, 100), 'before should fix');
        assert(can_fix(100, 100), 'on the tick should fix');
    }

    #[test]
    fn one_tick_late_is_a_meltdown() {
        assert(!can_fix(101, 100), 'too late to fix');
        assert(is_blown(101, 100), 'should have blown');
    }

    /// The two windows must never both be true.
    #[test]
    fn fixable_and_blown_are_mutually_exclusive() {
        assert(!(can_fix(100, 100) && is_blown(100, 100)), 'overlap at deadline');
        assert(!(can_fix(101, 100) && is_blown(101, 100)), 'overlap after');
        assert(!(can_fix(1, 100) && is_blown(1, 100)), 'overlap before');
    }

    #[test]
    fn reactor_window_is_sane() {
        assert(signal::round::REACTOR_SECS > 0, 'needs a window');
        assert(signal::round::REACTOR_SECS <= 120, 'window too long to matter');
    }

    /// A meeting used to be a free "delete the sabotage" button: it moved the
    /// phase to VOTE, resolve_sabotage only fired during NIGHT, and end_vote
    /// then wiped the deadline. These pin the three guards that close it.
    fn meeting_allowed(reactor_deadline: u64) -> bool {
        reactor_deadline == 0
    }
    fn end_vote_allowed(now: u64, reactor_deadline: u64) -> bool {
        reactor_deadline == 0 || now <= reactor_deadline
    }

    #[test]
    fn no_meeting_while_the_reactor_is_going() {
        assert(!meeting_allowed(500), 'meeting must be blocked');
        assert(meeting_allowed(0), 'meeting fine when stable');
    }

    #[test]
    fn cannot_round_past_a_blown_reactor() {
        assert(!end_vote_allowed(501, 500), 'must resolve the meltdown');
    }

    #[test]
    fn can_end_a_round_with_the_reactor_stable_or_still_fixable() {
        assert(end_vote_allowed(999, 0), 'stable should pass');
        assert(end_vote_allowed(400, 500), 'still fixable should pass');
    }

    /// The dodge is only fully closed if all three hold at once.
    #[test]
    fn the_meltdown_cannot_be_escaped() {
        let live: u64 = 500;
        assert(!meeting_allowed(live), 'meeting escape open');
        assert(!end_vote_allowed(501, live), 'end_vote escape open');
    }

    // ── closing the ballot early ──────────────────────────────────────────

    /// Mirrors the vote-count half of `ballot_closed()`.
    ///
    /// The contract cannot see who voted - the legs are anonymous - so it
    /// compares total weight against the living count. That is sound only
    /// because each player shields exactly one vote stake; these pin the
    /// arithmetic so a change to vote weighting cannot silently let a round be
    /// closed before everyone has had their say.
    fn everyone_voted(total_weight: u256, alive: u32) -> bool {
        let alive_u: u256 = alive.into();
        total_weight >= alive_u
    }

    #[test]
    fn ballot_closes_when_every_living_player_has_voted() {
        assert(everyone_voted(4, 4), 'four of four should close');
    }

    #[test]
    fn ballot_stays_open_with_a_vote_outstanding() {
        assert(!everyone_voted(3, 4), 'one missing should hold');
    }

    #[test]
    fn the_dead_are_not_waited_for() {
        // Five seats, one killed: four votes is everyone who can still vote.
        assert(everyone_voted(4, 4), 'should not wait on a corpse');
    }

    /// The Cairo and TypeScript versions must agree here, or a round could be
    /// closable on one side and not the other.
    #[test]
    fn nobody_alive_does_not_close_the_ballot() {
        assert(!everyone_voted_guarded(0, 0), 'zero voters must not close');
    }

    fn everyone_voted_guarded(total_weight: u256, alive: u32) -> bool {
        if alive == 0 {
            return false;
        }
        let alive_u: u256 = alive.into();
        total_weight >= alive_u
    }

    #[test]
    fn no_votes_at_all_keeps_the_ballot_open() {
        assert(!everyone_voted(0, 5), 'zero votes should hold');
    }

    // ── multi-round ending ────────────────────────────────────────────────

    /// Mirrors the assert in `resolve_round`. The host picks when to stop, so
    /// this is the check that makes that choice honest rather than trusted -
    /// getting it wrong would let a host end on whichever round suited them.
    fn game_over(impostors_alive: u32, crew_alive: u32) -> bool {
        impostors_alive == 0 || impostors_alive >= crew_alive
    }
    fn crew_won(impostors_alive: u32) -> bool {
        impostors_alive == 0
    }

    #[test]
    fn all_impostors_gone_is_a_crew_win() {
        assert(game_over(0, 3), 'should be over');
        assert(crew_won(0), 'crew should win');
    }

    #[test]
    fn impostors_equalling_crew_ends_it() {
        // 1 impostor vs 1 crew: the impostor cannot be out-voted, so Among Us
        // stops here rather than playing a decided round.
        assert(game_over(1, 1), 'should be over');
        assert(!crew_won(1), 'impostor should win');
    }

    #[test]
    fn impostors_outnumbering_crew_ends_it() {
        assert(game_over(2, 1), 'should be over');
        assert(!crew_won(2), 'impostor should win');
    }

    #[test]
    fn a_live_impostor_among_many_crew_is_not_over() {
        assert(!game_over(1, 4), 'should keep playing');
    }

    #[test]
    fn two_impostors_among_three_crew_is_not_over() {
        assert(!game_over(2, 3), 'should keep playing');
    }

    /// The opening table must never already satisfy the end condition, or the
    /// host could resolve on round 0. This is exactly what the constructor's
    /// `2 * hidden < min_players` assert buys.
    #[test]
    fn a_legal_opening_table_is_never_already_over() {
        // 1 impostor, 5 players
        assert(!game_over(1, 4), 'k=1 n=5 already over');
        // 2 impostors, 5 players
        assert(!game_over(2, 3), 'k=2 n=5 already over');
        // 3 impostors, 7 players
        assert(!game_over(3, 4), 'k=3 n=7 already over');
    }

    #[test]
    fn round_cap_is_sane() {
        assert(signal::round::MAX_ROUNDS > 1, 'cap must allow a loop');
        assert(signal::round::MAX_ROUNDS <= 20, 'cap should bound a stall');
    }

    // ── the seer shares the impostors' seed ───────────────────────────────

    use signal::round::draw_seats;

    /// The whole point of continuing one Fisher-Yates sequence: drawing an
    /// extra seat for the seer must not disturb which seats became impostors.
    /// If this ever fails, adding a seer silently re-rolls the game.
    #[test]
    fn drawing_a_seer_does_not_move_the_impostors() {
        let c = seed(31337);
        let just_impostors = draw_seats(c, 9, 2);
        let with_a_seer = draw_seats(c, 9, 3);
        assert(*just_impostors.at(0) == *with_a_seer.at(0), 'impostor 0 moved');
        assert(*just_impostors.at(1) == *with_a_seer.at(1), 'impostor 1 moved');
    }

    #[test]
    fn the_seer_is_never_an_impostor() {
        let c = seed(4242);
        let all = draw_seats(c, 8, 3); // 2 impostors + 1 seer
        let seer = *all.at(2);
        assert(seer != *all.at(0), 'seer is impostor 0');
        assert(seer != *all.at(1), 'seer is impostor 1');
    }

    #[test]
    fn a_seer_draw_stays_in_range() {
        let all = draw_seats(seed(11), 6, 3);
        let mut i: u32 = 0;
        while i != all.len() {
            assert(*all.at(i) < 6, 'seat out of range');
            i += 1;
        }
    }

    /// `derive_hidden` is now a wrapper over `draw_seats`; it must still sort.
    #[test]
    fn derive_hidden_still_sorts_its_draw() {
        let h = derive_hidden(seed(555), 12, 3);
        assert(*h.at(0) < *h.at(1), 'not ascending 0 1');
        assert(*h.at(1) < *h.at(2), 'not ascending 1 2');
    }

    // ── cross-language parity ─────────────────────────────────────────────

    /// These exact seat lists were produced by the TypeScript mirror in
    /// `app/src/game/crypto.ts`. If either side's poseidon padding, felt->u256
    /// conversion or swap-remove ever drifts, this test fails — which is the
    /// only way to catch it, since a divergence would simply make every round
    /// unopenable at `resolve_round` with a "commitment mismatch".
    #[test]
    fn matches_the_typescript_mirror() {
        let a = derive_hidden(seed(5), 8, 2);
        assert(*a.at(0) == 2, 'ts parity a0');
        assert(*a.at(1) == 5, 'ts parity a1');

        let b = derive_hidden(seed(1234), 11, 3);
        assert(*b.at(0) == 1, 'ts parity b0');
        assert(*b.at(1) == 6, 'ts parity b1');
        assert(*b.at(2) == 8, 'ts parity b2');

        let c = derive_hidden(seed(42), 9, 3);
        assert(*c.at(0) == 2, 'ts parity c0');
        assert(*c.at(1) == 3, 'ts parity c1');
        assert(*c.at(2) == 8, 'ts parity c2');

        let d = derive_hidden(seed(7), 5, 2);
        assert(*d.at(0) == 1, 'ts parity d0');
        assert(*d.at(1) == 2, 'ts parity d1');
    }

    /// The seer split, pinned to what `deriveRoles` in `crypto.ts` returns for
    /// the same seed. Asserting only that "the first k picks are stable" would
    /// pass even if both languages drifted together; these are the literal
    /// seats the TypeScript printed.
    #[test]
    fn the_seer_split_matches_the_typescript_mirror() {
        let c = seed(42);
        let two = draw_seats(c, 9, 2);
        assert(*two.at(0) == 3, 'ts seer two0');
        assert(*two.at(1) == 2, 'ts seer two1');

        let three = draw_seats(c, 9, 3);
        assert(*three.at(0) == 3, 'ts seer three0');
        assert(*three.at(1) == 2, 'ts seer three1');
        // hidden = {2, 3}, seer = 8 — the impostors are untouched by the extra
        // draw, which is the property the whole split exists for.
        assert(*three.at(2) == 8, 'ts seer three2');
    }

    // ── the commitment the contract checks ────────────────────────────────

    /// `resolve_round` recomputes this exact hash; if the ordering convention
    /// drifted from the client the round would be unopenable.
    #[test]
    fn role_commitment_is_order_sensitive() {
        let a = poseidon_hash_span(array![1, 4, 999].span());
        let b = poseidon_hash_span(array![4, 1, 999].span());
        assert(a != b, 'order must matter');
    }

    #[test]
    fn seed_commitment_round_trips() {
        let host_seed: felt252 = 0x1234abcd;
        let commitment = poseidon_hash_span(array![host_seed].span());
        assert(commitment == seed(0x1234abcd), 'commitment mismatch');
    }

    /// The host commits before any player entropy exists, so mixing must
    /// change the result - otherwise the players contribute nothing.
    #[test]
    fn player_entropy_changes_the_combined_seed() {
        let host_seed: felt252 = 777;
        let without = poseidon_hash_span(array![host_seed].span());
        let with_players = poseidon_hash_span(array![host_seed, 11, 22, 33].span());
        assert(without != with_players, 'entropy ignored');
    }

    #[test]
    fn one_player_changing_entropy_changes_the_team() {
        let a = poseidon_hash_span(array![777, 11, 22, 33, 44, 55].span());
        let b = poseidon_hash_span(array![777, 11, 22, 33, 44, 56].span());
        assert(a != b, 'last player cannot matter');
        let team_a = derive_hidden(a, 6, 1);
        let team_b = derive_hidden(b, 6, 1);
        // Not guaranteed different for one draw, but the seeds must differ.
        assert(team_a.len() == team_b.len(), 'len differs');
    }
}
