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
app/                         Next.js frontend on the STRK20 starter kit
  src/game/types.ts            phases/seats/tallies, mirroring round.cairo
  src/game/engine.ts           pure state machine; every guard is a Cairo assert
  src/game/crypto.ts           burner session keys + poseidon role commitment
  src/game/store.ts            zustand; the seam the chain calls replace
  src/game/bots.ts             bot seats (pure decision fns) + useBotDriver
  src/game/ship.ts             rooms, movement, tasks, sightings — NO on-chain
                               counterpart; kept out of GameState on purpose
  src/app/play/ship/           2D deck, crewmate sprite, ejection scene,
                               and the three task minigames
  src/server/rooms.ts          in-memory relay for cross-device play
  src/app/api/rooms/           POST create room, GET view / POST action
  src/game/online.ts           client transport; useRoomSync.ts polls
  src/app/play/                the game surface, one panel per phase
                             Landing page (/) is still the starter kit.
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

## RFP coverage (audited 2026-09-06 against the code, not the docs)

Keep this honest — it is the first thing to re-check before claiming anything
in a submission or a demo.

| RFP requirement | Status | Where |
|---|---|---|
| Lobby management contract | written, **not deployed** | `round.cairo` |
| Turn progression | done | Lobby -> Assigned -> Night -> Vote -> Resolved |
| Game resolution | done | `resolve_round`, strict-argmax ejection |
| 5-15 players | done | configurable per variant, `CEIL_PLAYERS = 15` |
| ~15-minute rounds | done | "Table" pace = 10 min night + 4 min vote |
| Multiple variants as contract configuration | done (skeleton) | `variants.ts`, constructor takes `min/max/hidden_count` |
| Role assignment from a committed seed | **partial** | `poseidon(hidden_seats…, salt)` commit-reveal: binding, **not unbiased** — the host alone draws it. No VRF, no multi-party. |
| Session keys, scoped per game | **partial** | real Stark keypairs; `join` asserts `session_key != caller`; but nothing is signed on-chain yet |
| Public tally, unattributable votes | **design only** | `handle_vote` is escrow-only and public by construction; never deployed or called |
| Roles as encrypted STRK20 notes | **not built** | roles live in server/local state |
| Private transfers for night actions | **simulated** | `privateKill()` writes a log line; no pool transfer |
| Anonymous channel transfers for voting | **not wired** | `signal_escrow.cairo` exists; nothing calls it |
| Paymaster (zero gas signatures) | **not built** | no implementation |

**What blocks the remaining four.** They all need
`@starkware-libs/starknet-privacy-sdk`, which is published on **GitHub
Packages and requires authentication**, plus a proving-service URL, an indexer
URL and a viewing key. Those are external credentials and services, not code.
Until they exist the app can only simulate the pool legs, and the honest
framing is that the Cairo is written against the documented `privacy_invoke`
shape while the client half is unbuilt.

**Variants: be precise about the claim.** The generalisation is the *shared
skeleton* — hidden minority, private night action, anonymous vote — which is
exactly what the RFP says generalises. Each variant runs its hidden-role
elimination round from one contract configuration. It does **not** implement
each game's full ruleset (Secret Hitler's policy deck, Avalon's quests,
Clocktower's characters). Don't let that blur in a demo.

## Toolchain note

Scarb is **not** on PATH. A self-contained 2.20.1 lives at
`C:/Users/sndpb/.local/tools/scarb-v2.20.1-x86_64-pc-windows-msvc/bin/scarb.exe`
(installed 2026-09-06, no PATH changes). Use it before touching Cairo —
editing contracts without a compiler is how you ship a broken artifact.

Deployment does **not** need Scarb or sncast: `app/scripts/deploy.mjs` drives
starknet.js against the committed sierra/casm in `contracts/target/dev`.
`--dry-run` prints class hashes and the plan without any key.

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
anywhere.

**Frontend is built and playable** at `/play` — a full round (lobby →
roles → night → vote → resolve → payout) runs end to end locally, driven
by `src/game/engine.ts`. **Bot seats** ("Fill to 5 with bots") let one
person play, so a demo needs no second device: bots open their own role
notes, walk the deck, do tasks, kill and vote on a timer. A bot seat is an ordinary
seat with its own burner key — the contract cannot tell it from a person.
Bots bandwagon onto whoever is accumulating votes, and the last voter
breaks a tie for first, because a tie ejects nobody and hands the impostor
the round; without that, 2 of 3 test rounds deadlocked. Crew win ~1/3 of the time.

**Every screen uses crewmate characters** (`ship/Crewmate.tsx`) — one inline
SVG, recoloured per seat, no sprite sheet and no image requests. Dead seats
lie on their side with an X'd visor. That component replaced the seat-card
text grids on the lobby, role, night and vote screens, which were the reason
the game still read as a form outside the deck.

**Cross-device play runs through an in-memory relay** (`src/server/rooms.ts`),
added on request. Be clear-eyed about it: the real shared state for this game
is meant to be `SignalRound` on Starknet, and this earns nothing in the
judging — it exists so two people on two machines can play before the
contracts are deployed. Two properties it does get right:

- **The server runs the engine.** Clients post *actions*, never state.
  `engine.ts`/`ship.ts` are pure and React-free so they import straight into
  the route, and every client agrees by construction. Seat-bound actions take
  their seat from the server's claim table, never from the request, so a
  client cannot vote as somebody else.
- **State is redacted per viewer** (`viewFor`): you receive only your own
  role, only your own burner private key, and only the crewmates in your own
  room. Verified in a two-context test — the second player's own API response
  showed `Sandip:hidden, Friend:CREW, Nova:hidden…`. Without this the impostor
  would be readable from the network tab.

Rooms live in module memory (kept across hot reloads via `globalThis`), so
this needs ONE long-lived process — it will not work across serverless
instances on Vercel. Bots are ticked lazily off client polls rather than a
`setInterval`, so abandoned rooms stop dead. Online mode pins the viewer to
your own seat and the panels advance on progress (`roleSeen`, `hasVoted`)
rather than on the viewer clearing — otherwise your own role card never
clears and "Start night" never appears.

**Timer-gated host actions stay disabled until they would succeed.**
`resolve_round` asserts `now > vote_deadline` and `skip_night` asserts
`now > night_deadline`; both buttons now count down ("Reveal in 12s") and
only enable once the deadline passes. Previously they were clickable early
and fired a call that could only revert, which surfaced a red
`reverted: vote still open` — a correct contract guard rendered as if the
app had broken. The engine guard is still there; the UI just stops you
reaching it. See `useDeadline` in `app/src/app/play/ui.tsx`.

**Resolve plays an ejection scene** (`ship/Ejection.tsx`): parallax starfield
(two repeating gradients, no DOM per star), the ejected crewmate tumbling out
of frame, then the verdict in three timed beats. The commitment/salt proof is
still there but folded under a "Verify this round" disclosure — it is
reference material, not the story. Honours `prefers-reduced-motion`.

**The night is a 2D deck** (`/play`, night phase): a 3×2 room grid with
corridors, fog of war (you see only who is in *your* room), a per-player
task list, and three hand-rolled minigames — wire matching, a keypad, and
a timing gauge. No canvas, no game library; the only per-frame animation is
the gauge needle inside its own modal.

**Players spawn scattered, not all in one room.** With a shared spawn every
early sighting was "everyone in the Cafeteria" — true, but worthless as
evidence, because seeing someone tells you nothing if you saw everyone.
Placement is random with a cap of two per room (rejection-sampled): a
round-robin deal spreads perfectly evenly but, with 6 rooms and 5-6 players,
*guarantees* everyone starts alone, so nobody ever opens with an alibi.
Measured over 8000 draws at 5 players: a pair in 88% of rounds, never a
3-stack, room usage even to within 0.4%. Co-location at spawn is recorded as
a sighting, since you obviously see whoever you started next to.

**Tasks deliberately do not decide the round.** In Among Us finishing tasks
is a crew win condition; here the winner is whatever `resolve_round`
computes from the vote, and a second win condition would put the UI and the
contract into disagreement. Tasks instead generate *evidence*: walking
around to do them produces mutual sightings, and each player is shown what
they personally witnessed ("What you saw: Juno in Electrical") on their
vote screen. That is what the crew argue from — the vote still settles it.

The impostor — human or bot — may only kill someone standing in the same
room. A bot impostor additionally cannot kill until a third of the night has
elapsed: without that gate it killed on the first beat it shared a room with
anyone, ending the night in ~20s with no tasks done and no sightings to
argue from. The engine reimplements `round.cairo`'s rules
exactly and throws that contract's own assert strings, so an illegal
action reads like a reverted tx; verified by playing a scripted round in
a browser, including that resolving before the deadline is rejected with
`vote still open`. The role commitment and the burner session keys are
**real** (starknet.js poseidon + Stark keypairs), so those values are
already what the deployed contract will accept.

What is *not* wired yet: nothing calls the chain. `store.ts` is the only
place that would change — every transition already goes through it.
Wallet addresses and payout-note ids are locally-generated placeholders,
and the round is pass-the-device (one browser) rather than networked; a
shared lobby needs an indexer or relay for the encrypted notes, which is
out of scope for the sprint.

`strk20.json` present but empty. Local git repo, **not** on GitHub. Not
yet registered in `registry.json` on the hackathon repo — **do that
before anything else**; it needs the public repo URL and team telegram
handle(s), then it's a one-time PR that merges automatically.

## Style notes for whoever (human or Claude) touches this next

- Keep `docs/ARCHITECTURE.md` in sync if the mechanic changes — it's
  also the doc a judge is most likely to read for "documentation
  quality," so keep it accurate and don't let it drift from the code.
- Prefer editing `strk20.json` and `docs/TIMELINE.md` checkboxes over
  creating new status-tracking files.
- Don't add Phase 2 features (multi-night, task minigames, Secret
  Hitler/Avalon variants, paymaster) unless the Day 2 checklist in
  TIMELINE.md is fully done with time to spare.
