/**
 * Game variants, as contract configuration.
 *
 * The RFP asks for one platform covering Among Us, Secret Hitler, Avalon,
 * Blood on the Clocktower and One Night Werewolf, with "each variant operable
 * as a different contract configuration".
 *
 * What those games actually share is the skeleton `round.cairo` implements: a
 * hidden minority, a private night action, and an anonymous vote with a
 * publicly computable tally. What differs is table size and how big the hidden
 * team is — so those are constructor arguments, not forks of the contract.
 *
 * Be precise about the claim: this generalises the *shared* mechanic, and each
 * variant here plays its hidden-role elimination round. It does not implement
 * each game's full ruleset (Secret Hitler's policy deck, Avalon's quests,
 * Clocktower's character abilities). Those are per-variant round logic layered
 * on this base, and are not built.
 */

export type Variant = {
  key: string;
  name: string;
  /** What the hidden team is called in this game. */
  hiddenName: string;
  /** Explicit plural — "werewolfs" and "minion of Mordreds" are not words. */
  hiddenPlural: string;
  /** What everyone else is called. */
  crewName: string;
  minPlayers: number;
  maxPlayers: number;
  /** Size of the hidden team. The contract requires 2 * hidden < minPlayers. */
  hiddenCount: number;
  blurb: string;
};

export const VARIANTS: Variant[] = [
  {
    key: "among-us",
    name: "Among Us",
    hiddenName: "Impostor",
    hiddenPlural: "Impostors",
    crewName: "Crew",
    minPlayers: 5,
    maxPlayers: 15,
    hiddenCount: 1,
    blurb: "One impostor aboard. Do your tasks, survive the night, vote them out.",
  },
  {
    key: "one-night-werewolf",
    name: "One Night Werewolf",
    hiddenName: "Werewolf",
    hiddenPlural: "Werewolves",
    crewName: "Villager",
    minPlayers: 5,
    maxPlayers: 10,
    hiddenCount: 2,
    blurb: "Two werewolves among the villagers. A single night, a single vote.",
  },
  {
    key: "secret-hitler",
    name: "Secret Hitler",
    hiddenName: "Fascist",
    hiddenPlural: "Fascists",
    crewName: "Liberal",
    minPlayers: 5,
    maxPlayers: 10,
    hiddenCount: 2,
    blurb: "Two fascists hidden in the assembly. Find them before they act.",
  },
  {
    key: "avalon",
    name: "Avalon",
    hiddenName: "Minion of Mordred",
    hiddenPlural: "Minions of Mordred",
    crewName: "Loyal Servant",
    minPlayers: 5,
    maxPlayers: 10,
    hiddenCount: 2,
    blurb: "Mordred's minions sit at the round table. Unmask one to win.",
  },
  {
    key: "clocktower",
    name: "Blood on the Clocktower",
    hiddenName: "Evil",
    hiddenPlural: "Evil",
    crewName: "Townsfolk",
    minPlayers: 7,
    maxPlayers: 15,
    hiddenCount: 3,
    blurb: "Three evil among the townsfolk. Execute one and the town holds.",
  },
];

/** The right noun for a count, so nothing renders "2 werewolfs". */
export function hiddenLabel(v: Variant, count: number): string {
  return count === 1 ? v.hiddenName : v.hiddenPlural;
}

export const DEFAULT_VARIANT = VARIANTS[0];

export function variantByKey(key: string): Variant {
  return VARIANTS.find((v) => v.key === key) ?? DEFAULT_VARIANT;
}

/** Mirrors the constructor's guard: the hidden team must be a strict minority. */
export function isValidVariant(v: Variant): boolean {
  return (
    v.minPlayers >= 3 &&
    v.maxPlayers <= 15 &&
    v.minPlayers <= v.maxPlayers &&
    v.hiddenCount >= 1 &&
    v.hiddenCount * 2 < v.minPlayers
  );
}
