"use client";

/**
 * The ejection scene.
 *
 * The resolve step used to be a key-value table — commitment, salt, total
 * votes — which is the least dramatic possible rendering of the one moment the
 * whole round builds to. This plays it out instead: the ejected crewmate
 * tumbles off into the starfield, then the verdict lands.
 *
 * All CSS keyframes over a handful of DOM nodes; the stars are one repeating
 * radial-gradient rather than elements, so nothing here costs a frame budget.
 */

import { useEffect, useState } from "react";
import s from "./ejection.module.css";
import { Crewmate } from "./Crewmate";

export function Ejection({
  ejected,
  hiddenSeats,
  hiddenNames,
  hiddenLabelSingular,
  crewWon,
  tied,
  confirmEjects,
}: {
  /** null when the vote tied and nobody went out the airlock. */
  ejected: { seat: number; name: string } | null;
  /** The whole hidden team — a variant may have two or three. */
  hiddenSeats: number[];
  hiddenNames: string[];
  /** "Impostor", "Werewolf", "Fascist"… from the variant config. */
  hiddenLabelSingular: string;
  crewWon: boolean;
  tied: boolean;
  /**
   * Among Us's "Confirm Ejects". When off, the scene does not say whether the
   * ejected player was an impostor — the crew get no free confirmation and
   * have to reason from the vote alone.
   */
  confirmEjects: boolean;
}) {
  const caught = ejected !== null && hiddenSeats.includes(ejected.seat);
  const team = hiddenNames.join(" and ");
  // Beat 1: the drift. Beat 2: was-or-wasn't. Beat 3: the verdict.
  const [beat, setBeat] = useState(0);

  useEffect(() => {
    const t1 = setTimeout(() => setBeat(1), 1500);
    const t2 = setTimeout(() => setBeat(2), 3000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  return (
    <div className={s.space}>
      <div className={s.stars} aria-hidden />
      <div className={s.stars2} aria-hidden />

      {tied ? (
        <div className={s.centre}>
          {/* `.show` is required — `.line` starts at opacity 0 and is only
              revealed by it, so without this the tie caption is invisible. */}
          <p className={`${s.line} ${s.show}`}>The vote tied.</p>
          <p className={s.sub}>Nobody went out the airlock.</p>
        </div>
      ) : (
        ejected && (
          <div className={s.drifter} aria-hidden>
            <Crewmate seat={ejected.seat} size={72} />
          </div>
        )
      )}

      <div className={s.captions}>
        {!tied && ejected && (
          <p className={`${s.line} ${s.show}`}>{ejected.name} was ejected.</p>
        )}
        {beat >= 1 &&
          (confirmEjects ? (
            <p className={`${s.line} ${s.show} ${crewWon ? s.good : s.bad}`}>
              {caught
                ? `${ejected?.name} was ${article(hiddenLabelSingular)}.`
                : tied
                  ? "They are still aboard."
                  : `${ejected?.name} was not ${article(hiddenLabelSingular)}.`}
            </p>
          ) : (
            <p className={`${s.line} ${s.show}`}>
              {tied ? "Nobody was ejected." : `${ejected?.name} is gone.`}
            </p>
          ))}
        {beat >= 2 && (
          <p className={`${s.verdict} ${s.show} ${crewWon ? s.good : s.bad}`}>
            {crewWon ? "Crew win" : `${hiddenLabelSingular} wins`}
            {!crewWon && team && (
              <span className={s.reveal}> — it was {team}</span>
            )}
          </p>
        )}
      </div>
    </div>
  );
}

/** "an Impostor" / "a Werewolf" — small thing, but it reads wrong without it. */
function article(noun: string): string {
  return /^[aeiou]/i.test(noun) ? `an ${noun}` : `a ${noun}`;
}
