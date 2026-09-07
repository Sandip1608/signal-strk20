import { existsSync, readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { NextResponse } from "next/server";
import { Account, RpcProvider } from "starknet";
import { DEPLOYMENT } from "@/game/deployed";

/**
 * POST /api/chain/resolve — the host reveals the round.
 *
 * Calls `resolve_round(host_seed, salt)`, which re-derives the impostor(s) from
 * the committed seed + on-chain entropy, checks the reveal against both
 * commitments, records the ejection, and sets `RESOLVED` (with `is_winner` /
 * `crew_won` now readable). This is the provably-fair reveal actually
 * happening on-chain, and the precondition the escrow's payout leg checks.
 *
 * `resolve_round` only succeeds when the on-chain vote left the game genuinely
 * over — for one impostor in five that means the ballot ejected the impostor.
 * If it did not, the contract returns `game not over`; if the ballot is still
 * open it returns `vote still open`. Both are surfaced verbatim.
 *
 * host_seed is read server-side (never sent to the client); salt is supplied by
 * the caller (returned to it by /api/chain/advance — revealing it is harmless,
 * resolve_round puts it on-chain anyway).
 */

export const dynamic = "force-dynamic";

const PHASES = ["LOBBY", "ASSIGNED", "NIGHT", "VOTE", "RESOLVED"] as const;

function envVal(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  const p = pathResolve(process.cwd(), ".env.deploy");
  if (existsSync(p)) {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, "");
    }
  }
  return undefined;
}

export async function POST(req: Request) {
  if (!DEPLOYMENT) return NextResponse.json({ error: "no round deployed" }, { status: 503 });

  const body = (await req.json().catch(() => ({}))) as { salt?: string; key?: string };
  if (process.env.ADVANCE_KEY && body.key !== process.env.ADVANCE_KEY) {
    return NextResponse.json({ error: "bad advance key" }, { status: 403 });
  }
  if (!body.salt) {
    return NextResponse.json({ error: "salt required (from the advance response)" }, { status: 400 });
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

  try {
    const acc = new Account({ provider, address, signer: pk });
    const tx = await acc.execute({
      contractAddress: round,
      entrypoint: "resolve_round",
      calldata: [hostSeed, body.salt],
    });
    await provider.waitForTransaction(tx.transaction_hash);

    const read = async (e: string, cd: string[] = []) =>
      (await provider.callContract({ contractAddress: round, entrypoint: e, calldata: cd }))[0];
    const phase = Number(await read("phase"));
    const crewWon = BigInt(await read("crew_won")) !== 0n;
    const winners = Number(await read("winner_count"));
    return NextResponse.json({
      phase: PHASES[phase] ?? String(phase),
      crewWon,
      winners,
      transaction: tx.transaction_hash,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
