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
  MAX_ROUNDS,
  NO_SEAT,
  SKIP_VOTE,
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
  minPlayers?: number;
  maxPlayers?: number;
  hiddenCount?: number;
  seerCount?: number;
  tasksPerPlayer?: number;
  confirmEjects?: boolean;
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
  const seerCount = opts.seerCount ?? 0;
  require_(hiddenCount + seerCount < minPlayers, "too many special roles");

  return {
    host: opts.host,
    escrow: "",
    phase: Phase.LOBBY,
    minPlayers,
    maxPlayers,
    hiddenCount,
    seerCount,
    tasksPerPlayer: opts.tasksPerPlayer ?? 3,
    confirmEjects: opts.confirmEjects ?? true,
    seats: [],
    seedCommitment: opts.seedCommitment ?? "",
    roleCommitment: "",
    hiddenSeats: [],
    seerSeats: [],
    salt: "",
    hostSeed: "",
    nightDurationSecs: opts.nightDurationSecs,
    voteDurationSecs: opts.voteDurationSecs,
    nightDeadline: 0,
    voteDeadline: 0,
    roundNumber: 0,
    ejections: {},
    ejectedWasImpostor: {},
    nightVictim: NO_SEAT,
    pendingVictim: NO_SEAT,
    tallies: {},
    skipTally: 0n,
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
    calledMeeting: false,
    checks: {},
    checkedRound: -1,
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
  p: { hiddenSeats: number[]; seerSeats?: number[]; salt: string; commitment: string },
): GameState {
  require_(state.phase === Phase.LOBBY, "not in lobby");
  require_(state.seats.length >= state.minPlayers, "not enough players");
  require_(p.commitment !== "" && p.commitment !== "0", "commitment required");
  require_(p.hiddenSeats.length === state.hiddenCount, "wrong hidden count");
  for (const seat of p.hiddenSeats) {
    require_(seat >= 0 && seat < state.seats.length, "bad hidden seat");
  }

  const hidden = new Set(p.hiddenSeats);
  const seers = new Set(p.seerSeats ?? []);
  const seats = state.seats.map((s) => ({
    ...s,
    role: (hidden.has(s.seat)
      ? "IMPOSTOR"
      : seers.has(s.seat)
        ? "SEER"
        : "CREW") as Seat["role"],
    roleSeen: false,
  }));

  return log(
    {
      ...state,
      seats,
      roleCommitment: p.commitment,
      hiddenSeats: [...p.hiddenSeats].sort((a, b) => a - b),
      seerSeats: [...(p.seerSeats ?? [])].sort((a, b) => a - b),
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
 * A seer check.
 *
 * Like the night kill, this is a private action with no on-chain call: the
 * contract learns nothing, and the result is knowledge held by one player.
 * One check per night, so it cannot be used to sweep the table.
 */
export function investigate(
  state: GameState,
  seerSeat: number,
  targetSeat: number,
): GameState {
  require_(state.phase === Phase.NIGHT, "not night");
  const seer = seatOf(state, seerSeat);
  require_(seer.role === "SEER", "not the seer");
  require_(!seer.dead, "dead cannot check");
  require_(seer.checkedRound !== state.roundNumber, "already checked tonight");
  require_(targetSeat !== seerSeat, "cannot check yourself");
  const target = seatOf(state, targetSeat);
  require_(!target.dead, "target is dead");

  const isImpostor = target.role === "IMPOSTOR";
  return log(
    {
      ...state,
      seats: state.seats.map((s) =>
        s.seat === seerSeat
          ? {
              ...s,
              checks: { ...s.checks, [targetSeat]: isImpostor },
              checkedRound: state.roundNumber,
            }
          : s,
      ),
    },
    {
      call: "pool: private_transfer",
      text: "A check note moved privately inside the pool — only the seer reads the answer.",
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

/**
 * `call_meeting()` — any living player, once per round, signed by their
 * session key. Opens the vote without waiting for a body.
 */
export function callMeeting(state: GameState, seat: number, now = Date.now()): GameState {
  require_(state.phase === Phase.NIGHT, "not night");
  const caller = seatOf(state, seat);
  require_(!caller.dead, "dead cannot call");
  require_(!caller.calledMeeting, "meeting already used");

  const seats = state.seats.map((s) =>
    s.seat === seat ? { ...s, calledMeeting: true } : s,
  );
  return log(openVote({ ...state, seats, pendingVictim: NO_SEAT }, now), {
    call: "call_meeting",
    text: `${caller.name} called an emergency meeting, signed by burner ${short(caller.sessionKey)}.`,
  });
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
  const skipping = p.candidateSeat === SKIP_VOTE;
  if (!skipping) {
    require_(p.candidateSeat >= 0 && p.candidateSeat < state.seats.length, "bad candidate");
    require_(!seatOf(state, p.candidateSeat).dead, "candidate dead");
  }

  const voter = seatOf(state, p.voterSeat);
  require_(!voter.dead, "dead cannot vote");
  require_(!voter.hasVoted, "already voted");

  const amount = VOTE_WEIGHT;
  require_(amount > 0n, "zero vote");

  const tallies = { ...state.tallies };
  let skipTally = state.skipTally;
  if (skipping) skipTally += amount;
  else tallies[p.candidateSeat] = (tallies[p.candidateSeat] ?? 0n) + amount;

  return log(
    {
      ...state,
      tallies,
      skipTally,
      totalVotes: state.totalVotes + amount,
      seats: state.seats.map((s) => (s.seat === p.voterSeat ? { ...s, hasVoted: true } : s)),
    },
    {
      call: "privacy_invoke → handle_vote",
      text: skipping
        ? `An anonymous vote leg declined to accuse anyone. Skips now ${skipTally}. Voter stays inside the pool.`
        : `An anonymous vote leg landed on seat ${p.candidateSeat}. Tally now ${tallies[p.candidateSeat]}. Voter stays inside the pool.`,
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

  // A skip that matches or beats the leading accusation ejects nobody.
  return tied || best === 0n || state.skipTally >= best ? 0 : bestSeatPlusOne;
}

/**
 * `resolve_round(impostor_seat, salt)` — host opens the commitment. The
 * caller supplies the recomputed poseidon hash (the engine stays hash-agnostic
 * so it has no crypto dependency); it must equal what was posted.
 */
/**
 * Whether the ballot may be closed — mirrors `ballot_closed()`.
 *
 * The deadline is one way; everybody having voted is the other, and waiting
 * out a clock nobody is still using is just dead air.
 *
 * On-chain the votes are anonymous, so the contract cannot see *who* voted,
 * only the total weight that arrived. Each player shields exactly one vote
 * stake, so that total reaching the living count is precisely "everyone has
 * voted" — which is why this counts weight rather than checking `hasVoted`.
 */
export function ballotClosed(state: GameState, now = Date.now()): boolean {
  if (now > state.voteDeadline) return true;
  const living = state.seats.filter((x) => !x.dead).length;
  return living > 0 && state.totalVotes >= BigInt(living);
}

/**
 * `end_vote()` - close this round's vote and open the next night.
 *
 * The contract cannot tell whether the game is over: that needs the roles, and
 * they stay sealed until the reveal. So the host chooses - end the vote to
 * play on, or resolve to finish - and `resolveRound` then verifies the choice
 * was honest. `MAX_ROUNDS` stops a host stalling forever.
 *
 * Deaths and used emergency meetings deliberately carry across the boundary;
 * everything else about the round is rebuilt.
 */
export function endVote(state: GameState, now = Date.now()): GameState {
  require_(state.phase === Phase.VOTE, "not in vote phase");
  require_(ballotClosed(state, now), "vote still open");
  require_(state.roundNumber + 1 < MAX_ROUNDS, "too many rounds");

  const ejected = computeEjected(state);
  const seats = state.seats.map((x) => ({
    ...x,
    dead: x.dead || (ejected !== NO_SEAT && x.seat === ejected - 1),
    hasVoted: false,
    // `checks` is deliberately NOT cleared — the seer remembers what they
    // learned. The one-per-night limit is `checkedRound` against the new
    // round, so a fresh check unlocks on its own.
  }));

  const round = state.roundNumber;
  return log(
    {
      ...state,
      seats,
      ejections: { ...state.ejections, [round]: ejected },
      // Computed here because this is the last place roles are in hand; the
      // relay redacts them, so the client could not work it out for itself.
      ejectedWasImpostor:
        state.confirmEjects && ejected !== NO_SEAT
          ? {
              ...state.ejectedWasImpostor,
              [round]: state.seats[ejected - 1].role === "IMPOSTOR",
            }
          : state.ejectedWasImpostor,
      roundNumber: round + 1,
      tallies: {},
      skipTally: 0n,
      totalVotes: 0n,
      nightVictim: NO_SEAT,
      pendingVictim: NO_SEAT,
      phase: Phase.NIGHT,
      nightDeadline: now + state.nightDurationSecs * 1000,
      voteDeadline: 0,
    },
    {
      call: "end_vote",
      text:
        ejected === NO_SEAT
          ? `Round ${round + 1} ended with nobody ejected. Night falls again.`
          : `${seats[ejected - 1].name} was ejected. Night falls again.`,
    },
  );
}

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
  require_(ballotClosed(state, now), "vote still open");
  require_(p.recomputedSeedCommitment === state.seedCommitment, "seed mismatch");
  require_(p.hiddenSeats.length === state.hiddenCount, "wrong hidden count");
  for (const seat of p.hiddenSeats) {
    require_(seat >= 0 && seat < state.seats.length, "bad hidden seat");
  }
  require_(p.recomputedCommitment === state.roleCommitment, "commitment mismatch");

  const hidden = new Set(p.hiddenSeats);
  const ejected = computeEjected(state);

  // Apply this round's ejection, then count who is left and check the host was
  // entitled to stop here - otherwise they could end the game on whichever
  // round happened to suit them.
  const afterSeats = state.seats.map((x) => ({
    ...x,
    dead: x.dead || (ejected !== NO_SEAT && x.seat === ejected - 1),
  }));
  let impostorsAlive = 0;
  let crewAlive = 0;
  for (const x of afterSeats) {
    if (x.dead) continue;
    if (hidden.has(x.seat)) impostorsAlive += 1;
    else crewAlive += 1;
  }
  const impostorsWon = impostorsAlive >= crewAlive;

  // The round cap is itself a terminal condition — see the long note in
  // `round.cairo::resolve_round`. Briefly: `endVote` refuses once the cap is
  // reached and this guard refused any finish that was not already a win, so a
  // table that got there with the impostors alive but not yet a majority had no
  // legal move left and the stakes stayed locked. Surviving to the cap is a
  // crew win.
  const capped = state.roundNumber + 1 >= MAX_ROUNDS;
  require_(impostorsAlive === 0 || impostorsWon || capped, "game not over");

  // Equivalent to `impostorsAlive === 0` in the two original cases, since the
  // guard above rules out anything else, and it is what decides a capped round.
  const crewWon = !impostorsWon;

  return log(
    {
      ...state,
      seats: afterSeats,
      ejected,
      ejections: { ...state.ejections, [state.roundNumber]: ejected },
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
