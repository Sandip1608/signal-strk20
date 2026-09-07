import { useState, type CSSProperties, type ReactNode } from "react";
import type { GameState, Seat } from "@/game/types";
import { Phase, SKIP_VOTE, displaySeat } from "@/game/types";
import { livingSeats, short } from "@/game/engine";
import { ROOM_BY_ID, sightingsFor, tasksComplete, type ShipState } from "@/game/ship";
import { CrewCard, Crewmate } from "../ship/Crewmate";
import { Ceremony, MicroTracker, AnonSet, beanId, visor } from "./chrome";
import { STAKE_STRK } from "../ui";
import st from "./stitch.module.css";
import s from "../play.module.css";

function rimStyle(i: number, n: number): CSSProperties {
  const angle = (i / Math.max(n, 1)) * Math.PI * 2 - Math.PI / 2;
  return {
    left: `${50 + 38 * Math.cos(angle)}%`,
    top: `${48 + 36 * Math.sin(angle)}%`,
  };
}

export function VoteTable({
  game,
  ship,
  viewer,
  onPickSeat,
  onCast,
  host,
}: {
  game: GameState;
  ship: ShipState | null;
  viewer?: Seat | null;
  onPickSeat?: (seat: number) => void;
  onCast?: (candidate: number) => void;
  host?: ReactNode;
}) {
  const living = livingSeats(game);
  const committed = living.filter((x) => x.hasVoted).length;
  const victim = game.nightVictim === 0 ? null : game.seats[game.nightVictim - 1];
  const [target, setTarget] = useState<number | null>(null);
  const max = living.reduce((m, x) => {
    const t = game.tallies[x.seat] ?? 0n;
    return t > m ? t : m;
  }, game.skipTally);

  return (
    <div className={st.root}>
      <Ceremony
        kicker="Phase 05 of 07 · ballot commit"
        title="Emergency debate"
        pills={[
          victim ? `Body: ${victim.name}` : "No body reported",
          "ZK-STARK verified",
          AnonSet({ game }),
        ]}
        seconds={Math.max(0, Math.ceil((game.voteDeadline - Date.now()) / 1000))}
        clockLabel="epoch closes"
        danger
      />
      <MicroTracker phase={Phase.VOTE} />

      <div className={st.split363}>
        <aside className={st.card}>
          {viewer ? (
            <>
              <h3 className={st.title} style={{ fontSize: 16 }}>My shielded secret</h3>
              <div className={st.avatarCol} style={{ margin: "12px 0" }}>
                <Crewmate seat={viewer.seat} size={64} title={viewer.name} />
                <div className={st.roleSub}>
                  {beanId(viewer.seat)} (you) {visor(viewer.seat)}
                </div>
              </div>
              <div className={st.stat}>
                <div className={st.statK}>Burner pubkey</div>
                <div className={st.cellV}>{short(viewer.sessionKey)}</div>
              </div>
              <div className={st.stat} style={{ marginTop: 8 }}>
                <div className={st.statK}>Shielded deposit</div>
                <div className={st.statV}>{STAKE_STRK} STRK</div>
              </div>
              {ship && <Witnessed game={game} ship={ship} seat={viewer.seat} />}
            </>
          ) : (
            <>
              <h3 className={st.title} style={{ fontSize: 16 }}>Chamber status</h3>
              <p className={st.hint}>
                {committed} / {living.length} sealed. Living players vote once each.
              </p>
            </>
          )}
        </aside>

        <div>
          <div className={st.tableStage}>
            <div className={st.felt} />
            <div className={st.hub}>
              <div className={st.hubT}>STRK20 privacy pool</div>
              <div className={st.hubS}>
                Nullifier circuit · {committed}/{living.length} sealed
              </div>
            </div>
            {game.seats.map((x, i) => (
              <div key={x.seat} className={st.seatAbs} style={rimStyle(i, game.seats.length)}>
                <CrewCard
                  seat={x.seat}
                  name={x.name}
                  size={48}
                  dead={x.dead}
                  faded={x.hasVoted}
                  selected={viewer ? target === x.seat : false}
                  onClick={
                    viewer && onCast
                      ? x.dead || x.seat === viewer.seat
                        ? undefined
                        : () => setTarget(x.seat)
                      : onPickSeat && !x.dead && !x.hasVoted && !x.isBot
                        ? () => onPickSeat(x.seat)
                        : undefined
                  }
                  disabled={
                    viewer
                      ? x.dead || x.seat === viewer.seat
                      : x.dead || x.hasVoted || x.isBot
                  }
                  tag={
                    x.dead
                      ? "ghost"
                      : x.hasVoted
                        ? "voted (shielded)"
                        : viewer && x.seat === viewer.seat
                          ? "you · vote ready"
                          : x.isBot
                            ? "deciding…"
                            : viewer
                              ? "select"
                              : "tap to vote"
                  }
                />
              </div>
            ))}
          </div>

          {viewer && onCast && (
            <div className={st.card} style={{ marginTop: 12 }}>
              <h3 className={st.title} style={{ fontSize: 16 }}>Shielded voting terminal</h3>
              <p className={st.hint}>
                Your vote is sealed in a frosted-veil note and mixed through the pool. The escrow
                reports only (candidate, amount).
              </p>
              <div className={st.targets} style={{ marginTop: 10 }}>
                {living
                  .filter((x) => x.seat !== viewer.seat)
                  .map((x) => (
                    <button
                      key={x.seat}
                      type="button"
                      className={`${st.tgt} ${target === x.seat ? st.tgtOn : ""}`}
                      onClick={() => setTarget(x.seat)}
                    >
                      {visor(x.seat)} {x.name}
                    </button>
                  ))}
                <button
                  type="button"
                  className={`${st.tgt} ${target === SKIP_VOTE ? st.tgtOn : ""}`}
                  onClick={() => setTarget(SKIP_VOTE)}
                >
                  ∅ Skip
                </button>
              </div>
              <div className={st.actions}>
                <button
                  type="button"
                  className={s.btn}
                  disabled={target === null}
                  onClick={() => target !== null && onCast(target)}
                >
                  Cast shielded nullifier note
                </button>
              </div>
            </div>
          )}
        </div>

        <aside className={st.card}>
          <h3 className={st.title} style={{ fontSize: 16 }}>Public tally ledger</h3>
          <span className={st.pillGold}>
            {committed} / {living.length} committed
          </span>
          {living.length - committed > 0 ? (
            <p className={st.hint} style={{ marginTop: 8 }}>
              {living.length - committed} uncast — counted as skip if the clock runs out.
            </p>
          ) : null}
          <div style={{ marginTop: 10 }}>
            {living.map((seat) => {
              const t = game.tallies[seat.seat] ?? 0n;
              const pct = max > 0n ? Number((t * 100n) / max) : 0;
              return (
                <div key={seat.seat} className={st.tallyRow}>
                  <span className={st.tallyN}>{seat.name}</span>
                  <span className={st.tallyB}>
                    <span className={st.tallyF} style={{ width: `${pct}%` }} />
                  </span>
                  <span className={st.tallyC}>{String(t)}</span>
                </div>
              );
            })}
            <div className={st.tallyRow}>
              <span className={st.tallyN}>Skip</span>
              <span className={st.tallyB}>
                <span
                  className={st.tallyF}
                  style={{
                    width: max > 0n ? `${Number((game.skipTally * 100n) / max)}%` : 0,
                    background: "#64748b",
                  }}
                />
              </span>
              <span className={st.tallyC}>{String(game.skipTally)}</span>
            </div>
          </div>
          <h3 className={st.title} style={{ fontSize: 16, marginTop: 16 }}>
            Interrogation log
          </h3>
          <div className={st.log}>
            {[...game.log].reverse().slice(0, 8).map((e, i) => (
              <div key={i} className={`${st.logItem} ${e.private ? st.logPriv : ""}`}>
                <div className={st.logCall}>{e.call}</div>
                {e.text}
              </div>
            ))}
          </div>
          {host}
        </aside>
      </div>
    </div>
  );
}

function Witnessed({
  game,
  ship,
  seat,
}: {
  game: GameState;
  ship: ShipState;
  seat: number;
}) {
  const all = sightingsFor(ship, seat);
  const nameOf = (n: number) => game.seats.find((x) => x.seat === n)?.name ?? `Seat ${displaySeat(n)}`;
  const collapse = (xs: typeof all) => {
    const out: { who: number; room: string }[] = [];
    for (const sg of xs) {
      const room = ROOM_BY_ID[sg.room].name;
      if (!out.some((u) => u.who === sg.who && u.room === room)) out.push({ who: sg.who, room });
    }
    return out;
  };
  const seen = collapse(all.filter((x) => !x.viaLog && !x.visual));
  const proven = collapse(all.filter((x) => x.visual));
  const fromLog = collapse(all.filter((x) => x.viaLog));
  const phrase = (u: { who: number; room: string }) => `${nameOf(u.who)} in ${u.room}`;

  return (
    <div style={{ marginTop: 12 }}>
      <p className={st.hint}>
        <strong>What you saw.</strong>{" "}
        {seen.length === 0 ? "Nobody — you were alone." : seen.slice(0, 6).map(phrase).join(" · ")}
      </p>
      {proven.length > 0 && (
        <p className={st.hint} style={{ color: "#10b981", marginTop: 6 }}>
          Visual task: {proven.map(phrase).join(" · ")}. That clears them.
        </p>
      )}
      {fromLog.length > 0 && (
        <p className={st.hint} style={{ color: "#c77dff", marginTop: 6 }}>
          Security log: {fromLog.map(phrase).join(" · ")}.
        </p>
      )}
      {fromLog.length === 0 && !tasksComplete(ship, seat) && (
        <p className={st.hint} style={{ marginTop: 6 }}>
          Finish your tasks next night to open the security log.
        </p>
      )}
    </div>
  );
}
