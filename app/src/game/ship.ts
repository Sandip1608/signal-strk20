/**
 * The ship: rooms, movement, tasks and sightings.
 *
 * Kept in its own state slice, *outside* `GameState`, on purpose. `GameState`
 * is the mirror of `round.cairo` and nothing here has an on-chain counterpart —
 * the contract has no concept of a room or a task, and this must not start
 * looking like it does.
 *
 * Tasks are also the crew's second win condition. Completions are submitted
 * on-chain (`submit_task`); `resolve_round` counts only crew seats — ghosts
 * included — and the last job opens the commitment immediately. Until the bar
 * is full they still generate *evidence*: moving around to do them produces
 * sightings, which is what the crew argue from if a meeting is called first.
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
  /**
   * Everyone in the room watches you do it.
   *
   * Since an impostor can never *complete* a task, being seen finishing a
   * visual one is a proof of innocence rather than a claim — the one piece of
   * hard evidence the crew can manufacture for themselves.
   */
  visual?: boolean;
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
  {
    kind: "keypad",
    room: "medbay",
    label: "Submit to the medbay scan",
    blurb: "Anyone in Medbay will see you clear the scan.",
    visual: true,
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
  visual?: boolean;
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
  /**
   * The observer watched this player *complete* a visual task. Stronger than
   * "I saw them there": only crew can complete anything, so it clears them.
   */
  visual?: boolean;
};

export type ShipState = {
  /** seat -> room. */
  positions: Record<number, RoomId>;
  /** seat -> that player's task list. */
  tasks: Record<number, TaskInstance[]>;
  /** seat -> when that seat last finished a task. Paces the bots. */
  lastTaskAt: Record<number, number>;
  /**
   * seat -> the room that seat's body is lying in.
   *
   * Separate from `positions` on purpose: a ghost goes on walking the deck, but
   * the corpse stays where it fell. That is the whole point — "I found them in
   * Reactor" is evidence, and it only means something if the body does not
   * follow its owner around.
   *
   * Off-chain, like the rest of the deck. The contract records *that* somebody
   * died and that a body was called in; where it lay is for the players to
   * argue about, and keeping it out of public storage costs the round nothing.
   */
  bodies: Record<number, RoomId>;
  sightings: Sighting[];
  /**
   * Unix ms before which no kill is allowed. Set when the night opens and
   * again after each kill — without it an impostor kills the instant they
   * share a room, and the night is over before anyone has walked anywhere.
   */
  killReadyAt: number;
  /** Seconds this table waits before (and between) kills. Host-set. */
  killCooldownSecs: number;
  /** Unix ms before which no sabotage is allowed. */
  sabotageReadyAt: number;
  /** Unix ms the lights come back on. 0 = lights are up. */
  lightsOutUntil: number;
  /**
   * Unix ms the reactor blows. 0 = stable.
   *
   * Mirrors `reactor_deadline` on-chain. Unlike the lights, this one has a
   * losing outcome, so the fix has to be an on-chain action — otherwise the
   * contract would be taking someone's word for whether it was reached.
   */
  reactorDeadline: number;
  /**
   * The shared crew task bar.
   *
   * Precomputed rather than derived in the view, because only the server (or
   * the local store) knows every role. Each client computing it from what it
   * can see gave every viewer a different denominator — crew counted the
   * impostors' fake lists into a total that could never be reached, and an
   * impostor excluded only *itself*.
   */
  crewProgress: { done: number; total: number };
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

/**
 * Seconds between sabotages.
 *
 * There was no limit at all, so an impostor could re-cut the lights the instant
 * they were fixed and hold the deck dark for the whole night — the crew never
 * got a window to accrue sightings, which is the evidence the meeting runs on.
 * Longer than the kill cooldown because a sabotage costs nothing and hits
 * everybody at once.
 */
export const SABOTAGE_COOLDOWN_SECS = 30;

/**
 * Seconds a bot spends on one task.
 *
 * A human walks to the room and solves a minigame; a bot does neither, so it
 * used to finish a task every driver beat — 800ms. Four bots cleared all twelve
 * crew tasks about ten seconds into the first night, which since the task win
 * landed no longer just filled a bar: it decided the game before anyone had
 * played. Pacing them near a human's rate is the whole fix.
 */
export const BOT_TASK_SECS = 15;

/** Seconds the lights stay out once sabotaged. */
export const LIGHTS_OUT_SECS = 25;

/** `round.cairo::REACTOR_SECS` — seconds to reach the reactor. */
export const REACTOR_SECS = 30;

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
  killCooldownSecs = KILL_COOLDOWN_SECS,
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
    lastTaskAt: {},
    bodies: {},
    killCooldownSecs,
    killReadyAt: now + killCooldownSecs * 1000,
    // Opens on cooldown too, so the night cannot begin in darkness.
    sabotageReadyAt: now + SABOTAGE_COOLDOWN_SECS * 1000,
    lightsOutUntil: 0,
    reactorDeadline: 0,
    crewProgress: { done: 0, total: 0 },
  };
}

export function reactorGoing(ship: ShipState): boolean {
  return ship.reactorDeadline !== 0;
}

export function reactorSecsLeft(ship: ShipState, now = Date.now()): number {
  return ship.reactorDeadline === 0
    ? 0
    : Math.max(0, Math.ceil((ship.reactorDeadline - now) / 1000));
}

export function reactorBlown(ship: ShipState, now = Date.now()): boolean {
  return ship.reactorDeadline !== 0 && now > ship.reactorDeadline;
}

export function sabotageReactor(ship: ShipState, now = Date.now()): ShipState {
  return {
    ...ship,
    reactorDeadline: now + REACTOR_SECS * 1000,
    sabotageReadyAt: now + SABOTAGE_COOLDOWN_SECS * 1000,
  };
}

/** Whether the impostor may sabotage right now. */
export function sabotageReady(ship: ShipState, now = Date.now()): boolean {
  return now >= ship.sabotageReadyAt;
}

export function sabotageCooldownLeft(ship: ShipState, now = Date.now()): number {
  return Math.max(0, Math.ceil((ship.sabotageReadyAt - now) / 1000));
}

export function fixReactor(ship: ShipState): ShipState {
  return { ...ship, reactorDeadline: 0 };
}

/**
 * Is there still time to stop the meltdown?
 *
 * `fix_reactor` on-chain asserts `now <= reactor_deadline` ('too late'); the
 * client had no such check, so someone standing in Reactor could clear a
 * meltdown that had already blown and erase a win the impostors had earned.
 */
export function reactorFixable(ship: ShipState, now = Date.now()): boolean {
  return ship.reactorDeadline !== 0 && now <= ship.reactorDeadline;
}

/** Whether the impostor may kill right now. */
export function killReady(ship: ShipState, now = Date.now()): boolean {
  return now >= ship.killReadyAt;
}

export function killCooldownLeft(ship: ShipState, now = Date.now()): number {
  return Math.max(0, Math.ceil((ship.killReadyAt - now) / 1000));
}

function cooldownSecs(ship: ShipState): number {
  return ship.killCooldownSecs ?? KILL_COOLDOWN_SECS;
}

/** Start the cooldown again after a kill. */
export function armKillCooldown(ship: ShipState, now = Date.now()): ShipState {
  return { ...ship, killReadyAt: now + cooldownSecs(ship) * 1000 };
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
  return {
    ...ship,
    lightsOutUntil: now + LIGHTS_OUT_SECS * 1000,
    sabotageReadyAt: now + SABOTAGE_COOLDOWN_SECS * 1000,
  };
}

export function fixLights(ship: ShipState): ShipState {
  return { ...ship, lightsOutUntil: 0 };
}

/** Lay a body where its owner is standing. Called when the victim confirms. */
export function dropBody(ship: ShipState, seat: number): ShipState {
  return { ...ship, bodies: { ...ship.bodies, [seat]: ship.positions[seat] } };
}

/** Bodies lying in `room` — what a player standing there can see. */
export function bodiesIn(ship: ShipState, room: RoomId): number[] {
  return Object.entries(ship.bodies)
    .filter(([, r]) => r === room)
    .map(([seat]) => Number(seat));
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
    // A meeting clears the deck, exactly as `endVote` clears the on-chain flags.
    bodies: {},
    killReadyAt: now + cooldownSecs(ship) * 1000,
    sabotageReadyAt: now + SABOTAGE_COOLDOWN_SECS * 1000,
    lightsOutUntil: 0,
    // A new night starts with a stable reactor, matching `end_vote`.
    reactorDeadline: 0,
  };
}

/**
 * Recompute the shared crew bar. Call it wherever tasks or roles change.
 *
 * `crewSeats` is every living non-impostor. Only the store and the relay can
 * supply that, which is exactly why the number lives on the state rather than
 * being worked out in the view.
 */
export function withCrewProgress(ship: ShipState, crewSeats: number[]): ShipState {
  let done = 0;
  let total = 0;
  for (const seat of crewSeats) {
    for (const t of ship.tasks[seat] ?? []) {
      total += 1;
      if (t.done) done += 1;
    }
  }
  return { ...ship, crewProgress: { done, total } };
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

export function completeTask(
  ship: ShipState,
  seat: number,
  taskId: string,
  opts: { isImpostor?: boolean; living?: number[]; now?: number } = {},
): ShipState {
  const now = opts.now ?? Date.now();

  // An impostor's tasks are fake. They can open the panel and play it out —
  // looking busy is the whole disguise — but nothing is recorded: the task
  // never completes, the shared bar does not move, and the security log stays
  // shut. Without this, doing tasks was strictly *good* for the impostor,
  // which inverts the mechanic.
  if (opts.isImpostor) return ship;

  const task = (ship.tasks[seat] ?? []).find((t) => t.id === taskId);
  const mine = (ship.tasks[seat] ?? []).map((t) =>
    t.id === taskId ? { ...t, done: true } : t,
  );
  let next: ShipState = {
    ...ship,
    tasks: { ...ship.tasks, [seat]: mine },
    // Stamped only on a real completion, so an impostor's fake attempts above
    // never start the clock that paces the bots.
    lastTaskAt: { ...ship.lastTaskAt, [seat]: now },
  };

  // A visual task is witnessed by whoever is standing there — unless the
  // lights are out (nobody can see it, exactly as `move` records no sighting
  // in the dark) or the doer is a ghost (invisible, so being "witnessed"
  // would out them).
  const doerIsGhost = opts.living !== undefined && !opts.living.includes(seat);
  if (task?.visual && opts.living && !lightsOut(ship, now) && !doerIsGhost) {
    const room = ship.positions[seat];
    const watchers = occupants(ship, room, opts.living).filter((x) => x !== seat);
    if (watchers.length > 0) {
      next = {
        ...next,
        sightings: [
          ...next.sightings,
          ...watchers.map((observer) => ({
            at: now,
            observer,
            who: seat,
            room,
            visual: true,
          })),
        ],
      };
    }
  }

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
 * This is what stops tasks being busywork. Finishing the crew's whole list
 * also wins the round — `resolve_round` counts only crew submissions, ghosts
 * included, and the last job opens the commitment immediately. What each
 * finished list also buys is *evidence* (the security log), which is the
 * currency the vote runs on if the bar is not yet full.
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

/**
 * The shared crew bar.
 *
 * `crewOnly` excludes the impostors' fake lists — counting them would let the
 * impostor inflate the crew's apparent progress, and would make the bar's total
 * depend on how many impostors there are.
 */
export function taskProgress(
  ship: ShipState,
  living: number[],
  crewOnly?: number[],
): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const seat of crewOnly ?? living) {
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
  const target = open.length > 0 ? open[seat % open.length]!.room : undefined;
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
