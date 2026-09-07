"use client";

/**
 * Return to the top of the page whenever the round changes phase.
 *
 * Each phase is its own screen, but the browser keeps the scroll position
 * across the swap — so arriving at the vote from the bottom of the night deck
 * dropped you into the middle of the ballot, below the thing you were meant to
 * do next. Nothing looked broken; it looked like nothing had happened.
 *
 * Scrolls instantly rather than smoothly: a phase change is a cut, not a pan,
 * and a smooth scroll during one reads as the page drifting on its own.
 */

import { useEffect, useRef } from "react";
import { useGame } from "./store";

export function usePhaseScroll() {
  const phase = useGame((s) => s.game?.phase);
  const round = useGame((s) => s.game?.roundNumber);
  const seen = useRef<string | null>(null);

  useEffect(() => {
    if (phase === undefined) return;
    const key = `${round}:${phase}`;
    if (seen.current === key) return;
    seen.current = key;
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [phase, round]);
}
