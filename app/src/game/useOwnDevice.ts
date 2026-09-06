"use client";

/**
 * Pin the view to its owner when the screen belongs to exactly one player.
 *
 * The pass-the-device gate — "Pass the device to Me" → "I'm Me — reveal" — is
 * there so a hot-seat table cannot read each other's roles. It is pure friction
 * in the two cases that are *not* a hot seat: an online room, where the device
 * is already yours alone, and a solo game against bots, where there is nobody
 * to hide from.
 *
 * It was not a small cost. Playing solo on a 35s night, the deck sits behind
 * two taps every single round (tap your crewmate, then tap reveal) and the
 * night clock is already running while you do it — measured, a whole night went
 * by without the map ever opening: the impostor killed, the body was reported
 * and the vote closed first.
 *
 * So one human at the table means the deck opens by itself. Two or more humans
 * on one screen still get the gate, which is the only case it was ever for.
 */

import { useEffect } from "react";
import { ownDeviceSeat, useGame } from "./store";

export function useOwnDevice() {
  const game = useGame((s) => s.game);
  const mode = useGame((s) => s.mode);
  const mySeat = useGame((s) => s.mySeat);
  const viewerSeat = useGame((s) => s.viewerSeat);
  const revealed = useGame((s) => s.revealed);
  const setViewer = useGame((s) => s.setViewer);
  const reveal = useGame((s) => s.reveal);

  const own = ownDeviceSeat(game, mode, mySeat);

  useEffect(() => {
    if (own === null) return;
    // `setViewer` deliberately clears `revealed`, so this settles over two
    // passes: claim the seat, then uncover it. Anything that covers the screen
    // mid-round (a kill, an ejection) is re-opened by the same two steps.
    if (viewerSeat !== own) setViewer(own);
    else if (!revealed) reveal();
  }, [own, viewerSeat, revealed, setViewer, reveal]);
}
