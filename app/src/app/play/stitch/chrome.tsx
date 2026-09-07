import type { GameState, PhaseValue } from "@/game/types";
import { Phase } from "@/game/types";
import { livingSeats, short } from "@/game/engine";
import { STAKE_STRK } from "../ui";
import st from "./stitch.module.css";

export const VISOR = ["⚡", "★", "⬥", "🌙", "✹", "✚", "✦", "◆"] as const;
export const visor = (seat: number) => VISOR[seat % VISOR.length];
export const beanId = (seat: number) => `#${String(seat + 1).padStart(2, "0")}`;

export function clock(seconds: number) {
  const s = Math.max(0, seconds);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function potOf(game: GameState) {
  return game.seats.length * STAKE_STRK;
}

const MICRO: { id: PhaseValue | "emergency" | "payout"; n: string; label: string }[] = [
  { id: Phase.LOBBY, n: "01", label: "Lobby" },
  { id: Phase.ASSIGNED, n: "02", label: "Reveal" },
  { id: Phase.NIGHT, n: "03", label: "Night" },
  { id: "emergency", n: "04", label: "Emergency" },
  { id: Phase.VOTE, n: "05", label: "Vote" },
  { id: Phase.RESOLVED, n: "06", label: "Resolve" },
  { id: "payout", n: "07", label: "Payout" },
];

export function MicroTracker({
  phase,
  emergency = false,
}: {
  phase: PhaseValue;
  emergency?: boolean;
}) {
  return (
    <div className={st.micro} aria-hidden>
      {MICRO.map((step) => {
        const on =
          step.id === "emergency"
            ? emergency
            : step.id === "payout"
              ? phase === Phase.RESOLVED
              : step.id === phase && !emergency;
        const done =
          step.id !== "emergency" &&
          step.id !== "payout" &&
          typeof step.id === "number" &&
          phase > step.id;
        return (
          <span
            key={step.n}
            className={`${st.microCell} ${on ? (emergency && step.id === "emergency" ? st.microWarn : st.microOn) : done ? st.microDone : ""}`}
          >
            {step.n} {step.label}
          </span>
        );
      })}
    </div>
  );
}

export function Ceremony({
  kicker,
  title,
  pills,
  seconds,
  clockLabel,
  danger,
}: {
  kicker: string;
  title: string;
  pills?: string[];
  seconds?: number;
  clockLabel?: string;
  danger?: boolean;
}) {
  return (
    <div className={st.ceremony}>
      <div className={st.ceremonyLeft}>
        <div className={`${st.iconBox} ${danger ? st.iconBoxDanger : ""}`} aria-hidden>
          {danger ? "!" : "◈"}
        </div>
        <div>
          <div className={`${st.eyebrow} ${danger ? st.eyebrowDanger : ""}`}>{kicker}</div>
          <div className={st.title}>{title}</div>
          {pills && pills.length > 0 && (
            <div className={st.pills}>
              {pills.map((p) => (
                <span key={p} className={`${st.pill} ${danger ? st.pillRed : ""}`}>
                  {p}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      {seconds !== undefined && (
        <div className={st.clock}>
          <span className={st.clockLabel}>{clockLabel ?? "closes"}</span>
          <span className={`${st.clockVal} ${danger ? st.clockValDanger : ""}`}>{clock(seconds)}</span>
        </div>
      )}
    </div>
  );
}

export function Enclave({
  burner,
  extra,
  bond = STAKE_STRK,
}: {
  burner: string;
  extra: { k: string; v: string };
  bond?: number;
}) {
  return (
    <div className={st.enclave}>
      <p className={st.enclaveH}>Client-side proof enclave data (private to you)</p>
      <div className={st.cells}>
        <div>
          <div className={st.cellK}>Ephemeral burner key</div>
          <div className={st.cellV}>{short(burner)}</div>
        </div>
        <div>
          <div className={st.cellK}>{extra.k}</div>
          <div className={st.cellV}>{extra.v}</div>
        </div>
        <div>
          <div className={st.cellK}>Shielded pool bond</div>
          <div className={st.cellV}>{bond.toFixed(2)} STRK locked</div>
        </div>
      </div>
    </div>
  );
}

export function AnonSet({ game }: { game: GameState }) {
  const living = livingSeats(game).length;
  const n = game.seats.length;
  return `${n}/${n} synced · ${living} living`;
}
