import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextResponse } from "next/server";
import { Account, RpcProvider } from "starknet";
import { DEPLOYMENT } from "@/game/deployed";

/**
 * POST /api/chain/advance — perform the HOST's duties on the deployed round:
 * `assign_roles` and `start_night`, taking it LOBBY → ASSIGNED → NIGHT.
 *
 * It deliberately stops at NIGHT and does NOT open the meeting. Opening the
 * ballot (`call_meeting`) is a *player* action and must be signed by a seat's
 * session key — the browser does that itself from the player's own session
 * account (see `openMeetingFromSession`), so no player key is ever held
 * server-side. The host key is legitimately the game host's, so it stays here.
 *
 * Host key comes from the environment (on Render: dashboard env vars; locally
 * it falls back to .env.deploy). Read server-side only — never in the client
 * bundle:
 *   STARKNET_ACCOUNT_ADDRESS / STARKNET_PRIVATE_KEY   the host
 *   ADVANCE_KEY                                       optional shared secret;
 *                                                     when set, the request
 *                                                     body must carry it
 *
 * Idempotent: does nothing once the round is past NIGHT.
 */

export const dynamic = "force-dynamic";

const PHASES = ["LOBBY", "ASSIGNED", "NIGHT", "VOTE", "RESOLVED"] as const;

function hostKeys(): { address: string; pk: string } | null {
  let address = process.env.STARKNET_ACCOUNT_ADDRESS;
  let pk = process.env.STARKNET_PRIVATE_KEY;
  if (!address || !pk) {
    // Local dev convenience: the same file deploy.mjs reads.
    const p = resolve(process.cwd(), ".env.deploy");
    if (existsSync(p)) {
      for (const line of readFileSync(p, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (!m) continue;
        if (m[1] === "STARKNET_ACCOUNT_ADDRESS") address = address || m[2];
        if (m[1] === "STARKNET_PRIVATE_KEY") pk = pk || m[2];
      }
    }
  }
  return address && pk ? { address, pk } : null;
}

export async function POST(req: Request) {
  if (!DEPLOYMENT) {
    return NextResponse.json({ error: "no round deployed" }, { status: 503 });
  }
  const body = (await req.json().catch(() => ({}))) as { key?: string };
  if (process.env.ADVANCE_KEY && body.key !== process.env.ADVANCE_KEY) {
    return NextResponse.json({ error: "bad advance key" }, { status: 403 });
  }

  const host = hostKeys();
  if (!host) {
    return NextResponse.json(
      { error: "missing host env vars — set STARKNET_ACCOUNT_ADDRESS and STARKNET_PRIVATE_KEY" },
      { status: 503 },
    );
  }

  const provider = new RpcProvider({ nodeUrl: DEPLOYMENT.rpc });
  const round = DEPLOYMENT.round;
  const call = async (entrypoint: string) =>
    Number((await provider.callContract({ contractAddress: round, entrypoint, calldata: [] }))[0]);

  const txs: string[] = [];
  const step = async (entrypoint: string, calldata: string[] = []) => {
    const acc = new Account({ provider, address: host.address, signer: host.pk });
    const tx = await acc.execute({ contractAddress: round, entrypoint, calldata });
    await provider.waitForTransaction(tx.transaction_hash);
    txs.push(tx.transaction_hash);
  };

  try {
    let phase = await call("phase");
    if (phase === 0) {
      // A rehearsal commitment: nonzero so the contract accepts it. This route
      // exists to open ballots for vote-leg testing, not to run honest rounds —
      // the real role draw stays with the game client.
      await step("assign_roles", [`0x${Date.now().toString(16)}1`]);
      phase = await call("phase");
    }
    if (phase === 1) {
      await step("start_night");
      phase = await call("phase");
    }
    // Stops at NIGHT. The player's browser opens the meeting next.
    return NextResponse.json({ phase: PHASES[phase] ?? String(phase), transactions: txs });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e), transactions: txs },
      { status: 500 },
    );
  }
}
