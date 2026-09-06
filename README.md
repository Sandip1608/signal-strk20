# Signal

**A hidden-role elimination game on STRK20, Starknet's privacy pool.**

One round. 5–15 players. A hidden minority. Roles are committed on-chain from a
seed neither the host nor any player controls alone. The vote is publicly
tallied but individually unattributable. The payout is a shielded credit, never
a public transfer.

Built for the STRK20 Private Sprint, RFP-09: *on-chain Among Us with provably
fair roles and anonymous votes*.

---

## What actually works today

Stated up front, because a hidden-role game is easy to *describe* and hard to
prove.

| | Status |
|---|---|
| Cairo contracts (`SignalRound`, `SignalEscrow`) | compile; 14 unit tests pass |
| Provably-fair role assignment from a multi-party seed | **done, on-chain** |
| Turn progression + resolution | **done, on-chain** |
| Variants as contract configuration | **done** — 5 presets |
| Playable game (2D deck, tasks, voting, ejection) | **done** |
| Cross-device play | **done**, via a relay (caveat below) |
| Deployment to Starknet | **not yet** |
| Roles as encrypted STRK20 notes | **not built** — simulated locally |
| Private transfers for night actions | **not built** — simulated locally |
| Anonymous vote legs via `privacy_invoke` | Cairo written, **not wired** |
| Paymaster | **not built** |

The four unbuilt items all need `@starkware-libs/starknet-privacy-sdk`, which
is published on GitHub Packages behind authentication and additionally requires
a proving-service URL, an indexer URL and a viewing key. The Cairo is written
against the documented `privacy_invoke` shape; the client half is not.

## Provably fair roles

This is the part worth reading the code for.

The naive version — the host picks the hidden team and posts
`poseidon(team, salt)` — is *binding* but not *unbiased*. The host can still
aim the draw at whoever they like. Signal removes that:

1. **Before anyone joins**, the host commits `poseidon(host_seed)` in the
   constructor. You cannot aim a seed at players who do not exist yet.
2. **Each player contributes entropy** at `join`, which the host could not
   predict when committing.
3. **At `resolve_round`** the host reveals only `host_seed`. The contract
   checks it against the commitment, mixes it with every player's entropy, and
   **derives the hidden team itself** — the host never names it.

```
combined     = poseidon(host_seed, entropy_0, …, entropy_n-1)
hidden_seats = derive_hidden(combined, players, hidden_count)   // ascending
```

Neither side steers the draw alone, and anyone can recompute it from public
chain state plus the revealed seed.

`derive_hidden` is a partial Fisher-Yates with swap-remove, implemented twice —
in Cairo and in TypeScript — kept honest by a test:
`contracts/src/tests.cairo::matches_the_typescript_mirror` asserts the exact
seat lists the TS mirror produces. A drift in poseidon padding or felt→u256
conversion fails a test instead of silently making every round unopenable.

## Variants, as contract configuration

`SignalRound`'s constructor takes `min_players`, `max_players` and
`hidden_count`, so one contract covers the family:

| Variant | Players | Hidden |
|---|---|---|
| Among Us | 5–15 | 1 impostor |
| One Night Werewolf | 5–10 | 2 werewolves |
| Secret Hitler | 5–10 | 2 fascists |
| Avalon | 5–10 | 2 minions |
| Blood on the Clocktower | 7–15 | 3 evil |

**Be precise about this claim.** What generalises is the shared skeleton —
hidden minority, private night action, anonymous vote — which is exactly what
the RFP identifies as the common core. Each variant plays its hidden-role
elimination round. It does **not** implement Secret Hitler's policy deck,
Avalon's quests or Clocktower's characters.

## Play it

```bash
cd app
npm install
npm run dev          # http://localhost:3000/play
```

No API key or wallet needed — `/play` runs entirely locally.

**Solo** — pick a variant, hit **New round**, add your name, **Fill with bots**.
Bots walk the deck, do tasks, kill and vote on their own.

**Same room** — everyone shares one screen; each player taps their own crewmate
to reveal their role behind a cover screen.

**Separate devices** — **Host a room** for a 4-letter code; others join from
their own machine. The server runs the engine and redacts per viewer: you
receive only your own role, your own burner key, and only the crewmates
standing in your own room.

> ⚠️ Rooms live in process memory, so cross-device play needs **one long-lived
> process**. It will not work on Vercel, where requests hit different
> instances. Use Render/Railway/Fly, or tunnel to your machine.

### The game

A 3×2 deck with corridors and fog of war — you see only who is in your room.
Three task minigames (wire matching, keypad, timing gauge). Walking around to
do tasks is what produces **sightings**, and your vote screen shows what you
personally witnessed. That is the evidence the crew argue from.

Tasks deliberately **do not** decide the round. The winner is whatever
`resolve_round` computes from the vote; a second win condition would put the UI
and the contract into disagreement.

## Build and test

```bash
# Contracts (Scarb 2.20.1)
cd contracts
scarb build
scarb cairo-test          # 14 tests

# App
cd app
npx tsc --noEmit
npm run build
```

## Deploy

No Scarb or `sncast` needed — the script drives `starknet.js` against the
committed sierra/casm artifacts.

```bash
cd app
node scripts/deploy.mjs --dry-run       # class hashes + plan, no keys

# app/.env.deploy (gitignored)
#   STARKNET_NETWORK=sepolia            # or mainnet
#   STARKNET_ACCOUNT_ADDRESS=0x...
#   STARKNET_PRIVATE_KEY=0x...
node scripts/deploy.mjs
```

It declares and deploys both contracts, links them with `set_escrow`, and
writes the tx hashes, addresses and class hashes into `strk20.json`.

**Keep the `host_seed` it prints.** `resolve_round` cannot open a round without
it, and it is not recoverable from the chain.

No Sepolia pool address is published, so a testnet run deploys `SignalRound`
only — the half with zero privacy-pool coupling. Pass `POOL_ADDRESS=0x…` to
include `SignalEscrow`.

## Layout

```
contracts/src/
  round.cairo          state machine + derive_hidden; zero pool coupling
  signal_escrow.cairo  the only pool-facing surface; stateless between calls
  tests.cairo          14 unit tests
app/src/
  game/                engine (mirrors the contract), ship, bots, crypto
  server/rooms.ts      cross-device relay, redacted per viewer
  app/play/            the game surface
app/scripts/deploy.mjs declare + deploy via starknet.js
strk20.json            sprint scoring file (tx hashes, demo links)
```

`round.cairo` has **no** privacy-pool imports by design — game state is
ordinary public Starknet state, and `SignalEscrow` is the only contract that
touches the pool. That keeps the privacy-sensitive surface small enough to
audit.

Design notes: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) ·
Plan: [`docs/TIMELINE.md`](./docs/TIMELINE.md) ·
Working notes: [`CLAUDE.md`](./CLAUDE.md)
