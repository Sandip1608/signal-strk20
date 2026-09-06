"use client";

import { useEffect } from "react";
import { fetchRoom } from "./online";
import { useGame } from "./store";

/**
 * Keeps an online room in sync.
 *
 * Polling rather than WebSockets on purpose: the payload is a few kB, the game
 * is turn-based, and a poll survives a laptop sleeping, a phone locking, and a
 * dev-server restart without any reconnect logic. At ~800ms the deck still
 * feels live.
 *
 * A poll in flight is never allowed to overlap the next tick, so a slow
 * response cannot pile up requests, and an in-flight response is dropped if it
 * lands after we have already left the room.
 */
export function useRoomSync() {
  const mode = useGame((s) => s.mode);
  const roomCode = useGame((s) => s.roomCode);

  useEffect(() => {
    if (mode !== "online" || !roomCode) return;

    let live = true;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const view = await fetchRoom(roomCode);
        if (!live) return;
        const store = useGame.getState();
        // Ignore a stale response that lost a race with a newer one.
        if (store.mode === "online" && store.roomCode === roomCode) {
          store.applyView(view);
        }
      } catch {
        // Transient — a dropped poll just retries on the next tick rather than
        // tearing the player out of the round.
      } finally {
        if (live) timer = setTimeout(poll, 800);
      }
    };

    poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [mode, roomCode]);
}
