"use client";

/**
 * Client-side game store.
 *
 * Holds the `GameState` the engine operates on, plus the small amount of UI
 * state that has no on-chain counterpart: who is currently holding the device
 * (`viewerSeat`) and whether their secret is currently uncovered.
 *
 * v1 is pass-the-device: one browser, players take turns. A lobby shared
 * across machines needs an indexer or a relay for the encrypted notes, which
 * is out of scope for the sprint (docs/TIMELINE.md). Everything that *would*
 * be a transaction goes through the engine, so the wiring seam is one layer.
 */

import { create } from "zustand";
import * as engine from "./engine";
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
} from "./crypto";
import { nextBotName, type BotAction } from "./bots";
import * as ship from "./ship";
import type { RoomId, ShipState } from "./ship";
import * as online from "./online";
import { Phase, type GameState } from "./types";

type Store = {
  game: GameState | null;
  /** Seat currently holding the device. null = nobody / host view. */
  viewerSeat: number | null;
  /** Secrets stay covered until the holder explicitly uncovers them. */
  revealed: boolean;
  /**
   * Rooms, tasks and sightings. Kept beside `game` rather than inside it
   * because none of it exists on-chain — see the note atop `ship.ts`.
   */
  ship: ShipState | null;
  error: string | null;

  /**
   * "local" is pass-the-device on one screen. "online" relays every action to
   * the server, which runs the same engine and returns a redacted view — so
   * the panels below never learn which mode they are in.
   */
  mode: "local" | "online";
  roomCode: string | null;
  /** Our own seat in an online room; null until we have joined one. */
  mySeat: number | null;
  connecting: boolean;

  newGame: (opts: RoundOpts) => void;
  resetGame: () => void;

  addPlayer: (name: string, isBot?: boolean) => void;
  addBot: () => void;
  fillWithBots: () => void;
  assignRoles: () => void;
  startNight: () => void;
  kill: (victimSeat: number) => void;
  report: (seat: number) => void;
  skipNight: () => void;
  endVote: () => void;
  callMeeting: (seat: number) => void;
  investigate: (seat: number, target: number) => void;
  useVent: (seat: number) => void;
  sabotageLights: () => void;
  sabotageReactor: () => void;
  fixReactor: () => void;
  fixLights: () => void;
  vote: (voterSeat: number, candidateSeat: number) => void;
  /** Apply one bot action. Deliberately leaves viewer/reveal state alone. */
  botAct: (action: BotAction) => void;
  moveTo: (seat: number, to: RoomId) => void;
  completeTask: (seat: number, taskId: string) => void;
  resolve: () => void;
  payout: () => void;

  setViewer: (seat: number | null) => void;
  reveal: () => void;
  cover: () => void;
  seeRole: (seat: number) => void;
  clearError: () => void;

  hostRoom: (name: string, opts: RoundOpts) => Promise<void>;
  joinRoom: (code: string, name: string) => Promise<void>;
  leaveRoom: () => void;
  applyView: (view: online.RoomView) => void;
  send: (action: Record<string, unknown>) => Promise<void>;
};

/**
 * What the host picks on the start screen.
 *
 * Named rather than inlined twice: `newGame` and `hostRoom` take the same
 * object, and the local and relay paths drifting apart is exactly how the
 * seer setting would get silently dropped on one of them.
 */
export type RoundOpts = {
  nightDurationSecs: number;
  voteDurationSecs: number;
  minPlayers?: number;
  maxPlayers?: number;
  hiddenCount?: number;
  seerCount?: number;
  tasksPerPlayer?: number;
  confirmEjects?: boolean;
};

/** Living non-impostors — the seats the shared crew bar counts. */
function crewSeatsOf(game: GameState): number[] {
  return game.seats.filter((x) => !x.dead && x.role !== "IMPOSTOR").map((x) => x.seat);
}

const HOST = "0xhost";

/** The local host's secret seed. Module-scoped rather than stored in
 * `GameState`, because `GameState` is the mirror of public contract state
 * and the seed must not appear there before the reveal. */
const hostSeedRef = { current: "" };

/**
 * Run an engine transition, surfacing a `ContractError` as UI state instead of
 * throwing — an illegal action should read like a rejected transaction, not
 * crash the app.
 */
function apply(set: (fn: (s: Store) => Partial<Store>) => void, fn: (g: GameState) => GameState) {
  set((s) => {
    if (!s.game) return {};
    try {
      return { game: fn(s.game), error: null };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  });
}

export const useGame = create<Store>((set, get) => ({
  game: null,
  viewerSeat: null,
  revealed: false,
  ship: null,
  error: null,
  mode: "local",
  roomCode: null,
  mySeat: null,
  connecting: false,

  newGame: (opts) =>
    set({
      // The host's seed is committed before anyone joins; it is kept out of
            // `GameState` (which is the public mirror) until the reveal.
            game: engine.createGame({
              host: HOST,
              ...opts,
              seedCommitment: seedCommitment((hostSeedRef.current = randomSalt())),
            }),
      viewerSeat: null,
      revealed: false,
      ship: null,
      error: null,
    }),

  resetGame: () =>
    set({ game: null, viewerSeat: null, revealed: false, ship: null, error: null }),

  /**
   * Join a seat. The burner keypair is generated here and the wallet address
   * is a placeholder until the wallet connector is wired — but the crucial
   * invariant (`session_key != wallet`) holds from the start, because the two
   * come from independent keypairs.
   */
  addPlayer: (name, isBot = false) => {
    if (get().mode === "online") {
      void get().send({ type: "join", name });
      return;
    }
    const session = generateSessionKey();
    apply(set, (g) =>
      engine.join(g, {
        name,
        isBot,
        wallet: placeholderWallet(),
        sessionKey: session.publicKey,
        sessionPrivateKey: session.privateKey,
        payoutNoteId: placeholderPayoutNote(),
        entropy: randomEntropy(),
      }),
    );
  },

  addBot: () => {
    if (get().mode === "online") {
      void get().send({ type: "addBot" });
      return;
    }
    const g = get().game;
    if (!g) return;
    get().addPlayer(nextBotName(g.seats), true);
  },

  /** Top the lobby up to the minimum so one person can start a round alone. */
  fillWithBots: () => {
    const g = get().game;
    if (!g) return;
    for (let i = g.seats.length; i < g.minPlayers; i += 1) {
      get().addBot();
    }
  },

  /** Host draws the impostor, commits to it, and sends the encrypted notes. */
  assignRoles: () => {
    if (get().mode === "online") {
      void get().send({ type: "assignRoles" });
      return;
    }
    const g = get().game;
    if (!g) return;
    // Derived from the committed host seed mixed with every player's entropy,
            // exactly as `resolve_round` will recompute it.
            const combined = combinedSeed(
              hostSeedRef.current,
              g.seats.map((s) => s.entropy),
            );
    // Impostors and seer come off one draw, so adding a seer cannot change
    // who the impostors are.
    const { hidden: hiddenSeats, seers } = deriveRoles(
      combined,
      g.seats.length,
      g.hiddenCount,
      g.seerCount,
    );
    const salt = randomSalt();
    const commitment = poseidonCommitment(hiddenSeats, salt);
    apply(set, (s) =>
      engine.assignRoles(s, { hiddenSeats, seerSeats: seers, salt, commitment }),
    );
    set({ viewerSeat: null, revealed: false });
  },

  startNight: () => {
    if (get().mode === "online") {
      void get().send({ type: "startNight" });
      return;
    }
    apply(set, (g) => engine.startNight(g));
    const g = get().game;
    set({
      viewerSeat: null,
      revealed: false,
      ship: g
        ? ship.withCrewProgress(
            ship.initShip(g.seats.map((x) => x.seat), g.tasksPerPlayer),
            crewSeatsOf(g),
          )
        : null,
    });
  },

  /** Walk one room. Sightings are recorded by the ship reducer. */
  moveTo: (seat, to) => {
    if (get().mode === "online") {
      void get().send({ type: "move", to });
      return;
    }
    set((st) => {
      if (!st.ship || !st.game) return {};
      // `living` gates who can be *seen*, not who may move - a ghost still
      // walks the deck to finish its tasks.
      const living = st.game.seats.filter((x) => !x.dead).map((x) => x.seat);
      return { ship: ship.move(st.ship, seat, to, living) };
    });
  },

  completeTask: (seat, taskId) => {
    if (get().mode === "online") {
      void get().send({ type: "task", taskId });
      return;
    }
    set((st) => {
      if (!st.ship || !st.game) return {};
      const me = st.game.seats.find((x) => x.seat === seat);
      const next = ship.completeTask(st.ship, seat, taskId, {
        isImpostor: me?.role === "IMPOSTOR",
        living: st.game.seats.filter((x) => !x.dead).map((x) => x.seat),
      });
      return { ship: ship.withCrewProgress(next, crewSeatsOf(st.game)) };
    });
  },

  kill: (victimSeat) => {
    if (get().mode === "online") {
      void get().send({ type: "kill", victim: victimSeat });
      return;
    }
    apply(set, (g) => engine.privateKill(g, victimSeat));
    set((st) => (st.ship ? { ship: ship.armKillCooldown(st.ship) } : {}));
  },

  report: (seat) => {
    if (get().mode === "online") {
      void get().send({ type: "report" });
      return;
    }
    apply(set, (g) => {
      const s = engine.seatOf(g, seat);
      return engine.reportNightKill(g, s.sessionKey);
    });
    const g2 = get().game;
    set((st) => (st.ship && g2 ? { ship: ship.withCrewProgress(st.ship, crewSeatsOf(g2)) } : {}));
  },

  skipNight: () => {
    if (get().mode === "online") {
      void get().send({ type: "skipNight" });
      return;
    }
    apply(set, (g) => engine.skipNight(g));
  },

  /** Close this round and start the next night. */
  endVote: () => {
    if (get().mode === "online") {
      void get().send({ type: "endVote" });
      return;
    }
    const pre = get();
    if (pre.ship && ship.reactorBlown(pre.ship)) {
      set({ error: "resolve the reactor" });
      return;
    }
    apply(set, (g) => engine.endVote(g));
    const g = get().game;
    set((st) =>
      st.ship && g
        ? {
            // A death changes who the crew are, so the bar's total moves too.
            ship: ship.withCrewProgress(
              ship.resetForRound(st.ship, g.seats.map((x) => x.seat)),
              crewSeatsOf(g),
            ),
          }
        : {},
    );
  },

  callMeeting: (seat) => {
    if (get().mode === "online") {
      void get().send({ type: "callMeeting" });
      return;
    }
    // Same guard as the contract and the relay: a meeting must not be a free
    // way to delete a sabotage.
    const st = get();
    if (st.ship && ship.reactorGoing(st.ship)) {
      set({ error: "fix the reactor first" });
      return;
    }
    apply(set, (g) => engine.callMeeting(g, seat));
  },

  investigate: (seat, target) => {
    if (get().mode === "online") {
      void get().send({ type: "investigate", target });
      return;
    }
    apply(set, (g) => engine.investigate(g, seat, target));
  },

  useVent: (seat) => {
    if (get().mode === "online") {
      void get().send({ type: "vent" });
      return;
    }
    set((st) => (st.ship ? { ship: ship.vent(st.ship, seat) } : {}));
  },

  sabotageLights: () => {
    // Mirrors the relay guard; the local deck is one trusted device but the
    // two paths drifting is how a rule quietly stops applying in solo play.
    const st0 = get();
    if (st0.mode === "local" && st0.ship && !ship.sabotageReady(st0.ship)) {
      set({ error: "sabotage on cooldown" });
      return;
    }
    if (get().mode === "online") {
      void get().send({ type: "sabotageLights" });
      return;
    }
    set((st) => (st.ship ? { ship: ship.sabotageLights(st.ship) } : {}));
  },

  sabotageReactor: () => {
    const st1 = get();
    if (st1.mode === "local" && st1.ship && !ship.sabotageReady(st1.ship)) {
      set({ error: "sabotage on cooldown" });
      return;
    }
    if (get().mode === "online") {
      void get().send({ type: "sabotageReactor" });
      return;
    }
    set((st) => (st.ship ? { ship: ship.sabotageReactor(st.ship) } : {}));
  },

  fixReactor: () => {
    if (get().mode === "online") {
      void get().send({ type: "fixReactor" });
      return;
    }
    set((st) => (st.ship ? { ship: ship.fixReactor(st.ship) } : {}));
  },

  fixLights: () => {
    if (get().mode === "online") {
      void get().send({ type: "fixLights" });
      return;
    }
    set((st) => (st.ship ? { ship: ship.fixLights(st.ship) } : {}));
  },

  vote: (voterSeat, candidateSeat) => {
    if (get().mode === "online") {
      void get().send({ type: "vote", candidate: candidateSeat });
      return;
    }
    apply(set, (g) => engine.handleVote(g, { voterSeat, candidateSeat }));
    set({ viewerSeat: null, revealed: false });
  },

  /** Host opens the commitment. Recomputed here so a mismatch is caught. */
  resolve: () => {
    if (get().mode === "online") {
      void get().send({ type: "resolve" });
      return;
    }
    const g = get().game;
    if (!g || g.hiddenSeats.length === 0) return;
    apply(set, (s) =>
      engine.resolveRound(s, {
        hiddenSeats: g.hiddenSeats,
        salt: g.salt,
        hostSeed: hostSeedRef.current,
        recomputedCommitment: poseidonCommitment(g.hiddenSeats, g.salt),
        recomputedSeedCommitment: seedCommitment(hostSeedRef.current),
      }),
    );
  },

  payout: () => {
    if (get().mode === "online") {
      void get().send({ type: "payout" });
      return;
    }
    apply(set, (g) => engine.payout(g));
  },

  /**
   * Bots act through the same engine transitions as people — but must never
   * touch `viewerSeat`/`revealed`, or a bot voting in the background would
   * yank a human out of their own reveal screen mid-turn.
   */
  botAct: (action) => {
    if (action.kind === "move") {
      get().moveTo(action.seat, action.to);
      return;
    }
    if (action.kind === "task") {
      get().completeTask(action.seat, action.taskId);
      return;
    }
    apply(set, (g) => {
      switch (action.kind) {
        case "seeRole":
          return engine.markRoleSeen(g, action.seat);
        case "kill":
          return engine.privateKill(g, action.victim);
        case "check":
          return engine.investigate(g, action.seer, action.target);
        case "report":
          return engine.reportNightKill(g, engine.seatOf(g, action.seat).sessionKey);
        case "vote":
          return engine.handleVote(g, {
            voterSeat: action.voter,
            candidateSeat: action.candidate,
          });
        default:
          // "move" / "task" are routed to the deck above and never reach here.
          return g;
      }
    });
  },

  setViewer: (seat) => set({ viewerSeat: seat, revealed: false }),
  reveal: () => set({ revealed: true }),
  cover: () =>
    set((st) =>
      st.mode === "online" ? {} : { revealed: false, viewerSeat: null },
    ),
  seeRole: (seat) => {
    if (get().mode === "online") {
      void get().send({ type: "seeRole" });
      return;
    }
    apply(set, (g) => engine.markRoleSeen(g, seat));
  },
  clearError: () => set({ error: null }),

  // ── online ───────────────────────────────────────────────────────────

  /** Open a relayed room and take the first seat. */
  hostRoom: async (name, opts) => {
    set({ connecting: true, error: null });
    try {
      const code = await online.createRoom(opts);
      set({ mode: "online", roomCode: code });
      await get().joinRoom(code, name);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ connecting: false });
    }
  },

  /** Join an existing room by code. */
  joinRoom: async (code, name) => {
    set({ connecting: true, error: null, mode: "online", roomCode: code.toUpperCase() });
    try {
      const view = await online.sendAction(code.toUpperCase(), { type: "join", name });
      get().applyView(view);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ connecting: false });
    }
  },

  leaveRoom: () =>
    set({
      mode: "local",
      roomCode: null,
      mySeat: null,
      game: null,
      ship: null,
      viewerSeat: null,
      revealed: false,
      error: null,
    }),

  /**
   * Fold a server view into the store.
   *
   * `viewerSeat`/`revealed` are pinned to our own seat: online there is no
   * device to pass, so the cover screen would only be in the way.
   */
  applyView: (view) =>
    set({
      game: view.game,
      ship: view.ship,
      mySeat: view.seat,
      roomCode: view.code,
      viewerSeat: view.seat,
      revealed: true,
    }),

  /** Post one action and fold in the resulting view. */
  send: async (action) => {
    const code = get().roomCode;
    if (!code) return;
    try {
      get().applyView(await online.sendAction(code, action));
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },
}));

/**
 * The seat this screen belongs to, or null if the screen is shared.
 *
 * Online it is your own seat — there is no device to pass. Locally it is the
 * only human at the table, if there is exactly one; a solo game against bots
 * has nobody to hide from either. Two or more humans on one screen returns
 * null, which is the genuine hot seat the pass-the-device gate exists for.
 */
export function ownDeviceSeat(
  game: GameState | null,
  mode: "local" | "online",
  mySeat: number | null,
): number | null {
  if (!game) return null;
  if (mode === "online") return mySeat;
  const humans = game.seats.filter((x) => !x.isBot);
  return humans.length === 1 ? humans[0].seat : null;
}

/** Convenience selectors. */
export const selectPhase = (s: Store) => s.game?.phase ?? Phase.LOBBY;
