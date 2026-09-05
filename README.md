# Signal

**A hidden-role elimination game on STRK20, Starknet's privacy pool.**

One round. 5–7 players. One impostor. Roles are encrypted notes only the
holder can decrypt. The night kill is a private transfer. Voting is
anonymous transfers with a publicly computed tally. Payout is a shielded
credit — never a public transfer.

Built for the STRK20 Private Sprint (RFP-09: *on-chain Among Us with
provably fair roles and anonymous votes*).

## How it works, in one breath

Players shield a buy-in into the STRK20 pool and join a lobby with a
**burner session key** (so in-round actions never link to the funding
wallet) and a pre-created payout note. The host commits to the impostor
seat with a Poseidon hash and deals roles as encrypted 0-value notes. At
night the impostor privately transfers a kill note to a victim, who
self-reports. Everyone votes by running `privacy_invoke` legs through
`SignalEscrow` — sender hidden in the pool, tally public on `SignalRound`.
After the reveal (checked against the commitment — the host can't cheat),
the pot flows back through the escrow into the winners' shielded notes.

Full design: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) ·
Plan: [`docs/TIMELINE.md`](./docs/TIMELINE.md) ·
Contributor notes: [`CLAUDE.md`](./CLAUDE.md)

## Layout

```
contracts/   Cairo 2 (Scarb) — SignalRound state machine + SignalEscrow
             STRK20 invoke helper. Round has zero pool coupling; the
             escrow is the only privacy-facing surface.
app/         Next.js frontend, extending the STRK20 starter kit
docs/        Architecture + timeline
strk20.json  Sprint scoring file (mainnet tx hashes, demo links)
```

## Build & run

```bash
# Contracts (scarb 2.20.x)
cd contracts && scarb build

# Frontend
cd app && npm install
cp .env.example .env.local   # add your RPC key
npm run dev                  # http://localhost:3000
```

## Status

Contracts compile (sierra + casm). Not yet deployed; `strk20.json` not
yet filled. See `docs/TIMELINE.md` for the live checklist and
`CLAUDE.md` for the list of SDK-shape assumptions still to verify before
mainnet.
