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

import { RpcProvider, num } from "starknet";
import { DEPLOYMENT } from "./deployed";

/** One STRK20 action, mirroring WALLET_API.STRK20_ACTION (types-js wallet-api). */
export type Strk20Action =
  | { type: "deposit"; token: string; amount: string }
  | { type: "withdraw"; token: string; amount: string; recipient: string }
  | { type: "transfer"; token: string; amount: string; recipient: string }
  | { type: "invoke"; contract: string; calldata: string[] };

/** A connected wallet, kept structural so this file does not pin an SDK type. */
export type WalletLike = {
  address: string;
  execute: (calls: unknown) => Promise<{ transaction_hash: string }>;
  /** Present on privacy-enabled wallets (Ready, Xverse) via WalletAccountV6. */
  strk20InvokeTransaction?: (actions: Strk20Action[]) => Promise<{ transaction_hash: string }>;
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

/** STRK — same address on mainnet and Sepolia. */
const STRK_TOKEN = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

/**
 * The real vote stake, deliberately small: 1 STRK. The pool additionally takes
 * its own per-operation fee (2 STRK on the Sepolia pool, `get_fee_amount`).
 * `STAKE_STRK` in the HUD is conceptual; this is what actually moves.
 */
export const VOTE_STAKE_WEI = 10n ** 18n;

/** True when this wallet can send STRK20 actions and an escrow is deployed. */
export function canVoteThroughPool(wallet: WalletLike | null): boolean {
  return Boolean(
    wallet && typeof wallet.strk20InvokeTransaction === "function" && DEPLOYMENT?.escrow,
  );
}

/**
 * Cast a vote as a real STRK20 pool leg — the RFP's "anonymous channel
 * transfer with a publicly-computed tally".
 *
 * Two actions in one privacy transaction, the same shape as the starter kit's
 * echo round-trip (withdraw → helper → open-note refill):
 *   1. withdraw: the pool sends the stake to `SignalEscrow` — the on-chain
 *      sender is the pool, not the voter, which is the entire point.
 *   2. invoke: the pool calls `privacy_invoke(operation, in_token, out_token,
 *      assets, note_id)` on the escrow. `Vote` is enum variant 0; `note_id`
 *      carries the candidate seat (the client-supplied felt the pool passes
 *      through — see CLAUDE.md's verified-ABI note). The escrow reports
 *      (candidate, amount) to the round and re-deposits the stake into the pot
 *      open note.
 *
 * Needs shielded STRK in the wallet (Shield on the landing page first) and the
 * on-chain round to be in its VOTE phase — `handle_vote` reverts otherwise,
 * which is the contract doing its job, not this call misfiring.
 */
export async function voteThroughPool(
  wallet: WalletLike,
  candidateSeat: number,
  stakeWei: bigint = VOTE_STAKE_WEI,
): Promise<string> {
  if (!DEPLOYMENT?.escrow) throw new ChainError("no escrow deployed");
  const send = wallet.strk20InvokeTransaction;
  if (typeof send !== "function") {
    throw new ChainError("this wallet has no STRK20 support — use Ready or Xverse");
  }
  const stake = num.toHex(stakeWei);
  const actions: Strk20Action[] = [
    { type: "withdraw", token: STRK_TOKEN, amount: stake, recipient: DEPLOYMENT.escrow },
    {
      type: "invoke",
      contract: DEPLOYMENT.escrow,
      calldata: [
        "0x0", // SignalOperation::Vote (unit variant 0)
        STRK_TOKEN, // in_token
        STRK_TOKEN, // out_token (unused by the vote leg)
        stake, // assets.low
        "0x0", // assets.high
        num.toHex(candidateSeat), // note_id — the candidate seat
      ],
    },
  ];
  const res = await send.call(wallet, actions);
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
