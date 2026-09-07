"use client";

/**
 * One panel per phase of `round.cairo`. Each panel owns exactly the actions
 * that phase permits, so an illegal action is mostly unreachable in the UI —
 * and the engine still rejects it with the contract's own assert message if it
 * is reached anyway.
 */

import { useState } from "react";
import s from "./play.module.css";
import { DeviceGate, useDeadline } from "./ui";
import { ShipMap } from "./ship/ShipMap";
import { CrewCard } from "./ship/Crewmate";
import { ownDeviceSeat, useGame } from "@/game/store";
import { ballotClosed, livingSeats } from "@/game/engine";
import { displaySeat, type GameState } from "@/game/types";
import {
  MAX_IMPOSTORS,
  MAX_TASKS,
  MIN_IMPOSTORS,
  MIN_TASKS,
  PACES,
  PLAYER_CEILING,
  impostorLabel,
  minPlayersFor,
  normalise,
  optsFromSettings,
  settingsFromGame,
  type Settings,
} from "@/game/variants";
import { PublicLedger, RoleDossier } from "./stitch/role";
import { EmergencyReport, ImpostorRadar, NightCrewBlind, NightPlayFrame } from "./stitch/night";
import { VoteTable } from "./stitch/vote";
import { EjectionStage, PayoutStage } from "./stitch/end";
import { ROOM_BY_ID, sightingsFor, tasksComplete } from "@/game/ship";
import { ballotClosed, livingSeats, short } from "@/game/engine";
import { MAX_ROUNDS, SKIP_VOTE, type GameState, type Seat } from "@/game/types";
import { CREW_NAME, IMPOSTOR_NAME, impostorLabel } from "@/game/variants";

// ── Lobby ──────────────────────────────────────────────────────────────────

export function LobbyPanel({ game }: { game: GameState }) {
  const {
    addPlayer, addBot, fillWithBots, resetLobby, assignRoles, configureLobby,
    mode, mySeat, isHost,
  } = useGame();
  const [name, setName] = useState("");

  const full = game.seats.length >= game.maxPlayers;
  const enough = game.seats.length >= game.minPlayers;
  const seated = mode === "online" && mySeat !== null;
  const you = seated ? game.seats.find((x) => x.seat === mySeat) : null;
  const admin = mode !== "online" || isHost;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || full || seated) return;
    addPlayer(name.trim());
    setName("");
  };

  return (
    <div className={s.panel}>
      <h2 className={s.panelTitle}>Lobby</h2>
      <p className={s.panelHint}>
        Each player shields their buy-in, generates a burner session key in this browser, and
        pre-creates the open note their payout will land in. {game.minPlayers}–
        {game.maxPlayers} players · {game.hiddenCount}{" "}
        {impostorLabel(game.hiddenCount).toLowerCase()} · {game.nightDurationSecs}s night /{" "}
        {game.voteDurationSecs}s vote.
      </p>

      {admin ? (
        <HostSettings game={game} onChange={configureLobby} />
      ) : (
        <p className={s.note} style={{ marginBottom: 16 }}>
          <strong>Host is setting the table.</strong> {game.minPlayers}–{game.maxPlayers} seats ·{" "}
          {game.hiddenCount} {impostorLabel(game.hiddenCount).toLowerCase()} ·{" "}
          {game.tasksPerPlayer} tasks · {game.nightDurationSecs}s night / {game.voteDurationSecs}s
          vote.
        </p>
      )}

      {seated ? (
        <p className={s.tagline} style={{ display: "block", margin: "0 0 14px" }}>
          Seated as <strong>{you?.name ?? `Seat ${displaySeat(mySeat ?? 0)}`}</strong> — one seat per address.
        </p>
      ) : (
        <form onSubmit={submit} className={s.btnRow} style={{ marginTop: 0 }}>
          <input
            className={s.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={full ? "Lobby full" : "Player name"}
            disabled={full}
            maxLength={18}
            aria-label="Player name"
          />
          <button type="submit" className={s.btn} disabled={full || !name.trim()}>
            Join seat {displaySeat(game.seats.length)}
          </button>
        </form>
      )}

      {admin && (
        <div className={s.btnRow}>
          <button type="button" className={`${s.btn} ${s.btnGhost}`} onClick={addBot} disabled={full}>
            + Add bot
          </button>
          <button
            type="button"
            className={`${s.btn} ${s.btnGhost}`}
            onClick={fillWithBots}
            disabled={enough}
          >
            Fill to {game.minPlayers} with bots
          </button>
          {game.seats.some((x) => x.isBot) && (
            <button type="button" className={`${s.btn} ${s.btnGhost}`} onClick={resetLobby}>
              Reset lobby
            </button>
          )}
          <span className={s.tagline}>Bots play their own turns — enough to run a round solo</span>
        </div>
      )}

      {game.seats.length > 0 && (
        <div className={s.crewRow}>
          {game.seats.map((x) => (
            <CrewCard
              key={x.seat}
              seat={x.seat}
              name={x.name}
              tag={x.isBot ? "bot" : "player"}
            />
          ))}
        </div>
      )}

      <div className={s.section}>
        <p className={s.note}>
          <strong>Why two addresses per seat.</strong> The wallet that shields the buy-in is not the
          key that signs in-round actions — <code>join</code> rejects them being equal. Without that
          split, every vote and report would point straight back at the funding wallet.
        </p>
      </div>

      {admin && (
        <div className={s.btnRow}>
          <button type="button" className={s.btn} onClick={assignRoles} disabled={!enough}>
            Assign roles &amp; commit
          </button>
          {!enough && (
            <span className={s.tagline}>
              {game.minPlayers - game.seats.length} more player
              {game.minPlayers - game.seats.length === 1 ? "" : "s"} needed
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function HostSettings({
  game,
  onChange,
}: {
  game: GameState;
  onChange: (opts: ReturnType<typeof optsFromSettings>) => void;
}) {
  const settings = settingsFromGame(game);
  const floor = Math.max(minPlayersFor(settings.impostors), game.seats.length);
  const apply = (patch: Partial<Settings>) => onChange(optsFromSettings(normalise({ ...settings, ...patch })));

  return (
    <div className={s.section} style={{ marginBottom: 18 }}>
      <h3 className={s.panelTitle} style={{ fontSize: 15 }}>
        Round settings
      </h3>
      <p className={s.panelHint}>
        Only you can change these while the lobby is open. Impostors, table size and timers are
        constructor arguments; tasks and Confirm Ejects are client-side.
      </p>
      <div className={s.settings}>
        <Stepper
          label="Impostors"
          value={settings.impostors}
          min={MIN_IMPOSTORS}
          max={MAX_IMPOSTORS}
          onChange={(n) => apply({ impostors: n })}
          hint={`needs ${minPlayersFor(settings.impostors)}+ players`}
        />
        <Stepper
          label="Max players"
          value={settings.maxPlayers}
          min={floor}
          max={PLAYER_CEILING}
          onChange={(n) => apply({ maxPlayers: n })}
        />
        <Stepper
          label="Tasks each"
          value={settings.tasksPerPlayer}
          min={MIN_TASKS}
          max={MAX_TASKS}
          onChange={(n) => apply({ tasksPerPlayer: n })}
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
            onClick={() => apply({ seer: !settings.seer })}
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
            onClick={() => apply({ confirmEjects: !settings.confirmEjects })}
            className={`${s.toggle} ${settings.confirmEjects ? s.toggleOn : ""}`}
          >
            <span className={s.toggleKnob} />
          </button>
        </div>
      </div>
      <div className={s.btnRow} style={{ marginTop: 10 }}>
        {PACES.map((o) => (
          <button
            key={o.key}
            type="button"
            onClick={() => apply({ nightSecs: o.night, voteSecs: o.vote })}
            className={`${s.btn} ${
              settings.nightSecs === o.night && settings.voteSecs === o.vote ? "" : s.btnGhost
            }`}
          >
            {o.label} · {o.night >= 120 ? `${Math.round(o.night / 60)}m` : `${o.night}s`} night
          </button>
        ))}
      </div>
    </div>
  );
}

function Stepper({
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
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
        <span className={s.stepValue}>{value}</span>
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

// ── Roles ──────────────────────────────────────────────────────────────────

export function RolePanel({ game }: { game: GameState }) {
  const { viewerSeat, revealed, setViewer, reveal, cover, seeRole, startNight, mode, mySeat } =
    useGame();
  const pinned = ownDeviceSeat(game, mode, mySeat) !== null;

  // When the screen belongs to one player the viewer is permanently pinned to
  // their seat (there is no device to pass), so "have you looked yet" is what
  // decides the card-vs-roster view — otherwise the card would never clear and
  // Start night could never appear.
  const raw = viewerSeat === null ? null : game.seats.find((x) => x.seat === viewerSeat);
  const viewer = raw && raw.roleSeen && pinned ? null : raw;

  if (viewer && !revealed) {
    return (
      <div className={s.panel}>
        <h2 className={s.panelTitle}>Your role</h2>
        <p className={s.panelHint}>
          Delivered as a 0-value encrypted note. Only this seat&apos;s viewing key can open it — no
          server and no admin can read it.
        </p>
        <DeviceGate
          who={viewer.name}
          hint="Make sure nobody else can see the screen before you open your note."
          onReveal={reveal}
        />
      </div>
    );
  }

  if (viewer && revealed) {
    return (
      <RoleDossier
        game={game}
        viewer={viewer}
        onCommit={() => {
          seeRole(viewer.seat);
          cover();
        }}
      />
    const impostor = viewer.role === "IMPOSTOR";
    // Populated for an impostor in both modes: locally every role is in state,
    // and over the relay `viewFor` lets the IMPOSTOR label through to them.
    const partners = impostor
      ? game.seats.filter((x) => x.seat !== viewer.seat && x.role === "IMPOSTOR")
      : [];
    return (
      <div className={s.panel}>
        <h2 className={s.panelTitle}>Decryption ceremony</h2>
        <p className={s.panelHint}>
          Assignment note opened locally. Only this seat&apos;s viewing key can read it.
        </p>
        <div className={`${s.roleCard} ${impostor ? s.roleImpostor : s.roleCrew}`}>
          <span className={s.seal} aria-hidden>🔒</span>
          <Crewmate seat={viewer.seat} size={88} title={viewer.name} />
          <p className={s.roleLabel}>
            {impostor ? "Sealed envelope · impostor" : "Commendation note"} · seat {viewer.seat}
          </p>
          <p className={s.roleName}>
            {impostor ? IMPOSTOR_NAME : viewer.role === "SEER" ? "SEER" : CREW_NAME}
          </p>
          <p className={s.roleBlurb}>
            {impostor
              ? partners.length > 0
                ? `You are not alone — ${partners.map((x) => x.name).join(" and ")} ${partners.length === 1 ? "is" : "are"} with you. You cannot kill each other. Tonight one of you transfers the kill note to a crewmate, privately, inside the pool.`
                : "Tonight you transfer the kill note to one player, privately, inside the pool. Nobody sees the sender — not even the round contract."
              : viewer.role === "SEER"
                ? "You are crew, but once each night you may check one player and learn whether they are an impostor. The answer is yours alone — the table only hears it if you say it."
                : "Survive the night, then vote out the impostor. Your vote is anonymous; only the tally is public."}
          </p>
          {impostor && (
            <div className={s.perkList}>
              <div className={s.perk}>
                <div className={s.perkName}>Night kill</div>
                <div className={s.perkHint}>Private transfer — only from the same room, after cooldown.</div>
              </div>
              <div className={s.perk}>
                <div className={s.perkName}>Vents &amp; sabotage</div>
                <div className={s.perkHint}>Untraceable travel, lights out, reactor meltdown.</div>
              </div>
            </div>
          )}
          <div className={s.enclave}>
            <p className={s.enclaveLabel}>Client-side proof enclave · private to you</p>
            <KeyValue k="Burner session" v={short(viewer.sessionKey)} />
            <KeyValue k="Payout note" v={short(viewer.payoutNoteId)} />
            <KeyValue k="Shielded bond" v={`${STAKE_STRK}.00 STRK`} />
          </div>
        </div>
        <button
          type="button"
          className={s.btn}
          onClick={() => {
            seeRole(viewer.seat);
            cover();
          }}
        >
          Commit &amp; seal role
        </button>
      </div>
    );
  }

  return (
    <PublicLedger
      game={game}
      onOpen={setViewer}
      onStartNight={startNight}
    />
  );
}

// ── Night ──────────────────────────────────────────────────────────────────

export function NightPanel({ game }: { game: GameState }) {
  const {
    viewerSeat, revealed, setViewer, reveal, cover, kill, confirmDeath, reportBody, skipNight,
    ship, moveTo, completeTask, mode, callMeeting, useVent, sabotageLights, fixLights,
    sabotageReactor, fixReactor, investigate, mySeat,
  } = useGame();
  const own = ownDeviceSeat(game, mode, mySeat);
  const nightOver = useDeadline(game.nightDeadline);

  // The ejection that ended the previous round. `endVote` goes straight back to
  // NIGHT, so without this the airlock beat only ever existed as a line in the
  // activity log — you were simply dead, or someone else was, with no scene.
  const lastRound = game.roundNumber - 1;
  const [watchedBreak, setWatchedBreak] = useState(-1);
  const breakDue = game.roundNumber > 0 && watchedBreak < game.roundNumber;
  const ejectedLast = game.ejections[lastRound] ?? 0;

  if (breakDue) {
    const who = ejectedLast === 0 ? null : game.seats[ejectedLast - 1];
    return (
      <EjectionStage
        game={game}
        who={who ?? null}
        caught={game.ejectedWasImpostor[lastRound] ?? false}
        tied={ejectedLast === 0}
        onDone={() => setWatchedBreak(game.roundNumber)}
      />
    );
  }

  const viewer = viewerSeat === null ? null : game.seats.find((x) => x.seat === viewerSeat);
  // Read from `pendingVictim` rather than component state: a bot impostor kills
  // without this panel being mounted, and local state would also be lost on any
  // remount, stranding the round with nobody able to report.
  const victim =
    game.pendingVictim === 0 ? null : (game.seats[game.pendingVictim - 1] ?? null);

  // The victim attests to their own death with their session key — the only
  // proof of a death the contract can have, since it never learns a kill
  // happened. It no longer opens the vote: it leaves a body for someone to find.
  if (victim && !victim.dead && (own === null || victim.seat === own)) {
    if (!revealed) {
      return (
        <div className={s.panel}>
          <h2 className={s.panelTitle}>A note arrived</h2>
          <DeviceGate
            who={victim.name}
            hint="You received a private note. Open it away from the others."
            onReveal={reveal}
          />
        </div>
      );
    }
    return (
      <EmergencyReport
        game={game}
        victim={victim}
        onReport={() => {
          report(victim.seat);
          cover();
        }}
      />
        ) : (
          <>
            <div className={`${s.roleCard} ${s.roleImpostor}`}>
              <Crewmate seat={victim.seat} size={72} dead title={victim.name} />
              <p className={s.roleLabel}>Decrypted note</p>
              <p className={s.roleName}>YOU DIED</p>
              <p className={s.roleBlurb}>
                Open the note and you are dead — signed by your burner session key, so it links to
                your seat and never to the wallet that paid your buy-in. Your body stays where you
                fell, and the round runs on until somebody walks in and finds it.
              </p>
            </div>
            <button
              type="button"
              className={`${s.btn} ${s.btnDanger}`}
              onClick={() => {
                confirmDeath(victim.seat);
                cover();
              }}
            >
              Open the note (session key)
            </button>
          </>
        )}
      </div>
    );
  }

  if (viewer && !revealed) {
    return (
      <div className={s.panel}>
        <h2 className={s.panelTitle}>Night</h2>
        <DeviceGate
          who={viewer.name}
          hint="Only you should see what happens next."
          onReveal={reveal}
        />
      </div>
    );
  }

  if (viewer && revealed) {
    const isImpostor = viewer.role === "IMPOSTOR";
    return (
      <NightPlayFrame
        game={game}
        me={viewer}
        secondsLeft={nightOver.secondsLeft}
        impostor={!!isImpostor}
      >
        {isImpostor && ship && !viewer.dead && (
          <ImpostorRadar
            game={game}
            ship={ship}
            me={viewer}
            onKill={(v) => {
              kill(v);
              cover();
            }}
            onVent={() => useVent(viewer.seat)}
            onSabotageLights={sabotageLights}
            onSabotageReactor={sabotageReactor}
          />
        )}
        {ship ? (
          <ShipMap
            ship={ship}
            me={viewer}
            living={livingSeats(game)}
            canKill={!!isImpostor && !viewer.dead}
            onMove={(to) => moveTo(viewer.seat, to)}
            onCompleteTask={(taskId) => completeTask(viewer.seat, taskId)}
            onKill={(v) => {
              kill(v);
              cover();
            }}
            bodies={ship ? ship.bodies : {}}
            onReportBody={(v) => reportBody(viewer.seat, v)}
            partners={
              isImpostor
                ? game.seats
                    .filter((x) => x.seat !== viewer.seat && x.role === "IMPOSTOR")
                    .map((x) => x.seat)
                : []
            }
            onInvestigate={(target) => investigate(viewer.seat, target)}
            canCheck={
              viewer.role === "SEER" &&
              !viewer.dead &&
              viewer.checkedRound !== game.roundNumber
            }
            onVent={() => useVent(viewer.seat)}
            onSabotage={sabotageLights}
            onFixLights={fixLights}
            onCallMeeting={() => callMeeting(viewer.seat)}
            canCallMeeting={!viewer.calledMeeting && !viewer.dead}
            onSabotageReactor={sabotageReactor}
            onFixReactor={fixReactor}
            isImpostor={!!isImpostor}
          />
        ) : (
          <p className={s.panelHint}>The deck is not ready.</p>
        )}

        {/* A night can end with nobody killed, and then someone has to say so.
            This control lived only in the pass-the-device roster below, which
            pinning the viewer to one player made unreachable — so an expired
            night with no body had no way forward at all. A ghost felt it worst:
            they cannot call a meeting either, so the round simply stopped. */}
        {nightOver.passed && (
          <div className={s.btnRow}>
            <button type="button" className={`${s.btn} ${s.btnGhost}`} onClick={skipNight}>
              Skip night (host)
            </button>
            <span className={s.tagline}>
              The night is over and no body was reported — call everyone in.
            </span>
          </div>
        )}

        {/* Nothing to hide from when the screen has one owner. */}
        {own === null && (
          <div className={s.btnRow}>
            <button type="button" className={`${s.btn} ${s.btnGhost}`} onClick={cover}>
              Hide and pass on
            </button>
          </div>
        )}
      </NightPlayFrame>
    );
  }

  return (
    <NightCrewBlind
      game={game}
      secondsLeft={nightOver.secondsLeft}
      onPick={setViewer}
      onSkip={skipNight}
      canSkip={nightOver.passed}
      skipLabel={nightOver.passed ? "Skip night (host)" : `Skip in ${nightOver.secondsLeft}s`}
    />
  );
}

// ── Vote ───────────────────────────────────────────────────────────────────

export function VotePanel({ game }: { game: GameState }) {
  const { viewerSeat, revealed, setViewer, reveal, cover, vote, ship, mode, continueRound, mySeat } =
    useGame();
  const pinned = ownDeviceSeat(game, mode, mySeat) !== null;
  const deadline = useDeadline(game.voteDeadline);
  // Either the clock ran out, or everyone has voted — no reason to sit and
  // watch a timer nobody is still using.
  const everyoneVoted = livingSeats(game).every((x) => x.hasVoted);
  const voteClosed = {
    passed: deadline.passed || everyoneVoted || ballotClosed(game),
    secondsLeft: deadline.secondsLeft,
  };

  const living = livingSeats(game);
  const toVote = living.filter((x) => !x.hasVoted);
  // No further round can be opened past this point — see `MAX_ROUNDS`.
  const atRoundCap = game.roundNumber + 1 >= MAX_ROUNDS;
  // The crew's other win. Nobody would know they had won it without being told:
  // the bar fills and then nothing visibly happens until the host resolves.
  const tasksDone =
    ship !== null && ship.crewProgress.total > 0 &&
    ship.crewProgress.done >= ship.crewProgress.total;
  const rawViewer = viewerSeat === null ? null : game.seats.find((x) => x.seat === viewerSeat);
  // Same reason as the role card: on a screen pinned to one player, having
  // voted (or being dead) is what returns you to the tally, since the viewer
  // never clears on its own.
  const viewer = rawViewer && pinned && (rawViewer.hasVoted || rawViewer.dead) ? null : rawViewer;

  if (viewer && !revealed) {
    return (
      <div className={s.panel}>
        <h2 className={s.panelTitle}>Cast your vote</h2>
        <DeviceGate
          who={viewer.name}
          hint="Your vote leg is anonymous inside the pool, but the person next to you is not a cryptographic primitive — cover the screen."
          onReveal={reveal}
        />
      </div>
    );
  }

  if (viewer && revealed) {
    return (
      <VoteTable
        game={game}
        ship={ship}
        viewer={viewer}
        onCast={(candidate) => {
          vote(viewer.seat, candidate);
          cover();
        }}
        host={
          <div className={s.btnRow}>
            <button type="button" className={`${s.btn} ${s.btnGhost}`} onClick={cover}>
              Cancel
            </button>
          </div>
        }
      />
    );
  }

  return (
    <VoteTable
      game={game}
      ship={ship}
      onPickSeat={setViewer}
      host={
        <div className={s.btnRow}>
          <button
            type="button"
            className={`${s.btn} ${s.btnGhost}`}
            onClick={endVote}
            disabled={!voteClosed.passed}
          >
            {voteClosed.passed ? "Next round (host)" : `Next round in ${voteClosed.secondsLeft}s`}
          </button>
          <button type="button" className={s.btn} onClick={resolve} disabled={!voteClosed.passed}>
            {voteClosed.passed ? "Reveal & resolve (host)" : `Reveal in ${voteClosed.secondsLeft}s`}
          </button>
          <span className={s.tagline}>
            {!voteClosed.passed
              ? `${toVote.length} still to vote — or wait out the clock`
              : everyoneVoted
                ? "Everyone has voted. No need to wait for the clock."
                : "Ballot closed. Play on, or open the commitment to finish."}
          </span>
        </div>
      }
    />
        <div className={s.btnRow}>
          <button type="button" className={`${s.btn} ${s.btnGhost}`} onClick={cover}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={s.panel}>
      <h2 className={s.panelTitle}>Discussion &amp; vote table</h2>
      <p className={s.panelHint}>
        {game.nightVictim === 0
          ? "Nobody was reported dead. Vote anyway."
          : `${game.seats[game.nightVictim - 1]?.name} was found dead. Vote to eject.`}{" "}
        Living players vote once each.
      </p>

      <div className={s.tableWrap}>
        <div className={s.orbit}>
          <div className={s.orbitCore}>Nullifier circuit active</div>
          {game.seats.map((x) => (
            <CrewCard
              key={x.seat}
              seat={x.seat}
              name={x.name}
              dead={x.dead}
              faded={x.hasVoted}
              onClick={() => setViewer(x.seat)}
              disabled={x.dead || x.hasVoted || x.isBot}
              tag={
                x.dead
                  ? "dead"
                  : x.hasVoted
                    ? "voted"
                    : x.isBot
                      ? "deciding…"
                      : "tap to vote"
              }
            />
          ))}
        </div>

        <div className={s.section} style={{ marginTop: 0 }}>
          <h3 className={s.panelTitle} style={{ fontSize: 14, marginBottom: 8 }}>
            Public tally ledger
          </h3>
          <Tally game={game} />
          <p className={s.tagline} style={{ display: "block", marginTop: 6 }}>
            Skip: {String(game.skipTally)} — nobody is ejected unless one player beats this.
          </p>
        </div>
      </div>

      <div className={s.btnRow}>
        {/* One button, not two.

            Offering "Next round" and "Reveal & resolve" side by side asked the
            host to answer a question only the contract can: mid-game the roles
            are sealed, so nobody at the table knows whether the round is
            decided. Choosing wrong rounded straight past a win — a table voted
            out the last impostor and the game started another night.

            This asks instead. It tries to finish, and plays on only if the
            contract's own guard says the game is not over. */}
        <button
          type="button"
          className={s.btn}
          onClick={continueRound}
          disabled={!voteClosed.passed}
        >
          {voteClosed.passed ? "Continue (host)" : `Continue in ${voteClosed.secondsLeft}s`}
        </button>
        <span className={s.tagline}>
          {!voteClosed.passed
            ? // The host actions assert `ballot_closed()`, so they stay disabled
              // rather than firing a call that can only revert.
              `${toVote.length} still to vote — or wait out the clock`
            : tasksDone
              ? "Every crew task is done — open the commitment and the contract will count them as a crew win."
              : atRoundCap
              ? // Reaching the cap is itself terminal: the impostors had every
                // round the game allows.
                `Round ${game.roundNumber + 1} was the last — continuing will open the commitment and finish. Surviving the cap is a crew win.`
              : everyoneVoted
                ? "Everyone has voted. No need to wait for the clock."
                : "Ballot closed. Continue: the contract opens the commitment if the game is decided, and deals another night if it is not."}
        </span>
      </div>
    </div>
  );
}

export function ResolvedPanel({ game }: { game: GameState }) {
  const { payout, resetGame } = useGame();
  const [paid, setPaid] = useState(false);

  return (
    <PayoutStage
      game={game}
      paid={paid}
      onPayout={() => {
        payout();
        setPaid(true);
      }}
      onReset={resetGame}
    />
  );
}
