/**
 * Pure game engine mirroring `contracts/src/round.cairo`.
 *
 * Every guard here corresponds 1:1 to a Cairo `assert`, and throws that
 * assert's exact message ('not in lobby', 'need 5+ players', …). The point is
 * that a player hitting an illegal action locally sees the same failure they
 * would get from the chain, and that swapping this module for real contract
 * calls (TIMELINE.md day 1–2) cannot silently change the rules.
 *
 * Deliberately free of React, wallet and network concerns so the state machine
 * can be reasoned about — and tested — on its own.
 */

import {
  CEIL_PLAYERS,
  FLOOR_PLAYERS,
  NO_SEAT,
  Phase,
  VOTE_WEIGHT,
  type GameState,
  type LogEntry,
  type PhaseValue,
  type Seat,
} from "./types";

/** Mirrors a Cairo `assert(cond, 'msg')`. */
export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

function require_(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new ContractError(msg);
}

function log(state: GameState, entry: Omit<LogEntry, "at">): GameState {
  return { ...state, log: [...state.log, { at: Date.now(), ...entry }] };
}

export function createGame(opts: {
  host: string;
  nightDurationSecs: number;
  voteDurationSecs: number;
  variantKey?: string;
  minPlayers?: number;
  maxPlayers?: number;
  hiddenCount?: number;
  seedCommitment?: string;
}): GameState {
  require_(opts.host.length > 0, "host required");

  const minPlayers = opts.minPlayers ?? 5;
  const maxPlayers = opts.maxPlayers ?? 15;
  const hiddenCount = opts.hiddenCount ?? 1;

  // Mirrors the Cairo constructor's guards exactly.
  require_(minPlayers >= FLOOR_PLAYERS, "min too small");
  require_(maxPlayers <= CEIL_PLAYERS, "max too large");
  require_(minPlayers <= maxPlayers, "min above max");
  require_(hiddenCount >= 1, "need a hidden team");
  require_(hiddenCount * 2 < minPlayers, "hidden team too large");

  return {
    host: opts.host,
    escrow: "",
    phase: Phase.LOBBY,
    variantKey: opts.variantKey ?? "among-us",
    minPlayers,
    maxPlayers,
    hiddenCount,
    seats: [],
    seedCommitment: opts.seedCommitment ?? "",
    roleCommitment: "",
    hiddenSeats: [],
    salt: "",
    hostSeed: "",
    nightDurationSecs: opts.nightDurationSecs,
    voteDurationSecs: opts.voteDurationSecs,
    nightDeadline: 0,
    voteDeadline: 0,
    nightVictim: NO_SEAT,
    pendingVictim: NO_SEAT,
    tallies: {},
    totalVotes: 0n,
    ejected: NO_SEAT,
    impostorRevealed: NO_SEAT,
    crewWon: false,
    log: [],
  };
}

/** `set_escrow` — host-only, once. */
export function setEscrow(state: GameState, escrow: string): GameState {
  require_(state.escrow === "", "escrow already set");
  require_(escrow.length > 0, "escrow required");
  return log({ ...state, escrow }, { call: "set_escrow", text: `Escrow linked (${short(escrow)})` });
}

/**
 * `join(session_key, payout_note_id)`, called by the lobby-join wallet.
 *
 * The `session_key != caller` check is the unlinkability invariant, not a
 * formality: if the burner were the joining wallet, every in-round action
 * would point straight back at the address that shielded the buy-in.
 */
export function join(
  state: GameState,
  p: {
    name: string;
    isBot?: boolean;
    wallet: string;
    sessionKey: string;
    sessionPrivateKey: string;
    payoutNoteId: string;
    entropy: string;
  },
): GameState {
  require_(state.phase === Phase.LOBBY, "not in lobby");
  require_(!state.seats.some((s) => s.wallet === p.wallet), "already joined");
  require_(p.sessionKey.length > 0, "session key required");
  require_(p.sessionKey !== p.wallet, "session key = wallet");
  require_(!state.seats.some((s) => s.sessionKey === p.sessionKey), "session key taken");
  require_(p.payoutNoteId !== "" && p.payoutNoteId !== "0", "payout note required");
  require_(p.entropy !== "" && p.entropy !== "0", "entropy required");

  const seat = state.seats.length;
  require_(seat < state.maxPlayers, "lobby full");

  const next: Seat = {
    seat,
    name: p.name.trim() || `Seat ${seat}`,
    isBot: p.isBot ?? false,
    wallet: p.wallet,
    sessionKey: p.sessionKey,
    sessionPrivateKey: p.sessionPrivateKey,
    payoutNoteId: p.payoutNoteId,
    entropy: p.entropy,
    dead: false,
    roleSeen: false,
    hasVoted: false,
  };

  return log(
    { ...state, seats: [...state.seats, next] },
    {
      call: "join",
      text: `${next.name}${next.isBot ? " (bot)" : ""} took seat ${seat} — buy-in shielded, burner ${short(p.sessionKey)} registered`,
    },
  );
}

/**
 * `assign_roles(role_commitment)`.
 *
 * The host draws the impostor off-chain and posts only
 * `poseidon(impostor_seat, salt)`. That makes the draw *binding* — the host
 * cannot re-pick after seeing the vote — without revealing it. It does not
 * make it *unbiased*; see the trust model in docs/ARCHITECTURE.md.
 */
export function assignRoles(
  state: GameState,
  p: { hiddenSeats: number[]; salt: string; commitment: string },
): GameState {
  require_(state.phase === Phase.LOBBY, "not in lobby");
  require_(state.seats.length >= state.minPlayers, "not enough players");
  require_(p.commitment !== "" && p.commitment !== "0", "commitment required");
  require_(p.hiddenSeats.length === state.hiddenCount, "wrong hidden count");
  for (const seat of p.hiddenSeats) {
    require_(seat >= 0 && seat < state.seats.length, "bad hidden seat");
  }

  const hidden = new Set(p.hiddenSeats);
  const seats = state.seats.map((s) => ({
    ...s,
    role: (hidden.has(s.seat) ? "IMPOSTOR" : "CREW") as Seat["role"],
    roleSeen: false,
  }));

  return log(
    {
      ...state,
      seats,
      roleCommitment: p.commitment,
      hiddenSeats: [...p.hiddenSeats].sort((a, b) => a - b),
      salt: p.salt,
      phase: Phase.ASSIGNED,
    },
    {
      call: "assign_roles",
      text: `Roles committed — poseidon(impostor, salt) = ${short(p.commitment)}. Encrypted role notes delivered.`,
      private: true,
    },
  );
}

/** Player opens their 0-value encrypted role note. Purely local — no tx. */
export function markRoleSeen(state: GameState, seat: number): GameState {
  return {
    ...state,
    seats: state.seats.map((s) => (s.seat === seat ? { ...s, roleSeen: true } : s)),
  };
}

/** `start_night()` — host-only, ASSIGNED → NIGHT. */
export function startNight(state: GameState, now = Date.now()): GameState {
  require_(state.phase === Phase.ASSIGNED, "roles not assigned");
  const deadline = now + state.nightDurationSecs * 1000;
  return log(
    { ...state, phase: Phase.NIGHT, nightDeadline: deadline },
    { call: "start_night", text: "Night falls. The impostor moves." },
  );
}

/**
 * The night kill: a private transfer of the kill note to the victim, inside
 * the pool. There is no on-chain call here at all — that is the point. The
 * contract learns a death only when the victim self-reports.
 */
export function privateKill(state: GameState, victimSeat: number): GameState {
  require_(state.phase === Phase.NIGHT, "not night");
  const victim = seatOf(state, victimSeat);
  require_(!victim.dead, "already dead");
  require_(victim.role !== "IMPOSTOR", "impostor cannot kill self");
  require_(state.pendingVictim === NO_SEAT, "kill already sent");
  return log(
    { ...state, pendingVictim: victimSeat + 1 },
    {
      call: "pool: private_transfer",
      text: "Kill note transferred privately inside the pool — sender and recipient hidden.",
      private: true,
    },
  );
}

/**
 * `report_night_kill()` — signed by the victim's SESSION KEY, not their wallet.
 * Opens the vote.
 */
export function reportNightKill(
  state: GameState,
  sessionKey: string,
  now = Date.now(),
): GameState {
  require_(state.phase === Phase.NIGHT, "not night");
  const victim = state.seats.find((s) => s.sessionKey === sessionKey);
  require_(victim !== undefined, "not a session key");
  require_(!victim.dead, "already dead");

  const seats = state.seats.map((s) => (s.seat === victim.seat ? { ...s, dead: true } : s));
  return log(
    openVote({ ...state, seats, nightVictim: victim.seat + 1, pendingVictim: NO_SEAT }, now),
    {
      call: "report_night_kill",
      text: `${victim.name} (seat ${victim.seat}) reports their own death, signed by burner ${short(sessionKey)}. Vote opens.`,
    },
  );
}

/** `skip_night()` — host-only fallback once the night deadline has passed. */
export function skipNight(state: GameState, now = Date.now()): GameState {
  require_(state.phase === Phase.NIGHT, "not night");
  require_(now > state.nightDeadline, "night not over");
  return log(openVote({ ...state, pendingVictim: NO_SEAT }, now), {
    call: "skip_night",
    text: "Night deadline passed with no body reported. Vote opens anyway.",
  });
}

function openVote(state: GameState, now: number): GameState {
  return {
    ...state,
    phase: Phase.VOTE,
    voteDeadline: now + state.voteDurationSecs * 1000,
  };
}

/**
 * `handle_vote(candidate_seat, amount)` — in the real system this is reached
 * only via `privacy_invoke` → `SignalEscrow`, so the contract sees a candidate
 * and an amount but never a voter. `voterSeat` here is local bookkeeping to
 * stop one browser double-voting; it is deliberately NOT part of the state the
 * contract would see.
 */
export function handleVote(
  state: GameState,
  p: { voterSeat: number; candidateSeat: number },
  now = Date.now(),
): GameState {
  require_(state.phase === Phase.VOTE, "not in vote phase");
  require_(now <= state.voteDeadline, "vote closed");
  require_(p.candidateSeat >= 0 && p.candidateSeat < state.seats.length, "bad candidate");
  require_(!seatOf(state, p.candidateSeat).dead, "candidate dead");

  const voter = seatOf(state, p.voterSeat);
  require_(!voter.dead, "dead cannot vote");
  require_(!voter.hasVoted, "already voted");

  const amount = VOTE_WEIGHT;
  require_(amount > 0n, "zero vote");

  const tallies = { ...state.tallies };
  tallies[p.candidateSeat] = (tallies[p.candidateSeat] ?? 0n) + amount;

  return log(
    {
      ...state,
      tallies,
      totalVotes: state.totalVotes + amount,
      seats: state.seats.map((s) => (s.seat === p.voterSeat ? { ...s, hasVoted: true } : s)),
    },
    {
      call: "privacy_invoke → handle_vote",
      text: `An anonymous vote leg landed on seat ${p.candidateSeat}. Tally now ${tallies[p.candidateSeat]}. Voter stays inside the pool.`,
      private: true,
    },
  );
}

/**
 * `compute_ejected` — strict argmax over LIVING seats. A tie for first (or an
 * all-zero tally) ejects nobody, which means the impostor survives and the
 * crew lose. Returns `seat + 1`, or 0.
 */
export function computeEjected(state: GameState): number {
  let bestSeatPlusOne = 0;
  let best = 0n;
  let tied = false;

  for (const s of state.seats) {
    if (s.dead) continue;
    const t = state.tallies[s.seat] ?? 0n;
    if (t > best) {
      best = t;
      bestSeatPlusOne = s.seat + 1;
      tied = false;
    } else if (t === best && t > 0n) {
      tied = true;
    }
  }

  return tied || best === 0n ? 0 : bestSeatPlusOne;
}

/**
 * `resolve_round(impostor_seat, salt)` — host opens the commitment. The
 * caller supplies the recomputed poseidon hash (the engine stays hash-agnostic
 * so it has no crypto dependency); it must equal what was posted.
 */
/**
 * Mirrors `resolve_round`. The caller does the hashing (this module stays free
 * of crypto dependencies) but every check the contract makes is made here, in
 * the same order and with the same messages.
 */
export function resolveRound(
  state: GameState,
  p: {
    hiddenSeats: number[];
    salt: string;
    hostSeed: string;
    recomputedCommitment: string;
    recomputedSeedCommitment: string;
  },
  now = Date.now(),
): GameState {
  require_(state.phase === Phase.VOTE, "not in vote phase");
  require_(now > state.voteDeadline, "vote still open");
  require_(p.recomputedSeedCommitment === state.seedCommitment, "seed mismatch");
  require_(p.hiddenSeats.length === state.hiddenCount, "wrong hidden count");
  for (const seat of p.hiddenSeats) {
    require_(seat >= 0 && seat < state.seats.length, "bad hidden seat");
  }
  require_(p.recomputedCommitment === state.roleCommitment, "commitment mismatch");

  const hidden = new Set(p.hiddenSeats);
  const ejected = computeEjected(state);
  // Crew win by ejecting anyone from the hidden team.
  const crewWon = ejected !== NO_SEAT && hidden.has(ejected - 1);

  return log(
    {
      ...state,
      ejected,
      impostorRevealed: Math.min(...p.hiddenSeats) + 1,
      hiddenSeats: [...p.hiddenSeats].sort((a, b) => a - b),
      hostSeed: p.hostSeed,
      crewWon,
      phase: Phase.RESOLVED,
    },
    {
      call: "resolve_round",
      text:
        `Commitment opened: the hidden team was ${p.hiddenSeats.join(", ")}. ` +
        (ejected === 0
          ? "The vote tied — nobody was ejected, so the impostor survives."
          : `Seat ${ejected - 1} was ejected.`) +
        ` ${crewWon ? "Crew win." : "Impostor wins."}`,
    },
  );
}

/** `is_winner(seat)`. Crew win pays every crew seat, dead crew included. */
export function isWinner(state: GameState, seat: number): boolean {
  if (state.phase !== Phase.RESOLVED) return false;
  if (seat >= state.seats.length) return false;
  const hidden = state.hiddenSeats.includes(seat);
  return state.crewWon ? !hidden : hidden;
}

/** `winner_count()`. */
export function winnerCount(state: GameState): number {
  if (state.phase !== Phase.RESOLVED) return 0;
  return state.crewWon ? state.seats.length - state.hiddenCount : state.hiddenCount;
}

/** The shielded payout leg — one `privacy_invoke`, credited to open notes. */
export function payout(state: GameState): GameState {
  require_(state.phase === Phase.RESOLVED, "not resolved");
  const winners = state.seats.filter((s) => isWinner(state, s.seat));
  return log(state, {
    call: "privacy_invoke → Payout",
    text: `Pot credited to ${winners.length} payout note${winners.length === 1 ? "" : "s"} as shielded balances — no public transfer to any wallet.`,
    private: true,
  });
}

// ── helpers ────────────────────────────────────────────────────────────────

export function seatOf(state: GameState, seat: number): Seat {
  const s = state.seats.find((x) => x.seat === seat);
  require_(s !== undefined, "bad seat");
  return s;
}

export function livingSeats(state: GameState): Seat[] {
  return state.seats.filter((s) => !s.dead);
}

export function canAdvance(state: GameState, now = Date.now()): boolean {
  if (state.phase === Phase.NIGHT) return now > state.nightDeadline;
  if (state.phase === Phase.VOTE) return now > state.voteDeadline;
  return false;
}

export function phaseLabel(phase: PhaseValue): string {
  return (
    { 0: "Lobby", 1: "Roles assigned", 2: "Night", 3: "Vote", 4: "Resolved" }[phase] ?? "Unknown"
  );
}

export function short(hex: string, lead = 6, tail = 4): string {
  if (!hex) return "—";
  if (hex.length <= lead + tail + 2) return hex;
  return `${hex.slice(0, lead)}…${hex.slice(-tail)}`;
}
