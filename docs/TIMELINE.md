# Signal — Execution timeline

Deadline: **Sept 7, 23:59 UTC**. Judging: 30% integration depth, 30%
working mainnet product, 25% innovation, 15% docs. A compiling contract
with 3 real mainnet txs beats an ambitious one that never deploys.

## Day 0 (done)

- [x] Contracts drafted (`round.cairo`, `signal_escrow.cairo`,
      `interfaces.cairo`)
- [x] `scarb build` green (scarb/Cairo 2.20.1, sierra + casm artifacts)
- [x] Docs: ARCHITECTURE.md, this file
- [x] `strk20.json` skeleton at repo root (schema verified against
      hackathon repo: `transactions` ≥ 3 + `demo_video` required;
      `contracts`, `demo_url` optional)
- [x] Verified pool phase numbers 0/1/2/5/7 against
      starkware-libs/starknet-privacy
- [x] Verified `privacy_invoke` signature + `OpenNoteDeposit` fields
      against the deployed Vesu helper ABI on mainnet (via
      `starknet_getClassAt`) — matches `interfaces.cairo` exactly;
      `note_id` is client-supplied, so the candidate-index overload in
      the vote leg is a valid encoding
- [x] `app/` scaffolded from strk20-starter-kit, `npm install` green
- [ ] **Register in `registry.json`** — PR to
      github.com/starkience/strk20-hackathon with
      `{"repo_url": ..., "telegram": [...]}`. Merges automatically.
      **Blocked on: public GitHub repo URL + telegram handle(s).**

## Day 1 (Sept 6) — make it real

- [ ] Push repo to GitHub, open the registry PR (see above) **first thing**
- [ ] Deploy `SignalRound` + `SignalEscrow` to **mainnet** (declare +
      deploy; record class hashes and addresses in `strk20.json.contracts`)
- [ ] `app/.env.local` with RPC key (`cp .env.example .env.local`)
- [x] Build the game UI: lobby, role reveal, night, vote, resolve/payout,
      one panel per phase, on a local engine that mirrors `round.cairo`
      (`app/src/game/engine.ts`). Session keys and the poseidon commitment
      are real starknet.js values, not stand-ins.
- [x] Bot seats so one person can run a whole round solo — needed for the
      demo video, since there is no networked lobby (`app/src/game/bots.ts`)
- [x] RFP gap audit (table in CLAUDE.md) - 3 of 13 fully met before this pass
- [x] Player bounds raised to the RFP's 5-15; added a ~15-minute "Table" pace
- [x] Variants as contract configuration: `round.cairo` now takes
      `min/max/hidden_count` and resolves over a hidden *team*, with
      Among Us / One Night Werewolf / Secret Hitler / Avalon / Clocktower
      presets. Verified a 2-werewolf round end to end.
- [!] Encrypted role notes, private night transfers, anonymous vote legs and
      paymaster remain BLOCKED on `@starkware-libs/starknet-privacy-sdk`
      (GitHub Packages auth) + proving service + indexer URLs
- [x] Cross-device play via an in-memory relay (room codes) — requested, but
      note it earns nothing against the judging criteria and the mainnet
      deploy below is still the highest-value remaining item
- [x] Crewmate sprites on every screen + an ejection scene on resolve, so the
      non-deck phases stop looking like forms (`ship/Crewmate.tsx`,
      `ship/Ejection.tsx`)
- [x] 2D deck for the night phase: rooms + corridors, fog of war, movement,
      three task minigames, sightings surfaced at the vote
      (`app/src/game/ship.ts`, `app/src/app/play/ship/`). NOTE: this was a
      listed Phase-2 cut, pulled forward on request. Nothing is deployed yet —
      mainnet deploy is still the highest-value remaining item (30% of scoring).
- [ ] Swap the engine for chain calls in `app/src/game/store.ts`: `join`
      (payout-note creation via SDK phase 5), `assign_roles`, `start_night`
- [ ] Wire role-note send (host tool) + role decrypt view to real
      encrypted notes (currently roles are held in local state)

## Day 2 (Sept 7) — run a round, ship the proof

- [ ] Wire night-kill (private transfer) + report button (session key)
- [ ] Wire vote screen: `privacy_invoke` Vote leg via SDK, live tally
- [ ] Wire resolve + payout button (host)
- [ ] **Run one full round on mainnet with real players** — capture ≥3 tx
      hashes that touch the pool (shield, vote invoke, payout invoke)
- [ ] Fill `strk20.json`: transactions, contracts, demo_url
- [ ] Record 3-minute demo video, add link to `strk20.json.demo_video`
- [ ] README pass: quickstart, addresses, screenshots
- [ ] Deploy `app/` (Vercel) → `demo_url`

## Cut line

If Day 2 runs long, in priority order keep: mainnet txs + strk20.json →
demo video → deployed frontend. Drop polish, not proof. No Phase 2
features (multi-night, minigames, variants, paymaster) unless everything
above is checked with time to spare.
