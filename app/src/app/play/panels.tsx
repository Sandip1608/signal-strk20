"use client";

/**
 * One panel per phase of `round.cairo`. Each panel owns exactly the actions
 * that phase permits, so an illegal action is mostly unreachable in the UI —
 * and the engine still rejects it with the contract's own assert message if it
 * is reached anyway.
 */

import { useState } from "react";
import s from "./play.module.css";
import { DeviceGate, KeyValue, STAKE_STRK, Tally, useDeadline } from "./ui";
import { ShipMap } from "./ship/ShipMap";
import { CrewCard, Crewmate } from "./ship/Crewmate";
import { Ejection } from "./ship/Ejection";
import { ownDeviceSeat, useGame } from "@/game/store";
import { ROOM_BY_ID, sightingsFor, tasksComplete } from "@/game/ship";
import { ballotClosed, livingSeats, short } from "@/game/engine";
import { MAX_ROUNDS, SKIP_VOTE, type GameState, type Seat } from "@/game/types";
import { CREW_NAME, IMPOSTOR_NAME, impostorLabel } from "@/game/variants";

// ── Lobby ──────────────────────────────────────────────────────────────────

export function LobbyPanel({ game }: { game: GameState }) {
  const { addPlayer, addBot, fillWithBots, assignRoles } = useGame();
  const [name, setName] = useState("");

  const full = game.seats.length >= game.maxPlayers;
  const enough = game.seats.length >= game.minPlayers;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || full) return;
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
        {impostorLabel(game.hiddenCount).toLowerCase()} · {game.tasksPerPlayer} tasks each.
      </p>

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
          Join seat {game.seats.length}
        </button>
      </form>

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
        <span className={s.tagline}>Bots play their own turns — enough to run a round solo</span>
      </div>

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
    </div>
  );
}

// ── Roles ──────────────────────────────────────────────────────────────────

export function RolePanel({ game }: { game: GameState }) {
  const { viewerSeat, revealed, setViewer, reveal, cover, seeRole, startNight, mode, mySeat } =
    useGame();
  const pinned = ownDeviceSeat(game, mode, mySeat) !== null;

  const pending = game.seats.filter((x) => !x.roleSeen);
  const allSeen = pending.length === 0;
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
    <div className={s.panel}>
      <h2 className={s.panelTitle}>Roles assigned</h2>
      <p className={s.panelHint}>
        The host drew the impostor and posted <code>poseidon(impostor_seat, salt)</code> on-chain.
        That binds the draw — the host cannot re-pick after seeing the vote — without revealing it.
        {mode === "online"
          ? " Waiting for everyone to open their own note on their own device."
          : " Each player now opens their own encrypted note."}
      </p>

      <div className={s.crewRow}>
        {game.seats.map((x) => (
          <CrewCard
            key={x.seat}
            seat={x.seat}
            name={x.name}
            faded={x.roleSeen}
            onClick={() => setViewer(x.seat)}
            disabled={x.roleSeen || x.isBot}
            tag={
              x.isBot
                ? x.roleSeen ? "opened" : "opening…"
                : x.roleSeen ? "opened" : "tap to open"
            }
          />
        ))}
      </div>

      <div className={s.section}>
        <KeyValue k="Commitment" v={short(game.roleCommitment, 10, 6)} />
        <KeyValue k="Notes opened" v={`${game.seats.length - pending.length} / ${game.seats.length}`} />
      </div>

      <div className={s.btnRow}>
        <button type="button" className={s.btn} onClick={startNight} disabled={!allSeen}>
          Start night
        </button>
        {!allSeen && <span className={s.tagline}>{pending.length} still to open their note</span>}
      </div>
    </div>
  );
}

// ── Night ──────────────────────────────────────────────────────────────────

export function NightPanel({ game }: { game: GameState }) {
  const {
    viewerSeat, revealed, setViewer, reveal, cover, kill, report, skipNight,
    ship, moveTo, completeTask, mode, callMeeting, useVent, sabotageLights, fixLights,
    sabotageReactor, fixReactor, investigate, mySeat,
  } = useGame();
  const online = mode === "online";
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
      <div className={s.panel}>
        <h2 className={s.panelTitle}>Round {lastRound + 1} — the airlock</h2>
        <Ejection
          ejected={who ? { seat: who.seat, name: who.name } : null}
          caught={game.ejectedWasImpostor[lastRound] ?? false}
          hiddenLabelSingular={IMPOSTOR_NAME}
          tied={ejectedLast === 0}
          confirmEjects={game.confirmEjects}
          final={null}
          onDone={() => setWatchedBreak(game.roundNumber)}
        />
      </div>
    );
  }

  const viewer = viewerSeat === null ? null : game.seats.find((x) => x.seat === viewerSeat);
  // Read from `pendingVictim` rather than component state: a bot impostor kills
  // without this panel being mounted, and local state would also be lost on any
  // remount, stranding the round with nobody able to report.
  const victim =
    game.pendingVictim === 0 ? null : (game.seats[game.pendingVictim - 1] ?? null);

  // The victim self-reports with their session key; that call is what opens the
  // vote. Until then the contract knows nothing about the kill.
  if (victim && !victim.dead && (own === null || victim.seat === own)) {
    return (
      <div className={`${s.panel} ${s.alarm}`}>
        <p className={s.alarmBanner}>Emergency · body report</p>
        <h2 className={s.panelTitle}>A note arrived</h2>
        <p className={s.panelHint}>
          The kill note moved inside the pool. Only its recipient can decrypt it — the round
          contract still knows nothing.
        </p>
        {!revealed ? (
          <DeviceGate
            who={victim.name}
            hint="You received a private note. Open it away from the others."
            onReveal={reveal}
          />
        ) : (
          <>
            <div className={`${s.roleCard} ${s.roleImpostor}`}>
              <Crewmate seat={victim.seat} size={72} dead title={victim.name} />
              <p className={s.roleLabel}>Decrypted note</p>
              <p className={s.roleName}>YOU DIED</p>
              <p className={s.roleBlurb}>
                Report it to open the vote. This is signed by your burner session key, so it links
                to your seat — never to the wallet that paid your buy-in.
              </p>
            </div>
            <button
              type="button"
              className={`${s.btn} ${s.btnDanger}`}
              onClick={() => {
                report(victim.seat);
                cover();
              }}
            >
              Report my death (session key)
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
      <div className={s.panel}>
          <h2 className={s.panelTitle}>
            {isImpostor ? "Night shroud — target picker" : "Night shroud — eyes closed"}
          </h2>
        <p className={s.panelHint}>
          {viewer.dead
            ? "You are a ghost. You can still finish your tasks, but nobody can see you and you cannot vote."
            : isImpostor
              ? "Walk the deck. You can only kill someone standing in the same room as you — and the note moves privately inside the pool, so no transaction names you or your target."
              : "Walk the deck and finish your tasks. Note who you see and where — that is all the crew will have to argue from at the meeting."}
        </p>

        {ship ? (
          <ShipMap
            ship={ship}
            me={viewer}
            living={livingSeats(game)}
            canKill={isImpostor && !viewer.dead}
            onMove={(to) => moveTo(viewer.seat, to)}
            onCompleteTask={(taskId) => completeTask(viewer.seat, taskId)}
            onKill={(victim) => {
              kill(victim);
              cover();
            }}
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
            isImpostor={isImpostor}
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
      </div>
    );
  }

  return (
    <div className={s.panel}>
      <h2 className={s.panelTitle}>Night</h2>
      <p className={s.panelHint}>
        Pass the device around every living player in turn. Crew see nothing; the impostor picks a
        target. Passing to everyone is what stops the impostor being identified by how long the
        device was held.
      </p>

      <div className={s.crewRow}>
        {game.seats.map((x) => (
          <CrewCard
            key={x.seat}
            seat={x.seat}
            name={x.name}
            dead={x.dead}
            onClick={() => setViewer(x.seat)}
            disabled={x.isBot}
            tag={x.dead ? "ghost — tasks only" : x.isBot ? "on its own" : "tap when holding"}
          />
        ))}
      </div>

      <div className={s.btnRow}>
        <button
          type="button"
          className={`${s.btn} ${s.btnGhost}`}
          onClick={skipNight}
          disabled={!nightOver.passed}
        >
          {nightOver.passed ? "Skip night (host)" : `Skip in ${nightOver.secondsLeft}s`}
        </button>
        <span className={s.tagline}>
          {nightOver.passed
            ? "No body was reported. Call the meeting anyway."
            : "Only once the night runs out — until then, someone may still be killed."}
        </span>
      </div>
    </div>
  );
}

// ── Vote ───────────────────────────────────────────────────────────────────

export function VotePanel({ game }: { game: GameState }) {
  const { viewerSeat, revealed, setViewer, reveal, cover, vote, resolve, ship, mode, endVote, mySeat } =
    useGame();
  const online = mode === "online";
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
      <div className={s.panel}>
        <h2 className={s.panelTitle}>{viewer.name} — cast a shielded vote</h2>
        <p className={s.panelHint}>
          Your stake is withdrawn to the escrow through <code>privacy_invoke</code>. The escrow
          reports only <code>(candidate, amount)</code> to the tally; you stay inside the pool&apos;s
          anonymity set.
        </p>
        {ship && <Witnessed game={game} ship={ship} seat={viewer.seat} />}

        <div className={s.crewRow}>
          {living
            .filter((x) => x.seat !== viewer.seat)
            .map((x) => (
              <CrewCard
                key={x.seat}
                seat={x.seat}
                name={x.name}
                onClick={() => vote(viewer.seat, x.seat)}
                // Only a seer ever has a check to show — everyone else's copy
                // is redacted to `{}` before it leaves the server.
                tag={
                  x.seat in viewer.checks
                    ? viewer.checks[x.seat]
                      ? "you checked — IMPOSTOR"
                      : "you checked — clear"
                    : "cast nullifier"
                }
              />
            ))}
        </div>

        {/* Abstaining is a real Among Us move: without it every round forces
            an accusation even when nobody has evidence. It is an ordinary
            anonymous leg that names the SKIP_VOTE sentinel. */}
        <div className={s.btnRow}>
          <button
            type="button"
            className={`${s.btn} ${s.btnGhost}`}
            onClick={() => vote(viewer.seat, SKIP_VOTE)}
          >
            Skip — eject nobody
          </button>
          <span className={s.tagline}>
            If skips match or beat the top accusation, nobody goes out the airlock.
          </span>
        </div>
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
        <button
          type="button"
          className={`${s.btn} ${s.btnGhost}`}
          onClick={endVote}
          // `end_vote` refuses to open a round past the cap, so offering the
          // button there could only ever revert.
          disabled={!voteClosed.passed || atRoundCap}
        >
          {atRoundCap
            ? "Last round played"
            : voteClosed.passed
              ? "Next round (host)"
              : `Next round in ${voteClosed.secondsLeft}s`}
        </button>
        <button type="button" className={s.btn} onClick={resolve} disabled={!voteClosed.passed}>
          {voteClosed.passed
            ? "Reveal & resolve (host)"
            : `Reveal in ${voteClosed.secondsLeft}s`}
        </button>
        <span className={s.tagline}>
          {!voteClosed.passed
            ? // The host actions assert `ballot_closed()`, so they stay disabled
              // rather than firing a call that can only revert.
              `${toVote.length} still to vote — or wait out the clock`
            : atRoundCap
              ? // Reaching the cap is itself terminal: the impostors had every
                // round the game allows. Resolve is the only move left, and it
                // is now a legal one.
                `Round ${game.roundNumber + 1} was the last. Open the commitment to finish — surviving the cap is a crew win.`
              : everyoneVoted
                ? "Everyone has voted. No need to wait for the clock."
                : "Ballot closed. Play on, or open the commitment to finish — resolving before the game is actually over is rejected."}
        </span>
      </div>
    </div>
  );
}

/**
 * What one player personally saw during the night.
 *
 * This is the whole reason the deck and the tasks exist: the round is still
 * decided by the on-chain vote, but walking around to do tasks is what
 * generates the evidence people vote on. Each player sees only their own
 * sightings — pooling them is what the argument at the table is for.
 */
function Witnessed({
  game,
  ship,
  seat,
}: {
  game: GameState;
  ship: NonNullable<ReturnType<typeof useGame.getState>["ship"]>;
  seat: number;
}) {
  const all = sightingsFor(ship, seat);
  const nameOf = (n: number) => game.seats.find((x) => x.seat === n)?.name ?? `Seat ${n}`;

  // Collapse repeats: "saw Nova in Reactor" three times is one fact.
  const collapse = (xs: typeof all) => {
    const out: { who: number; room: string }[] = [];
    for (const sg of xs) {
      const room = ROOM_BY_ID[sg.room].name;
      if (!out.some((u) => u.who === sg.who && u.room === room)) out.push({ who: sg.who, room });
    }
    return out;
  };

  const witnessed = collapse(all.filter((x) => !x.viaLog && !x.visual));
  const proven = collapse(all.filter((x) => x.visual));
  const fromLog = collapse(all.filter((x) => x.viaLog));
  const finished = tasksComplete(ship, seat);
  const phrase = (u: { who: number; room: string }) => `${nameOf(u.who)} in ${u.room}`;

  return (
    <div className={s.section}>
      <p className={s.note}>
        <strong>What you saw.</strong>{" "}
        {witnessed.length === 0
          ? "Nobody — you were alone all night. That also means nobody can vouch for you."
          : `${witnessed.slice(0, 6).map(phrase).join(" · ")}.`}
      </p>

      {/* A visual task is the only hard evidence in the game: an impostor can
          never complete anything, so watching someone finish one clears them. */}
      {proven.length > 0 && (
        <p className={s.note} style={{ marginTop: 8, borderColor: "#1f6f63" }}>
          <strong>You watched them finish a task.</strong>{" "}
          {proven.map(phrase).join(" · ")}. Only crew can complete a task, so that clears them.
        </p>
      )}

      {/* Finishing your task list buys evidence. It does not change who wins —
          that is still whatever resolve_round computes from the vote. */}
      {fromLog.length > 0 && (
        <p className={s.note} style={{ marginTop: 8, borderColor: "#3a3560" }}>
          <strong>Security log.</strong>{" "}
          <span style={{ color: "#b78bff" }}>Unlocked by finishing your tasks.</span>{" "}
          {fromLog.map(phrase).join(" · ")}. You did not see this yourself.
        </p>
      )}
      {fromLog.length === 0 && !finished && (
        <p className={s.tagline} style={{ display: "block", marginTop: 8 }}>
          Finish your task list next round — it opens the security log and shows you movements you
          did not witness.
        </p>
      )}
    </div>
  );
}

// ── Resolved ───────────────────────────────────────────────────────────────

export function ResolvedPanel({ game }: { game: GameState }) {
  const { payout, resetGame } = useGame();
  const [paid, setPaid] = useState(false);

  // The whole impostor team, not just one seat — a round may have two or three.
  const hidden = game.hiddenSeats;
  const hiddenSeatObjs = game.seats.filter((x) => hidden.includes(x.seat));
  const ejected: Seat | undefined =
    game.ejected === 0 ? undefined : game.seats.find((x) => x.seat === game.ejected - 1);

  return (
    <div className={s.panel}>
      <div className={`${s.victory} ${game.crewWon ? s.victoryCrew : s.victoryImpostor}`}>
        <p className={s.victoryKicker}>Phase 07 · escrow settlement</p>
        <p className={s.victoryTitle}>
          {game.crewWon ? "Crew victory" : "Impostor victory"}
        </p>
        <p className={s.victorySub}>
          {game.crewWon
            ? "The hidden seats were ejected or outnumbered. The pot credits to living crew as shielded notes."
            : "Parity or sabotage. The pot routes to impostor nullifiers — never a public transfer."}
        </p>
      </div>
      <Ejection
        ejected={ejected ? { seat: ejected.seat, name: ejected.name } : null}
        caught={ejected !== undefined && hidden.includes(ejected.seat)}
        hiddenLabelSingular={IMPOSTOR_NAME}
        tied={game.ejected === 0}
        confirmEjects={game.confirmEjects}
        final={{ crewWon: game.crewWon, teamNames: hiddenSeatObjs.map((x) => x.name) }}
      />

      <div className={s.crewRow}>
        {game.seats.map((x) => (
          <CrewCard
            key={x.seat}
            seat={x.seat}
            name={x.name}
            dead={x.dead}
            faded={!hidden.includes(x.seat) && !game.crewWon}
            tag={
              hidden.includes(x.seat)
                ? IMPOSTOR_NAME.toLowerCase()
                : game.crewWon
                  ? `${CREW_NAME.toLowerCase()} · paid`
                  : CREW_NAME.toLowerCase()
            }
          />
        ))}
      </div>

      <div className={s.btnRow}>
        <button
          type="button"
          className={s.btn}
          onClick={() => {
            payout();
            setPaid(true);
          }}
          disabled={paid}
        >
          {paid ? "Pot credited" : "Pay out the pot"}
        </button>
        <button type="button" className={`${s.btn} ${s.btnGhost}`} onClick={resetGame}>
          New round
        </button>
        {paid && (
          <span className={s.tagline}>
            Credited to each winner&apos;s open note as a shielded balance — never a public transfer.
          </span>
        )}
      </div>

      {/* The proof still matters, but it is reference material, not the story —
          so it sits folded away under the scene rather than above it. */}
      <details className={s.proof}>
        <summary className={s.proofSummary}>Verify this round</summary>
        <div className={s.proofBody}>
          <p className={s.panelHint}>
            Recompute <code>poseidon(hidden_seats…, salt)</code> from the values below and
            compare with the commitment posted before anyone voted. They match, so the host could
            not have swapped the impostor after seeing the tally.
          </p>
          <KeyValue k="Commitment" v={short(game.roleCommitment, 12, 8)} />
          <KeyValue k="Salt (revealed)" v={short(game.salt, 12, 8)} />
          <KeyValue
            k={`${impostorLabel(game.hiddenCount)} seat${game.hiddenCount === 1 ? "" : "s"}`}
            v={hidden.join(", ")}
          />
          {game.seerCount > 0 && (
            <KeyValue
              k={`Seer seat${game.seerCount === 1 ? "" : "s"}`}
              v={game.seerSeats.join(", ") || "—"}
            />
          )}
          <KeyValue k="Total votes" v={String(game.totalVotes)} />
          <KeyValue
            k="Winners"
            v={`${game.crewWon ? game.seats.length - game.hiddenCount : game.hiddenCount} of ${game.seats.length}`}
          />
        </div>
      </details>
    </div>
  );
}
