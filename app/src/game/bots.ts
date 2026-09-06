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
import { botDestination, occupants, taskHere, type RoomId, type ShipState } from "./ship";
import { Phase, type GameState, type Seat } from "./types";

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
 * Both roles bandwagon onto whoever is already accumulating votes, which is
 * how real tables behave and keeps tallies converging instead of scattering
 * one-vote-each (which would tie, eject nobody, and hand the impostor a win
 * almost every round). The impostor simply never bandwagons onto itself, so
 * it deflects — the one asymmetry between the two.
 */
export function chooseVote(state: GameState, voter: Seat): number | null {
  const candidates = others(state, voter.seat);
  if (candidates.length === 0) return null;

  const BANDWAGON = 0.75;

  // Last voter, top currently tied: break it. A tie ejects nobody and hands the
  // impostor the round, and no real table votes to deadlock on purpose — this
  // is the one place bots need to act like players rather than dice.
  const isLastVoter = remainingVoters(state).length <= 1;
  if (isLastVoter) {
    const tied = tiedForFirst(state, voter.seat);
    if (tied.length > 0) return pick(tied)!.seat;
  }

  const leader = currentLeader(state, voter.seat);
  if (leader && Math.random() < BANDWAGON) return leader.seat;
  return pick(candidates)?.seat ?? null;
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
  | { kind: "vote"; voter: number; candidate: number }
  | { kind: "move"; seat: number; to: RoomId }
  | { kind: "task"; seat: number; taskId: string };

export function nextBotAction(state: GameState): BotAction | null {
  switch (state.phase) {
    case Phase.ASSIGNED: {
      const s = state.seats.find((x) => x.isBot && !x.roleSeen);
      return s ? { kind: "seeRole", seat: s.seat } : null;
    }

    case Phase.NIGHT:
      // Handled by `nextNightAction`, which needs the deck state.
      return null;

    case Phase.VOTE: {
      const voter = state.seats.find((x) => x.isBot && !x.dead && !x.hasVoted);
      if (!voter) return null;
      const candidate = chooseVote(state, voter);
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
  // 1. A kill note already delivered to a bot: it reports itself.
  if (state.pendingVictim !== 0) {
    const victim = state.seats[state.pendingVictim - 1];
    return victim?.isBot ? { kind: "report", seat: victim.seat } : null;
  }

  const living = livingSeats(state);
  const livingSeatNos = living.map((x) => x.seat);

  // 2. A bot impostor alone with someone takes the chance — but only once the
  //    night is a third gone.
  //
  //    Without this gate the impostor kills on the first beat it shares a room
  //    with anyone, which in testing ended the night in ~20 seconds: the human
  //    never got to walk anywhere or finish a task, and the "what you saw"
  //    evidence at the meeting was empty. Gating on elapsed time rather than a
  //    move count keeps it proportional to whichever pace the host picked.
  const elapsed = nightElapsedFraction(state);
  const impostor = living.find((x) => x.isBot && x.role === "IMPOSTOR");
  if (impostor && elapsed > 0.34) {
    const room = ship.positions[impostor.seat];
    const targets = occupants(ship, room, livingSeatNos).filter((x) => x !== impostor.seat);
    // Ramps up as the night runs out, so a kill still lands before the timer.
    const urgency = 0.18 + 0.5 * Math.max(0, elapsed - 0.34);
    if (targets.length > 0 && Math.random() < urgency) {
      return { kind: "kill", impostor: impostor.seat, victim: pick(targets)! };
    }
  }

  // 3. Standing on an unfinished task: do it.
  const worker = living.find((x) => x.isBot && taskHere(ship, x.seat) !== null);
  if (worker) {
    const t = taskHere(ship, worker.seat)!;
    return { kind: "task", seat: worker.seat, taskId: t.id };
  }

  // 4. Otherwise somebody walks.
  const walkers = living.filter((x) => x.isBot);
  const walker = pick(walkers);
  if (!walker) return null;
  const to = botDestination(ship, walker.seat);
  return to === null ? null : { kind: "move", seat: walker.seat, to };
}
