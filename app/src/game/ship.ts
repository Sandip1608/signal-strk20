/**
 * The ship: rooms, movement, tasks and sightings.
 *
 * Kept in its own state slice, *outside* `GameState`, on purpose. `GameState`
 * is the mirror of `round.cairo` and nothing here has an on-chain counterpart —
 * the contract has no concept of a room or a task, and this must not start
 * looking like it does.
 *
 * Tasks deliberately do **not** decide the round. In Among Us finishing tasks
 * is a crew win condition; here the winner is whatever `resolve_round` computes
 * from the vote, and inventing a second win condition would put the UI and the
 * contract into disagreement. Instead tasks generate *evidence*: moving around
 * to do them is what produces sightings, and sightings are what the crew argue
 * from at the meeting. The vote stays the only thing that settles the round.
 */

export type RoomId =
  | "upper-engine"
  | "cafeteria"
  | "weapons"
  | "electrical"
  | "medbay"
  | "reactor";

export type Room = {
  id: RoomId;
  name: string;
  /** Grid cell, 3 columns × 2 rows. */
  col: number;
  row: number;
};

/** A 3×2 deck. Small enough to read at a glance, big enough to lose someone in. */
export const ROOMS: Room[] = [
  { id: "upper-engine", name: "Upper Engine", col: 0, row: 0 },
  { id: "cafeteria", name: "Cafeteria", col: 1, row: 0 },
  { id: "weapons", name: "Weapons", col: 2, row: 0 },
  { id: "electrical", name: "Electrical", col: 0, row: 1 },
  { id: "medbay", name: "Medbay", col: 1, row: 1 },
  { id: "reactor", name: "Reactor", col: 2, row: 1 },
];

export const ROOM_BY_ID: Record<RoomId, Room> = Object.fromEntries(
  ROOMS.map((r) => [r.id, r]),
) as Record<RoomId, Room>;

/** Orthogonal neighbours — you walk through a wall's door, not diagonally. */
export function adjacent(a: RoomId, b: RoomId): boolean {
  const ra = ROOM_BY_ID[a];
  const rb = ROOM_BY_ID[b];
  return Math.abs(ra.col - rb.col) + Math.abs(ra.row - rb.row) === 1;
}

export function neighbours(id: RoomId): RoomId[] {
  return ROOMS.filter((r) => adjacent(id, r.id)).map((r) => r.id);
}

/**
 * Vent network — impostor-only travel between rooms that are *not* adjacent.
 *
 * This is what makes an alibi hard to trust: without it, "I saw them in
 * Electrical ten seconds ago" rules them out of Weapons, and the deduction
 * collapses into simple bookkeeping.
 */
export const VENTS: [RoomId, RoomId][] = [
  ["electrical", "weapons"],
  ["upper-engine", "reactor"],
  ["medbay", "cafeteria"],
];

export function ventFrom(room: RoomId): RoomId | null {
  for (const [a, b] of VENTS) {
    if (a === room) return b;
    if (b === room) return a;
  }
  return null;
}

/**
 * Where the round opens.
 *
 * Players are spread across the deck rather than all starting in one room.
 * With a shared spawn, every early sighting was "everyone in the Cafeteria" —
 * true, but worthless as evidence, because seeing someone tells you nothing if
 * you saw everyone. Scattering means where you were, and who was with you, is
 * information from the first second.
 */
export function spawnRooms(seats: number[]): Record<number, RoomId> {
  // Random placement, rejecting any layout that stacks 3+ in one room.
  //
  // A round-robin deal spreads perfectly evenly, which sounds better but is
  // worse: with 6 rooms and 5-6 players it guarantees everybody starts alone,
  // so no one ever opens with an alibi and pairs never happen. Random with a
  // cap of two keeps the deck spread out while still producing the occasional
  // "we started together" that makes the meeting worth having.
  const roomIds = ROOMS.map((r) => r.id);

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const positions: Record<number, RoomId> = {};
    const perRoom: Partial<Record<RoomId, number>> = {};
    let ok = true;

    for (const seat of seats) {
      const room = roomIds[Math.floor(Math.random() * roomIds.length)];
      const n = (perRoom[room] ?? 0) + 1;
      if (n > 2) {
        ok = false;
        break;
      }
      perRoom[room] = n;
      positions[seat] = room;
    }

    if (ok) return positions;
  }

  // Unreachable for 5-7 players, but never leave seats unplaced.
  const deck = shuffled(roomIds);
  return Object.fromEntries(seats.map((seat, i) => [seat, deck[i % deck.length]]));
}

// ── tasks ──────────────────────────────────────────────────────────────────

export type TaskKind = "rewire" | "keypad" | "stabilize";

export type TaskDef = {
  kind: TaskKind;
  room: RoomId;
  label: string;
  /** Shown on the station before you start it. */
  blurb: string;
};

/**
 * One task per room, two rooms per puzzle type.
 *
 * The shape matters: with three types and two rooms each, a player can always
 * be dealt one of *every* type in three different rooms. The previous list had
 * five defs drawn at random, which measured out at a repeated puzzle type in
 * 60% of rounds — you would play the same wiring panel twice and the round felt
 * thin. It also left the Cafeteria with no task, so a sixth of the deck was
 * somewhere you never had a reason to walk.
 */
export const TASK_DEFS: TaskDef[] = [
  {
    kind: "rewire",
    room: "electrical",
    label: "Fix wiring",
    blurb: "Join each wire to the matching colour.",
  },
  {
    kind: "rewire",
    room: "upper-engine",
    label: "Recalibrate engine",
    blurb: "Join each wire to the matching colour.",
  },
  {
    kind: "keypad",
    room: "weapons",
    label: "Enter access code",
    blurb: "Key in the code on the panel.",
  },
  {
    kind: "keypad",
    room: "medbay",
    label: "Log medical scan",
    blurb: "Key in the code on the panel.",
  },
  {
    kind: "stabilize",
    room: "reactor",
    label: "Stabilise reactor",
    blurb: "Hold the needle inside the band.",
  },
  {
    kind: "stabilize",
    room: "cafeteria",
    label: "Tune the comms array",
    blurb: "Hold the needle inside the band.",
  },
];

export const TASK_KINDS: TaskKind[] = ["rewire", "keypad", "stabilize"];

export type TaskInstance = {
  /** Unique per seat, so two seats can hold the "same" task. */
  id: string;
  kind: TaskKind;
  room: RoomId;
  label: string;
  blurb: string;
  /**
   * How hard this particular instance is — 3 wires or 5, a 4-digit code or a
   * 6-digit one, two gauge locks or four. Rolled per task so the second time
   * you meet a puzzle type it is not the identical panel.
   */
  magnitude: number;
  done: boolean;
};

/** A sighting: seat `who` was seen in `room` by whoever was standing there. */
export type Sighting = {
  at: number;
  observer: number;
  who: number;
  room: RoomId;
  /**
   * Came from the security log rather than the observer's own eyes — the
   * reward for finishing a task list. See `grantSecurityLog`.
   */
  viaLog?: boolean;
};

export type ShipState = {
  /** seat -> room. */
  positions: Record<number, RoomId>;
  /** seat -> that player's task list. */
  tasks: Record<number, TaskInstance[]>;
  sightings: Sighting[];
  /**
   * Unix ms before which no kill is allowed. Set when the night opens and
   * again after each kill — without it an impostor kills the instant they
   * share a room, and the night is over before anyone has walked anywhere.
   */
  killReadyAt: number;
  /** Unix ms the lights come back on. 0 = lights are up. */
  lightsOutUntil: number;
};

const DEFAULT_TASKS_PER_PLAYER = 3;

/**
 * Difficulty for one task instance.
 *
 * Ranges are chosen so the hardest instance is still a few seconds of work —
 * a task is meant to hold your attention while somebody could walk in, not to
 * become a puzzle game.
 */
function rollMagnitude(kind: TaskKind): number {
  const range: Record<TaskKind, [number, number]> = {
    rewire: [3, 5], // wires to join
    keypad: [4, 6], // digits in the code
    stabilize: [2, 4], // locks needed
  };
  const [lo, hi] = range[kind];
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** How many extra log entries finishing your whole list is worth. */
const SECURITY_LOG_ENTRIES = 2;

/** Seconds an impostor must wait before the first (and each next) kill. */
export const KILL_COOLDOWN_SECS = 20;

/** Seconds the lights stay out once sabotaged. */
export const LIGHTS_OUT_SECS = 25;

function shuffled<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Open the deck: scatter everyone across the rooms and deal three tasks each.
 *
 * The impostor gets a task list too — an impostor with nothing to do is
 * trivially caught by watching who never walks anywhere.
 */
export function initShip(
  seats: number[],
  tasksPerPlayer = DEFAULT_TASKS_PER_PLAYER,
  now = Date.now(),
): ShipState {
  const positions = spawnRooms(seats);
  const tasks: Record<number, TaskInstance[]> = {};

  for (const seat of seats) {
    // One task of each kind, in a randomly chosen room for that kind: three
    // different puzzles in three different rooms, every time.
    // More tasks than puzzle types means repeating a type; the shuffle still
    // guarantees you see each one before any repeat.
    const wanted = Math.max(1, tasksPerPlayer);
    const kinds: TaskKind[] = [];
    while (kinds.length < wanted) kinds.push(...shuffled(TASK_KINDS));

    // Rooms are claimed as we go. Picking each room independently let a
    // repeated kind land on the room it already used — two "Fix wiring" in
    // Electrical, which reads as a bug and leaves one pip for two tasks.
    const usedRooms = new Set<RoomId>();
    tasks[seat] = kinds.slice(0, wanted).map((kind, i) => {
      const options = TASK_DEFS.filter((d) => d.kind === kind);
      const fresh = options.filter((d) => !usedRooms.has(d.room));
      const pool = fresh.length > 0 ? fresh : options;
      const def = pool[Math.floor(Math.random() * pool.length)];
      usedRooms.add(def.room);
      return {
        ...def,
        id: `${seat}:${def.kind}:${def.room}:${i}`,
        magnitude: rollMagnitude(kind),
        done: false,
      };
    });
  }

  // You can obviously see whoever you started next to, so record it. Without
  // this, spawning together was invisible to the meeting even though in the
  // fiction everyone saw each other.
  const sightings: Sighting[] = [];
  for (const a of seats) {
    for (const bSeat of seats) {
      if (a === bSeat) continue;
      if (positions[a] === positions[bSeat]) {
        sightings.push({ at: now, observer: a, who: bSeat, room: positions[a] });
      }
    }
  }

  return {
    positions,
    tasks,
    sightings,
    killReadyAt: now + KILL_COOLDOWN_SECS * 1000,
    lightsOutUntil: 0,
  };
}

/** Whether the impostor may kill right now. */
export function killReady(ship: ShipState, now = Date.now()): boolean {
  return now >= ship.killReadyAt;
}

export function killCooldownLeft(ship: ShipState, now = Date.now()): number {
  return Math.max(0, Math.ceil((ship.killReadyAt - now) / 1000));
}

/** Start the cooldown again after a kill. */
export function armKillCooldown(ship: ShipState, now = Date.now()): ShipState {
  return { ...ship, killReadyAt: now + KILL_COOLDOWN_SECS * 1000 };
}

export function lightsOut(ship: ShipState, now = Date.now()): boolean {
  return now < ship.lightsOutUntil;
}

export function lightsOutLeft(ship: ShipState, now = Date.now()): number {
  return Math.max(0, Math.ceil((ship.lightsOutUntil - now) / 1000));
}

/**
 * Impostor sabotage: cut the lights.
 *
 * While they are out nobody can see who else is in their room, so sightings
 * stop accruing and the crew lose the evidence trail. Any player standing in
 * Electrical can restore them.
 */
export function sabotageLights(ship: ShipState, now = Date.now()): ShipState {
  return { ...ship, lightsOutUntil: now + LIGHTS_OUT_SECS * 1000 };
}

export function fixLights(ship: ShipState): ShipState {
  return { ...ship, lightsOutUntil: 0 };
}

/** Travel through a vent. Impostor-only; enforced by the caller. */
export function vent(ship: ShipState, seat: number, now = Date.now()): ShipState {
  const to = ventFrom(ship.positions[seat]);
  if (!to) return ship;
  // Deliberately records no sighting: moving unseen is the entire point.
  return { ...ship, positions: { ...ship.positions, [seat]: to } };
}

/**
 * Reset the deck for a new round.
 *
 * Everyone re-spawns, the evidence trail is wiped and the impostor's cooldown
 * is re-armed — but **task progress carries over**, which is the whole point
 * of tasks spanning rounds. Sightings are cleared deliberately: evidence from
 * two rounds ago is not what a table argues about, and keeping it would make
 * the ballot unreadable.
 */
export function resetForRound(
  ship: ShipState,
  seats: number[],
  now = Date.now(),
): ShipState {
  return {
    ...ship,
    positions: spawnRooms(seats),
    sightings: [],
    killReadyAt: now + KILL_COOLDOWN_SECS * 1000,
    lightsOutUntil: 0,
  };
}

/** Everyone (living) currently standing in `room`. */
export function occupants(ship: ShipState, room: RoomId, living: number[]): number[] {
  return living.filter((seat) => ship.positions[seat] === room);
}

/**
 * Move a player, recording what they and everyone already there can see.
 *
 * Sightings are mutual: walking into a room means you see them and they see
 * you. That symmetry is what makes an alibi worth anything at the meeting.
 */
export function move(
  ship: ShipState,
  seat: number,
  to: RoomId,
  living: number[],
  now = Date.now(),
): ShipState {
  const from = ship.positions[seat];
  if (from === to || !adjacent(from, to)) return ship;

  const positions = { ...ship.positions, [seat]: to };
  const alreadyThere = occupants(ship, to, living).filter((s) => s !== seat);

  const sightings: Sighting[] = [...ship.sightings];
  // Two reasons a move records nothing:
  //  - the lights are out, so nobody can tell who is beside them (that is what
  //    makes the sabotage worth doing);
  //  - the mover is dead. Ghosts keep doing tasks but are invisible, so they
  //    must not manufacture alibis for themselves or anyone else.
  const dark = lightsOut(ship, now);
  const ghost = !living.includes(seat);
  for (const other of dark || ghost ? [] : alreadyThere) {
    sightings.push({ at: now, observer: seat, who: other, room: to });
    sightings.push({ at: now, observer: other, who: seat, room: to });
  }

  return { ...ship, positions, sightings };
}

export function completeTask(ship: ShipState, seat: number, taskId: string): ShipState {
  const mine = (ship.tasks[seat] ?? []).map((t) =>
    t.id === taskId ? { ...t, done: true } : t,
  );
  const next: ShipState = { ...ship, tasks: { ...ship.tasks, [seat]: mine } };

  // Finishing your whole list opens the security log.
  const wasIncomplete = (ship.tasks[seat] ?? []).some((t) => !t.done);
  if (wasIncomplete && mine.every((t) => t.done)) {
    return grantSecurityLog(next, seat);
  }
  return next;
}

/**
 * Reward for finishing a task list: a couple of movements you did not witness
 * yourself.
 *
 * This is what stops tasks being busywork. It deliberately does **not** touch
 * the win condition — the round is still decided by whatever `resolve_round`
 * computes from the vote, and a second win condition would put the UI and the
 * contract into disagreement. What finishing your tasks buys is *evidence*,
 * which is the currency the vote actually runs on.
 *
 * Entries are marked `viaLog` so the ballot can show them as hearsay from the
 * logs rather than something you saw with your own eyes.
 */
export function grantSecurityLog(ship: ShipState, seat: number): ShipState {
  const alreadyKnown = new Set(
    ship.sightings
      .filter((s) => s.observer === seat)
      .map((s) => `${s.who}:${s.room}`),
  );

  const candidates = ship.sightings.filter(
    (s) => s.observer !== seat && s.who !== seat && !alreadyKnown.has(`${s.who}:${s.room}`),
  );

  // Newest first, de-duplicated by who-and-where.
  const picked: Sighting[] = [];
  const seen = new Set<string>();
  for (let i = candidates.length - 1; i >= 0 && picked.length < SECURITY_LOG_ENTRIES; i -= 1) {
    const c = candidates[i];
    const key = `${c.who}:${c.room}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push({ ...c, observer: seat, viaLog: true });
  }

  return picked.length === 0 ? ship : { ...ship, sightings: [...ship.sightings, ...picked] };
}

/** Whether this seat has finished everything it was dealt. */
export function tasksComplete(ship: ShipState, seat: number): boolean {
  const mine = ship.tasks[seat] ?? [];
  return mine.length > 0 && mine.every((t) => t.done);
}

/** The task at this seat's current room that is still outstanding. */
export function taskHere(ship: ShipState, seat: number): TaskInstance | null {
  const room = ship.positions[seat];
  return (ship.tasks[seat] ?? []).find((t) => t.room === room && !t.done) ?? null;
}

export function taskProgress(ship: ShipState, living: number[]): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const seat of living) {
    for (const t of ship.tasks[seat] ?? []) {
      total += 1;
      if (t.done) done += 1;
    }
  }
  return { done, total };
}

/** What one seat witnessed, newest first — the crew's argument at the meeting. */
export function sightingsFor(ship: ShipState, seat: number): Sighting[] {
  return ship.sightings.filter((s) => s.observer === seat).reverse();
}

/** A bot's next room: wander toward an unfinished task, else drift. */
export function botDestination(ship: ShipState, seat: number): RoomId | null {
  const here = ship.positions[seat];
  const open = (ship.tasks[seat] ?? []).filter((t) => !t.done);
  const options = neighbours(here);
  if (options.length === 0) return null;

  // Head for the room holding an outstanding task, one step at a time.
  const target = open[0]?.room;
  if (target && target !== here) {
    const step = options.find((o) => o === target);
    if (step) return step;
    // Not adjacent — take the neighbour that closes the gap.
    const t = ROOM_BY_ID[target];
    const best = options
      .map((o) => ROOM_BY_ID[o])
      .sort(
        (a, b) =>
          Math.abs(a.col - t.col) + Math.abs(a.row - t.row) -
          (Math.abs(b.col - t.col) + Math.abs(b.row - t.row)),
      )[0];
    return best.id;
  }

  return options[Math.floor(Math.random() * options.length)];
}
