import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextResponse } from "next/server";
import { Account, RpcProvider, num, validateAndParseAddress } from "starknet";
import { DEPLOYMENT } from "@/game/deployed";

/**
 * POST /api/chain/faucet — gas-fund a player's session account so the browser
 * can deploy it and open the meeting itself.
 *
 * This exists so no player key is ever server-side: the server only pays gas,
 * it never signs a player action. The guard is what keeps it from being an
 * open tap on the host wallet — it funds an address ONLY when that address is
 * registered as a seat's session key on the deployed round (checked live via
 * `session_key_of`). A stranger's address is refused.
 *
 * Idempotent: skips an address that already holds enough to deploy + act.
 */

export const dynamic = "force-dynamic";

/** Enough for one account deploy + one call_meeting on Sepolia, with slack. */
const TOP_UP_WEI = 3n * 10n ** 18n;
const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

function hostKeys(): { address: string; pk: string } | null {
  let address = process.env.STARKNET_ACCOUNT_ADDRESS;
  let pk = process.env.STARKNET_PRIVATE_KEY;
  if (!address || !pk) {
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
  if (!DEPLOYMENT) return NextResponse.json({ error: "no round deployed" }, { status: 503 });

  let address: string;
  try {
    const body = (await req.json()) as { address?: string };
    address = validateAndParseAddress(body.address ?? "");
  } catch {
    return NextResponse.json({ error: "bad address" }, { status: 400 });
  }

  const host = hostKeys();
  if (!host) {
    return NextResponse.json({ error: "faucet has no host key configured" }, { status: 503 });
  }

  const provider = new RpcProvider({ nodeUrl: DEPLOYMENT.rpc });
  const round = DEPLOYMENT.round;
  const read = async (entrypoint: string, calldata: string[] = []) =>
    provider.callContract({ contractAddress: round, entrypoint, calldata });

  // GUARD: the address must be a seated session key on this round.
  try {
    const count = Number((await read("player_count"))[0]);
    let seated = false;
    for (let seat = 0; seat < count; seat += 1) {
      const r = await read("session_key_of", [String(seat)]);
      if (BigInt(r[0]) === BigInt(address)) {
        seated = true;
        break;
      }
    }
    if (!seated) {
      return NextResponse.json(
        { error: "address is not a seated session key — refusing to fund" },
        { status: 403 },
      );
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }

  // Already funded? Don't spend again.
  try {
    const bal = await provider.callContract({
      contractAddress: STRK,
      entrypoint: "balanceOf",
      calldata: [address],
    });
    const have = BigInt(bal[0]) + (BigInt(bal[1] ?? 0) << 128n);
    if (have >= TOP_UP_WEI) {
      return NextResponse.json({ funded: false, reason: "already funded", have: have.toString() });
    }
  } catch {
    // If the read fails, fall through and try to fund anyway.
  }

  try {
    const acc = new Account({ provider, address: host.address, signer: host.pk });
    const tx = await acc.execute({
      contractAddress: STRK,
      entrypoint: "transfer",
      calldata: [address, num.toHex(TOP_UP_WEI), "0x0"],
    });
    await provider.waitForTransaction(tx.transaction_hash);
    return NextResponse.json({ funded: true, transaction: tx.transaction_hash });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
