import type { GameState, Seat } from "@/game/types";
import { Phase } from "@/game/types";
import { livingSeats, short, isWinner } from "@/game/engine";
import { CREW_NAME, IMPOSTOR_NAME, impostorLabel } from "@/game/variants";
import { CrewCard, Crewmate } from "../ship/Crewmate";
import { Ejection } from "../ship/Ejection";
import { Ceremony, MicroTracker, AnonSet, potOf, beanId } from "./chrome";
import { STAKE_STRK } from "../ui";
import st from "./stitch.module.css";
import s from "../play.module.css";

export function EjectionStage({
  game,
  who,
  caught,
  tied,
  onDone,
}: {
  game: GameState;
  who: Seat | null;
  caught: boolean;
  tied: boolean;
  onDone: () => void;
}) {
  const living = livingSeats(game);
  const max = game.seats.reduce((m, x) => {
    const t = game.tallies[x.seat] ?? 0n;
    return t > m ? t : m;
  }, game.skipTally);

  return (
    <div className={st.root}>
      <Ceremony
        kicker="Phase 06 of 07 · resolution & execution rite"
        title="Airlock ejection & on-chain vote resolve"
        pills={["Poseidon tally verified", "Starknet L2 consensus", AnonSet({ game })]}
      />
      <MicroTracker phase={Phase.RESOLVED} />
      <div className={st.split453}>
        <aside className={st.card}>
          <h3 className={st.title} style={{ fontSize: 18 }}>Homomorphic tally</h3>
          <span className={st.sealOpen}>ZK proof valid</span>
          <p className={st.hint} style={{ margin: "10px 0" }}>
            Ballots arrived as anonymous notes. Only (candidate, amount) is public.
          </p>
          {game.seats.map((seat) => {
            const t = game.tallies[seat.seat] ?? 0n;
            const pct = max > 0n ? Number((t * 100n) / max) : 0;
            const top = who && seat.seat === who.seat;
            return (
              <div key={seat.seat} className={st.tallyRow}>
                <span className={st.tallyN}>{seat.name}</span>
                <span className={st.tallyB}>
                  <span
                    className={st.tallyF}
                    style={{
                      width: `${pct}%`,
                      background: top ? "linear-gradient(90deg,#7b2cbf,#ef4444)" : undefined,
                    }}
                  />
                </span>
                <span className={st.tallyC}>
                  {String(t)}
                  {top ? " · plurality" : ""}
                </span>
              </div>
            );
          })}
          <div className={st.tallyRow}>
            <span className={st.tallyN}>Skip</span>
            <span className={st.tallyC}>{String(game.skipTally)}</span>
          </div>
        </aside>
        <div>
          <Ejection
            ejected={who ? { seat: who.seat, name: who.name } : null}
            caught={caught}
            hiddenLabelSingular={IMPOSTOR_NAME}
            tied={tied}
            confirmEjects={game.confirmEjects}
            final={null}
            onDone={onDone}
          />
        </div>
        <aside className={st.card}>
          <h3 className={st.title} style={{ fontSize: 18 }}>STRK20 pool status</h3>
          <div className={st.statV} style={{ fontSize: 22 }}>
            {potOf(game).toLocaleString()} STRK
          </div>
          <p className={st.hint} style={{ marginTop: 8 }}>
            {living.length} still in the anonymity set.
          </p>
          <div className={st.envelopes} style={{ marginTop: 10 }}>
            {game.seats.map((x) => (
              <CrewCard
                key={x.seat}
                seat={x.seat}
                name={x.name}
                dead={x.dead}
                faded={who?.seat === x.seat}
                tag={who?.seat === x.seat ? "ejected" : x.dead ? "ghost" : "alive"}
              />
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

export function PayoutStage({
  game,
  paid,
  onPayout,
  onReset,
  resetLabel = "Return to lobby",
  showEjection,
  onEjectionDone,
}: {
  game: GameState;
  paid: boolean;
  onPayout: () => void;
  onReset: () => void;
  resetLabel?: string;
  showEjection: boolean;
  onEjectionDone: () => void;
}) {
  const hidden = game.hiddenSeats;
  const hiddenObjs = game.seats.filter((x) => hidden.includes(x.seat));
  const winners = game.seats.filter((x) => isWinner(game, x.seat));
  const share = winners.length ? potOf(game) / winners.length : 0;
  const ejected = game.ejected === 0 ? undefined : game.seats.find((x) => x.seat === game.ejected - 1);

  return (
    <div className={st.root}>
      <Ceremony
        kicker="Phase 07 of 07 · match settlement & escrow payout"
        title="Poseidon root finalized"
        pills={[`Pool ${potOf(game).toLocaleString()} STRK`, "Cairo-STARK 100%"]}
      />
      <MicroTracker phase={Phase.RESOLVED} />

      <div className={`${st.hero} ${game.crewWon ? st.heroCrew : st.heroImp}`}>
        <div className={st.eyebrow}>{game.crewWon ? "Protocol verdict sealed" : "Vault siphon finalized"}</div>
        <h2 className={st.heroH}>
          {game.crewWon ? "Crewmate victory: station survived" : "Impostor victory: sabotage extinction"}
        </h2>
        <p className={st.heroS}>
          {game.crewWon
            ? "The pot credits to every crewmate — living and dead — as shielded notes."
            : "Parity or sabotage. The pot routes to impostor nullifiers — never a public transfer."}
        </p>
        <div className={st.pills} style={{ justifyContent: "center", marginTop: 12 }}>
          <span className={st.pill}>Buy-in {STAKE_STRK} STRK · {game.seats.length} stakers</span>
          <span className={st.pillGold}>Dividend {potOf(game).toLocaleString()} STRK</span>
        </div>
      </div>

      <div className={st.podium}>
        {winners.slice(0, 3).map((x, i) => (
          <div key={x.seat} className={`${st.podCard} ${i === 0 ? st.podYou : ""}`}>
            <Crewmate seat={x.seat} size={i === 0 ? 80 : 64} title={x.name} dead={x.dead} />
            <div className={st.roleSub} style={{ marginTop: 8 }}>
              {beanId(x.seat)} {x.name}
              {x.dead ? " · ghost" : ""}
            </div>
            <div className={st.pay}>+{share.toFixed(2)} STRK</div>
          </div>
        ))}
      </div>

      {/* A task win never went through the airlock, so skip the scene. A kill
          that left the impostors at parity is the same — there was no vote.
          A meltdown must not narrate the last ballot as a tie either. */}
      {showEjection &&
      !(game.ejected === 0 && game.totalVotes === 0n && !game.endedBySabotage) ? (
        <Ejection
          key={`eject-${game.roundNumber}-${game.ejected}`}
          reactor={game.endedBySabotage}
          ejected={
            game.endedBySabotage || !ejected ? null : { seat: ejected.seat, name: ejected.name }
          }
          caught={ejected !== undefined && hidden.includes(ejected.seat)}
          hiddenLabelSingular={IMPOSTOR_NAME}
          tied={!game.endedBySabotage && game.ejected === 0}
          confirmEjects={game.confirmEjects}
          final={{ crewWon: game.crewWon, teamNames: hiddenObjs.map((x) => x.name) }}
          onDone={onEjectionDone}
        />
      ) : null}

      <div className={st.split}>
        <aside className={st.card}>
          <h3 className={st.title} style={{ fontSize: 18 }}>
            {game.crewWon ? "Escrow settlement" : "Heist escrow settlement"}
          </h3>
          <div className={st.statV} style={{ fontSize: 28 }}>
            {potOf(game).toFixed(2)} STRK
          </div>
          <p className={st.hint}>
            {winners.length} winner{winners.length === 1 ? "" : "s"} · {share.toFixed(2)} STRK each
          </p>
          <div className={st.actions}>
            <button type="button" className={s.btn} onClick={onPayout} disabled={paid}>
              {paid
                ? "Success — pot credited"
                : game.crewWon
                  ? "Claim to shielded wallet"
                  : "Claim illicit STRK to shielded vault"}
            </button>
            <button type="button" className={`${s.btn} ${s.btnGhost}`} onClick={onReset}>
              {resetLabel}
            </button>
          </div>
          {paid && (
            <p className={st.hint} style={{ marginTop: 8 }}>
              Credited to each winner&apos;s open note — never a public transfer.
            </p>
          )}
        </aside>
        <aside className={st.card}>
          <h3 className={st.title} style={{ fontSize: 18 }}>Nullifier disclosures</h3>
          <div className={st.envelopes}>
            {game.seats.map((x) => {
              const imp = hidden.includes(x.seat);
              return (
                <CrewCard
                  key={x.seat}
                  seat={x.seat}
                  name={x.name}
                  dead={x.dead}
                  faded={!imp && !game.crewWon}
                  tag={
                    imp
                      ? IMPOSTOR_NAME.toLowerCase()
                      : game.crewWon
                        ? x.dead
                          ? "ghost · paid"
                          : `${CREW_NAME.toLowerCase()} · paid`
                        : CREW_NAME.toLowerCase()
                  }
                />
              );
            })}
          </div>
          <details className={s.proof} style={{ marginTop: 14 }}>
            <summary className={s.proofSummary}>Verify this round</summary>
            <div className={s.proofBody}>
              <p className={s.panelHint}>
                Recompute <code>poseidon(hidden_seats…, salt)</code> and compare with the
                commitment posted before anyone voted.
              </p>
              <div className={st.cellK}>Commitment</div>
              <div className={st.cellV}>{short(game.roleCommitment, 12, 8)}</div>
              <div className={st.cellK} style={{ marginTop: 8 }}>Salt</div>
              <div className={st.cellV}>{short(game.salt, 12, 8)}</div>
              <div className={st.cellK} style={{ marginTop: 8 }}>
                {impostorLabel(game.hiddenCount)} seats
              </div>
              <div className={st.cellV}>{hidden.join(", ")}</div>
            </div>
          </details>
        </aside>
      </div>
    </div>
  );
}
