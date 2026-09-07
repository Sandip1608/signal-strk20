"use client";

/**
 * Signal — the game surface.
 *
 * Routes to one panel per phase of `contracts/src/round.cairo`, with a
 * persistent seat roster and an action feed alongside. Every state transition
 * goes through `@/game/engine`, which enforces the contract's own guards, so
 * the flow you see here is the flow the chain will accept.
 *
 * v1 runs the round locally (pass-the-device) while the contracts are being
 * deployed — see docs/TIMELINE.md. The engine seam is deliberately the only
 * thing that has to change.
 */

import { useEffect, useState } from "react";
import s from "./play.module.css";
import { ActivityLog, GameHud, PhaseBanner } from "./ui";
import { LobbyPanel, NightPanel, ResolvedPanel, RolePanel, VotePanel } from "./panels";
import { useGame } from "@/game/store";
import { useBotDriver } from "@/game/useBotDriver";
import { useRoomSync } from "@/game/useRoomSync";
import { useOwnDevice } from "@/game/useOwnDevice";
import { fetchLobbies, type LobbyListing } from "@/game/online";
import { Phase, type GameState } from "@/game/types";
import { impostorLabel } from "@/game/variants";

export default function PlayPage() {
  const {
    game, error, clearError, mode, roomCode, hostRoom, joinRoom, leaveRoom,
    connecting, viewerSeat, mySeat,
  } = useGame();

  // Local rounds drive bots in the browser; online rounds let the server do it
  // once for everybody, or every client would fight over the same bot turn.
  useBotDriver({ enabled: mode === "local" });
  useRoomSync();
  // One human at the table? Then the deck is theirs — open it without making
  // them tap through a gate meant for a shared screen.
  useOwnDevice();

  const you =
    (viewerSeat !== null ? game?.seats.find((x) => x.seat === viewerSeat) : null) ??
    (mySeat !== null ? game?.seats.find((x) => x.seat === mySeat) : null);

  return (
    <div className={s.shell}>
      <GameHud
        game={game}
        roomCode={roomCode}
        viewerName={you?.name ?? null}
        viewerTag={you ? `Bean #${String(you.seat + 1).padStart(2, "0")}` : null}
        onLeave={leaveRoom}
      />
      <div className={s.inner}>
        {error && (
          <div className={s.error} role="alert">
            <span className={s.errorCode}>reverted:</span>
            <span>{error}</span>
            <button
              type="button"
              className={`${s.btn} ${s.btnGhost}`}
              style={{ height: 30, padding: "0 12px", marginLeft: "auto" }}
              onClick={clearError}
            >
              Dismiss
            </button>
          </div>
        )}

        {mode === "online" && roomCode && (
          <div className={s.roomBar}>
            <span className={s.roomLabel}>Room</span>
            <span className={s.roomCode}>{roomCode}</span>
            <span className={s.tagline}>Share this code — others join from their own device.</span>
            <button type="button" className={`${s.btn} ${s.btnGhost}`} onClick={leaveRoom}>
              Leave
            </button>
          </div>
        )}

        {game === null ? (
          <StartScreen
            onHost={(name) => void hostRoom(name)}
            onJoin={joinRoom}
            connecting={connecting}
          />
        ) : game.phase === Phase.LOBBY ? (
          <>
            <PhaseBanner game={game}>{bannerText(game)}</PhaseBanner>
            <div className={s.grid}>
              <div>{phasePanel(game)}</div>
              <aside className={s.panel}>
                <h2 className={s.panelTitle}>Commitment ledger</h2>
                <p className={s.panelHint} style={{ marginBottom: 14 }}>
                  Each entry names the call behind it. A{" "}
                  <span style={{ color: "#c77dff" }}>●</span> marks an action that never appears in
                  public state.
                </p>
                <ActivityLog log={game.log} />
              </aside>
            </div>
          </>
        ) : (
          phasePanel(game)
        )}
      </div>
    </div>
  );
}

function phasePanel(game: GameState) {
  switch (game.phase) {
    case Phase.LOBBY:
      return <LobbyPanel game={game} />;
    case Phase.ASSIGNED:
      return <RolePanel game={game} />;
    case Phase.NIGHT:
      return <NightPanel game={game} />;
    case Phase.VOTE:
      return <VotePanel game={game} />;
    case Phase.RESOLVED:
      return <ResolvedPanel game={game} />;
    default:
      return null;
  }
}

function bannerText(game: GameState) {
  switch (game.phase) {
    case Phase.LOBBY:
      return (
        <>
          <strong>{game.seats.length}</strong> of {game.maxPlayers} seats filled ·{" "}
          {game.minPlayers} needed to start
        </>
      );
    case Phase.ASSIGNED:
      return <>Roles committed on-chain. Each player opens their encrypted note.</>;
    case Phase.NIGHT:
      return (
        <>
          Round <strong>{game.roundNumber + 1}</strong> — the impostor is choosing a target,
          privately.
        </>
      );
    case Phase.VOTE:
      return (
        <>
          Round <strong>{game.roundNumber + 1}</strong> · {String(game.totalVotes)} anonymous vote
          {game.totalVotes === 1n ? "" : "s"} counted
        </>
      );
    case Phase.RESOLVED:
      return <>Commitment opened — the round is verifiable by anyone.</>;
    default:
      return null;
  }
}

function StartScreen({
  onHost,
  onJoin,
  connecting,
}: {
  onHost: (name: string) => void;
  onJoin: (code: string, name: string) => void;
  connecting: boolean;
}) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [rooms, setRooms] = useState<LobbyListing[]>([]);

  useEffect(() => {
    let cancelled = false;
    const pull = () => {
      void fetchLobbies().then((list) => {
        if (!cancelled) setRooms(list);
      });
    };
    pull();
    const id = window.setInterval(pull, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  return (
    <div className={s.panel}>
      <h2 className={s.panelTitle}>Signal</h2>
      <p className={s.panelHint}>
        One round of shielded social deduction. Roles arrive as encrypted notes only their holder
        can decrypt. The night kill is a private transfer. Votes are anonymous. The payout is a
        shielded credit — never a public transfer.
      </p>

      <div className={s.section}>
        <h3 className={s.panelTitle} style={{ fontSize: 15 }}>
          How to play
        </h3>
        <ol className={s.how}>
          <li>
            <strong>Take a seat.</strong> Start a round as host, or join someone else&apos;s lobby
            with the 4-letter code. The host sets players, impostors and timers in the lobby.
          </li>
          <li>
            <strong>Open your role note.</strong> Most of you are crew. One or more are impostors.
            Only you can read your own note.
          </li>
          <li>
            <strong>Night.</strong> Walk the deck and do tasks. Crew gather sightings. Impostors
            kill only in the same room, and may sabotage lights or the reactor.
          </li>
          <li>
            <strong>Meeting.</strong> Report a body or call an emergency. Vote anonymously — the
            tally is public, the voter is not. A skip that ties or leads ejects nobody.
          </li>
          <li>
            <strong>Win.</strong> Crew win by ejecting every impostor. Impostors win if they equal
            or outnumber the living crew, or if the reactor melts down.
          </li>
        </ol>
      </div>

      <div className={s.section}>
        <h3 className={s.panelTitle} style={{ fontSize: 15 }}>
          Start a new round
        </h3>
        <p className={s.panelHint}>
          You host. Share the room code, then set the table in the lobby.
        </p>
        <div className={s.btnRow} style={{ marginTop: 0 }}>
          <input
            className={s.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            maxLength={18}
            aria-label="Your name"
          />
          <button
            type="button"
            className={s.btn}
            disabled={!name.trim() || connecting}
            onClick={() => onHost(name.trim())}
          >
            {connecting ? "Opening…" : "Start new round"}
          </button>
        </div>
      </div>

      <div className={s.section}>
        <h3 className={s.panelTitle} style={{ fontSize: 15 }}>
          Join a hosted game
        </h3>
        <p className={s.panelHint}>
          Enter a room code, or pick an open lobby below. Same name field as above.
        </p>
        <div className={s.btnRow} style={{ marginTop: 0 }}>
          <input
            className={s.input}
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 4))}
            placeholder="Room code"
            maxLength={4}
            aria-label="Room code"
            style={{ maxWidth: 150, letterSpacing: "0.3em", fontFamily: "var(--font-mono-ui)" }}
          />
          <button
            type="button"
            className={`${s.btn} ${s.btnGhost}`}
            disabled={code.length !== 4 || !name.trim() || connecting}
            onClick={() => onJoin(code, name.trim())}
          >
            Join room
          </button>
        </div>

        {rooms.length === 0 ? (
          <p className={s.tagline} style={{ display: "block", marginTop: 12 }}>
            No open lobbies right now — start a round and share the code.
          </p>
        ) : (
          <div className={s.lobbyList}>
            {rooms.map((room) => {
              const full = room.seated >= room.maxPlayers;
              return (
                <button
                  key={room.code}
                  type="button"
                  className={s.lobbyRow}
                  disabled={full || !name.trim() || connecting}
                  onClick={() => {
                    setCode(room.code);
                    onJoin(room.code, name.trim());
                  }}
                >
                  <span className={s.lobbyCode}>{room.code}</span>
                  <span className={s.lobbyMeta}>
                    {room.hostName} · {room.seated}/{room.maxPlayers} ·{" "}
                    {impostorLabel(room.hiddenCount).toLowerCase()} × {room.hiddenCount}
                  </span>
                  <span className={s.lobbyGo}>{full ? "Full" : "Join"}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
