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
| Cairo contracts (`SignalRound`, `SignalEscrow`) | compile; 62 unit tests pass |
| Provably-fair role assignment from a multi-party seed | **done, on-chain** |
| Night actions — impostor kills **and seer checks** | **done** (simulated, see below) |
| Crew win by tasks, counted on-chain | **done** |
| Bodies on the deck — find one to call the meeting | **done** |
| All four win conditions, checked by the contract | **done** |
| Turn progression + resolution | **done, on-chain** |
| Host-tweakable settings as contract configuration | **done** |
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

Every special role comes off that one draw. `draw_seats` returns picks in draw
order and `derive_hidden` is just `sort(draw_seats(…))`, so drawing
`hidden_count + seer_count` seats *continues the same Fisher-Yates sequence* —
the first `hidden_count` picks are byte-identical to drawing the impostors
alone. Turning the seer on therefore cannot re-roll who the impostors are.
`contracts/src/tests.cairo::drawing_a_seer_does_not_move_the_impostors` asserts
exactly that, and `the_seer_split_matches_the_typescript_mirror` pins both
halves to the literal seats the TypeScript produces.

Neither side steers the draw alone, and anyone can recompute it from public
chain state plus the revealed seed.

`derive_hidden` is a partial Fisher-Yates with swap-remove, implemented twice —
in Cairo and in TypeScript — kept honest by a test:
`contracts/src/tests.cairo::matches_the_typescript_mirror` asserts the exact
seat lists the TS mirror produces. A drift in poseidon padding or felt→u256
conversion fails a test instead of silently making every round unopenable.

## The seer

The RFP names night actions as *"impostor kills, seer checks"*, so there is an
investigative role — off by default, since vanilla Among Us has none (the
closest thing is the Sheriff from The Other Roles mod).

A seer is drawn from the same committed seed as the impostors, never picked by
the host. Once per night they may check one player standing **in the same
room** and learn whether that player is an impostor. Co-location is deliberate:
it costs them the tasks they did not do instead, and it keeps the seer a
presence on the deck rather than a lobby-wide oracle.

The result is private the same way a role is. `Seat.checks` is redacted for
every viewer but its owner — and so is `checkedRound`, because a non-negative
value there would name the seer as surely as the role field would. Checks are
cumulative across rounds: a seer who cleared someone in round 1 still has it in
round 3, and the one-per-night limit is enforced against the round number
rather than by wiping what they learned.

## Configuration, not variants

`SignalRound`'s constructor takes `min_players`, `max_players`, `hidden_count`
and `seer_count`, so the host tunes the table without a fork.

This used to advertise five variants — Among Us, One Night Werewolf, Secret
Hitler, Avalon, Blood on the Clocktower. That was dropped on purpose. Measured,
three of the five were byte-identical configurations differing only in
vocabulary, and worse, Avalon and Secret Hitler have **no night kill at all**
(Avalon is quests, Secret Hitler is policy cards) — so modelling them as
"hidden team kills someone at night" misrepresented the games they were named
after. Claiming one game that is actually implemented beats claiming five where
two are wrong.

The generalisation the RFP asks about is still real and still in the contract:
another hidden-role game is a different constructor call, not a fork. It is
simply not dressed up as five menu entries.

## Play it

```bash
cd app
npm install
npm run dev          # http://localhost:3000/play
```

No API key or wallet needed — `/play` runs entirely locally.

**Solo** — set the table, hit **New round**, add your name, **Fill with bots**.
Bots walk the deck, do tasks, kill and vote on their own — and a bot that draws
the seer spends its check and votes what it learned, so the role is not dead
weight in a solo game.

**Same room** — everyone shares one screen; each player taps their own crewmate
to reveal their role behind a cover screen.

**Separate devices** — **Host a room** for a 4-letter code; others join from
their own machine. The server runs the engine and redacts per viewer: you
receive only your own role, your own burner key, and only the crewmates
standing in your own room.

> **Sepolia.** The docs publish a testnet privacy pool "for SDK and integration
> testing" at `0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91`,
> verified live, and `deploy.mjs` uses it — so a Sepolia run rehearses all five
> transactions rather than only the two that never touch the pool.

> ⚠️ Rooms live in process memory, so cross-device play needs **one long-lived
> process**. It will not work on Vercel, where requests hit different
> instances. Use Render/Railway/Fly, or tunnel to your machine.

### The game

A 3×2 deck with corridors and fog of war — you see only who is in your room.
Three task minigames (wire matching, keypad, timing gauge). Walking around to
do tasks is what produces **sightings**, and your vote screen shows what you
personally witnessed. That is the evidence the crew argue from.

Tasks are the crew's **second win condition**, and the contract counts them
itself — which is what stops the UI and the chain disagreeing.

Each completion is a `submit_task()` signed by that seat's burner. The contract
cannot verify a minigame, and does not pretend to; what it enforces is the part
that makes the tally honest. No seat may claim more than its own allotment, and
at `resolve_round` — the first moment roles exist — only seats the derived roles
say are crew are counted. So an impostor calling `submit_task` achieves nothing,
which is precisely why the entrypoint does not need to know who is who.

Finishing the list outranks impostor parity: the crew completed the objective
the game sets them, and an impostor who allowed that has lost on the count.
A crew win pays **every crewmate**, including the dead — the pot is a team
credit, not a survivor bonus.

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
  tests.cairo          62 unit tests
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
