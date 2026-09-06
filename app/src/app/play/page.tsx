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
import {
  DEFAULT_SETTINGS,
  MAX_IMPOSTORS,
  MAX_TASKS,
  MIN_IMPOSTORS,
  MIN_TASKS,
  PLAYER_CEILING,
  impostorLabel,
  minPlayersFor,
  normalise,
  type Settings,
} from "@/game/variants";

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
/** Presets that fill the length fields; the host can still tune them. */
const PACES = [
  { key: "demo", label: "Demo", night: 35, vote: 15 },
  { key: "quick", label: "Quick", night: 60, vote: 40 },
  { key: "full", label: "Full", night: NIGHT_SECS, vote: VOTE_SECS },
  // Roughly the 15-minute round the RFP describes, and the pace a table of
  // 10+ actually needs to walk the deck and argue.
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

type RoundConfig = {
  nightDurationSecs: number;
  voteDurationSecs: number;
  minPlayers: number;
  maxPlayers: number;
  hiddenCount: number;
  seerCount: number;
  tasksPerPlayer: number;
  confirmEjects: boolean;
};

/** One labelled +/- stepper. */
function Stepper({
  label,
  hint,
  value,
  min,
  max,
  onChange,
  format,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  format?: (n: number) => string;
}) {
  return (
    <div className={s.setting}>
      <span className={s.settingLabel}>
        {label}
        {hint && <span className={s.settingHint}>{hint}</span>}
      </span>
      <span className={s.stepper}>
        <button
          type="button"
          className={s.stepBtn}
          onClick={() => onChange(value - 1)}
          disabled={value <= min}
          aria-label={`Fewer ${label}`}
        >
          −
        </button>
        <span className={s.stepValue}>{format ? format(value) : value}</span>
        <button
          type="button"
          className={s.stepBtn}
          onClick={() => onChange(value + 1)}
          disabled={value >= max}
          aria-label={`More ${label}`}
        >
          +
        </button>
      </span>
    </div>
  );
}

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
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");

  const set = (patch: Partial<Settings>) =>
    setSettings((prev) => normalise({ ...prev, ...patch }));

  const minPlayers = minPlayersFor(settings.impostors);
  const config: RoundConfig = {
    nightDurationSecs: settings.nightSecs,
    voteDurationSecs: settings.voteSecs,
    minPlayers,
    maxPlayers: settings.maxPlayers,
    hiddenCount: settings.impostors,
    seerCount: settings.seer ? 1 : 0,
    tasksPerPlayer: settings.tasksPerPlayer,
    confirmEjects: settings.confirmEjects,
  };

  return (
    <div className={s.panel}>
      <h2 className={s.panelTitle}>On-chain Among Us</h2>
      <p className={s.panelHint}>
One round aboard the ship. Roles are encrypted notes only their holder can decrypt. The night kill is a private transfer. Votes are anonymous transfers
        with a publicly computable tally. The payout is a shielded credit — never a public transfer.
      </p>

      <div className={s.section}>
        <p className={s.note}>
          <strong>How this round is secured.</strong> The host commits to{" "}
          <code>poseidon(host_seed)</code> <em>before anyone joins</em>, and every player adds
          entropy when they take a seat. At the reveal the contract mixes them and derives the
          impostors itself — the host never names them, so neither side can steer the draw. Every
          in-round action is signed by a burner session key generated in this browser, never by the
          wallet that shielded the buy-in.
        </p>
      </div>

      {/* ── host settings ───────────────────────────────────────────── */}
      <div className={s.section}>
        <h3 className={s.panelTitle} style={{ fontSize: 15 }}>
          Round settings
        </h3>
        <p className={s.panelHint}>
          Impostors, table size and round length are the contract's constructor
          arguments. Tasks and Confirm Ejects are client-side — the contract has no concept of a
          task, and confirming an eject is only how the reveal is presented.
        </p>

        <div className={s.settings}>
          <Stepper
            label="Impostors"
            value={settings.impostors}
            min={MIN_IMPOSTORS}
            max={MAX_IMPOSTORS}
            onChange={(n) => set({ impostors: n })}
            hint={`needs ${minPlayersFor(settings.impostors)}+ players`}
          />
          <Stepper
            label="Max players"
            value={settings.maxPlayers}
            min={minPlayers}
            max={PLAYER_CEILING}
            onChange={(n) => set({ maxPlayers: n })}
          />
          <Stepper
            label="Tasks each"
            value={settings.tasksPerPlayer}
            min={MIN_TASKS}
            max={MAX_TASKS}
            onChange={(n) => set({ tasksPerPlayer: n })}
          />

          <div className={s.setting}>
            <span className={s.settingLabel}>
              Seer
              <span className={s.settingHint}>
                {settings.seer
                  ? "one crewmate checks one player each night"
                  : "no investigative role — vanilla Among Us"}
              </span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={settings.seer}
              onClick={() => set({ seer: !settings.seer })}
              className={`${s.toggle} ${settings.seer ? s.toggleOn : ""}`}
            >
              <span className={s.toggleKnob} />
            </button>
          </div>

          <div className={s.setting}>
            <span className={s.settingLabel}>
              Confirm ejects
              <span className={s.settingHint}>
                {settings.confirmEjects
                  ? "the reveal says if they were an impostor"
                  : "the reveal stays silent — much harder"}
              </span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={settings.confirmEjects}
              onClick={() => set({ confirmEjects: !settings.confirmEjects })}
              className={`${s.toggle} ${settings.confirmEjects ? s.toggleOn : ""}`}
            >
              <span className={s.toggleKnob} />
            </button>
          </div>
        </div>

        <p className={s.tagline} style={{ display: "block", marginTop: 12 }}>
          {minPlayers}–{settings.maxPlayers} players · {settings.impostors}{" "}
          {impostorLabel(settings.impostors).toLowerCase()} · {settings.tasksPerPlayer} tasks each
        </p>
      </div>

      {/* ── round length ────────────────────────────────────────────── */}
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
              onClick={() => set({ nightSecs: o.night, voteSecs: o.vote })}
              className={`${s.btn} ${
                settings.nightSecs === o.night && settings.voteSecs === o.vote ? "" : s.btnGhost
              }`}
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
          One screen, pass the device · {settings.nightSecs}s deck, {settings.voteSecs}s vote
        </span>
      </div>

      {/* ── play across devices ─────────────────────────────────────── */}
      <div className={s.section} style={{ marginTop: 26 }}>
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
