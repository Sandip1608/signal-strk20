"use client";

/**
 * Client transport for relayed (cross-device) rounds.
 *
 * The design goal is that `panels.tsx` does not know whether it is in a local
 * pass-the-device round or a networked one: both modes fill the same `game` /
 * `ship` fields on the same store, so every phase panel works unchanged. The
 * only difference is that online actions are posted to the server, which runs
 * the engine and hands back a redacted view.
 */

import type { GameState } from "./types";
import type { ShipState } from "./ship";

export type RoomView = {
  code: string;
  version: number;
  seat: number | null;
  game: GameState;
  ship: ShipState | null;
};

/** Identifies this browser to the server so a refresh reclaims its seat. */
export function playerId(): string {
  const KEY = "signal:playerId";
  try {
    const existing = window.localStorage.getItem(KEY);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    window.localStorage.setItem(KEY, fresh);
    return fresh;
  } catch {
    // Private mode — a per-tab id still works for one sitting.
    return crypto.randomUUID();
  }
}

export class RelayError extends Error {}

export async function createRoom(opts: {
  nightDurationSecs: number;
  voteDurationSecs: number;
  minPlayers?: number;
  maxPlayers?: number;
  hiddenCount?: number;
  seerCount?: number;
  tasksPerPlayer?: number;
  confirmEjects?: boolean;
}): Promise<string> {
  const res = await fetch("/api/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(opts),
  });
  if (!res.ok) throw new RelayError("could not open a room");
  return ((await res.json()) as { code: string }).code;
}

export async function fetchRoom(code: string): Promise<RoomView> {
  const res = await fetch(
    `/api/rooms/${encodeURIComponent(code)}?playerId=${encodeURIComponent(playerId())}`,
    { cache: "no-store" },
  );
  if (res.status === 404) throw new RelayError("no such room");
  if (!res.ok) throw new RelayError("lost the room");
  return reviveBigints((await res.json()) as RoomView);
}

/**
 * Post an action. A 409 carries the engine's own assert message, which the
 * store surfaces exactly like a local rejection.
 */
export async function sendAction(
  code: string,
  action: Record<string, unknown>,
): Promise<RoomView> {
  const res = await fetch(`/api/rooms/${encodeURIComponent(code)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...action, playerId: playerId() }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new RelayError((body as { error?: string }).error ?? "action failed");
  return reviveBigints(body as RoomView);
}

/**
 * Tallies are `bigint` in the engine, and JSON has no bigint — they arrive as
 * strings (or numbers) and must be put back, or every tally comparison in the
 * UI silently comes out wrong.
 */
function reviveBigints(view: RoomView): RoomView {
  const tallies: Record<number, bigint> = {};
  for (const [k, v] of Object.entries(view.game.tallies ?? {})) {
    tallies[Number(k)] = BigInt(v as unknown as string);
  }
  return {
    ...view,
    game: {
      ...view.game,
      tallies,
      totalVotes: BigInt((view.game.totalVotes as unknown as string) ?? 0),
      skipTally: BigInt((view.game.skipTally as unknown as string) ?? 0),
    },
  };
}
