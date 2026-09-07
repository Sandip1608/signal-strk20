/**
 * In-memory room store for cross-device play.
 *
 * A stopgap, and worth being honest about what it is: the real shared state
 * for this game is meant to be `SignalRound` on Starknet — that is the whole
 * premise of the project. This relay exists so two people on two machines can
 * play before the contracts are deployed. It earns nothing in the judging and
 * should not grow into a second source of truth.
 *
 * Two properties it does have to get right:
 *
 *  1. **The server runs the engine.** Clients post *actions*, never state.
 *     `engine.ts` and `ship.ts` are pure and React-free, so they import
 *     straight in here and every client agrees by construction. If clients
 *     applied moves locally and pushed state, two simultaneous votes would
 *     race and one would be silently lost.
 *
 *  2. **State is redacted per viewer.** A client only receives its own role,
 *     its own burner key, and only the crewmates standing in its own room.
 *     Without that, anyone could read the impostor out of the network tab —
 *     which would make the game's central claim false in the demo.
 *
 * State lives in module memory, so it survives hot reloads via `globalThis`
 * but not a server restart, and it will NOT work across serverless instances
 * (Vercel). Run this on one long-lived process — `npm run dev` or `npm start`.
 */

import * as engine from "@/game/engine";
import * as ship from "@/game/ship";
import { nextBotAction, nextNightAction } from "@/game/bots";
import {
  combinedSeed,
  deriveRoles,
  generateSessionKey,
  placeholderPayoutNote,
  placeholderWallet,
  poseidonCommitment,
  randomEntropy,
  randomSalt,
  seedCommitment,
} from "@/game/crypto";
import { Phase, type GameState, type Seat } from "@/game/types";
import type { RoomId, ShipState } from "@/game/ship";

export type Room = {
  code: string;
  game: GameState;
  ship: ShipState | null;
  /** Host-only secrets. Never leave the server until `resolve_round` opens them. */
  hiddenSeats: number[];
  salt: string;
  hostSeed: string;
  /** Bumps on every change so clients can skip unchanged payloads. */
  version: number;
  /** playerId -> seat, so a browser reclaims its seat after a refresh. */
  claims: Record<string, number>;
  /**
   * The player who opened the room. Host-only actions are `assert_host` in the
   * Cairo and were completely unguarded here, so any joined player could
   * re-assign roles, start the night or resolve the game.
   */
  hostPlayerId: string | null;
  lastBotAt: number;
  lastTouchedAt: number;
};

type Store = { rooms: Map<string, Room> };

// Survive Next's dev hot-reload, which re-evaluates modules.
const g = globalThis as unknown as { __signalRooms?: Store };
const store: Store = (g.__signalRooms ??= { rooms: new Map() });

/**
 * Every non-impostor seat — the seats the shared crew bar counts.
 *
 * Ghosts included, deliberately. A dead crewmate's finished tasks still filled
 * the bar, and they can go on filling it, which is the whole reason ghosts keep
 * a task list. Dropping them would also put the bar out of step with the
 * contract, whose task-win target is computed over every crew seat: the bar
 * could read full while `resolve_round` still answered "game not over".
 */
function crewSeatsOf(game: GameState): number[] {
  return game.seats.filter((x) => x.role !== "IMPOSTOR").map((x) => x.seat);
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1
const ROOM_TTL_MS = 3 * 60 * 60 * 1000;
const BOT_INTERVAL_MS = 800;

function newCode(): string {
  let code = "";
  do {
    code = Array.from(
      { length: 4 },
      () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)],
    ).join("");
  } while (store.rooms.has(code));
  return code;
}

function sweep() {
  const now = Date.now();
  for (const [code, room] of store.rooms) {
    if (now - room.lastTouchedAt > ROOM_TTL_MS) store.rooms.delete(code);
  }
}

export function createRoom(opts: {
  nightDurationSecs: number;
  voteDurationSecs: number;
  minPlayers?: number;
  maxPlayers?: number;
  hiddenCount?: number;
  seerCount?: number;
  tasksPerPlayer?: number;
  confirmEjects?: boolean;
}): Room {
  sweep();
  const code = newCode();
  // Committed before the first player joins, so it cannot be aimed at anyone.
  const hostSeed = randomSalt();
  const room: Room = {
    code,
    game: engine.createGame({
      host: "relay",
      ...opts,
      seedCommitment: seedCommitment(hostSeed),
    }),
    ship: null,
    hiddenSeats: [],
    salt: "",
    hostSeed,
    version: 1,
    claims: {},
    hostPlayerId: null,
    lastBotAt: 0,
    lastTouchedAt: Date.now(),
  };
  store.rooms.set(code, room);
  return room;
}

export function getRoom(code: string): Room | null {
  return store.rooms.get(code.toUpperCase()) ?? null;
}

export type LobbyListing = {
  code: string;
  seated: number;
  maxPlayers: number;
  hiddenCount: number;
  hostName: string;
};

/** Open lobbies only — in-progress rounds stay off the public board. */
export function listLobbies(): LobbyListing[] {
  sweep();
  return [...store.rooms.values()]
    .filter((room) => room.game.phase === Phase.LOBBY)
    .sort((a, b) => b.lastTouchedAt - a.lastTouchedAt)
    .map((room) => ({
      code: room.code,
      seated: room.game.seats.length,
      maxPlayers: room.game.maxPlayers,
      hiddenCount: room.game.hiddenCount,
      hostName: room.game.seats[0]?.name ?? "Host",
    }));
}

// ── actions ────────────────────────────────────────────────────────────────

export type Action =
  | { type: "join"; playerId: string; name: string }
  | { type: "addBot" }
  | { type: "resetLobby" }
  | {
      type: "configure";
      nightDurationSecs: number;
      voteDurationSecs: number;
      minPlayers?: number;
      maxPlayers?: number;
      hiddenCount?: number;
      seerCount?: number;
      tasksPerPlayer?: number;
      confirmEjects?: boolean;
    }
  | { type: "assignRoles" }
  | { type: "seeRole"; seat: number }
  | { type: "startNight" }
  | { type: "move"; seat: number; to: RoomId }
  | { type: "task"; seat: number; taskId: string }
  | { type: "kill"; seat: number; victim: number }
  | { type: "confirmDeath"; seat: number }
  | { type: "reportBody"; seat: number; victim: number }
  | { type: "skipNight" }
  | { type: "endVote" }
  | { type: "callMeeting"; seat: number }
  | { type: "investigate"; seat: number; target: number }
  | { type: "vent"; seat: number }
  | { type: "sabotageLights"; seat: number }
  | { type: "sabotageReactor"; seat: number }
  | { type: "fixReactor"; seat: number }
  | { type: "fixLights"; seat: number }
  | { type: "vote"; seat: number; candidate: number }
  | { type: "resolve" }
  | { type: "continue" }
  | { type: "payout" };

/**
 * Apply one action. Engine guards throw `ContractError`, which the route turns
 * into a 409 carrying the contract's own message — so an illegal action on a
 * remote client reads exactly like it does locally.
 */
export function applyAction(room: Room, action: Action): void {
  const g0 = room.game;

  switch (action.type) {
    case "join": {
      // One playerId, one seat — same as `joined[caller]` on-chain. A second
      // join from this address is a no-op so a refresh cannot fill a ghost seat.
      if (room.claims[action.playerId] !== undefined) break;
      const session = generateSessionKey();
      room.game = engine.join(g0, {
        name: action.name,
        wallet: placeholderWallet(),
        sessionKey: session.publicKey,
        sessionPrivateKey: session.privateKey,
        payoutNoteId: placeholderPayoutNote(),
        entropy: randomEntropy(),
      });
      room.claims[action.playerId] = room.game.seats.length - 1;
      // First through the door hosts it.
      room.hostPlayerId ??= action.playerId;
      break;
    }

    case "addBot": {
      const session = generateSessionKey();
      room.game = engine.join(g0, {
        name: botName(g0.seats),
        isBot: true,
        wallet: placeholderWallet(),
        sessionKey: session.publicKey,
        sessionPrivateKey: session.privateKey,
        payoutNoteId: placeholderPayoutNote(),
        entropy: randomEntropy(),
      });
      break;
    }

    case "resetLobby": {
      if (g0.phase !== Phase.LOBBY) throw new engine.ContractError("not in lobby");
      const humans = [...g0.seats]
        .filter((s) => !s.isBot)
        .sort((a, b) => a.seat - b.seat);
      const hostSeed = randomSalt();
      room.game = engine.createGame({
        host: "relay",
        nightDurationSecs: g0.nightDurationSecs,
        voteDurationSecs: g0.voteDurationSecs,
        minPlayers: g0.minPlayers,
        maxPlayers: g0.maxPlayers,
        hiddenCount: g0.hiddenCount,
        seerCount: g0.seerCount,
        tasksPerPlayer: g0.tasksPerPlayer,
        confirmEjects: g0.confirmEjects,
        seedCommitment: seedCommitment(hostSeed),
      });
      room.hostSeed = hostSeed;
      room.hiddenSeats = [];
      room.salt = "";
      room.ship = null;
      const playerBySeat = new Map(
        Object.entries(room.claims).map(([playerId, seat]) => [seat, playerId]),
      );
      const nextClaims: Record<string, number> = {};
      for (const who of humans) {
        const playerId = playerBySeat.get(who.seat);
        if (!playerId) continue;
        const session = generateSessionKey();
        room.game = engine.join(room.game, {
          name: who.name,
          wallet: placeholderWallet(),
          sessionKey: session.publicKey,
          sessionPrivateKey: session.privateKey,
          payoutNoteId: placeholderPayoutNote(),
          entropy: randomEntropy(),
        });
        nextClaims[playerId] = room.game.seats.length - 1;
      }
      room.claims = nextClaims;
      break;
    }

    case "configure":
      room.game = engine.configureLobby(g0, {
        nightDurationSecs: action.nightDurationSecs,
        voteDurationSecs: action.voteDurationSecs,
        minPlayers: action.minPlayers,
        maxPlayers: action.maxPlayers,
        hiddenCount: action.hiddenCount,
        seerCount: action.seerCount,
        tasksPerPlayer: action.tasksPerPlayer,
        confirmEjects: action.confirmEjects,
      });
      break;

    case "assignRoles": {
      const combined = combinedSeed(
        room.hostSeed,
        g0.seats.map((s) => s.entropy),
      );
      const { hidden: hiddenSeats, seers } = deriveRoles(
        combined,
        g0.seats.length,
        g0.hiddenCount,
        g0.seerCount,
      );
      const salt = randomSalt();
      room.game = engine.assignRoles(g0, {
        hiddenSeats,
        seerSeats: seers,
        salt,
        commitment: poseidonCommitment(hiddenSeats, salt),
      });
      room.hiddenSeats = hiddenSeats;
      room.salt = salt;
      break;
    }

    case "seeRole":
      room.game = engine.markRoleSeen(g0, action.seat);
      break;

    case "startNight":
      room.game = engine.startNight(g0);
      room.ship = ship.withCrewProgress(
        ship.initShip(room.game.seats.map((s) => s.seat), room.game.tasksPerPlayer),
        crewSeatsOf(room.game),
      );
      break;

    case "move":
      if (room.ship) {
        room.ship = ship.move(
          room.ship,
          action.seat,
          action.to,
          g0.seats.filter((s) => !s.dead).map((s) => s.seat),
        );
      }
      break;

    case "task": {
      const me = g0.seats.find((x) => x.seat === action.seat);
      // The on-chain half. Submitted by everyone, impostors included — the
      // contract cannot tell them apart until the roles open, and discards
      // theirs then. Its own per-seat cap is what stops anyone inflating the
      // bar, so a rejection here is a real rule, not bookkeeping.
      room.game = engine.submitTask(g0, engine.seatOf(g0, action.seat).sessionKey);
      if (room.ship) {
        room.ship = ship.withCrewProgress(
          ship.completeTask(room.ship, action.seat, action.taskId, {
            isImpostor: me?.role === "IMPOSTOR",
            living: g0.seats.filter((x) => !x.dead).map((x) => x.seat),
          }),
          crewSeatsOf(room.game),
        );
      }
      break;
    }

    case "kill": {
      // Every one of these was enforced only by hiding the button. Over the
      // relay a second client can simply POST, so the server has to check.
      const killer = g0.seats.find((x) => x.seat === action.seat);
      if (!killer || killer.dead) throw new engine.ContractError("dead cannot kill");
      if (killer.role !== "IMPOSTOR") throw new engine.ContractError("only an impostor kills");
      if (!room.ship) throw new engine.ContractError("no deck");
      if (!ship.killReady(room.ship)) throw new engine.ContractError("kill on cooldown");
      if (room.ship.positions[action.seat] !== room.ship.positions[action.victim]) {
        throw new engine.ContractError("not in the same room");
      }
      room.game = engine.privateKill(g0, action.victim);
      room.ship = ship.armKillCooldown(room.ship);
      break;
    }

    case "investigate": {
      // Co-located, like the kill: a seer has to walk to the person they want
      // to read, which costs them the tasks they did not do instead. The
      // engine cannot check this itself — positions are ship state, not
      // `GameState` — so the guard has to live here.
      if (!room.ship) throw new engine.ContractError("no deck");
      // Role first, position second: otherwise a crewmate who tries this is
      // told "not in the same room", which is true but not the reason.
      const asker = g0.seats.find((x) => x.seat === action.seat);
      if (asker?.role !== "SEER") throw new engine.ContractError("not the seer");
      if (room.ship.positions[action.seat] !== room.ship.positions[action.target]) {
        throw new engine.ContractError("not in the same room");
      }
      room.game = engine.investigate(g0, action.seat, action.target);
      break;
    }

    case "callMeeting":
      // Mirrors the Cairo guard. It cannot live in `engine.ts`, which only
      // sees GameState — the reactor is ship state — so it has to be enforced
      // here and in the store, wherever both halves are in scope.
      if (room.ship && ship.reactorGoing(room.ship)) {
        throw new engine.ContractError("fix the reactor first");
      }
      room.game = engine.callMeeting(g0, action.seat);
      break;

    case "vent": {
      // Venting leaves no sighting, so crew doing it is free untraceable
      // teleportation.
      const who = g0.seats.find((x) => x.seat === action.seat);
      if (who?.role !== "IMPOSTOR") throw new engine.ContractError("only an impostor vents");
      if (who.dead) throw new engine.ContractError("dead cannot vent");
      if (room.ship) room.ship = ship.vent(room.ship, action.seat);
      break;
    }

    case "sabotageLights":
      requireImpostor(room, action.seat);
      if (room.ship) room.ship = ship.sabotageLights(room.ship);
      break;

    case "sabotageReactor":
      requireImpostor(room, action.seat);
      if (room.ship) room.ship = ship.sabotageReactor(room.ship);
      break;

    case "fixReactor":
      // The whole point of the meltdown is that somebody has to walk there.
      requireIn(room, action.seat, "reactor");
      // `fix_reactor` asserts `now <= deadline` on-chain. Without the same check
      // here, arriving after it blew still cleared it — erasing a win the
      // impostors had already earned.
      if (room.ship && !ship.reactorFixable(room.ship)) {
        throw new engine.ContractError("too late");
      }
      if (room.ship) room.ship = ship.fixReactor(room.ship);
      break;

    case "fixLights":
      requireIn(room, action.seat, "electrical");
      if (room.ship) room.ship = ship.fixLights(room.ship);
      break;

    case "confirmDeath":
      room.game = engine.confirmDeath(g0, engine.seatOf(g0, action.seat).sessionKey);
      if (room.ship) {
        // The corpse stays where they fell; the ghost walks on from here.
        room.ship = ship.withCrewProgress(
          ship.dropBody(room.ship, action.seat),
          crewSeatsOf(room.game),
        );
      }
      break;

    case "reportBody": {
      // You have to be standing over it. The engine cannot check this —
      // positions are deck state, not `GameState` — so the guard lives here,
      // the same as the kill and the seer's check.
      if (!room.ship) throw new engine.ContractError("no deck");
      if (room.ship.bodies[action.victim] !== room.ship.positions[action.seat]) {
        throw new engine.ContractError("no body here");
      }
      room.game = engine.reportBody(
        g0,
        engine.seatOf(g0, action.seat).sessionKey,
        action.victim,
      );
      break;
    }

    case "skipNight":
      room.game = engine.skipNight(g0);
      break;

    case "endVote":
      // A blown reactor must be resolved, not rounded past.
      if (room.ship && ship.reactorBlown(room.ship)) {
        throw new engine.ContractError("resolve the reactor");
      }
      room.game = engine.endVote(g0);
      if (room.ship) {
        room.ship = ship.withCrewProgress(
          ship.resetForRound(room.ship, room.game.seats.map((x) => x.seat)),
          crewSeatsOf(room.game),
        );
      }
      break;

    case "vote":
      room.game = engine.handleVote(g0, { voterSeat: action.seat, candidateSeat: action.candidate });
      break;

    case "resolve": {
      if (room.hiddenSeats.length === 0) throw new engine.ContractError("roles not assigned");
      room.game = engine.resolveRound(g0, {
        hiddenSeats: room.hiddenSeats,
        salt: room.salt,
        hostSeed: room.hostSeed,
        recomputedCommitment: poseidonCommitment(room.hiddenSeats, room.salt),
        recomputedSeedCommitment: seedCommitment(room.hostSeed),
      });
      break;
    }

    /**
     * One button for the host: finish if the game is over, otherwise play on.
     *
     * The client cannot make this call itself. Mid-game the roles are sealed —
     * that is the entire premise — so nothing outside the contract knows
     * whether the round is decided. And the contract cannot be asked without
     * being told: checking the win condition means opening the roles, which is
     * exactly what `resolve_round` does and what must not happen early.
     *
     * So we try to finish and let the contract's own guard answer. "game not
     * over" is not an error here, it is the answer, and the round plays on. On
     * chain that costs a reverted call before the real one; off chain it is
     * free. What it buys is that the host can no longer round *past* a win they
     * could not see — which is precisely what happened: a table voted out the
     * last impostor and the game cheerfully started another night.
     */
    case "continue": {
      if (room.hiddenSeats.length === 0) throw new engine.ContractError("roles not assigned");
      // A blown reactor is decided before anything else: the contract watched
      // its own deadline pass, so it needs nobody's word for it.
      if (room.ship && ship.reactorBlown(room.ship)) {
        room.game = engine.resolveSabotage(g0, {
          hiddenSeats: room.hiddenSeats,
          salt: room.salt,
          hostSeed: room.hostSeed,
          recomputedCommitment: poseidonCommitment(room.hiddenSeats, room.salt),
          recomputedSeedCommitment: seedCommitment(room.hostSeed),
        });
        break;
      }
      try {
        room.game = engine.resolveRound(g0, {
          hiddenSeats: room.hiddenSeats,
          salt: room.salt,
          hostSeed: room.hostSeed,
          recomputedCommitment: poseidonCommitment(room.hiddenSeats, room.salt),
          recomputedSeedCommitment: seedCommitment(room.hostSeed),
        });
        break;
      } catch (e) {
        if (!(e instanceof engine.ContractError) || e.message !== "game not over") throw e;
      }
      // Not decided: play the next round instead.
      if (room.ship && ship.reactorBlown(room.ship)) {
        throw new engine.ContractError("resolve the reactor");
      }
      room.game = engine.endVote(g0);
      if (room.ship) {
        room.ship = ship.withCrewProgress(
          ship.resetForRound(room.ship, room.game.seats.map((x) => x.seat)),
          crewSeatsOf(room.game),
        );
      }
      break;
    }

    case "payout":
      room.game = engine.payout(g0);
      break;
  }

  room.version += 1;
  room.lastTouchedAt = Date.now();
}

/** Only an impostor may sabotage, and not on cooldown. */
function requireImpostor(room: Room, seat: number): void {
  const who = room.game.seats.find((x) => x.seat === seat);
  if (who?.role !== "IMPOSTOR") throw new engine.ContractError("only an impostor sabotages");
  if (who.dead) throw new engine.ContractError("dead cannot sabotage");
  // Enforced here, not only by greying the button out: over the relay a second
  // client can post directly, and holding the deck dark all night is the most
  // effective thing an unlimited sabotage could do.
  if (room.ship && !ship.sabotageReady(room.ship)) {
    throw new engine.ContractError("sabotage on cooldown");
  }
}

/** You must actually be standing there to fix it. */
function requireIn(room: Room, seat: number, roomId: RoomId): void {
  const who = room.game.seats.find((x) => x.seat === seat);
  if (!who || who.dead) throw new engine.ContractError("dead cannot fix");
  if (!room.ship || room.ship.positions[seat] !== roomId) {
    throw new engine.ContractError("you are not there");
  }
}

/** Host-only actions, mirroring `assert_host` in the Cairo. */
export const HOST_ONLY = [
  "addBot",
  "resetLobby",
  "configure",
  "assignRoles",
  "startNight",
  "endVote",
  "skipNight",
  "resolve",
  // Continue is resolve-or-end-vote, and both of those are host-only. Missing
  // it here let any joined player drive the round to its finish.
  "continue",
  "payout",
];

export function isHost(room: Room, playerId: string | null): boolean {
  // Before anyone has joined there is no host yet, so the first join is let
  // through; after that only the room's opener.
  return room.hostPlayerId === null || room.hostPlayerId === playerId;
}

const BOT_NAMES = ["Nova", "Rhea", "Juno", "Atlas", "Vega", "Orion", "Lyra"];
function botName(seats: Seat[]): string {
  const taken = new Set(seats.map((s) => s.name));
  return BOT_NAMES.find((n) => !taken.has(n)) ?? `Bot ${seats.length}`;
}

/**
 * Advance bots at most one step, rate-limited.
 *
 * Driven lazily off client requests rather than a `setInterval`: a timer would
 * keep every abandoned room ticking forever, and would not survive the module
 * reloads that Next does in dev.
 */
export function tickBots(room: Room): void {
  const now = Date.now();
  if (now - room.lastBotAt < BOT_INTERVAL_MS) return;

  const action =
    room.game.phase === Phase.NIGHT
      ? room.ship
        ? nextNightAction(room.game, room.ship)
        : null
      : nextBotAction(room.game);
  if (!action) return;

  room.lastBotAt = now;
  try {
    switch (action.kind) {
      case "seeRole":
        applyAction(room, { type: "seeRole", seat: action.seat });
        break;
      case "kill":
        applyAction(room, { type: "kill", seat: action.impostor, victim: action.victim });
        break;
      case "report":
        applyAction(room, { type: "confirmDeath", seat: action.seat });
        break;
      case "reportBody":
        applyAction(room, {
          type: "reportBody",
          seat: action.finder,
          victim: action.victim,
        });
        break;
      case "vote":
        applyAction(room, { type: "vote", seat: action.voter, candidate: action.candidate });
        break;
      case "move":
        applyAction(room, { type: "move", seat: action.seat, to: action.to });
        break;
      case "task":
        applyAction(room, { type: "task", seat: action.seat, taskId: action.taskId });
        break;
      case "check":
        applyAction(room, { type: "investigate", seat: action.seer, target: action.target });
        break;
    }
  } catch {
    // A bot racing a human (both voting the same tick) can lose; skip the beat.
  }
}

// ── redaction ──────────────────────────────────────────────────────────────

export type ViewerState = {
  code: string;
  version: number;
  seat: number | null;
  isHost: boolean;
  game: GameState;
  ship: ShipState | null;
};

/**
 * The state one player is allowed to see.
 *
 * Roles, burner private keys and other players' positions are stripped. This
 * is the difference between "the impostor is hidden" and "the impostor is
 * hidden unless you open devtools".
 */
export function viewFor(room: Room, seat: number | null, playerId: string | null = null): ViewerState {
  const revealed = room.game.phase === Phase.RESOLVED;

  // Among Us tells the impostors who their partners are. Without it a
  // multi-impostor game is broken rather than merely harder: they cannot
  // coordinate, and `privateKill` rejects a partner as "impostor cannot kill
  // self", which reads as a bug to someone who was never told.
  //
  // Only the IMPOSTOR label crosses, and only to an impostor — a seer is not
  // exposed to them, and crew learn nothing.
  const viewerRole = seat === null ? undefined : room.game.seats[seat]?.role;
  const viewerIsImpostor = viewerRole === "IMPOSTOR";

  const seats = room.game.seats.map((s) => {
    const mine = s.seat === seat;
    const partner = viewerIsImpostor && s.role === "IMPOSTOR";
    return {
      ...s,
      role: mine || revealed || partner ? s.role : undefined,
      sessionPrivateKey: mine ? s.sessionPrivateKey : "",
      // A check result is knowledge one player had to spend their night
      // earning. Shipping it to the table would hand everyone the answer.
      checks: mine ? s.checks : {},
      // A non-negative `checkedRound` only ever belongs to a seer, so leaving
      // it public would name them as surely as the role field would.
      checkedRound: mine ? s.checkedRound : -1,
      // The public key is fine to share — it is what `report_night_kill` is
      // signed by and appears on-chain anyway.
    };
  });

  let shipView: ShipState | null = null;
  if (room.ship) {
    const myRoom = seat === null ? null : room.ship.positions[seat];
    const positions: Record<number, RoomId> = {};
    for (const [k, v] of Object.entries(room.ship.positions)) {
      const n = Number(k);
      // Fog of war: you see yourself, and whoever shares your room.
      if (n === seat || (myRoom !== null && v === myRoom)) positions[n] = v;
    }
    shipView = {
      killReadyAt: room.ship.killReadyAt,
      lightsOutUntil: room.ship.lightsOutUntil,
      // Everyone must see the meltdown - it is the one thing the whole crew
      // has to react to at once.
      reactorDeadline: room.ship.reactorDeadline,
      // Without this the client cannot tell the cooldown is running and the
      // button looks broken rather than disabled.
      sabotageReadyAt: room.ship.sabotageReadyAt,
      crewProgress: room.ship.crewProgress,
      positions,
      // Task lists are sent in full, deliberately. They carry no role
      // information — the impostor gets a list too — and the shared crew
      // progress bar is computed from all of them, so redacting them would
      // show every player only their own three tasks as "the crew total".
      tasks: room.ship.tasks,
      // Bodies obey the same fog as crewmates: you see the one you are standing
      // over, nothing else. Broadcasting the map of corpses would hand everyone
      // the murder scene without anyone having to walk there.
      bodies: Object.fromEntries(
        Object.entries(room.ship.bodies).filter(([, r]) => myRoom !== null && r === myRoom),
      ) as Record<number, RoomId>,
      sightings: room.ship.sightings.filter((s) => s.observer === seat),
    };
  }

  return {
    code: room.code,
    version: room.version,
    seat,
    isHost: room.hostPlayerId !== null && room.hostPlayerId === playerId,
    game: {
      ...room.game,
      seats,
      // Only the victim knows a note arrived. Broadcasting it told the whole
      // table who had been hit before they reported — which is exactly what
      // `report_night_kill` exists to keep private.
      pendingVictim:
        seat !== null && room.game.pendingVictim === seat + 1 ? room.game.pendingVictim : 0,
      // The team and the salt are the commitment's preimage: releasing either
      // early would let a client compute who is hidden before the reveal.
      hiddenSeats: revealed ? room.game.hiddenSeats : [],
      seerSeats: revealed ? room.game.seerSeats : [],
      salt: revealed ? room.game.salt : "",
    },
    ship: shipView,
  };
}

export function seatOfPlayer(room: Room, playerId: string | null): number | null {
  if (!playerId) return null;
  const seat = room.claims[playerId];
  return seat === undefined ? null : seat;
}

/**
 * Make a view JSON-safe.
 *
 * `tallies` and `totalVotes` are `bigint` in the engine, and `JSON.stringify`
 * throws outright on a bigint — without this every room response is a 500.
 * They go out as strings and `online.ts` revives them.
 */
export function jsonSafe(view: ViewerState) {
  return {
    ...view,
    game: {
      ...view.game,
      totalVotes: view.game.totalVotes.toString(),
      // Every bigint on GameState must be listed here. Missing one does not
      // degrade gracefully - JSON.stringify throws and the whole route 500s.
      skipTally: view.game.skipTally.toString(),
      tallies: Object.fromEntries(
        Object.entries(view.game.tallies).map(([seat, n]) => [seat, n.toString()]),
      ),
    },
  };
}
