import { NextResponse } from "next/server";
import { createRoom, listLobbies } from "@/server/rooms";

/** Open lobbies anyone can join from the landing page. */
export async function GET() {
  return NextResponse.json({ rooms: listLobbies() });
}

/** Rooms live in process memory, so this must never be cached or prerendered. */
export const dynamic = "force-dynamic";

/** POST /api/rooms — open a room, returns its code. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    nightDurationSecs?: number;
    voteDurationSecs?: number;
    minPlayers?: number;
    maxPlayers?: number;
    hiddenCount?: number;
    seerCount?: number;
    tasksPerPlayer?: number;
    confirmEjects?: boolean;
    killCooldownSecs?: number;
  };

  const room = createRoom({
    nightDurationSecs: clamp(body.nightDurationSecs ?? 90, 10, 1200),
    voteDurationSecs: clamp(body.voteDurationSecs ?? 120, 10, 1200),
    minPlayers: body.minPlayers,
    maxPlayers: body.maxPlayers,
    hiddenCount: body.hiddenCount,
    seerCount: body.seerCount,
    tasksPerPlayer: body.tasksPerPlayer,
    confirmEjects: body.confirmEjects,
    killCooldownSecs: clamp(body.killCooldownSecs ?? 20, 5, 60),
  });

  return NextResponse.json({ code: room.code });
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, Math.round(n)));
}
