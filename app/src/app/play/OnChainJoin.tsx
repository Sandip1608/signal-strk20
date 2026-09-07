"use client";

/**
 * Connect a wallet and take the seat on chain.
 *
 * Optional on purpose. The game is playable with no wallet at all — the relay
 * runs the same engine either way — so this never gates anything. What it adds
 * is that the seat, the burner it will act through, the payout note and the
 * entropy that will feed the role draw are all written to Starknet, where
 * anyone can check them afterwards. That is the RFP's provably-fair claim
 * actually happening rather than being described.
 *
 * It does not take a payment. `SignalEscrow` is reachable only by the privacy
 * pool (`assert(get_caller_address() == self.pool.read(), 'only pool')`), and
 * it has no buy-in operation — only Vote and Payout legs. A wallet cannot pay
 * it, on any network, until the pool path exists.
 */

import { useEffect, useState } from "react";
import s from "./play.module.css";
import { useWallet, onRightChain } from "@/game/useWallet";
import { DEPLOYMENT } from "@/game/deployed";
import { explorerContract, explorerTx, joinOnChain, waitFor } from "@/game/chain";
import type { Seat } from "@/game/types";

const short = (v: string) => `${v.slice(0, 6)}…${v.slice(-4)}`;

export function OnChainJoin({ you }: { you: Seat | null }) {
  const {
    available, address, chainId, account, onChainSeat,
    connecting, error, discover, connect, disconnect, refreshSeat, clearError,
  } = useWallet();
  const [tx, setTx] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  // Wallets register asynchronously, so subscribe rather than reading once.
  useEffect(() => discover(), [discover]);

  if (!DEPLOYMENT) return null;

  const rightChain = onRightChain(chainId);
  const joinable = you && onChainSeat === null && rightChain && !!account;

  const takeSeat = async () => {
    if (!account || !you) return;
    setSending(true);
    clearError();
    try {
      const hash = await joinOnChain(account, {
        sessionKey: you.sessionKey,
        payoutNoteId: you.payoutNoteId,
        entropy: you.entropy,
      });
      setTx(hash);
      await waitFor(hash);
      await refreshSeat();
    } catch (e) {
      useWallet.setState({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={s.section}>
      <h3 className={s.panelTitle} style={{ fontSize: 15 }}>
        Take the seat on chain <span className={s.tagline}>· optional</span>
      </h3>
      <p className={s.panelHint}>
        The game plays without this. Connecting writes your seat, burner key, payout note and
        entropy to{" "}
        <a href={explorerContract(DEPLOYMENT.round)} target="_blank" rel="noreferrer">
          SignalRound
        </a>{" "}
        on {DEPLOYMENT.network}, so the role draw can be checked by anyone afterwards. No payment —
        the escrow is reachable only by the privacy pool.
      </p>

      {!address ? (
        <div className={s.btnRow}>
          {available.length === 0 ? (
            <span className={s.tagline}>No Starknet wallet detected — install Argent X or Braavos.</span>
          ) : (
            available.map((w) => (
              <button
                key={w.name}
                type="button"
                className={`${s.btn} ${s.btnGhost}`}
                disabled={connecting}
                onClick={() => connect(w)}
              >
                {connecting ? "Connecting…" : `Connect ${w.name}`}
              </button>
            ))
          )}
        </div>
      ) : (
        <>
          <p className={s.tagline} style={{ display: "block" }}>
            {short(address)} · {rightChain ? DEPLOYMENT.network : "WRONG NETWORK"}
            {onChainSeat !== null && ` · holds seat ${onChainSeat} on chain`}
          </p>

          {!rightChain && (
            <p className={s.panelHint}>
              This wallet is not on {DEPLOYMENT.network}. Switch networks in the wallet — a join
              sent from anywhere else would go to a chain the round is not on.
            </p>
          )}

          <div className={s.btnRow}>
            {onChainSeat === null && (
              <button
                type="button"
                className={s.btn}
                disabled={!joinable || sending}
                onClick={takeSeat}
              >
                {sending ? "Waiting for the wallet…" : "Join on chain"}
              </button>
            )}
            <button type="button" className={`${s.btn} ${s.btnGhost}`} onClick={disconnect}>
              Disconnect
            </button>
          </div>

          {!you && (
            <p className={s.tagline} style={{ display: "block" }}>
              Take a seat in the lobby first — the join needs its burner key and entropy.
            </p>
          )}
        </>
      )}

      {tx && (
        <p className={s.tagline} style={{ display: "block", marginTop: 8 }}>
          <a href={explorerTx(tx)} target="_blank" rel="noreferrer">
            {sending ? "Sent" : "Confirmed"} — {short(tx)} ↗
          </a>
        </p>
      )}

      {error && (
        <p className={s.panelHint} style={{ color: "#ff9aa6" }}>
          {error}
        </p>
      )}
    </div>
  );
}
