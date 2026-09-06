"use client";

/**
 * The three task minigames.
 *
 * Deliberately hand-rolled from SVG + CSS with no game library and no canvas:
 * the whole point of a task is that it takes a few seconds of your attention
 * while you are standing still in a room where someone can walk in on you. A
 * physics engine would add weight for nothing.
 *
 * Each game takes `onSolve` and calls it once. None of them can be failed —
 * only fumbled — because a task you can lose would punish the crew for the
 * impostor's benefit without adding any deduction.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import s from "./ship.module.css";
import type { TaskKind } from "@/game/ship";

/**
 * `magnitude` scales the instance — wires to join, digits in the code, locks
 * needed — so meeting a puzzle type a second time is not the identical panel.
 */
/**
 * Fire `onSolve` once, after a short beat, immune to re-renders.
 *
 * The obvious version — `setTimeout(onSolve, 420)` inside an effect that lists
 * `onSolve` in its deps — is broken here. Callers pass an inline arrow, so its
 * identity changes every render; the deck re-renders constantly while bots
 * move; the effect re-runs, its cleanup clears the pending timeout, and the
 * `solved` guard then stops it ever being rescheduled. The puzzle shows
 * "3 / 3 joined" and the task is never marked done.
 *
 * So: keep the callback in a ref, key the effect only on the completion flag,
 * and clear the timer on unmount only.
 */
function useSolveOnce(done: boolean, onSolve: () => void, delay = 420) {
  const cb = useRef(onSolve);
  cb.current = onSolve;
  const fired = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!done || fired.current) return;
    fired.current = true;
    timer.current = setTimeout(() => cb.current(), delay);
  }, [done, delay]);

  useEffect(() => () => clearTimeout(timer.current), []);
}

export function Minigame({
  kind,
  magnitude,
  onSolve,
}: {
  kind: TaskKind;
  magnitude: number;
  onSolve: () => void;
}) {
  switch (kind) {
    case "rewire":
      return <Rewire wires={magnitude} onSolve={onSolve} />;
    case "keypad":
      return <Keypad digits={magnitude} onSolve={onSolve} />;
    case "stabilize":
      return <Stabilize needed={magnitude} onSolve={onSolve} />;
  }
}

// ── 1. Rewire ──────────────────────────────────────────────────────────────

const WIRE_COLOURS = ["#ff4d5e", "#f5c451", "#35d9c4", "#7f8bff", "#b78bff"];

function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function Rewire({ wires, onSolve }: { wires: number; onSolve: () => void }) {
  const count = Math.max(3, Math.min(WIRE_COLOURS.length, wires));
  const colours = WIRE_COLOURS.slice(0, count);
  // Right-hand order is shuffled once, on mount.
  const [right] = useState(() => shuffle(colours.map((_, i) => i)));
  const [picked, setPicked] = useState<number | null>(null);
  const [joined, setJoined] = useState<number[]>([]);
  const [wrong, setWrong] = useState(false);

  const ROW_H = 46;
  const H = count * ROW_H;

  useSolveOnce(joined.length === count, onSolve);

  const tapRight = (rightIdx: number) => {
    if (picked === null) return;
    const colourAtRight = right[rightIdx];
    if (colourAtRight === picked) {
      setJoined((j) => [...j, picked]);
      setPicked(null);
      setWrong(false);
    } else {
      setWrong(true);
      setPicked(null);
      setTimeout(() => setWrong(false), 380);
    }
  };

  return (
    <div className={s.game}>
      <p className={s.gameHint}>
        {wrong ? "Wrong terminal — try again." : "Tap a wire, then its matching colour."}
      </p>
      <svg viewBox={`0 0 300 ${H}`} className={s.wireSvg} role="img" aria-label="Wiring panel">
        {joined.map((colour) => {
          const li = colour;
          const ri = right.indexOf(colour);
          return (
            <line
              key={colour}
              x1={54}
              y1={li * ROW_H + ROW_H / 2}
              x2={246}
              y2={ri * ROW_H + ROW_H / 2}
              stroke={colours[colour]}
              strokeWidth={5}
              strokeLinecap="round"
            />
          );
        })}

        {colours.map((c, i) => {
          const done = joined.includes(i);
          return (
            <g key={`l${i}`}>
              <rect
                x={8}
                y={i * ROW_H + 9}
                width={46}
                height={28}
                rx={6}
                fill={c}
                opacity={done ? 1 : picked === i ? 1 : 0.75}
                stroke={picked === i ? "#fff" : "transparent"}
                strokeWidth={2}
                style={{ cursor: done ? "default" : "pointer" }}
                onClick={() => !done && setPicked(i)}
              />
            </g>
          );
        })}

        {right.map((colour, i) => {
          const done = joined.includes(colour);
          return (
            // Right terminals show their colour. Hiding it would make this
            // trial-and-error rather than a matching puzzle — in Among Us both
            // sides are visible and only the order is shuffled.
            <rect
              key={`r${i}`}
              x={246}
              y={i * ROW_H + 9}
              width={46}
              height={28}
              rx={6}
              fill={colours[colour]}
              opacity={done ? 1 : 0.75}
              stroke={picked !== null && !done ? "#ffffff66" : "transparent"}
              strokeWidth={2}
              style={{ cursor: done ? "default" : "pointer" }}
              onClick={() => !done && tapRight(i)}
            />
          );
        })}
      </svg>
      <p className={s.gameCount}>
        {joined.length} / {count} joined
      </p>
    </div>
  );
}

// ── 2. Keypad ──────────────────────────────────────────────────────────────

function Keypad({ digits, onSolve }: { digits: number; onSolve: () => void }) {
  const len = Math.max(3, Math.min(8, digits));
  const [code] = useState(() =>
    Array.from({ length: len }, () => Math.floor(Math.random() * 10)).join(""),
  );
  const [entered, setEntered] = useState("");
  const [wrong, setWrong] = useState(false);

  const correct = entered.length === code.length && entered === code;
  useSolveOnce(correct, onSolve, 380);

  // A wrong code clears itself; this timer is safe to re-run since it only
  // resets local state.
  useEffect(() => {
    if (entered.length < code.length || correct) return;
    setWrong(true);
    const id = setTimeout(() => {
      setEntered("");
      setWrong(false);
    }, 500);
    return () => clearTimeout(id);
  }, [entered, code, correct]);

  return (
    <div className={s.game}>
      <p className={s.gameHint}>Enter this code</p>
      <p className={s.codeTarget}>{code}</p>

      <div className={`${s.codeDisplay} ${wrong ? s.codeWrong : ""}`}>
        {Array.from({ length: code.length }, (_, i) => (
          <span key={i} className={s.codeCell}>
            {entered[i] ?? ""}
          </span>
        ))}
      </div>

      <div className={s.keypad}>
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((n) => (
          <button
            key={n}
            type="button"
            className={s.key}
            onClick={() => !wrong && setEntered((e) => (e.length < code.length ? e + n : e))}
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── 3. Stabilize ───────────────────────────────────────────────────────────

function Stabilize({ needed, onSolve }: { needed: number; onSolve: () => void }) {
  const NEEDED = Math.max(2, Math.min(5, needed));
  const onSolveRef = useRef(onSolve);
  onSolveRef.current = onSolve;
  const [pos, setPos] = useState(0); // 0..1 across the track
  const [hits, setHits] = useState(0);
  const [flash, setFlash] = useState<"hit" | "miss" | null>(null);
  const dir = useRef(1);
  const raf = useRef<number | undefined>(undefined);
  const solved = useRef(false);

  // Band shrinks as you go, so the last one takes actual attention. Scaled by
  // the total so a 4-lock task does not become impossible at the end.
  const half = 0.14 - (hits * 0.075) / NEEDED;
  const lo = 0.5 - half;
  const hi = 0.5 + half;

  useEffect(() => {
    let last = performance.now();
    const speed = 0.00075 + (hits * 0.0006) / NEEDED;

    const tick = (t: number) => {
      const dt = t - last;
      last = t;
      setPos((p) => {
        let next = p + dir.current * speed * dt;
        if (next >= 1) {
          next = 1;
          dir.current = -1;
        } else if (next <= 0) {
          next = 0;
          dir.current = 1;
        }
        return next;
      });
      raf.current = requestAnimationFrame(tick);
    };

    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current !== undefined) cancelAnimationFrame(raf.current);
    };
  }, [hits]);

  const lock = useCallback(() => {
    if (solved.current) return;
    if (pos >= lo && pos <= hi) {
      const next = hits + 1;
      setHits(next);
      setFlash("hit");
      if (next >= NEEDED) {
        solved.current = true;
        if (raf.current !== undefined) cancelAnimationFrame(raf.current);
        // Fired from an event handler, not an effect, so no cleanup can cancel
        // it - but read through a ref for the same reason the others do.
        setTimeout(() => onSolveRef.current(), 420);
      }
    } else {
      setFlash("miss");
    }
    setTimeout(() => setFlash(null), 300);
  }, [pos, lo, hi, hits, NEEDED, onSolve]);

  return (
    <div className={s.game}>
      <p className={s.gameHint}>
        {flash === "miss" ? "Missed — the needle drifted." : "Lock the needle inside the band."}
      </p>

      <div className={`${s.gauge} ${flash ? (flash === "hit" ? s.gaugeHit : s.gaugeMiss) : ""}`}>
        <span
          className={s.gaugeBand}
          style={{ left: `${lo * 100}%`, width: `${(hi - lo) * 100}%` }}
        />
        <span className={s.needle} style={{ left: `${pos * 100}%` }} />
      </div>

      <button type="button" className={s.lockBtn} onClick={lock}>
        Lock
      </button>
      <p className={s.gameCount}>
        {hits} / {NEEDED} stabilised
      </p>
    </div>
  );
}
