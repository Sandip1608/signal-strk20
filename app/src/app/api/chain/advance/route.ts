import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextResponse } from "next/server";
import { Account, RpcProvider } from "starknet";
import { DEPLOYMENT } from "@/game/deployed";

/**
 * POST /api/chain/advance — walk the DEPLOYED round to an open ballot, so the
 * pool vote leg has somewhere to land. The server-side twin of
 * `scripts/advance.mjs --open`, so a demo run from the website needs no
 * terminal: LOBBY → assign_roles → start_night → call_meeting → VOTE.
 *
 * Signing keys come from the environment (on Render: dashboard env vars;
 * locally they fall back to .env.deploy / .players.json, the same files the
 * scripts use). They are read server-side only — nothing here reaches the
 * client bundle:
 *   STARKNET_ACCOUNT_ADDRESS / STARKNET_PRIVATE_KEY   the host
 *   SESSION5_ADDRESS / SESSION5_PRIVATE_KEY           a seated session account
 *                                                     (call_meeting must be
 *                                                     signed by a session key)
 *   ADVANCE_KEY                                       optional shared secret;
 *                                                     when set, the request
 *                                                     body must carry it
 *
 * Costs the host a little testnet gas per call and burns the session seat's
 * one emergency meeting, so it does nothing when the round is already past
 * NIGHT — re-posting while a ballot is open just reports the deadline.
 */

export const dynamic = "force-dynamic";

const PHASES = ["LOBBY", "ASSIGNED", "NIGHT", "VOTE", "RESOLVED"] as const;

function envOrFile(): {
  host?: { address: string; pk: string };
  session?: { address: string; pk: string };
} {
  const out: ReturnType<typeof envOrFile> = {};
  let hostAddr = process.env.STARKNET_ACCOUNT_ADDRESS;
  let hostPk = process.env.STARKNET_PRIVATE_KEY;
  if (!hostAddr || !hostPk) {
    // Local dev convenience: the same file deploy.mjs reads.
    const p = resolve(process.cwd(), ".env.deploy");
    if (existsSync(p)) {
      for (const line of readFileSync(p, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (!m) continue;
        if (m[1] === "STARKNET_ACCOUNT_ADDRESS") hostAddr = hostAddr || m[2];
        if (m[1] === "STARKNET_PRIVATE_KEY") hostPk = hostPk || m[2];
      }
    }
  }
  if (hostAddr && hostPk) out.host = { address: hostAddr, pk: hostPk };

  let sessAddr = process.env.SESSION5_ADDRESS;
  let sessPk = process.env.SESSION5_PRIVATE_KEY;
  if (!sessAddr || !sessPk) {
    const p = resolve(process.cwd(), ".players.json");
    if (existsSync(p)) {
      try {
        const players = JSON.parse(readFileSync(p, "utf8")) as {
          sessionAccount?: { address: string; privateKey: string };
        }[];
        const withSession = players.find((x) => x.sessionAccount);
        if (withSession?.sessionAccount) {
          sessAddr = sessAddr || withSession.sessionAccount.address;
          sessPk = sessPk || withSession.sessionAccount.privateKey;
        }
      } catch {
        // fall through to the "missing keys" error below
      }
    }
  }
  if (sessAddr && sessPk) out.session = { address: sessAddr, pk: sessPk };
  return out;
}

export async function POST(req: Request) {
  if (!DEPLOYMENT) {
    return NextResponse.json({ error: "no round deployed" }, { status: 503 });
  }
  const body = (await req.json().catch(() => ({}))) as { key?: string };
  if (process.env.ADVANCE_KEY && body.key !== process.env.ADVANCE_KEY) {
    return NextResponse.json({ error: "bad advance key" }, { status: 403 });
  }

  const keys = envOrFile();
  if (!keys.host || !keys.session) {
    return NextResponse.json(
      {
        error:
          "missing signer env vars — set STARKNET_ACCOUNT_ADDRESS, " +
          "STARKNET_PRIVATE_KEY, SESSION5_ADDRESS, SESSION5_PRIVATE_KEY",
      },
      { status: 503 },
    );
  }

  const provider = new RpcProvider({ nodeUrl: DEPLOYMENT.rpc });
  const round = DEPLOYMENT.round;
  const call = async (entrypoint: string) =>
    Number((await provider.callContract({ contractAddress: round, entrypoint, calldata: [] }))[0]);

  const txs: string[] = [];
  const step = async (who: { address: string; pk: string }, entrypoint: string, calldata: string[] = []) => {
    const acc = new Account({ provider, address: who.address, signer: who.pk });
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
      await step(keys.host, "assign_roles", [`0x${Date.now().toString(16)}1`]);
      phase = await call("phase");
    }
    if (phase === 1) {
      await step(keys.host, "start_night");
      phase = await call("phase");
    }
    if (phase === 2) {
      await step(keys.session, "call_meeting");
      phase = await call("phase");
    }
    const deadline = await call("vote_deadline");
    const now = Math.floor(Date.now() / 1000);
    return NextResponse.json({
      phase: PHASES[phase] ?? String(phase),
      voteDeadline: deadline,
      secondsLeft: Math.max(0, deadline - now),
      transactions: txs,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e), transactions: txs },
      { status: 500 },
    );
  }
}
