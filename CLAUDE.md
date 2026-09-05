# CLAUDE.md

Context file for working on this repo with Claude / Claude Code. Read this
before touching contracts or app code.

## What this is

**Signal** — a hidden-role elimination game (Among Us-style) built on
STRK20, Starknet's privacy pool. Built for the STRK20 Private Sprint
hackathon (RFP-09: "On-chain Among Us with provably fair roles and
anonymous votes"). Deadline: **Sept 7, 23:59 UTC** — treat remaining time
as scarce in every decision.

Full mechanic write-up: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).
Day-by-day plan: [`docs/TIMELINE.md`](./docs/TIMELINE.md). Read both before
making scope decisions — don't re-expand scope back toward the full RFP
platform pitch without explicitly deciding to blow the deadline.

## The one-line pitch

One round, 5-7 players, one impostor. Roles are encrypted notes only the
holder can decrypt. The night kill is a private transfer. Voting is
anonymous transfers with a publicly-computed tally. Payout is a shielded
credit, never a public transfer.

## System components

```
contracts/                  Cairo (Scarb project, Cairo 2024_07 edition)
  src/interfaces.cairo         ISignalEscrow, OpenNoteDeposit, SignalOperation, IERC20
  src/round.cairo               Lobby → Assigned → Night → Vote → Resolved state machine
  src/signal_escrow.cairo       STRK20 invoke helper (tally + payout), IPrivacyInvoke shape
app/                         Next.js frontend, meant to extend the STRK20
                             starter kit (wallet picker, shield, unshield,
                             private transfer) — not yet wired up, see
                             TIMELINE.md day 1
docs/
  ARCHITECTURE.md             mechanic <-> STRK20 primitive mapping, scope cut rationale
  TIMELINE.md                  2-day execution plan, priority order
strk20.json                  Sprint scoring file: mainnet tx hashes, contracts,
                             demo_video, demo_url — REQUIRED, currently empty
```

## Non-negotiable design decisions (don't relitigate these under time pressure)

- **`round.cairo` has zero privacy-pool coupling.** Game state (phase,
  seats, timers) lives in a plain Starknet contract. Only
  `signal_escrow.cairo` talks to the STRK20 pool, via the standard
  `privacy_invoke` path. This keeps the privacy-sensitive surface small
  and auditable — mirrors STRK20's own guidance for DeFi helpers
  (see `docs.starknet.io/build/starknet-privacy/anonymous-defi`).
- **Session keys, not main wallets, sign in-round actions.** A player's
  lobby-join address (which shielded the buy-in) must never be the same
  signer as their `kill()`/`vote()`/`resolve_round()` calls, or the
  "unlinkable" claim in the pitch is false. v1 session keys are
  locally-held burner EOAs generated client-side — not a custom
  account contract. Don't build session-key account abstraction unless
  Phase 2 time exists; a burner keypair is enough to make the claim true.
- **Votes use the open-note pattern**, not confidential notes. The tally
  needs to be publicly computable (that's the RFP requirement), so vote
  amounts are deliberately plaintext-after-fill, matching how STRK20's
  own AMM-swap helpers expose output amounts. Don't try to hide the vote
  count itself — only the sender.
- **`SignalEscrow` holds nothing between calls.** Per STRK20's own helper
  convention (see anonymous-defi.md), it receives tokens for one leg,
  acts, and returns `OpenNoteDeposit[]`. Don't turn it into a persistent
  vault.

## Things that are unverified and need checking against the real SDK

The Cairo in this repo was written against the *documented shape* of
STRK20 invoke helpers (`IVesuLendingHelper` in the public docs), not
against compiled/tested code. Before trusting it:

1. ~~`scarb build` in `contracts/` and fix whatever the compiler flags~~
   ✅ builds clean on scarb/Cairo 2.20.1 (sierra + casm artifacts).
2. Confirm against `starkware-libs/starknet-privacy` source (not just
   docs) that:
   - ~~the phase numbers are current~~ ✅ verified against the
     `packages/privacy` README: 0 SetViewingKey, 1 OpenChannel,
     2 OpenSubchannel, 3 Deposit, 4 UseNote, 5 CreateEncNote/OpenNote,
     6 Withdraw, 7 InvokeExternal.
   - ~~`privacy_invoke`'s actual parameter order / types on mainnet
     match `interfaces.cairo`~~ ✅ verified against the deployed Vesu
     helper's ABI (fetched via `starknet_getClassAt` on mainnet,
     `0x028b...c336`): `privacy_invoke(operation: <helper-specific
     enum>, in_token: ContractAddress, out_token: ContractAddress,
     assets: u256, note_id: felt252) -> Span<OpenNoteDeposit>`, and
     `privacy::objects::OpenNoteDeposit { note_id: felt252, token:
     ContractAddress, amount: u128 }` — exactly what this repo uses.
     `note_id` is a client-supplied felt the pool passes through, so
     overloading it as the candidate seat index in the vote leg is a
     valid encoding (the voter's client action just sets it).
   - ⚠️ still open, lower stakes: end-to-end test on mainnet that the
     pool accepts a helper-defined operation enum with >0 variants
     serialized the same way (`SignalOperation` mirrors
     `LendingOperation`'s unit-variant shape, so this should be
     mechanical).
3. ~~Verify `strk20.json`'s required schema~~ ✅ verified against the
   hackathon repo: `transactions` (≥3 mainnet hashes) and `demo_video`
   required; `contracts`, `demo_url` optional.

## Reference material (read these, don't reinvent)

- Hackathon rules/registry: `github.com/starkience/strk20-hackathon`
- RFP being addressed: `strk20.starknet.io/rfp/social-deduction-game`
- Protocol docs: `docs.starknet.io/build/starknet-privacy/*`
  (`overview`, `notes-and-nullifiers`, `discovery`, `encryption-and-keys`,
  `anonymous-defi`, `glossary` are all directly relevant)
- Hands-on examples: `strk20-by-example.org` (SDK getting-started,
  `helpers/privacy-invoke`, wallet integration, anonymous-airdrop app)
- SDK source: `github.com/starkware-libs/starknet-privacy`
- Starter kit to extend for `app/`: `github.com/Akashneelesh/strk20-starter-kit`
- Reference invoke helper on mainnet (Vesu lending):
  `voyager.online/contract/0x028b49bc7a48b92d06d436d90e889729d7161dfc2fef3f16b674029bf7abc336`

## Commands

```bash
# Cairo
cd contracts && scarb build

# Frontend (once app/ is scaffolded from the starter kit)
cd app && npm install && npm run dev
```

## Judging weights (STRK20 sprint) — keep these in mind when prioritizing

| Weight | Criterion |
|---|---|
| 30% | STRK20 integration depth |
| 30% | Working mainnet product |
| 25% | Innovation |
| 15% | Documentation & open-source quality |

Translation: a contract that compiles and runs one real round on mainnet
with 3 real txs beats a more ambitious contract that never deploys.

## Current status

🚧 Contracts written and **compiling** (scarb 2.20.1), not deployed
anywhere. `app/` scaffolded from the starter kit, not yet wired to the
game contracts. `strk20.json` present but empty. Not yet a git repo /
not on GitHub. Not yet registered in `registry.json` on the hackathon
repo — **do that before anything else**; it needs the public repo URL
and team telegram handle(s), then it's a one-time PR that merges
automatically.

## Style notes for whoever (human or Claude) touches this next

- Keep `docs/ARCHITECTURE.md` in sync if the mechanic changes — it's
  also the doc a judge is most likely to read for "documentation
  quality," so keep it accurate and don't let it drift from the code.
- Prefer editing `strk20.json` and `docs/TIMELINE.md` checkboxes over
  creating new status-tracking files.
- Don't add Phase 2 features (multi-night, task minigames, Secret
  Hitler/Avalon variants, paymaster) unless the Day 2 checklist in
  TIMELINE.md is fully done with time to spare.
