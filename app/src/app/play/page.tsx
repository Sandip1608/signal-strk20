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

import Link from "next/link";
import { useState } from "react";
import s from "./play.module.css";
import { ActivityLog, PhaseBanner } from "./ui";
import { LobbyPanel, NightPanel, ResolvedPanel, RolePanel, VotePanel } from "./panels";
import { useGame } from "@/game/store";
import { useBotDriver } from "@/game/useBotDriver";
import { useRoomSync } from "@/game/useRoomSync";
import { Phase, type GameState } from "@/game/types";
import { DEFAULT_VARIANT, VARIANTS, hiddenLabel, type Variant } from "@/game/variants";

const NIGHT_SECS = 90;
const VOTE_SECS = 120;

/**
 * Round lengths a host actually wants.
 *
 * The night is play time (walk the deck, do tasks); the vote is dead time you
 * must wait out before `resolve_round` will accept a reveal. So the demo pace
 * keeps a usable night and cuts the *vote* — a 10s night left no time to reach
 * a room, let alone finish a task.
 */
const PACES = [
  { key: "demo", label: "Demo", night: 35, vote: 15 },
  { key: "quick", label: "Quick", night: 60, vote: 40 },
  { key: "full", label: "Full", night: NIGHT_SECS, vote: VOTE_SECS },
  // The RFP asks for roughly 15-minute rounds; this is that, and it is the
  // pace a real table of 10+ actually needs to walk the deck and argue.
  { key: "table", label: "Table", night: 600, vote: 240 },
] as const;

export default function PlayPage() {
  const { game, error, clearError, newGame, mode, roomCode, hostRoom, joinRoom, leaveRoom, connecting } =
    useGame();

  // Local rounds drive bots in the browser; online rounds let the server do it
  // once for everybody, or every client would fight over the same bot turn.
  useBotDriver({ enabled: mode === "local" });
  useRoomSync();

  return (
    <div className={s.shell}>
      <div className={s.inner}>
        <header className={s.top}>
          <h1 className={s.logo}>
            Signal<span className={s.logoDot}>.</span>
          </h1>
          <span className={s.tagline}>Hidden roles · anonymous votes · shielded payout</span>
          <Link href="/" className={s.backLink}>
            STRK20 wallet →
          </Link>
        </header>

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
            onStart={newGame}
            onHost={hostRoom}
            onJoin={joinRoom}
            connecting={connecting}
          />
        ) : (
          <>
            <PhaseBanner game={game}>{bannerText(game)}</PhaseBanner>
            <div className={s.grid}>
              <div>{phasePanel(game)}</div>
              <aside className={s.panel}>
                <h2 className={s.panelTitle}>Activity</h2>
                <p className={s.panelHint} style={{ marginBottom: 14 }}>
                  Each entry names the call behind it. A{" "}
                  <span style={{ color: "#9b7bff" }}>●</span> marks an action that never appears in
                  public state.
                </p>
                <ActivityLog log={game.log} />
              </aside>
            </div>
          </>
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
      return <>The impostor is choosing a target, privately.</>;
    case Phase.VOTE:
      return (
        <>
          <strong>{String(game.totalVotes)}</strong> anonymous vote
          {game.totalVotes === 1n ? "" : "s"} counted
        </>
      );
    case Phase.RESOLVED:
      return <>Commitment opened — the round is verifiable by anyone.</>;
    default:
      return null;
  }
}

type RoundConfig = {
  nightDurationSecs: number;
  voteDurationSecs: number;
  variantKey: string;
  minPlayers: number;
  maxPlayers: number;
  hiddenCount: number;
};

function StartScreen({
  onStart,
  onHost,
  onJoin,
  connecting,
}: {
  onStart: (o: RoundConfig) => void;
  onHost: (name: string, o: RoundConfig) => void;
  onJoin: (code: string, name: string) => void;
  connecting: boolean;
}) {
  const [pace, setPace] = useState<(typeof PACES)[number]>(PACES[2]);
  const [variant, setVariant] = useState<Variant>(DEFAULT_VARIANT);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");

  // Exactly the arguments `SignalRound`'s constructor takes.
  const config: RoundConfig = {
    nightDurationSecs: pace.night,
    voteDurationSecs: pace.vote,
    variantKey: variant.key,
    minPlayers: variant.minPlayers,
    maxPlayers: variant.maxPlayers,
    hiddenCount: variant.hiddenCount,
  };

  return (
    <div className={s.panel}>
      <h2 className={s.panelTitle}>On-chain Among Us</h2>
      <p className={s.panelHint}>
        One round, 5–15 players, a hidden minority. Roles are encrypted notes only
        their holder can decrypt. The night kill is a private transfer. Votes are anonymous transfers
        with a publicly computable tally. The payout is a shielded credit — never a public transfer.
      </p>

      <div className={s.section}>
        <p className={s.note}>
          <strong>How this round is secured.</strong> The host commits to{" "}
          <code>poseidon(impostor_seat, salt)</code> before anyone votes and opens it after, so the
          draw is binding. Every in-round action is signed by a burner session key generated in this
          browser — never by the wallet that shielded the buy-in.
        </p>
      </div>

      <div className={s.section}>
        <p className={s.panelHint} style={{ marginBottom: 10 }}>
          Variant — the same contract, different constructor arguments: table size and how big the
          hidden team is.
        </p>
        <div className={s.btnRow} style={{ marginTop: 0 }}>
          {VARIANTS.map((v) => (
            <button
              key={v.key}
              type="button"
              onClick={() => setVariant(v)}
              className={`${s.btn} ${variant.key === v.key ? "" : s.btnGhost}`}
            >
              {v.name}
            </button>
          ))}
        </div>
        <p className={s.tagline} style={{ display: "block", marginTop: 10 }}>
          {variant.blurb} · {variant.minPlayers}–{variant.maxPlayers} players ·{" "}
          {variant.hiddenCount} {hiddenLabel(variant, variant.hiddenCount).toLowerCase()}
        </p>
      </div>

      <div className={s.section}>
        <p className={s.panelHint} style={{ marginBottom: 10 }}>
          Round length — the host can only resolve once the vote deadline has passed, so pick
          something you are willing to wait out.
        </p>
        <div className={s.btnRow} style={{ marginTop: 0 }}>
          {PACES.map((o) => (
            <button
              key={o.key}
              type="button"
              onClick={() => setPace(o)}
              className={`${s.btn} ${pace.key === o.key ? "" : s.btnGhost}`}
            >
              {o.label} · {o.night >= 120 ? `${Math.round(o.night / 60)}m` : `${o.night}s`} night
            </button>
          ))}
        </div>
      </div>

      <div className={s.btnRow}>
        <button
          type="button"
          className={s.btn}
          onClick={() => onStart(config)}
        >
          New round
        </button>
        <span className={s.tagline}>
          One screen, pass the device · {pace.night}s deck, {pace.vote}s vote
        </span>
      </div>

      {/* ── play across devices ─────────────────────────────────────── */}
      <div className={s.section}>
        <h3 className={s.panelTitle} style={{ fontSize: 15 }}>
          Play from separate devices
        </h3>
        <p className={s.panelHint}>
          Host a room and share the 4-letter code. Everyone plays on their own screen — roles and
          who-is-where are kept on the server and only ever sent to the player they belong to.
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
            onClick={() =>
              onHost(name.trim(), config)
            }
          >
            {connecting ? "Opening…" : "Host a room"}
          </button>
        </div>

        <div className={s.btnRow}>
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
          <span className={s.tagline}>Needs your name too</span>
        </div>
      </div>
    </div>
  );
}
