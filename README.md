# Signal

**A hidden-role elimination game on STRK20, Starknet's note-based privacy pool.**

One round. 5–15 players. A hidden minority. Roles are committed on-chain from a
seed neither the host nor any player controls alone. The vote is publicly
tallied but individually unattributable. The payout is a shielded credit, never
a public transfer.

Built for the **STRK20 Private Sprint**, RFP-09: *on-chain Among Us with
provably fair roles and anonymous votes*.

- 🎮 **Play it live:** https://signal-strk20.onrender.com
- ⛓️ **Live on Starknet Sepolia** — contracts deployed, seats taken, ballots and votes on-chain (addresses below)
- 📜 **Design:** [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) · **Deploy:** [`docs/DEPLOY.md`](./docs/DEPLOY.md)

---

## The one-line pitch

One impostor hides among the crew. Roles are **sealed commitments**, the night
kill is a **private transfer**, votes are **anonymous pool legs with a public
tally**, and the payout comes back **shielded**. Everything *social* is public;
everything *identifying* is hidden inside the pool.

## How Signal uses STRK20

The whole point of the project is that each game mechanic maps onto a real
STRK20 privacy primitive, not a bespoke crypto scheme.

| Game mechanic | STRK20 primitive | State today |
|---|---|---|
| Provably-fair role draw | `poseidon` commit–reveal over a multi-party seed | **Live on-chain** — committed in `assign_roles`, revealed in `resolve_round` |
| In-round identity | **Session keys** (per-seat burner accounts, browser-held) | **Live on-chain** — registered at `join`, sign their own actions |
| Anonymous vote | `privacy_invoke` open-note leg → `SignalEscrow` | **Live** — cast from a privacy wallet; sender hidden, tally public |
| Buy-in / pot | **Shield** (deposit → note), pot as an open note | **Live** — shield works via the wallet; stakes accumulate in the pot note |
| Round settlement | `resolve_round` reveal → winners set on-chain | **Live on-chain** — provably-fair reveal, `is_winner` readable |
| Roles as encrypted notes | 0-value confidential note per player | Contract-ready; needs the SDK's note encryption *(see Roadmap)* |
| Night kill as private transfer | note transfer to the victim | Contract-ready; needs a registered recipient + proving *(see Roadmap)* |
| Payout token split | escrow returns `OpenNoteDeposit[]` | Contract written & deployed; the open-note spend needs SDK-level note handling *(see Roadmap)* |

**The design rule that makes this auditable:** `round.cairo` has **zero**
privacy-pool coupling — game state (phase, seats, tally) is ordinary public
Starknet state. Only `signal_escrow.cairo` ever touches the pool, via the
standard `privacy_invoke` path. The privacy-sensitive surface is one small,
stateless contract.

## Live on Sepolia

| Contract | Address |
|---|---|
| `SignalRound` | [`0x252ecaea…6756d`](https://sepolia.voyager.online/contract/0x252ecaea30b870d8ab30075ac7eb4b6e29572dbd0c0464be33396497026756d) |
| `SignalEscrow` | [`0x7c12b841…11ad8`](https://sepolia.voyager.online/contract/0x7c12b8419a68a412f9397e16e23faf3219b0a547e70e141fff87a295c311ad8) |
| STRK20 pool (testnet) | [`0x0254a6b2…e0d91`](https://sepolia.voyager.online/contract/0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91) |

Every deploy, join, ballot and vote transaction hash is recorded in
[`strk20.json`](./strk20.json). Six seats are taken on the live round (four
scripted players plus a human wallet); the vote and settlement legs run from the
browser against these contracts.

## Provably fair roles

This is the part worth reading the code for.

The naive version — the host picks the hidden team and posts
`poseidon(team, salt)` — is *binding* but not *unbiased*. The host can still aim
the draw at whoever they like. Signal removes that:

1. **Before anyone joins**, the host commits `poseidon(host_seed)` in the
   constructor. You cannot aim a seed at players who do not exist yet.
2. **Each player contributes entropy** at `join`, which the host could not
   predict when committing.
3. **At `resolve_round`** the host reveals only `host_seed`. The contract checks
   it against the commitment, mixes it with every player's entropy, and
   **derives the hidden team itself** — the host never names it.

```
combined     = poseidon(host_seed, entropy_0, …, entropy_n-1)
hidden_seats = derive_hidden(combined, players, hidden_count)   // ascending
```

Neither side steers the draw alone, and anyone can recompute it from public
chain state plus the revealed seed. `derive_hidden` is a partial Fisher-Yates
with swap-remove, implemented **twice** — in Cairo and TypeScript — kept honest
by `tests.cairo::matches_the_typescript_mirror`, which asserts the exact seat
lists the TS mirror produces. A drift in poseidon padding or felt→u256
conversion fails a test instead of silently making every round unopenable.

## Session keys, done honestly

A player's lobby wallet shields the buy-in; a **separate per-seat session key**
signs their in-round actions. If those were the same signer, the "unlinkable"
claim would be false — so `join` rejects them being equal, on-chain.

Because a bare keypair cannot *send* a Starknet transaction, `join` registers
the session key's deterministic **account address**, and the **browser deploys
that account and signs its own actions** (e.g. opening the emergency meeting).
No player key is ever held server-side. The one thing a fresh account can't
self-provide is gas, so a **guarded faucet** tops up an address *only* after
confirming it holds a seat on-chain — the server pays gas, never signs for a
player. A full paymaster removes even the faucet (see Roadmap).

## Configuration, not variants

`SignalRound`'s constructor takes `min_players`, `max_players`, `hidden_count`
and `seer_count`, so the host tunes the table without a fork — and another
hidden-role game is a different constructor call, not a new contract.

An earlier version advertised five named variants. That was dropped on purpose:
three were byte-identical configs differing only in vocabulary, and two (Avalon,
Secret Hitler) have **no night kill at all**, so modelling them as "hidden team
kills at night" misrepresented them. Claiming one game that is actually
implemented beats claiming five where two are wrong. The generalisation the RFP
asks about is real and in the contract — it is simply not dressed up as menu
entries.

## Play it

```bash
cd app
npm install
npm run dev          # http://localhost:3000
```

No API key or wallet needed for local play — `/play` runs entirely on the
in-browser engine, which mirrors `round.cairo` assert-for-assert.

- **Solo** — set the table, add your name, **Fill with bots**. Bots walk the
  deck, do tasks, kill and vote on their own; a bot seer spends its check and
  votes what it learns.
- **Same room** — one screen; each player taps their crewmate to reveal their
  role behind a cover screen.
- **Separate devices** — **Host a room** for a 4-letter code. The server runs
  the engine and redacts per viewer: you receive only your own role, your own
  burner key, and only the crewmates in your own room.
- **On-chain** — connect a Starknet privacy wallet (Ready/Xverse on Sepolia),
  **take your seat on chain**, and the vote screen can cast a **real pool vote
  leg** and **settle the round on-chain**.

The night is a 3×2 deck with corridors and fog of war — you see only who is in
your room. Walking around to do tasks produces **sightings**, shown on your vote
screen: that is the evidence the crew argue from. Tasks are a second crew win
condition, and the contract counts them itself (only seats the revealed roles
say are crew — so an impostor calling `submit_task` achieves nothing).

## Build and test

```bash
# Contracts (Scarb 2.20.1)
cd contracts
scarb build
scarb cairo-test          # 65 tests pass

# App
cd app
npm run build             # type-checks + production build
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

It declares and deploys both contracts, links them with `set_escrow`, and writes
the hashes, addresses and class hashes into `strk20.json`. **Keep the
`host_seed` it prints** — `resolve_round` cannot open a round without it, and it
is not recoverable from the chain.

`scripts/players.mjs` provisions and seats funded test players; `docs/DEPLOY.md`
covers hosting the relay on Render.

## Roadmap — where this goes next

Signal is deliberately honest about the line between what is live and what the
STRK20 infrastructure still gates. The remaining work is not redesign; it is
wiring against services that require credentials the sprint did not include.

**Completing the pool integration** *(needs the STRK20 SDK + a proving service,
indexer and viewing keys)*
- **Encrypted role notes** — deliver each role as a 0-value confidential note
  only its holder can decrypt, replacing the redacted-server-state stand-in.
- **Private night kill** — the kill becomes a real note transfer to the victim,
  witnessed by no one, self-reported with the victim's session key.
- **Escrow payout split** — the deployed `handle_payout_leg` already computes
  the shielded split; wiring the pot open-note spend credits each winner's note
  on-chain.

**Removing the last server touch-point**
- **Paymaster / account abstraction** for session keys, so a seat's burner
  account is sponsored rather than gas-funded by a faucet — the RFP's zero-gas
  signatures.

**Reach**
- **Mainnet** deployment against the live pool.
- **Multi-round** play and genuinely distinct hidden-role games (each a new
  constructor config with its own night action), not just re-skins.

**Beyond the game.** The three primitives Signal composes are general:

- *Committed, multi-party fair assignment* → verifiable lotteries, randomized
  audits, jury/committee selection where no organizer can rig the draw.
- *Anonymous-but-publicly-tallied voting* → DAO governance and sealed decisions
  where the count must be trustless but the ballot must be unlinkable.
- *Shielded settlement* → sealed-bid auctions and private payouts that never
  expose who received what on a public ledger.

A social-deduction game is a demanding, adversarial test-bed for exactly these —
which is why the RFP frames it as a proving ground, and why the same escrow
shape would drop into a governance or auction dapp with a different operation
enum.

## Layout

```
contracts/src/
  round.cairo          state machine + derive_hidden; zero pool coupling
  signal_escrow.cairo  the only pool-facing surface; stateless between calls
  tests.cairo          65 unit tests
app/src/
  game/                engine (mirrors the contract), ship, bots, crypto, chain
  server/rooms.ts      cross-device relay, redacted per viewer
  app/api/chain/       advance / faucet / resolve — the host + gas server routes
  app/play/            the game surface, one panel per phase
app/scripts/           deploy.mjs, players.mjs — starknet.js, no Scarb needed
strk20.json            sprint scoring file (tx hashes, contracts, demo links)
```

Design notes: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) ·
Deploy guide: [`docs/DEPLOY.md`](./docs/DEPLOY.md) ·
Working notes: [`CLAUDE.md`](./CLAUDE.md)
