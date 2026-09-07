# Signal — Architecture

Hidden-role elimination game (Among Us-style) on **STRK20**, Starknet's
note-based privacy pool. Built for the STRK20 Private Sprint, RFP-09:
*"On-chain Among Us with provably fair roles and anonymous votes."*

One round. 5–7 players. One impostor. Everything social is public;
everything identifying is shielded.

## The mechanic ↔ STRK20 primitive mapping

| Game mechanic | STRK20 primitive | Why it works |
|---|---|---|
| Buy-in | **Shield** (deposit → encrypted note) | The pot funds enter the pool; funding wallets are visible at the pool edge but nowhere in the game. |
| Role assignment | **Encrypted notes** (phase 5 memo, 0-value confidential note per player) | Only the holder's viewing key decrypts their role. On-chain, the host posts `poseidon(impostor_seat, salt)` — a commitment that makes the reveal provably fair. |
| Night kill | **Private transfer** (a "kill token" note to the victim) | Nobody — not even the round contract — sees who sent it or who received it. The victim decrypts, learns they're dead, and attests to it on-chain with their session key. The body then waits on the deck until another player finds it and calls it in. |
| Anonymous vote | **`privacy_invoke` with an open-note leg** | The pool withdraws the voter's vote stake to `SignalEscrow`; the escrow reports `(candidate, amount)` publicly to the tally. Sender: hidden inside the pool. Tally: publicly computable (RFP requirement). |
| Payout | **Open-note deposit** back into the pool | Winners registered a pre-created open note at join time. The escrow returns `OpenNoteDeposit[]` and the pool credits those notes. Never a public ERC-20 transfer to a wallet. |
| In-round identity | **Session keys** (burner EOAs, client-side) | `kill`-adjacent and `vote`-adjacent actions are signed by a burner, never by the wallet that shielded the buy-in. Without this the "unlinkable" claim is false. |

## Components

```
                      ┌────────────────────────┐
   join / phases /    │  SignalRound (Cairo)   │   zero pool coupling:
   tally / resolve ──▶│  Lobby → Assigned →    │   plain public game state
                      │  Night → Vote →        │
                      │  Resolved              │
                      └──────────▲─────────────┘
                                 │ handle_vote (escrow-only)
                      ┌──────────┴─────────────┐
   privacy_invoke ───▶│  SignalEscrow (Cairo)  │   the ONLY pool-facing
   (pool is sole      │  Vote leg / Payout leg │   surface; stateless
    caller)           └──────────▲─────────────┘   between calls
                                 │ tokens in / OpenNoteDeposit[] out
                      ┌──────────┴─────────────┐
                      │  STRK20 privacy pool   │
                      └────────────────────────┘
```

- **`round.cairo`** — the state machine. No pool imports, no note types,
  nothing privacy-sensitive. Auditable as an ordinary game contract.
- **`signal_escrow.cairo`** — an STRK20 invoke helper in the standard shape
  (`IVesuLendingHelper` pattern from the anonymous-defi docs): receives
  tokens for one leg, acts, approves the pool to pull outputs, returns
  `Span<OpenNoteDeposit>`. Holds nothing between calls; the pot lives in
  the pool as an open note.
- **`app/`** — the STRK20 starter kit (wallet picker, shield, unshield,
  private transfer) extended with lobby/round screens.

## One full round, tx by tx

1. **Lobby.** Host deploys `SignalRound`, creates the pot open note
   (phase 5), deploys `SignalEscrow(pool, round, pot_note)`, links it with
   `set_escrow`. Each player shields the buy-in, generates a burner session
   key locally, pre-creates a payout open note, and calls
   `join(session_key, payout_note_id)` from their main wallet.
2. **Roles.** Host draws the impostor seat off-chain, posts
   `assign_roles(poseidon(impostor_seat, salt))`, and sends each player a
   0-value encrypted note whose memo says `CREW` or `IMPOSTOR`.
3. **Night.** `start_night()`. The impostor privately transfers the kill
   note to a victim inside the pool. The victim decrypts it and calls
   `confirm_death()` **with their session key** — that signature is the only
   proof of a death the contract can have, since it never learns a kill
   happened. That does *not* open the vote: it leaves a body where they fell,
   and any living player standing over it calls `report_body(seat)`, which
   does. So a night can hold more than one kill, and "where was the body" is
   evidence a player has to walk to. If nobody finds one by the deadline,
   `skip_night()`.
4. **Vote.** Each living player votes by running a `privacy_invoke` (phase
   7) against `SignalEscrow` with `operation = Vote` and the candidate
   seat as the payload. The tally accumulates publicly in `SignalRound`;
   the voters stay inside the pool.
5. **Resolve.** After the deadline, `resolve_round(impostor_seat, salt)`
   opens the commitment. Ejected = strict-max tally (ties eject nobody →
   impostor survives → impostor wins). Crew win ⇢ crew (dead included)
   split the pot; impostor win ⇢ impostor takes it.
6. **Payout.** One `privacy_invoke` with `operation = Payout` moves the
   pot note through the escrow and back into the winners' payout notes as
   shielded credits.

## Trust model (v1, honest about it)

- **The host is a trusted dealer for role assignment.** The commitment
  makes the assignment *binding* (host can't re-pick the impostor after
  the vote), not *unbiased*. A commit-reveal from all players or VRF would
  fix bias — Phase 2.
- **Death is self-attested.** The contract cannot see a kill, so it takes the
  victim's signature for it — which also means a player can declare themselves
  dead unprompted. The only seat that ends is their own, at the cost of their
  round. The victim still has a grief option (refuse to open the note); the
  night deadline + `skip_night` bounds it.
- **Where a body lay is off-chain.** The contract records *that* a seat died
  and that a body was called in; the room is deck state, argued over by players
  rather than agreed on by the round. Keeping it out of public storage costs
  the game nothing and the privacy surface stays as small as it was.
- **Vote privacy = pool anonymity set.** A vote leg is anonymous among
  pool users, not just among the 5–7 players.

## Scope cuts (deliberate — don't re-expand, see CLAUDE.md)

- **One night, one vote, one round.** Multi-night loops multiply state
  machine edges and demo time; the RFP's novel claims (fair roles,
  anonymous votes, shielded payout) are all demonstrated in one cycle.
- **Burner EOAs, not session-key account abstraction.** A locally-held
  burner keypair already makes the unlinkability claim true.
- **No task minigames, no Secret Hitler/Avalon variants, no paymaster.**
  Phase 2, only if the Day 2 checklist is done with time to spare.
- **Vote amounts are plaintext-after-fill by design** (open-note pattern,
  same as STRK20's own AMM helpers expose swap outputs). The RFP wants a
  publicly computable tally; hiding the count is a non-goal.

## Known-unverified list

Tracked in `CLAUDE.md` ("Things that are unverified"). Verified so far:
`privacy_invoke`'s signature and `OpenNoteDeposit`'s fields match the
deployed mainnet Vesu helper ABI byte for byte; `note_id` is a
client-supplied passthrough felt, which makes the candidate-index
overload in the vote leg a valid encoding; pool phase numbers match
`starkware-libs/starknet-privacy`; `strk20.json` schema matches the
hackathon repo. Still open: an end-to-end mainnet invoke against our own
helper (the docs' shapes are confirmed, our deployment is not).
