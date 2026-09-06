"use client";

/**
 * The 2D deck view — the night phase's play surface.
 *
 * A CSS grid of rooms with absolutely-positioned crewmates, moved by CSS
 * transitions. No canvas and no game loop: the only thing that animates per
 * frame is the stabilise needle, inside its own minigame. That keeps the whole
 * screen cheap enough to run on the phone this game is meant to be passed
 * around on.
 *
 * Fog of war is the important rule here — you see who is in *your* room and
 * nowhere else. Showing every dot on the map would hand the crew perfect
 * information and there would be nothing left to deduce at the meeting.
 */

import { useEffect, useState } from "react";
import s from "./ship.module.css";
import { Minigame } from "./Minigames";
import {
  ROOMS,
  ROOM_BY_ID,
  killCooldownLeft,
  killReady,
  lightsOut,
  lightsOutLeft,
  neighbours,
  occupants,
  taskHere,
  taskProgress,
  ventFrom,
  type RoomId,
  type ShipState,
} from "@/game/ship";
import { Crewmate } from "./Crewmate";
import type { Seat } from "@/game/types";

/**
 * Corridors joining adjacent rooms, drawn behind the grid.
 *
 * Purely decorative, but it is what makes the deck read as a ship rather than
 * six cards: the lines show at a glance which rooms connect, which is exactly
 * the adjacency `move` enforces.
 */
function Corridors() {
  // Grid cell centres as percentages: 3 columns, 2 rows.
  const cx = (col: number) => ((col + 0.5) / 3) * 100;
  const cy = (row: number) => ((row + 0.5) / 2) * 100;

  const links: [number, number, number, number][] = [];
  for (const a of ROOMS) {
    for (const b of ROOMS) {
      if (a.id >= b.id) continue;
      if (Math.abs(a.col - b.col) + Math.abs(a.row - b.row) !== 1) continue;
      links.push([cx(a.col), cy(a.row), cx(b.col), cy(b.row)]);
    }
  }

  return (
    <svg className={s.corridors} aria-hidden viewBox="0 0 100 100" preserveAspectRatio="none">
      {links.map(([x1, y1, x2, y2], i) => (
        <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
}

export function ShipMap({
  ship,
  me,
  living,
  onMove,
  onCompleteTask,
  onKill,
  canKill,
  onVent,
  onSabotage,
  onFixLights,
  onCallMeeting,
  canCallMeeting,
}: {
  ship: ShipState;
  me: Seat;
  living: Seat[];
  onMove: (to: RoomId) => void;
  onCompleteTask: (taskId: string) => void;
  onKill: (victim: number) => void;
  canKill: boolean;
  onVent: () => void;
  onSabotage: () => void;
  onFixLights: () => void;
  onCallMeeting: () => void;
  canCallMeeting: boolean;
}) {
  const [openTask, setOpenTask] = useState<string | null>(null);
  // Re-render once a second so the cooldown and lights timers tick.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, []);

  const dark = lightsOut(ship);
  const canKillNow = canKill && killReady(ship);
  const cooldown = killCooldownLeft(ship);
  const ventTo = canKill ? ventFrom(ship.positions[me.seat]) : null;

  const livingSeats = living.map((x) => x.seat);
  const here = ship.positions[me.seat];
  const canGo = neighbours(here);
  const roomMates = occupants(ship, here, livingSeats).filter((x) => x !== me.seat);
  const task = taskHere(ship, me.seat);
  const myTasks = ship.tasks[me.seat] ?? [];
  const progress = taskProgress(ship, livingSeats);

  const active = myTasks.find((t) => t.id === openTask) ?? null;

  return (
    <div className={s.wrap}>
      {/* ── deck ─────────────────────────────────────────────────────── */}
      <div className={s.deck}>
        <Corridors />
        {ROOMS.map((room) => {
          const isHere = room.id === here;
          const reachable = canGo.includes(room.id);
          const mine = myTasks.find((t) => t.room === room.id && !t.done);
          // Fog of war: crewmates render only in the room you are standing in —
          // and in the dark, not even them.
          const dots = isHere ? (dark ? [me.seat] : [me.seat, ...roomMates]) : [];

          return (
            <button
              key={room.id}
              type="button"
              disabled={!reachable}
              onClick={() => reachable && onMove(room.id)}
              style={{ gridColumn: room.col + 1, gridRow: room.row + 1 }}
              className={[
                s.room,
                isHere ? s.roomHere : "",
                reachable ? s.roomOpen : "",
                !isHere && !reachable ? s.roomFar : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <span className={s.roomName}>{room.name}</span>

              {mine && <span className={s.taskPip} title="You have a task here" />}

              <span className={s.dots}>
                {dots.map((seat) => (
                  <span key={seat} className={seat === me.seat ? s.dotMe : undefined}>
                    <Crewmate
                      seat={seat}
                      size={22}
                      title={living.find((x) => x.seat === seat)?.name}
                    />
                  </span>
                ))}
              </span>

              {reachable && <span className={s.goHint}>Move</span>}
            </button>
          );
        })}
      </div>

      {/* ── status strip ─────────────────────────────────────────────── */}
      <div className={s.status}>
        <span className={s.statusRoom}>{ROOM_BY_ID[here].name}</span>
        <span className={s.statusWho}>
          {dark
            ? `Lights out — you cannot see who is here (${lightsOutLeft(ship)}s)`
            : roomMates.length === 0
              ? "You are alone here."
              : `With you: ${roomMates.map((x) => living.find((l) => l.seat === x)?.name).join(", ")}`}
        </span>
        <span className={s.progressWrap} title="Crew tasks completed">
          <span
            className={s.progressBar}
            style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
          />
        </span>
        <span className={s.progressNum}>
          {progress.done}/{progress.total}
        </span>
      </div>

      {/* ── actions ──────────────────────────────────────────────────── */}
      <div className={s.actions}>
        {task ? (
          <button type="button" className={s.primary} onClick={() => setOpenTask(task.id)}>
            {task.label}
          </button>
        ) : (
          <span className={s.noTask}>
            {myTasks.every((t) => t.done)
              ? "All your tasks are done — keep moving, or watch someone."
              : "No task in this room. Head for a room with a dot."}
          </span>
        )}

        {canKill &&
          roomMates.map((victim) => (
            <button
              key={victim}
              type="button"
              className={s.kill}
              disabled={!canKillNow}
              onClick={() => onKill(victim)}
            >
              {canKillNow
                ? `Kill ${living.find((x) => x.seat === victim)?.name}`
                : `Kill in ${cooldown}s`}
            </button>
          ))}

        {ventTo && (
          <button type="button" className={s.vent} onClick={onVent}>
            Vent to {ROOM_BY_ID[ventTo].name}
          </button>
        )}

        {canKill && !dark && (
          <button type="button" className={s.sabotage} onClick={onSabotage}>
            Sabotage lights
          </button>
        )}

        {dark && ship.positions[me.seat] === "electrical" && (
          <button type="button" className={s.primary} onClick={onFixLights}>
            Restore lights
          </button>
        )}

        {canCallMeeting && (
          <button type="button" className={s.meeting} onClick={onCallMeeting}>
            Emergency meeting
          </button>
        )}
      </div>

      {/* ── task list ────────────────────────────────────────────────── */}
      <ul className={s.taskList}>
        {myTasks.map((t) => (
          <li key={t.id} className={`${s.taskItem} ${t.done ? s.taskDone : ""}`}>
            <span className={s.taskTick}>{t.done ? "✓" : "○"}</span>
            {t.label}
            <span className={s.taskRoom}>{ROOM_BY_ID[t.room].name}</span>
          </li>
        ))}
      </ul>

      {/* ── minigame ─────────────────────────────────────────────────── */}
      {active && (
        <div className={s.modal} role="dialog" aria-label={active.label}>
          <div className={s.modalCard}>
            <h3 className={s.modalTitle}>{active.label}</h3>
            <p className={s.modalBlurb}>{active.blurb}</p>
            <Minigame
              kind={active.kind}
              magnitude={active.magnitude}
              onSolve={() => {
                onCompleteTask(active.id);
                setOpenTask(null);
              }}
            />
            <button type="button" className={s.modalClose} onClick={() => setOpenTask(null)}>
              Leave it for now
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
