import { NextResponse } from "next/server";
import { ContractError } from "@/game/engine";
import {
  HOST_ONLY,
  applyAction,
  getRoom,
  isHost,
  jsonSafe,
  seatOfPlayer,
  tickBots,
  viewFor,
  type Action,
} from "@/server/rooms";

export const dynamic = "force-dynamic";

/**
 * GET /api/rooms/CODE?playerId=…  — this player's redacted view of the room.
 *
 * Bots are advanced here rather than on a timer: clients poll continuously
 * while anyone is watching, so the room ticks exactly while it is being played
 * and stops dead when everybody leaves.
 */
export async function GET(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const room = getRoom(code);
  if (!room) return NextResponse.json({ error: "no such room" }, { status: 404 });

  const playerId = new URL(req.url).searchParams.get("playerId");
  tickBots(room);

  return NextResponse.json(jsonSafe(viewFor(room, seatOfPlayer(room, playerId))));
}

/**
 * POST /api/rooms/CODE — apply one action.
 *
 * A rejected engine guard comes back as 409 with the contract's own message
 * ("vote still open", "already voted"), so a remote client can surface exactly
 * what a local one would.
 */
export async function POST(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const room = getRoom(code);
  if (!room) return NextResponse.json({ error: "no such room" }, { status: 404 });

  const action = (await req.json().catch(() => null)) as (Action & { playerId?: string }) | null;
  if (!action || typeof action.type !== "string") {
    return NextResponse.json({ error: "bad action" }, { status: 400 });
  }

  // Seat-bound actions are taken from the server's claim table, never from the
  // client — otherwise anyone could post a vote as somebody else's seat.
  const claimed = seatOfPlayer(room, action.playerId ?? null);
  // Host-only actions are `assert_host` on-chain and were unguarded here, so
  // any joined player could re-assign roles or resolve the game.
  if (HOST_ONLY.includes(action.type) && !isHost(room, action.playerId ?? null)) {
    return NextResponse.json({ error: "only the host" }, { status: 403 });
  }

  const seatBound = [
    "seeRole",
    "move",
    "task",
    "kill",
    "report",
    "vote",
    "callMeeting",
    "vent",
    // Sabotage and repair are seat-bound too: the server checks the caller's
    // role and where they are standing.
    "sabotageLights",
    "sabotageReactor",
    "fixLights",
    "fixReactor",
  ];
  if (seatBound.includes(action.type)) {
    if (claimed === null) {
      return NextResponse.json({ error: "not seated in this room" }, { status: 403 });
    }
    (action as { seat: number }).seat = claimed;
  }

  try {
    applyAction(room, action);
  } catch (e) {
    if (e instanceof ContractError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    throw e;
  }

  tickBots(room);
  return NextResponse.json(jsonSafe(viewFor(room, claimed)));
}
