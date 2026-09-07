"use client";

import Link from "next/link";
import { Fragment, useEffect, useState } from "react";
import s from "./play.module.css";
import { livingSeats, short } from "@/game/engine";
import { Phase, displaySeat, type GameState, type LogEntry, type PhaseValue, type Seat } from "@/game/types";

/**
 * Ticks once a second against a deadline.
 *
 * Host actions that the contract gates on a timer (`resolve_round` wants
 * `now > vote_deadline`, `skip_night` wants `now > night_deadline`) use this to
 * stay disabled until they would actually succeed — clicking early used to
 * fire the call and surface a red `reverted: vote still open`, which reads like
 * a failure when it is just "not yet".
 */
export function useDeadline(deadline: number): { passed: boolean; secondsLeft: number } {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!deadline) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [deadline]);

  if (!deadline) return { passed: false, secondsLeft: 0 };
  const left = deadline - now;
  return { passed: left <= 0, secondsLeft: Math.max(0, Math.ceil(left / 1000)) };
}

/** Live mm:ss until `deadline`. Counts past zero into "closed". */
export function Countdown({ deadline, label }: { deadline: number; label: string }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  if (!deadline) return null;
  const left = deadline - now;
  const over = left <= 0;
  const secs = Math.max(0, Math.ceil(left / 1000));
  const mm = String(Math.floor(secs / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");

  return (
    <div className={`${s.clock} ${over ? s.clockLate : ""}`}>
      <span className={s.clockLabel}>{label}</span>
      {over ? "closed" : `${mm}:${ss}`}
    </div>
  );
}

const PHASE_CLASS: Record<PhaseValue, string> = {
  [Phase.LOBBY]: s.phaseLobby,
  [Phase.ASSIGNED]: s.phaseAssigned,
  [Phase.NIGHT]: s.phaseNight,
  [Phase.VOTE]: s.phaseVote,
  [Phase.RESOLVED]: s.phaseResolved,
};

const PHASE_TEXT: Record<PhaseValue, string> = {
  [Phase.LOBBY]: "Lobby",
  [Phase.ASSIGNED]: "Reveal",
  [Phase.NIGHT]: "Night",
  [Phase.VOTE]: "Vote",
  [Phase.RESOLVED]: "Resolve",
};

const PHASE_STEPS: { id: PhaseValue | "payout"; label: string }[] = [
  { id: Phase.LOBBY, label: "Lobby" },
  { id: Phase.ASSIGNED, label: "Reveal" },
  { id: Phase.NIGHT, label: "Night" },
  { id: Phase.VOTE, label: "Vote" },
  { id: Phase.RESOLVED, label: "Resolve" },
  { id: "payout", label: "Payout" },
];

/** Conceptual buy-in shown in the HUD — the contract does not store a stake amount. */
export const STAKE_STRK = 50;

export function GameHud({
  game,
  roomCode,
  viewerName,
  viewerTag,
  onLeave,
}: {
  game: GameState | null;
  roomCode?: string | null;
  viewerName?: string | null;
  viewerTag?: string | null;
  onLeave?: () => void;
}) {
  const phase = game?.phase ?? Phase.LOBBY;
  const living = game ? livingSeats(game).length : 0;
  const filled = game?.seats.length ?? 0;
  const pot = filled * STAKE_STRK;

  return (
    <header className={s.hud}>
      <div className={s.brand}>
        <div className={s.brandMark} aria-hidden>
          ⌖<span className={s.brandPulse} />
        </div>
        <div className={s.brandMeta}>
          <h1 className={s.logo}>
            Signal<span className={s.logoDot}>.</span>
            <span className={s.zkPill}>ZK-Mafia</span>
          </h1>
          <span className={s.tagline}>STRK20 privacy pool</span>
        </div>
      </div>

      <nav className={s.phaseTrack} aria-label="Round phases">
        {PHASE_STEPS.map((step, i) => {
          const active =
            step.id === "payout" ? phase === Phase.RESOLVED : step.id === phase;
          const done =
            step.id !== "payout" && typeof step.id === "number" && phase > step.id;
          return (
            <Fragment key={step.label}>
              {i > 0 && <span className={s.stepRail} aria-hidden />}
              <span className={`${s.step} ${active ? s.stepActive : done ? s.stepDone : ""}`}>
                {step.label}
                {active && step.id === Phase.VOTE ? " · live" : ""}
              </span>
            </Fragment>
          );
        })}
      </nav>

      <div className={s.hudStats}>
        <div className={s.stat}>
          <span className={`${s.statVal} ${s.statValGold}`}>Pool: {pot.toLocaleString()} STRK</span>
          <span className={s.statSub}>
            Anon-set: {filled ? `${Math.round((living / Math.max(filled, 1)) * 100)}%` : "—"}
            {filled ? ` (${living}/${filled})` : ""}
          </span>
        </div>
        {viewerName && (
          <div className={s.youChip}>
            <span className={s.youName}>{viewerName}</span>
            <span className={s.youTag}>{viewerTag ?? "burner session"}</span>
          </div>
        )}
        {roomCode && onLeave && (
          <button type="button" className={`${s.btn} ${s.btnGhost}`} onClick={onLeave}>
            Leave
          </button>
        )}
        <Link href="/" className={s.backLink}>
          Wallet →
        </Link>
      </div>
    </header>
  );
}

export function PhaseBanner({ game, children }: { game: GameState; children?: React.ReactNode }) {
  return (
    <div className={s.banner}>
      <span className={`${s.phasePill} ${PHASE_CLASS[game.phase]}`}>{PHASE_TEXT[game.phase]}</span>
      <span className={s.bannerText}>{children}</span>
      {game.phase === Phase.NIGHT && <Countdown deadline={game.nightDeadline} label="Night ends" />}
      {game.phase === Phase.VOTE && <Countdown deadline={game.voteDeadline} label="Vote closes" />}
    </div>
  );
}

export type SeatTag = { label: string; className: string };

/**
 * The seat grid, reused by every phase. `onPick` makes seats selectable;
 * without it the grid is a read-only roster.
 */
export function SeatGrid({
  seats,
  onPick,
  selected,
  disabled,
  tagFor,
  metaFor,
}: {
  seats: Seat[];
  onPick?: (seat: number) => void;
  selected?: number | null;
  disabled?: (seat: Seat) => boolean;
  tagFor?: (seat: Seat) => SeatTag | null;
  metaFor?: (seat: Seat) => string;
}) {
  return (
    <div className={s.seats}>
      {seats.map((seat) => {
        const isDisabled = disabled?.(seat) ?? false;
        const tag = tagFor?.(seat) ?? null;
        return (
          <button
            key={seat.seat}
            type="button"
            onClick={onPick ? () => onPick(seat.seat) : undefined}
            disabled={isDisabled || !onPick}
            className={[
              s.seat,
              !onPick ? s.seatStatic : "",
              selected === seat.seat ? s.seatSelected : "",
              seat.dead ? s.seatDead : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <span className={s.seatNum}>Seat {displaySeat(seat.seat)}</span>
            <span className={s.seatName}>{seat.name}</span>
            <span className={s.seatMeta}>{metaFor?.(seat) ?? short(seat.sessionKey)}</span>
            {tag && <span className={`${s.seatTag} ${tag.className}`}>{tag.label}</span>}
          </button>
        );
      })}
    </div>
  );
}

export const seatTags = {
  dead: { label: "Dead", className: s.tagDead },
  voted: { label: "Voted", className: s.tagVoted },
  seen: { label: "Seen", className: s.tagSeen },
  you: { label: "You", className: s.tagYou },
  bot: { label: "Bot", className: s.tagBot },
};

/** Live tally. Public by design — the RFP wants a publicly computable count. */
export function Tally({ game }: { game: GameState }) {
  const max = game.seats.reduce((m, x) => {
    const t = game.tallies[x.seat] ?? 0n;
    return t > m ? t : m;
  }, 0n);

  return (
    <div>
      {game.seats.map((seat) => {
        const t = game.tallies[seat.seat] ?? 0n;
        const pct = max > 0n ? Number((t * 100n) / max) : 0;
        return (
          <div key={seat.seat} className={s.tallyRow}>
            <span className={s.tallyName} style={seat.dead ? { opacity: 0.45 } : undefined}>
              {seat.name}
            </span>
            <span className={s.tallyBarWrap}>
              <span className={s.tallyBar} style={{ width: `${pct}%` }} />
            </span>
            <span className={s.tallyNum}>{String(t)}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Pass-the-device secrecy gate.
 *
 * A hidden-role game on one screen only works if a secret stays covered until
 * its owner is actually holding the device — so nothing sensitive renders
 * until they uncover it, and it re-covers when they hand it back.
 */
export function DeviceGate({
  who,
  hint,
  onReveal,
}: {
  who: string;
  hint: string;
  onReveal: () => void;
}) {
  return (
    <div className={s.gate}>
      <p className={s.gateWho}>Pass the device to {who}</p>
      <p className={s.gateHint}>{hint}</p>
      <button type="button" className={s.btn} onClick={onReveal}>
        I&apos;m {who} — reveal
      </button>
    </div>
  );
}

/**
 * Action feed. Each entry names the call it corresponds to, and entries that
 * are private in the real system are marked — that mapping is the clearest way
 * to show a judge which parts never touch public state.
 */
export function ActivityLog({ log }: { log: LogEntry[] }) {
  if (log.length === 0) {
    return <p className={s.logEmpty}>Nothing yet. Actions appear here with the call behind them.</p>;
  }
  return (
    <div className={s.log}>
      {[...log].reverse().map((e, i) => (
        <div key={log.length - i} className={`${s.logItem} ${e.private ? s.logPrivate : ""}`}>
          <span className={s.logCall}>
            {e.private && (
              <span className={s.logLock} title="Never visible on-chain">
                ●
              </span>
            )}
            {e.call}
          </span>
          <p className={s.logText}>{e.text}</p>
        </div>
      ))}
    </div>
  );
}

export function KeyValue({ k, v }: { k: string; v: string }) {
  return (
    <div className={s.kv}>
      <span className={s.kvKey}>{k}</span>
      <span className={s.kvVal}>{v}</span>
    </div>
  );
}
