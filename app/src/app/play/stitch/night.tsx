import type { ReactNode } from "react";
import type { GameState, Seat } from "@/game/types";
import { Phase } from "@/game/types";
import { livingSeats, short } from "@/game/engine";
import { ROOM_BY_ID, ROOMS, type ShipState } from "@/game/ship";
import { CREW_NAME, IMPOSTOR_NAME } from "@/game/variants";
import { CrewCard, Crewmate } from "../ship/Crewmate";
import { Ceremony, MicroTracker, AnonSet, beanId, visor } from "./chrome";
import st from "./stitch.module.css";
import s from "../play.module.css";

export function NightCrewBlind({
  game,
  secondsLeft,
  onPick,
  onSkip,
  canSkip,
  skipLabel,
}: {
  game: GameState;
  secondsLeft: number;
  onPick: (seat: number) => void;
  onSkip: () => void;
  canSkip: boolean;
  skipLabel: string;
}) {
  return (
    <div className={st.root}>
      <Ceremony
        kicker="Phase 03 of 07 · night cycle active (sleep shroud)"
        title="Quarters lockdown"
        pills={["ZK-circuits frozen", "Enclave blinded: 100% integrity", AnonSet({ game })]}
        seconds={secondsLeft}
        clockLabel="dawn re-sync"
      />
      <MicroTracker phase={Phase.NIGHT} />
      <div className={st.split}>
        <div className={st.pod}>
          <span className={st.sealOpen}>Optical transducers grounded</span>
          <Crewmate seat={0} size={88} faded />
          <p className={st.podCaption}>Eyes sealed · sensory shroud engaged</p>
          <p className={st.podSub}>
            Pass the device. Crew see nothing; the impostor picks a target. Equal timing is what
            stops the impostor being identified by how long the device was held.
          </p>
        </div>
        <aside className={st.card}>
          <h3 className={st.title} style={{ fontSize: 18 }}>Zero-leak blindfold</h3>
          <div className={st.rule}>
            <span className={st.ruleI}>◈</span>
            <div>
              <div className={st.ruleT}>Mathematical blinding</div>
              <div className={st.ruleB}>No optical telemetry leaves the night enclave.</div>
            </div>
          </div>
          <div className={st.rule}>
            <span className={st.ruleI}>◈</span>
            <div>
              <div className={st.ruleT}>Equal timing pad</div>
              <div className={st.ruleB}>Everyone holds the device. That is the alibi.</div>
            </div>
          </div>
          <div className={st.envelopes} style={{ marginTop: 12 }}>
            {game.seats.map((x) => (
              <CrewCard
                key={x.seat}
                seat={x.seat}
                name={x.name}
                dead={x.dead}
                onClick={() => onPick(x.seat)}
                disabled={x.isBot}
                tag={x.dead ? "ghost" : x.isBot ? "on its own" : "tap when holding"}
              />
            ))}
          </div>
          <div className={st.actions}>
            <button type="button" className={`${s.btn} ${s.btnGhost}`} onClick={onSkip} disabled={!canSkip}>
              {skipLabel}
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}

export function NightPlayFrame({
  game,
  me,
  secondsLeft,
  impostor,
  children,
}: {
  game: GameState;
  me: Seat;
  secondsLeft: number;
  impostor: boolean;
  children: ReactNode;
}) {
  const allies = game.seats.filter((x) => x.role === "IMPOSTOR" && x.seat !== me.seat);
  return (
    <div className={st.root}>
      <Ceremony
        kicker={
          impostor
            ? "Phase 03 of 07 · night shroud active"
            : "Phase 03 of 07 · night cycle active"
        }
        title={impostor ? "Impostor target-picker" : "The deck"}
        pills={
          impostor
            ? [
                `Operative ${beanId(me.seat)} ${visor(me.seat)}`,
                allies.length ? `Ally: ${allies.map((a) => a.name).join(", ")}` : "Solo cell",
                "Zero state trace",
              ]
            : [`Role: ${me.role === "SEER" ? "seer" : CREW_NAME.toLowerCase()}`, `${me.name} ${visor(me.seat)}`]
        }
        seconds={secondsLeft}
        clockLabel="dawn re-sync"
        danger={impostor}
      />
      <MicroTracker phase={Phase.NIGHT} />
      {children}
    </div>
  );
}

export function ImpostorRadar({
  game,
  ship,
  me,
  onKill,
  onVent,
  onSabotageLights,
  onSabotageReactor,
}: {
  game: GameState;
  ship: ShipState;
  me: Seat;
  onKill: (seat: number) => void;
  onVent: () => void;
  onSabotageLights: () => void;
  onSabotageReactor: () => void;
}) {
  const living = livingSeats(game);
  const here = ship.positions[me.seat];
  const targets = living.filter(
    (x) => x.seat !== me.seat && ship.positions[x.seat] === here,
  );
  const ready = Date.now() >= ship.killReadyAt;
  const lightsOut = ship.lightsOutUntil > Date.now();
  const reactor = ship.reactorDeadline > 0;

  return (
    <div className={st.split84}>
      <div>
        <div className={st.radar}>
          <svg className={st.radarGrid} viewBox="0 0 100 100" aria-hidden>
            <circle cx="50" cy="50" r="42" fill="none" stroke="#9d4edd" strokeOpacity="0.25" />
            <circle cx="50" cy="50" r="28" fill="none" stroke="#7bd0ff" strokeOpacity="0.2" />
            <circle cx="50" cy="50" r="14" fill="none" stroke="#9d4edd" strokeOpacity="0.35" />
            <line x1="50" y1="8" x2="50" y2="92" stroke="#23283b" />
            <line x1="8" y1="50" x2="92" y2="50" stroke="#23283b" />
          </svg>
          <div className={st.radarSweep} />
          {ROOMS.map((r) => (
            <span
              key={r.id}
              className={st.radarLabel}
              style={{ left: `${8 + r.col * 42}%`, top: `${10 + r.row * 48}%` }}
            >
              {r.name}
            </span>
          ))}
          {living.map((x) => {
            const room = ROOM_BY_ID[ship.positions[x.seat]];
            if (!room) return null;
            const locked = x.seat !== me.seat && ship.positions[x.seat] === here;
            return (
              <div
                key={x.seat}
                className={st.radarDot}
                style={{
                  left: `${18 + room.col * 32 + (x.seat % 3) * 6}%`,
                  top: `${22 + room.row * 40 + (x.seat % 2) * 8}%`,
                }}
              >
                {locked && <div className={st.lock}>Target lock</div>}
                <Crewmate seat={x.seat} size={36} title={x.name} />
                <div className={st.hint}>
                  {x.seat === me.seat ? "YOU" : x.name}
                </div>
              </div>
            );
          })}
        </div>
        <div className={st.sabotage} style={{ marginTop: 10 }}>
          <button type="button" className={st.sabBtn} onClick={onSabotageReactor} disabled={reactor}>
            <div className={st.sabN}>Meltdown</div>
            <div className={st.sabH}>{reactor ? "Armed" : "Forces the crew to the reactor"}</div>
          </button>
          <button type="button" className={st.sabBtn} onClick={onSabotageLights} disabled={lightsOut}>
            <div className={st.sabN}>Comms jam / lights</div>
            <div className={st.sabH}>{lightsOut ? "Dark" : "No sightings while dark"}</div>
          </button>
          <button type="button" className={st.sabBtn} onClick={onVent}>
            <div className={st.sabN}>Vent shift</div>
            <div className={st.sabH}>Jump the vent from {ROOM_BY_ID[here]?.name ?? "here"}</div>
          </button>
        </div>
      </div>
      <aside className={st.card}>
        <h3 className={st.title} style={{ fontSize: 18 }}>Selected target dossier</h3>
        <p className={st.hint}>
          You can only commit a strike on someone in {ROOM_BY_ID[here]?.name ?? "your room"}.
          {ready ? "" : " Kill cooldown is still ticking."}
        </p>
        {targets.length === 0 ? (
          <p className={st.hint} style={{ marginTop: 10 }}>
            No isolated target in this room. Walk the deck.
          </p>
        ) : (
          targets.map((t) => (
            <div key={t.seat} className={st.rule}>
              <Crewmate seat={t.seat} size={40} title={t.name} />
              <div style={{ flex: 1 }}>
                <div className={st.ruleT}>
                  {t.name} {beanId(t.seat)} {visor(t.seat)}
                </div>
                <div className={st.ruleB}>Isolated in {ROOM_BY_ID[here]?.name}</div>
                <button
                  type="button"
                  className={`${s.btn} ${s.btnDanger}`}
                  style={{ marginTop: 8, height: 36 }}
                  disabled={!ready}
                  onClick={() => onKill(t.seat)}
                >
                  Commit strike
                </button>
              </div>
            </div>
          ))
        )}
      </aside>
    </div>
  );
}

export function EmergencyReport({
  game,
  victim,
  onReport,
}: {
  game: GameState;
  victim: Seat;
  onReport: () => void;
}) {
  const living = livingSeats(game).filter((x) => x.seat !== victim.seat);
  return (
    <div className={st.root}>
      <div className={st.klaxon}>
        <div>
          <div className={st.klaxonT}>Critical incident: casualty discovered</div>
          <div className={st.hint} style={{ color: "#ffdad6" }}>
            Verified nullifier · {short(victim.payoutNoteId)} · {AnonSet({ game })}
          </div>
        </div>
        <span className={st.sealBroke}>Klaxon engaged</span>
      </div>
      <MicroTracker phase={Phase.NIGHT} emergency />
      <div className={st.split453}>
        <aside className={st.card}>
          <h3 className={st.title} style={{ fontSize: 18 }}>Casualty log</h3>
          <span className={st.sealBroke}>Nullified</span>
          <div className={st.banner} style={{ marginTop: 12, gridTemplateColumns: "1fr" }}>
            <div className={st.avatarCol}>
              <Crewmate seat={victim.seat} size={72} dead title={victim.name} />
              <div className={st.roleWord} style={{ fontSize: 18 }}>
                {victim.name}
              </div>
              <div className={st.roleSub}>Ejected from the night state root</div>
            </div>
          </div>
          <p className={st.hint} style={{ marginTop: 10 }}>
            Surviving beans · {living.length} alive
          </p>
          <div className={st.envelopes}>
            {living.map((x) => (
              <CrewCard key={x.seat} seat={x.seat} name={x.name} tag={x.seat === victim.seat ? "" : "alive"} />
            ))}
          </div>
        </aside>
        <div className={st.scene}>
          <div className={st.sceneTag}>Live forensic tape</div>
          <Crewmate seat={victim.seat} size={96} dead title={victim.name} />
          <p className={st.podCaption}>You died</p>
          <p className={st.podSub}>
            The kill note moved inside the pool. Report it — signed by your burner session key,
            never by the wallet that paid your buy-in.
          </p>
          <button type="button" className={`${s.btn} ${s.btnDanger}`} onClick={onReport}>
            Convene emergency table
          </button>
        </div>
        <aside className={st.card}>
          <h3 className={st.title} style={{ fontSize: 18 }}>ZK death guarantee</h3>
          <p className={st.hint}>
            The contract will only learn a kill happened when this report lands. Until then the
            note sits undecrypted.
          </p>
          <div className={st.enclave} style={{ marginTop: 12 }}>
            <p className={st.enclaveH}>Commitment nullifier hash</p>
            <div className={st.cellV}>{short(victim.sessionKey, 10, 6)}</div>
          </div>
        </aside>
      </div>
    </div>
  );
}
