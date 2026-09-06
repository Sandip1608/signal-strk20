"use client";

/**
 * The ejection scene.
 *
 * The resolve step used to be a key-value table — commitment, salt, total
 * votes — which is the least dramatic possible rendering of the one moment the
 * whole round builds to. This plays it out instead: the ejected crewmate
 * tumbles off into the starfield, then the verdict lands.
 *
 * It plays in two places, which is what `final` distinguishes:
 *
 *  - **Between rounds** (`final` null). A multi-round game used to cut from the
 *    tally straight into the next night, so an ejection — the loudest beat in
 *    Among Us — happened entirely in the activity log. Here the scene runs
 *    without a verdict, because mid-game nobody has won and the team is sealed.
 *  - **At the end** (`final` set). The same scene, then the winner and the
 *    revealed hidden team.
 *
 * All CSS keyframes over a handful of DOM nodes; the stars are one repeating
 * radial-gradient rather than elements, so nothing here costs a frame budget.
 */

import { useEffect, useRef, useState } from "react";
import s from "./ejection.module.css";
import { Crewmate } from "./Crewmate";

export function Ejection({
  ejected,
  caught,
  hiddenLabelSingular,
  tied,
  confirmEjects,
  final,
  onDone,
}: {
  /** null when the vote tied and nobody went out the airlock. */
  ejected: { seat: number; name: string } | null;
  /**
   * Was the ejected player on the hidden team?
   *
   * Passed in rather than derived, because between rounds the hidden team is
   * still sealed — there the caller reads `ejectedWasImpostor`, which the
   * engine fills at `endVote`, the last point where roles are in hand. Only
   * meaningful when `confirmEjects` is on.
   */
  caught: boolean;
  /** "Impostor", "Werewolf", "Fascist"… from the variant config. */
  hiddenLabelSingular: string;
  tied: boolean;
  /**
   * Among Us's "Confirm Ejects". When off, the scene does not say whether the
   * ejected player was an impostor — the crew get no free confirmation and
   * have to reason from the vote alone.
   */
  confirmEjects: boolean;
  /** The end-of-game verdict, or null while the game is still running. */
  final: { crewWon: boolean; teamNames: string[] } | null;
  /** Between rounds only: dismiss the scene and get on with the night. */
  onDone?: () => void;
}) {
  const team = final?.teamNames.join(" and ") ?? "";
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

  // Between rounds the night clock is already running, so the scene clears
  // itself rather than waiting to be dismissed.
  //
  // `onDone` is an inline arrow in the caller, so its identity changes on every
  // render — and the panel re-renders once a second to tick the night clock. A
  // plain `[onDone]` dependency therefore cancelled and re-armed this timeout
  // forever and the scene never dismissed itself. Hold the callback in a ref
  // and arm the timer exactly once, the same fix `useSolveOnce` carries.
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    const t = setTimeout(() => done.current?.(), 4200);
    return () => clearTimeout(t);
  }, []);

  return (
    <div
      className={s.space}
      // Between rounds this is a cutscene over live time — let an impatient
      // player skip straight to the deck.
      onClick={onDone}
      role={onDone ? "button" : undefined}
      tabIndex={onDone ? 0 : undefined}
      onKeyDown={onDone ? (e) => e.key === "Enter" && onDone() : undefined}
    >
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
            // Coloured by whether they were actually caught — not by who won
            // the game, which rendered "was an Impostor" in red whenever the
            // crew went on to lose.
            <p className={`${s.line} ${s.show} ${caught ? s.good : s.bad}`}>
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

        {beat >= 2 &&
          (final ? (
            <p className={`${s.verdict} ${s.show} ${final.crewWon ? s.good : s.bad}`}>
              {final.crewWon ? "Crew win" : `${hiddenLabelSingular} wins`}
              {!final.crewWon && team && <span className={s.reveal}> — it was {team}</span>}
            </p>
          ) : (
            <p className={`${s.line} ${s.sub} ${s.show}`}>
              {onDone ? "Night falls again — tap to continue." : "Night falls again."}
            </p>
          ))}
      </div>
    </div>
  );
}

/** "an Impostor" / "a Werewolf" — small thing, but it reads wrong without it. */
function article(noun: string): string {
  return /^[aeiou]/i.test(noun) ? `an ${noun}` : `a ${noun}`;
}
