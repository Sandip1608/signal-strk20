"use client";

/**
 * The thin seam between the game and the deployed round.
 *
 * Everything else in `game/` is a mirror that never touches a chain — that is
 * deliberate, and it stays that way. This module is the one place that talks to
 * Starknet, so the rest of the engine keeps running unchanged when no wallet is
 * connected, which is still the normal case.
 *
 * Calls are built as raw calldata rather than through `Contract` + ABI. The
 * sierra artifact lives in `contracts/target/`, outside `app/`, so Next cannot
 * import it; and `join` takes three felts, which is not worth a build step to
 * describe.
 */

import { RpcProvider } from "starknet";
import { DEPLOYMENT } from "./deployed";

/** A connected wallet, kept structural so this file does not pin an SDK type. */
export type WalletLike = {
  address: string;
  execute: (calls: unknown) => Promise<{ transaction_hash: string }>;
};

export function provider(): RpcProvider | null {
  if (!DEPLOYMENT) return null;
  return new RpcProvider({ nodeUrl: DEPLOYMENT.rpc });
}

/** Phase numbers as `round.cairo` writes them. */
export const CHAIN_PHASE = ["LOBBY", "ASSIGNED", "NIGHT", "VOTE", "RESOLVED"] as const;

async function readFelt(entrypoint: string): Promise<bigint | null> {
  const p = provider();
  if (!p || !DEPLOYMENT) return null;
  try {
    const r = await p.callContract({
      contractAddress: DEPLOYMENT.round,
      entrypoint,
      calldata: [],
    });
    return BigInt(r[0]);
  } catch {
    return null;
  }
}

/** What the deployed round currently looks like, for the lobby to display. */
export async function readRound(): Promise<{
  phase: string;
  players: number;
  minPlayers: number;
  maxPlayers: number;
} | null> {
  const [phase, players, min, max] = await Promise.all([
    readFelt("phase"),
    readFelt("player_count"),
    readFelt("min_players"),
    readFelt("max_players"),
  ]);
  if (phase === null || players === null) return null;
  return {
    phase: CHAIN_PHASE[Number(phase)] ?? `#${phase}`,
    players: Number(players),
    minPlayers: Number(min ?? 0n),
    maxPlayers: Number(max ?? 0n),
  };
}

/**
 * Has this wallet already taken a seat? `join` rejects a second attempt with
 * 'already joined', and a revert after the wallet popup is a poor way to learn.
 *
 * There is no `has_joined` view, so this walks the seats. A lobby is at most 15
 * of them, and this runs once when the wallet connects.
 */
export async function seatOfAddress(address: string): Promise<number | null> {
  const p = provider();
  if (!p || !DEPLOYMENT) return null;
  const want = BigInt(address);
  const count = await readFelt("player_count");
  if (count === null) return null;
  for (let seat = 0; seat < Number(count); seat += 1) {
    try {
      const r = await p.callContract({
        contractAddress: DEPLOYMENT.round,
        entrypoint: "seat_address",
        calldata: [String(seat)],
      });
      if (BigInt(r[0]) === want) return seat;
    } catch {
      return null;
    }
  }
  return null;
}

export class ChainError extends Error {}

/**
 * `join(session_key, payout_note_id, entropy)` — take a seat on chain.
 *
 * The wallet signs it, so the seat is owned by the wallet; every in-round
 * action is signed by the burner instead. The contract enforces that split
 * itself (`session_key != caller`), which is the whole reason the two exist.
 */
export async function joinOnChain(
  wallet: WalletLike,
  p: { sessionKey: string; payoutNoteId: string; entropy: string },
): Promise<string> {
  if (!DEPLOYMENT) throw new ChainError("no deployment recorded");
  if (!p.sessionKey || !p.payoutNoteId || !p.entropy) {
    throw new ChainError("seat is missing its keys — take a seat first");
  }
  const res = await wallet.execute({
    contractAddress: DEPLOYMENT.round,
    entrypoint: "join",
    calldata: [p.sessionKey, p.payoutNoteId, p.entropy],
  });
  return res.transaction_hash;
}

/** Block until the transaction is accepted, so the UI can stop saying "sending". */
export async function waitFor(txHash: string): Promise<void> {
  const p = provider();
  if (!p) return;
  await p.waitForTransaction(txHash);
}

export function explorerTx(txHash: string): string {
  const host =
    DEPLOYMENT?.network === "mainnet" ? "https://voyager.online" : "https://sepolia.voyager.online";
  return `${host}/tx/${txHash}`;
}

export function explorerContract(address: string): string {
  const host =
    DEPLOYMENT?.network === "mainnet" ? "https://voyager.online" : "https://sepolia.voyager.online";
  return `${host}/contract/${address}`;
}
