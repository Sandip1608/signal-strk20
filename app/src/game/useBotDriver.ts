"use client";

import { useEffect } from "react";
import { nextBotAction, nextNightAction } from "./bots";
import { useGame } from "./store";
import { Phase } from "./types";

/**
 * Runs bot turns, one at a time, on a timer.
 *
 * Paced rather than looped on purpose: a human needs to see *that* something
 * happened. Firing every bot action in one synchronous pass would jump from
 * "night starts" to "vote closed" with nothing to watch.
 *
 * The effect re-runs whenever the game or the deck changes, so each completed
 * action schedules the next — a chain that stops on its own when there is
 * nothing left for a bot to do.
 */
export function useBotDriver({ enabled = true }: { enabled?: boolean } = {}) {
  const game = useGame((s) => s.game);
  const ship = useGame((s) => s.ship);
  const botAct = useGame((s) => s.botAct);

  useEffect(() => {
    if (!enabled || !game) return;

    const action =
      game.phase === Phase.NIGHT
        ? ship
          ? nextNightAction(game, ship)
          : null
        : nextBotAction(game);
    if (!action) return;

    // Walking is the common beat during the night, so it stays brisk; a kill
    // gets a longer pause so the body report doesn't land on top of it.
    const delay =
      action.kind === "kill" ? 1200 : action.kind === "move" || action.kind === "task" ? 550 : 850;

    const id = setTimeout(() => botAct(action), delay);
    return () => clearTimeout(id);
  }, [enabled, game, ship, botAct]);
}
