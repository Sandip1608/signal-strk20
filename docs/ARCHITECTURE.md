# Signal — Architecture

Hidden-role elimination game (Among Us-style) on **STRK20**, Starknet's
note-based privacy pool. Built for the STRK20 Private Sprint, RFP-09:
*"On-chain Among Us with provably fair roles and anonymous votes."*

One round. 5–15 players. A hidden minority. Everything social is public;
everything identifying is shielded.

> **Implementation status lives in the [README](../README.md#how-signal-uses-strk20).**
> This document is the *design* — the mechanic↔primitive mapping and the full
> intended flow. The README's table is the source of truth for what is live
> on-chain today (contracts, seats, session keys, the vote leg and the reveal)
> versus what remains gated on the STRK20 SDK + proving service (the encrypted
> role notes, the private-transfer kill, the escrow token split). Where this
> doc describes a leg as on-chain, read it as *the design that leg implements*.

## The mechanic ↔ STRK20 primitive mapping

| Game mechanic | STRK20 primitive | Why it works |
|---|---|---|
| Buy-in | **Shield** (deposit → encrypted note) | The pot funds enter the pool; funding wallets are visible at the pool edge but nowhere in the game. |
| Role assignment | **Encrypted notes** (phase 5 memo, 0-value confidential note per player) | Only the holder's viewing key decrypts their role. On-chain, the host commits `poseidon(hidden_seats, salt)` where `hidden_seats` is **derived** from a multi-party seed the host cannot steer (see *Provably fair roles* in the README), not a team the host picks — that is what makes the reveal both binding and unbiased. |
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
  private transfer) extended with the lobby/deck/vote/payout screens, the
  React-free game engine that mirrors `round.cairo`, and the thin chain seam:
  `game/chain.ts` (join, the pool vote leg, the browser-signed meeting) plus
  the `app/api/chain/*` host routes (`advance`, `resolve`) and the guarded gas
  `faucet`.

## One full round, tx by tx

1. **Lobby.** Host deploys `SignalRound`, creates the pot open note
   (phase 5), deploys `SignalEscrow(pool, round, pot_note)`, links it with
   `set_escrow`. Each player shields the buy-in, generates a burner session
   key locally, pre-creates a payout open note, and calls
   `join(session_key, payout_note_id)` from their main wallet.
2. **Roles.** The impostor seat(s) are **derived** from the seed the host
   committed in the constructor, mixed with every player's join-time entropy —
   the host never names the team. The host posts
   `assign_roles(poseidon(hidden_seats, salt))` over those derived seats, and
   sends each player a 0-value encrypted note whose memo says `CREW` or
   `IMPOSTOR`. (See *Provably fair roles* in the README for why neither side
   can steer the draw.)
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
   the voters stay inside the pool. If the clock runs out, uncast stakes
   are counted as skip (`absorb_abstentions`) and the round either
   resolves or night falls again — a skip that ties or beats the leader
   ejects nobody.
5. **Resolve.** After the deadline — or immediately when the crew finish
   every job during the night, or when a kill leaves living impostors equal
   to (or more than) living crew — `resolve_round(host_seed, salt)` opens the
   commitment. Ejected = strict-max tally (ties eject nobody). Crew also
   win by filling the task bar (`submit_task`, counted only over crew
   seats, ghosts included). Crew win ⇢ every crewmate (dead included)
   splits the pot; impostor win ⇢ the hidden team takes it.
6. **Payout.** One `privacy_invoke` with `operation = Payout` moves the
   pot note through the escrow and back into the winners' payout notes as
   shielded credits.

## Trust model (v1, honest about it)

- **Role assignment is binding *and* unbiased.** The constructor commitment
  makes it binding (the host can't re-pick the impostor after the vote), and
  because the team is derived from a seed the host committed *before anyone
  joined* mixed with each player's own entropy, the host cannot aim the draw
  either. The one residual trust is liveness: the host alone holds `host_seed`
  and must reveal it to resolve. A player commit-reveal or VRF for the seed
  itself would remove even that — Phase 2.
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
  pool users, not just among the 5–15 players at the table.

## Scope cuts (deliberate — don't re-expand, see CLAUDE.md)

- **One night, one vote, one round.** Multi-night loops multiply state
  machine edges and demo time; the RFP's novel claims (fair roles,
  anonymous votes, shielded payout) are all demonstrated in one cycle.
- **Burner EOAs, not session-key account abstraction.** A locally-held
  burner keypair already makes the unlinkability claim true. Since a bare
  keypair cannot *send* a Starknet transaction, `join` registers the burner's
  deterministic **account address** (OZ v0.8.1 class) as the seat's session
  key, and the browser deploys that account and signs its own in-round actions
  (e.g. `call_meeting`) from it. Gas is the one thing the player cannot self-
  provide before their account exists, so a guarded server faucet
  (`/api/chain/faucet`) tops up an address *only* after confirming it holds a
  seat on-chain — the server pays gas, but **never holds or signs with a player
  key**. A full paymaster would remove even that faucet; it is the documented
  Phase-2 item.
- **No multi-night loop, no named Secret Hitler/Avalon variants, no paymaster.**
  Phase 2. (Task minigames, the seer, bodies-on-the-deck and the on-chain vote
  leg all landed within the sprint and are no longer cuts.)
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
