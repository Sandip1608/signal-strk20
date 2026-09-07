"use client";

/**
 * Landing: one promise, one button.
 *
 * "Connect & Play" connects a Starknet wallet through the game's own wallet
 * store (the same one the lobby uses, so arriving at /play the wallet is
 * already live) and then goes to the table. No wallet is still a valid way in
 * — the game runs locally without one — so that path stays, just quiet.
 *
 * The starter kit's pool console (shield / send / unshield / echo) is still
 * here because shielding is how a player funds the vote leg, but folded into a
 * disclosure: the game is the headline, the plumbing is not.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { CSSProperties } from "react";
import styles from "./landing.module.css";
import WalletAccountV6Tag from "./components/client/WalletHandle/WalletAccountV6Tag";
import { Crewmate } from "./play/ship/Crewmate";
import { useWallet } from "@/game/useWallet";

/** Crewmates adrift around the hero. Far ones are blurred and slower. */
const FLOATERS: {
  seat: number;
  pos: CSSProperties;
  size: number;
  blur?: number;
  tilt: number;
  delay: number;
  dead?: boolean;
}[] = [
  { seat: 0, pos: { top: "16%", left: "8%" }, size: 74, tilt: -12, delay: 0 },
  { seat: 1, pos: { top: "58%", left: "13%" }, size: 46, blur: 2, tilt: 18, delay: 1.6 },
  { seat: 3, pos: { top: "10%", right: "12%" }, size: 56, blur: 1, tilt: 10, delay: 0.8 },
  { seat: 5, pos: { top: "52%", right: "7%" }, size: 88, tilt: -22, delay: 2.4 },
  { seat: 7, pos: { top: "80%", left: "28%" }, size: 38, blur: 3, tilt: 32, delay: 3.1 },
  // one of them did not make it
  { seat: 4, pos: { top: "76%", right: "24%" }, size: 44, blur: 2, tilt: 0, delay: 1.2, dead: true },
];

export default function Page() {
  const router = useRouter();
  const { available, account, connecting, error, discover, connect, clearError } = useWallet();
  const [choosing, setChoosing] = useState(false);
  // Navigate only after a deliberate click, never on a remembered connection.
  const wantsPlay = useRef(false);

  useEffect(() => discover(), [discover]);
  useEffect(() => {
    if (wantsPlay.current && account) router.push("/play");
  }, [account, router]);

  const onCta = async () => {
    clearError();
    wantsPlay.current = true;
    if (account) {
      router.push("/play");
      return;
    }
    if (available.length === 0) return; // the error line below explains
    if (available.length > 1) {
      setChoosing(true);
      return;
    }
    await connect(available[0]);
  };

  return (
    <div className={styles.page}>
      {FLOATERS.map((f, i) => (
        <span
          key={i}
          className={styles.floater}
          style={{
            ...f.pos,
            "--tilt": `${f.tilt}deg`,
            animationDelay: `${f.delay}s`,
            filter: f.blur ? `blur(${f.blur}px)` : undefined,
            opacity: f.blur ? 0.7 : 0.95,
          } as CSSProperties}
          aria-hidden
        >
          <Crewmate seat={f.seat} size={f.size} dead={f.dead} />
        </span>
      ))}

      <nav className={styles.nav}>
        <div className={styles.wordmark}>
          SIGNA<span>L</span>
        </div>
        <span className={styles.navTag}>STRK20 · Mainnet</span>
      </nav>

      <header className={styles.hero}>
        <p className={styles.kicker}>Among Us, on Starknet&apos;s privacy pool</p>
        <h1 className={styles.title}>SIGNAL</h1>
        <p className={styles.sub}>
          One impostor hides among the crew. Roles are <strong>sealed commitments</strong>, the
          night kill is a <strong>private transfer</strong>, votes are{" "}
          <strong>anonymous pool legs</strong> with a public tally — and the payout comes back
          shielded.
        </p>

        <button type="button" className={styles.cta} onClick={onCta} disabled={connecting}>
          {connecting ? "Connecting…" : "Connect & Play"}
        </button>

        {choosing && !account && (
          <div className={styles.chooser}>
            {available.map((w) => (
              <button
                key={w.name}
                type="button"
                className={styles.chooserBtn}
                onClick={() => void connect(w)}
              >
                {w.name}
              </button>
            ))}
          </div>
        )}

        {error && <p className={styles.err}>{error}</p>}
        {!error && available.length === 0 && (
          <p className={styles.err}>
            No Starknet wallet found — install Ready, or play without one below.
          </p>
        )}

        <Link href="/play" className={styles.ghost}>
          Play without a wallet →
        </Link>

        <div className={styles.chips}>
          <span className={styles.chip}>
            <b>●</b>&nbsp;Contracts live on mainnet
          </span>
          <span className={styles.chip}>Session keys per seat</span>
          <span className={styles.chip}>5–15 players · bots fill in</span>
        </div>
      </header>

      <details className={styles.console}>
        <summary>STRK20 pool console — shield · send · unshield · echo</summary>
        <div className={styles.consoleInner}>
          <WalletAccountV6Tag />
        </div>
      </details>

      <footer className={styles.footer}>
        <a href="https://github.com/Sandip1608/signal-strk20" target="_blank" rel="noreferrer">
          Repo
        </a>
        <span>·</span>
        <span>Built for the STRK20 Private Sprint</span>
      </footer>
    </div>
  );
}
