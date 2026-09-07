/**
 * Among Us, with the settings a host actually tweaks.
 *
 * This used to carry five "variants" — Among Us, One Night Werewolf, Secret
 * Hitler, Avalon, Blood on the Clocktower. That was dropped deliberately.
 * Measured, only three of the five were mechanically distinct: Werewolf,
 * Secret Hitler and Avalon were byte-identical configurations (5-10 players,
 * 2 hidden) differing only in vocabulary. Worse, Avalon and Secret Hitler have
 * no night kill at all — Avalon is quests, Secret Hitler is policy cards — so
 * modelling them as "hidden team kills someone at night" misrepresented the
 * games they were named after.
 *
 * Claiming one game you actually implement beats claiming five where two are
 * wrong. The generalisation the RFP asks about is still real and still in the
 * contract: `SignalRound` takes `min_players`, `max_players` and
 * `hidden_count`, so another hidden-role game is a different constructor call,
 * not a fork. It is simply not dressed up as five menu entries.
 */

export type Settings = {
  /** Seats the lobby will accept. Among Us runs 4-15; the contract caps at 15. */
  maxPlayers: number;
  /** How many impostors. The contract requires 2 * impostors < minPlayers. */
  impostors: number;
  /** Tasks dealt to each player. */
  tasksPerPlayer: number;
  /**
   * Give one crewmate the seer's night check.
   *
   * The RFP names night actions as "impostor kills, seer checks", so this is
   * the RFP's role rather than base Among Us's — the closest thing the real
   * game has is the Sheriff from The Other Roles mod. Off by default, because
   * vanilla Among Us has no investigative role.
   */
  seer: boolean;
  /** Seconds of free roam before a meeting can be forced. */
  nightSecs: number;
  /** Seconds the ballot stays open. */
  voteSecs: number;
  /**
   * Among Us's "Confirm Ejects". When off, the ejection scene does not say
   * whether the ejected player was an impostor — a real and much harder way to
   * play, because the crew never get a free confirmation.
   */
  confirmEjects: boolean;
};

export const IMPOSTOR_NAME = "Impostor";
export const IMPOSTOR_PLURAL = "Impostors";
export const CREW_NAME = "Crew";

export const SEER_NAME = "Seer";

export const MIN_IMPOSTORS = 1;
export const MAX_IMPOSTORS = 3;
export const MIN_TASKS = 1;
export const MAX_TASKS = 5;
export const MIN_TIMER_SECS = 10;
export const MAX_TIMER_SECS = 1200;
export const TIMER_STEP_SECS = 5;
/** Common vote lengths the host can tap rather than stepping. */
export const VOTE_PRESETS = [15, 30, 45, 60, 90, 120] as const;
/** `SignalRound::CEIL_PLAYERS`. */
export const PLAYER_CEILING = 15;

export function formatSecs(n: number): string {
  if (n < 60) return `${n}s`;
  const m = Math.floor(n / 60);
  const s = n % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

export const DEFAULT_SETTINGS: Settings = {
  maxPlayers: 10,
  impostors: 1,
  tasksPerPlayer: 3,
  seer: false,
  nightSecs: 90,
  voteSecs: 120,
  confirmEjects: true,
};

/** Presets that fill the length fields; the host can still tune them. */
export const PACES = [
  { key: "demo", label: "Demo", night: 35, vote: 15 },
  { key: "quick", label: "Quick", night: 60, vote: 40 },
  { key: "full", label: "Full", night: 90, vote: 120 },
  { key: "table", label: "Table", night: 600, vote: 240 },
] as const;

/** Constructor-shaped opts the store and relay both accept. */
export function optsFromSettings(s: Settings) {
  const n = normalise(s);
  return {
    nightDurationSecs: n.nightSecs,
    voteDurationSecs: n.voteSecs,
    minPlayers: minPlayersFor(n.impostors),
    maxPlayers: n.maxPlayers,
    hiddenCount: n.impostors,
    seerCount: n.seer ? 1 : 0,
    tasksPerPlayer: n.tasksPerPlayer,
    confirmEjects: n.confirmEjects,
  };
}

export function settingsFromGame(g: {
  hiddenCount: number;
  maxPlayers: number;
  tasksPerPlayer: number;
  seerCount: number;
  nightDurationSecs: number;
  voteDurationSecs: number;
  confirmEjects: boolean;
}): Settings {
  return normalise({
    impostors: g.hiddenCount,
    maxPlayers: g.maxPlayers,
    tasksPerPlayer: g.tasksPerPlayer,
    seer: g.seerCount > 0,
    nightSecs: g.nightDurationSecs,
    voteSecs: g.voteDurationSecs,
    confirmEjects: g.confirmEjects,
  });
}

/**
 * Seats needed before roles can be assigned.
 *
 * Derived rather than configured: the contract asserts
 * `2 * hidden_count < min_players`, so the impostors must be a strict
 * minority. Exposing both numbers would just let a host build a lobby that
 * the constructor rejects.
 */
export function minPlayersFor(impostors: number): number {
  return Math.max(5, impostors * 2 + 1);
}

/** The right noun for a count, so nothing renders "2 impostor". */
export function impostorLabel(count: number): string {
  return count === 1 ? IMPOSTOR_NAME : IMPOSTOR_PLURAL;
}

/** Clamp a settings object into something the contract will accept. */
export function normalise(s: Settings): Settings {
  const impostors = clamp(s.impostors, MIN_IMPOSTORS, MAX_IMPOSTORS);
  const floor = minPlayersFor(impostors);
  return {
    impostors,
    maxPlayers: clamp(s.maxPlayers, floor, PLAYER_CEILING),
    tasksPerPlayer: clamp(s.tasksPerPlayer, MIN_TASKS, MAX_TASKS),
    // `hidden_count + seer_count < min_players` in the constructor. With the
    // floor at 5 and at most 3 impostors this never binds, but the engine
    // asserts it too, so keep the clamp honest rather than assuming.
    seer: s.seer && impostors + 1 < floor,
    nightSecs: clamp(s.nightSecs, MIN_TIMER_SECS, MAX_TIMER_SECS),
    voteSecs: clamp(s.voteSecs, MIN_TIMER_SECS, MAX_TIMER_SECS),
    confirmEjects: s.confirmEjects,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n)));
}
