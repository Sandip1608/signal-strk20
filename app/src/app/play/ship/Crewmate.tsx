"use client";

/**
 * The crewmate figure, used everywhere a seat is shown.
 *
 * One inline SVG, no sprite sheet and no image requests — it scales to any
 * size, recolours per seat, and costs nothing to render a dozen of. Replacing
 * the old "SEAT 0 / name / role" text cards with these is most of what makes
 * the non-deck screens read as a game rather than a form.
 */

import s from "./crewmate.module.css";

/** Stable per-seat colour, so a player looks the same all round. */
const CREW_COLOURS = [
  "#ef4444", "#3b82f6", "#06b6d4", "#ec4899", "#84cc16", "#f97316", "#eab308", "#a855f7",
];
export const crewColour = (seat: number) => CREW_COLOURS[seat % CREW_COLOURS.length];

/** Slightly darkened body colour for the backpack + shading. */
function shade(hex: string, amount = 0.72) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * amount);
  const g = Math.round(((n >> 8) & 255) * amount);
  const b = Math.round((n & 255) * amount);
  return `rgb(${r} ${g} ${b})`;
}

export function Crewmate({
  seat,
  size = 56,
  dead = false,
  /** Dims and desaturates — used for seats that are out of play. */
  faded = false,
  className,
  title,
}: {
  seat: number;
  size?: number;
  dead?: boolean;
  faded?: boolean;
  className?: string;
  title?: string;
}) {
  const colour = crewColour(seat);
  const back = shade(colour);

  return (
    <svg
      viewBox="0 0 100 116"
      width={size}
      height={size * 1.16}
      className={[s.mate, dead ? s.dead : "", faded ? s.faded : "", className]
        .filter(Boolean)
        .join(" ")}
      role="img"
      aria-label={title ?? `Crewmate ${seat + 1}`}
    >
      {title && <title>{title}</title>}

      {/* backpack */}
      <rect x="8" y="34" width="20" height="44" rx="10" fill={back} />

      {/* body */}
      <path
        d="M26 40C26 22 38 10 56 10s30 12 30 30v42c0 6-4 10-10 10H36c-6 0-10-4-10-10V40z"
        fill={colour}
      />

      {/* legs */}
      <path d="M32 92h18v18a4 4 0 0 1-4 4h-10a4 4 0 0 1-4-4V92z" fill={colour} />
      <path d="M62 92h18v18a4 4 0 0 1-4 4h-10a4 4 0 0 1-4-4V92z" fill={colour} />

      {/* body shading, keeps the flat colour from looking like a sticker */}
      <path
        d="M76 40c0-14-8-24-20-28 14 1 30 10 30 30v42c0 6-4 10-10 10h-8c6 0 8-4 8-10V40z"
        fill="#000"
        opacity="0.16"
      />

      {/* visor */}
      <path
        d="M52 34h20c9 0 16 7 16 16s-7 16-16 16H52c-5 0-9-4-9-9V43c0-5 4-9 9-9z"
        fill="#a9d7ef"
      />
      <path
        d="M58 38h13c6 0 11 5 11 11 0 2 0 3-1 5-3-8-12-14-23-16z"
        fill="#fff"
        opacity="0.6"
      />

      {/* dead crewmates get X'd out on the visor */}
      {dead && (
        <g stroke="#20222f" strokeWidth="5" strokeLinecap="round">
          <path d="M56 42l12 12M68 42l-12 12" />
        </g>
      )}
    </svg>
  );
}

/**
 * A crewmate with its name underneath — the standard way a seat appears
 * outside the deck.
 */
export function CrewCard({
  seat,
  name,
  size = 56,
  dead = false,
  faded = false,
  tag,
  onClick,
  disabled,
  selected,
}: {
  seat: number;
  name: string;
  size?: number;
  dead?: boolean;
  faded?: boolean;
  /** Small caption under the name: a role, a vote count, "you"… */
  tag?: string;
  onClick?: () => void;
  disabled?: boolean;
  selected?: boolean;
}) {
  const body = (
    <>
      <Crewmate seat={seat} size={size} dead={dead} faded={faded} title={name} />
      <span className={s.name}>{name}</span>
      {tag && <span className={s.tag}>{tag}</span>}
    </>
  );

  if (!onClick) return <div className={s.card}>{body}</div>;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[s.card, s.cardBtn, selected ? s.cardSelected : ""].filter(Boolean).join(" ")}
    >
      {body}
    </button>
  );
}
