/**
 * Bot players.
 *
 * A bot seat is an ordinary seat — its own burner key, its own payout note —
 * so nothing here weakens the round: the contract cannot tell a bot from a
 * person, and a bot's vote goes through the same anonymous leg. Bots exist so
 * one person can play (and record) a full round without five humans passing a
 * phone around.
 *
 * The decision functions are pure so bot behaviour can be reasoned about
 * without a browser; `useBotDriver` is the only part that touches React.
 */

import { livingSeats } from "./engine";
import {
  BOT_TASK_SECS,
  botDestination,
  killReady,
  neighbours,
  occupants,
  sightingsFor,
  taskHere,
  type RoomId,
  type ShipState,
} from "./ship";
import { Phase, SKIP_VOTE, type GameState, type Seat } from "./types";

const BOT_NAMES = [
  "Nova", "Rhea", "Juno", "Atlas", "Vega", "Orion", "Lyra", "Pax", "Iris", "Kepler",
];

/** A name not already taken at the table. */
export function nextBotName(seats: Seat[]): string {
  const taken = new Set(seats.map((s) => s.name));
  return BOT_NAMES.find((n) => !taken.has(n)) ?? `Bot ${seats.length}`;
}

/** Living seats that are not `self`. */
function others(state: GameState, self: number): Seat[] {
  return livingSeats(state).filter((s) => s.seat !== self);
}

function pick<T>(xs: T[]): T | null {
  return xs.length === 0 ? null : xs[Math.floor(Math.random() * xs.length)];
}

/**
 * Stable 0..1 from (seat, salt). Each bot is a character with fixed habits,
 * not a new coin flip every tick — that's what made them vote as a bloc.
 */
function unit(seat: number, salt: number): number {
  const x = Math.imul(seat + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b);
  return ((x >>> 0) % 1000) / 1000;
}

type Traits = {
  /** Chance to pile onto the current leader. 0.15–0.55, not a shared 75%. */
  bandwagon: number;
  /** Chance to skip when they have no strong read. */
  skip: number;
  /** Fraction of the vote clock they wait before casting. */
  delay: number;
  /** Chance to roam instead of bee-lining to a task. */
  wander: number;
};

function traits(seat: number): Traits {
  return {
    bandwagon: 0.15 + unit(seat, 1) * 0.4,
    skip: 0.1 + unit(seat, 2) * 0.28,
    delay: 0.12 + unit(seat, 3) * 0.68,
    wander: 0.2 + unit(seat, 4) * 0.38,
  };
}

function voteElapsed(state: GameState, now: number): number {
  const window = state.voteDurationSecs * 1000;
  if (window <= 0 || state.voteDeadline === 0) return 1;
  return Math.min(1, Math.max(0, 1 - (state.voteDeadline - now) / window));
}

function readyToVote(state: GameState, seat: number, now: number): boolean {
  const elapsed = voteElapsed(state, now);
  // Last tenth of the clock: remaining bots commit rather than all skip-by-timeout.
  if (elapsed >= 0.9) return true;
  return elapsed >= traits(seat).delay;
}

/** Living seats with votes, highest first, excluding `exclude`. */
function ranked(state: GameState, exclude: number): { seat: Seat; votes: bigint }[] {
  return livingSeats(state)
    .filter((s) => s.seat !== exclude)
    .map((seat) => ({ seat, votes: state.tallies[seat.seat] ?? 0n }))
    .filter((x) => x.votes > 0n)
    .sort((a, b) => (b.votes > a.votes ? 1 : b.votes < a.votes ? -1 : 0));
}

/** The living seat with the most votes so far, if any votes have been cast. */
function currentLeader(state: GameState, exclude: number): Seat | null {
  return ranked(state, exclude)[0]?.seat ?? null;
}

/** Seats currently tied for first, if the top is contested. */
function tiedForFirst(state: GameState, exclude: number): Seat[] {
  const r = ranked(state, exclude);
  if (r.length < 2) return [];
  const top = r[0].votes;
  const tied = r.filter((x) => x.votes === top);
  return tied.length > 1 ? tied.map((x) => x.seat) : [];
}

/** Living players who still have a vote to cast. */
function remainingVoters(state: GameState): Seat[] {
  return livingSeats(state).filter((s) => !s.hasVoted);
}

/** Who a bot impostor kills: any living crew member. */
export function chooseKill(state: GameState, impostorSeat: number): number | null {
  return pick(others(state, impostorSeat))?.seat ?? null;
}

/**
 * Who a bot votes for.
 *
 * Used to be one shared policy (75% pile onto the leader), so four bots
 * produced four identical ballots a beat apart. Each seat now has its own
 * delay, skip habit and bandwagon rate, and crew weigh who they actually saw.
 */
export function chooseVote(
  state: GameState,
  voter: Seat,
  ship: ShipState | null = null,
): number | null {
  const candidates = others(state, voter.seat);
  if (candidates.length === 0) return SKIP_VOTE;

  const t = traits(voter.seat);

  // A bot seer votes what it knows. Without this the role is dead weight
  // whenever the seed hands it to a bot, which at 1 seer in 6 seats is most
  // of the time in a solo game.
  const guilty = candidates.find((x) => voter.checks[x.seat] === true);
  if (guilty) return guilty.seat;

  // Last voter, top currently tied: break it. A tie ejects nobody and hands the
  // impostor the round, and no real table votes to deadlock on purpose.
  const isLastVoter = remainingVoters(state).length <= 1;
  if (isLastVoter) {
    const tied = tiedForFirst(state, voter.seat);
    if (tied.length > 0) {
      const crewTied =
        voter.role === "IMPOSTOR" ? tied.filter((x) => x.role !== "IMPOSTOR") : tied;
      return pick(crewTied.length > 0 ? crewTied : tied)!.seat;
    }
  }

  const seen = ship
    ? sightingsFor(ship, voter.seat).filter((s) => s.who !== voter.seat)
    : [];
  const cleared = new Set(seen.filter((s) => s.visual).map((s) => s.who));
  const alibi = new Set(seen.map((s) => s.who));

  const victim = state.nightVictim === 0 ? undefined : state.nightVictim - 1;
  const killRoom = victim !== undefined && ship ? ship.bodies[victim] : undefined;
  const seenAtKill = new Set(
    killRoom ? seen.filter((s) => s.room === killRoom).map((s) => s.who) : [],
  );

  const open = candidates.filter((x) => !cleared.has(x.seat));
  const pool = open.length > 0 ? open : candidates;

  // Impostors never throw a partner under the bus on purpose, and they skip
  // more often — looking indecisive is safer than joining a crew pile-on.
  if (voter.role === "IMPOSTOR") {
    const crew = pool.filter((x) => x.role !== "IMPOSTOR");
    const frame = crew.filter((x) => seenAtKill.has(x.seat) || !alibi.has(x.seat));
    if (Math.random() < t.skip + 0.12) return SKIP_VOTE;
    const leader = currentLeader(state, voter.seat);
    if (leader && leader.role !== "IMPOSTOR" && Math.random() < t.bandwagon) {
      return leader.seat;
    }
    return pick(frame.length > 0 ? frame : crew.length > 0 ? crew : pool)?.seat ?? SKIP_VOTE;
  }

  const suspicious = pool.filter(
    (x) => seenAtKill.has(x.seat) || !alibi.has(x.seat),
  );
  const leader = currentLeader(state, voter.seat);
  if (
    leader &&
    !cleared.has(leader.seat) &&
    Math.random() < t.bandwagon
  ) {
    return leader.seat;
  }
  if (Math.random() < t.skip) return SKIP_VOTE;
  return pick(suspicious.length > 0 ? suspicious : pool)?.seat ?? SKIP_VOTE;
}

/**
 * The single bot action that is due right now, or null.
 *
 * Returning one action at a time (rather than looping) is what lets the driver
 * space them out on a timer, so a human watching can follow what happened.
 */
export type BotAction =
  | { kind: "seeRole"; seat: number }
  | { kind: "kill"; impostor: number; victim: number }
  | { kind: "report"; seat: number }
  | { kind: "reportBody"; finder: number; victim: number }
  | { kind: "vote"; voter: number; candidate: number }
  | { kind: "move"; seat: number; to: RoomId }
  | { kind: "task"; seat: number; taskId: string }
  | { kind: "check"; seer: number; target: number };

export function nextBotAction(
  state: GameState,
  ship: ShipState | null = null,
  now = Date.now(),
): BotAction | null {
  switch (state.phase) {
    case Phase.ASSIGNED: {
      const pending = state.seats.filter((x) => x.isBot && !x.roleSeen);
      const s = pick(pending);
      return s ? { kind: "seeRole", seat: s.seat } : null;
    }

    case Phase.NIGHT:
      // Handled by `nextNightAction`, which needs the deck state.
      return null;

    case Phase.VOTE: {
      const ready = state.seats.filter(
        (x) => x.isBot && !x.dead && !x.hasVoted && readyToVote(state, x.seat, now),
      );
      const voter = pick(ready);
      if (!voter) return null;
      const candidate = chooseVote(state, voter, ship);
      return candidate === null ? null : { kind: "vote", voter: voter.seat, candidate };
    }

    default:
      return null;
  }
}


/** How far through the night we are, 0..1. */
function nightElapsedFraction(state: GameState, now = Date.now()): number {
  const total = state.nightDurationSecs * 1000;
  if (total <= 0 || state.nightDeadline === 0) return 1;
  const left = state.nightDeadline - now;
  return Math.min(1, Math.max(0, 1 - left / total));
}

/**
 * A bot's next move during the night, on the deck.
 *
 * Split from `nextBotAction` because it needs `ShipState`, which is
 * deliberately not part of `GameState`.
 *
 * The ordering matters: report first (a body left unreported stalls the whole
 * round), then kill, then tasks, then wander. A bot impostor may only kill
 * someone standing in the same room — the same rule the human impostor plays
 * by, so watching who was where stays meaningful evidence.
 */
export function nextNightAction(state: GameState, ship: ShipState): BotAction | null {
  // 1. A kill note already delivered to a bot: it opens it and dies. This no
  //    longer calls the meeting — it leaves a body for somebody to find.
  if (state.pendingVictim !== 0) {
    const victim = state.seats[state.pendingVictim - 1];
    return victim?.isBot ? { kind: "report", seat: victim.seat } : null;
  }

  const living = livingSeats(state);
  const livingSeatNos = living.map((x) => x.seat);

  // 2. A living bot standing over a body calls it in. Without this a body a
  //    human never walks past is never found, and in a solo game that is most
  //    of them — the round would just run out its clock every time.
  const corpses = Object.keys(state.unreportedBody)
    .filter((k) => state.unreportedBody[Number(k)])
    .map(Number);
  if (corpses.length > 0) {
    for (const finder of living) {
      if (!finder.isBot) continue;
      const here = ship.positions[finder.seat];
      const found = corpses.find((c) => ship.bodies[c] === here);
      if (found !== undefined) {
        return { kind: "reportBody", finder: finder.seat, victim: found };
      }
    }
  }

  // 3. A bot impostor alone with someone takes the chance — but not while the
  //    host-set kill cooldown is still running. That used to be hidden by the
  //    UI only; bots (and a handwritten POST) skipped it, so the first shared
  //    room ended the night.
  const elapsed = nightElapsedFraction(state);
  const impostor = pick(living.filter((x) => x.isBot && x.role === "IMPOSTOR"));
  if (impostor && killReady(ship)) {
    const room = ship.positions[impostor.seat];
    const targets = occupants(ship, room, livingSeatNos).filter((x) => x !== impostor.seat);
    // Ramps up as the night runs out, so a kill still lands before the timer.
    const urgency = 0.18 + 0.5 * elapsed;
    if (targets.length > 0 && Math.random() < urgency) {
      return { kind: "kill", impostor: impostor.seat, victim: pick(targets)! };
    }
  }

  // 4. A bot seer spends its one check on whoever it is standing with.
  const seer = pick(
    living.filter(
      (x) => x.isBot && x.role === "SEER" && x.checkedRound !== state.roundNumber,
    ),
  );
  if (seer && elapsed > 0.15 + traits(seer.seat).delay * 0.2) {
    const room = ship.positions[seer.seat];
    const near = occupants(ship, room, livingSeatNos)
      .filter((x) => x !== seer.seat)
      // No point spending the night re-reading someone already known.
      .filter((x) => !(x in seer.checks));
    if (near.length > 0) return { kind: "check", seer: seer.seat, target: pick(near)! };
  }

  // 5. Standing on an unfinished task: do it — unless this seat has already
  //    submitted its whole allotment.
  //
  //    That second clause matters more than it looks. An impostor's tasks are
  //    fake and never mark themselves done, so `taskHere` keeps handing back
  //    the same one forever: the bot re-submitted it every beat, tripped the
  //    contract's per-seat cap, and the rejection surfaced on the *human's*
  //    screen as a permanent "reverted: task list already done".
  //    They are also paced. A bot neither walks a corridor nor solves a panel,
  //    so without a cooldown it finishes a task every driver beat and the crew
  //    bar — which now decides the game — fills before the first body drops.
  const now = Date.now();
  const worker = pick(
    living.filter(
      (x) =>
        x.isBot &&
        taskHere(ship, x.seat) !== null &&
        (state.tasksDone[x.seat] ?? 0) < state.tasksPerPlayer &&
        now - (ship.lastTaskAt[x.seat] ?? 0) >= BOT_TASK_SECS * 1000,
    ),
  );
  if (worker) {
    const t = taskHere(ship, worker.seat)!;
    return { kind: "task", seat: worker.seat, taskId: t.id };
  }

  // 6. Otherwise somebody walks. Some wander; others still path to a task.
  const walker = pick(living.filter((x) => x.isBot));
  if (!walker) return null;
  const here = ship.positions[walker.seat];
  if (Math.random() < traits(walker.seat).wander) {
    const roam = neighbours(here);
    const detour = pick(roam);
    return detour === null ? null : { kind: "move", seat: walker.seat, to: detour };
  }
  const to = botDestination(ship, walker.seat);
  return to === null ? null : { kind: "move", seat: walker.seat, to };
}
