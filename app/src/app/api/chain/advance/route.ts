import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextResponse } from "next/server";
import { Account, RpcProvider } from "starknet";
import { DEPLOYMENT } from "@/game/deployed";
import { combinedSeed, deriveHidden, poseidonCommitment, randomSalt } from "@/game/crypto";

/**
 * POST /api/chain/advance — perform the HOST's duties on the deployed round:
 * `assign_roles` and `start_night`, taking it LOBBY → ASSIGNED → NIGHT.
 *
 * Unlike the earlier rehearsal version, this posts a REAL role commitment so
 * the round can actually be resolved (and thus paid out) later: it reads every
 * seat's on-chain entropy, mixes it with the host seed exactly as
 * `open_roles` does, derives the impostor seat(s), and commits
 * poseidon([...hidden, salt]). The salt is returned so the client can hand it
 * back to `/api/chain/resolve`; the host seed never leaves the server.
 *
 * It deliberately stops at NIGHT and does NOT open the meeting. Opening the
 * ballot (`call_meeting`) is a *player* action signed by a seat's session key —
 * the browser does that itself (see `openMeetingFromSession`), so no player
 * key is ever held server-side. The host key is legitimately the game host's.
 *
 * Server-side env only (on Render: dashboard vars; locally .env.deploy):
 *   STARKNET_ACCOUNT_ADDRESS / STARKNET_PRIVATE_KEY   the host
 *   HOST_SEED                                         the seed committed at deploy
 *   ADVANCE_KEY                                       optional shared secret
 *
 * Idempotent: does nothing once the round is past NIGHT (returns the known
 * impostor seats so the caller still learns who to vote out).
 */

export const dynamic = "force-dynamic";

const PHASES = ["LOBBY", "ASSIGNED", "NIGHT", "VOTE", "RESOLVED"] as const;

function envVal(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  const p = resolve(process.cwd(), ".env.deploy");
  if (existsSync(p)) {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, "");
    }
  }
  return undefined;
}

export async function POST(req: Request) {
  if (!DEPLOYMENT) {
    return NextResponse.json({ error: "no round deployed" }, { status: 503 });
  }
  const body = (await req.json().catch(() => ({}))) as { key?: string };
  if (process.env.ADVANCE_KEY && body.key !== process.env.ADVANCE_KEY) {
    return NextResponse.json({ error: "bad advance key" }, { status: 403 });
  }

  const address = envVal("STARKNET_ACCOUNT_ADDRESS");
  const pk = envVal("STARKNET_PRIVATE_KEY");
  const hostSeed = envVal("HOST_SEED");
  if (!address || !pk || !hostSeed) {
    return NextResponse.json(
      { error: "missing host env vars — need STARKNET_ACCOUNT_ADDRESS, STARKNET_PRIVATE_KEY, HOST_SEED" },
      { status: 503 },
    );
  }

  const provider = new RpcProvider({ nodeUrl: DEPLOYMENT.rpc });
  const round = DEPLOYMENT.round;
  const call = async (entrypoint: string, calldata: string[] = []) =>
    (await provider.callContract({ contractAddress: round, entrypoint, calldata }))[0];
  const num = async (entrypoint: string) => Number(await call(entrypoint));

  const txs: string[] = [];
  const step = async (entrypoint: string, calldata: string[] = []) => {
    const acc = new Account({ provider, address, signer: pk });
    const tx = await acc.execute({ contractAddress: round, entrypoint, calldata });
    await provider.waitForTransaction(tx.transaction_hash);
    txs.push(tx.transaction_hash);
  };

  try {
    const n = await num("player_count");
    const k = await num("hidden_count");
    // Re-derive the impostor(s) the way `open_roles` will: host seed mixed with
    // every seat's on-chain entropy, drawn with the Cairo-identical algorithm.
    const entropies: string[] = [];
    for (let seat = 0; seat < n; seat += 1) {
      entropies.push(String(await call("entropy_of", [String(seat)])));
    }
    const combined = combinedSeed(hostSeed, entropies);
    const hidden = deriveHidden(combined, n, k);

    let phase = await num("phase");
    let salt: string | null = null;
    if (phase === 0) {
      salt = randomSalt();
      await step("assign_roles", [poseidonCommitment(hidden, salt)]);
      phase = await num("phase");
    }
    if (phase === 1) {
      await step("start_night");
      phase = await num("phase");
    }
    // Stops at NIGHT. The player's browser opens the meeting next.
    return NextResponse.json({
      phase: PHASES[phase] ?? String(phase),
      // Who must be voted out for the round to resolve as a crew win.
      impostorSeats: hidden,
      // Client keeps this and hands it to /api/chain/resolve. Revealing it is
      // harmless — resolve opens it publicly anyway.
      salt,
      transactions: txs,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e), transactions: txs },
      { status: 500 },
    );
  }
}
