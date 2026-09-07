import type { GameState, Seat } from "@/game/types";
import { Phase } from "@/game/types";
import { short } from "@/game/engine";
import { CREW_NAME, IMPOSTOR_NAME } from "@/game/variants";
import { CrewCard, Crewmate } from "../ship/Crewmate";
import { Ceremony, Enclave, MicroTracker, AnonSet, beanId, visor } from "./chrome";
import st from "./stitch.module.css";
import s from "../play.module.css";

export function RoleCeremony({ game }: { game: GameState }) {
  return (
    <>
      <Ceremony
        kicker="Phase 02 of 07 · ceremonial rite"
        title="Decryption ceremony (role reveal)"
        pills={[
          `Poseidon circuit verified (${short(game.roleCommitment, 6, 4)})`,
          AnonSet({ game }),
        ]}
      />
      <MicroTracker phase={Phase.ASSIGNED} />
    </>
  );
}

export function RoleDossier({
  game,
  viewer,
  onCommit,
}: {
  game: GameState;
  viewer: Seat;
  onCommit: () => void;
}) {
  const impostor = viewer.role === "IMPOSTOR";
  const partners = game.seats.filter((x) => x.role === "IMPOSTOR" && x.seat !== viewer.seat);
  const crewCount = game.seats.length - game.hiddenCount;

  return (
    <div className={st.root}>
      <RoleCeremony game={game} />
      <div className={st.split}>
        <article className={`${st.card} ${st.frost} ${impostor ? st.frostDanger : ""}`}>
          <span className={`${st.glow} ${impostor ? st.glowR : st.glowA}`} />
          <span className={`${st.glow} ${st.glowB}`} />
          <div className={st.headRow}>
            <div>
              <span className={impostor ? st.sealBroke : st.sealOpen}>
                {impostor ? "Seal compromised (local decrypt)" : "Seal opened locally"}
              </span>
              <p className={st.eyebrow} style={{ marginTop: 10 }}>
                {impostor ? "ZK-subversive enclave" : "ZK-proven local enclave"} · envelope {beanId(viewer.seat)}
              </p>
              <h2 className={st.title} style={{ marginTop: 4 }}>
                {impostor
                  ? "Assignment: covert infiltrator"
                  : viewer.role === "SEER"
                    ? "Assignment: seer note"
                    : "Assignment: commendation note"}
              </h2>
            </div>
          </div>

          <div className={st.banner}>
            <div className={st.avatarCol}>
              <Crewmate seat={viewer.seat} size={96} title={viewer.name} />
              <span>
                {beanId(viewer.seat)} {visor(viewer.seat)}
              </span>
              <div className={`${st.roleWord} ${impostor ? st.roleImp : st.roleCrew}`}>
                {impostor ? IMPOSTOR_NAME : viewer.role === "SEER" ? "SEER" : CREW_NAME}
              </div>
              <div className={st.roleSub}>
                {impostor ? "Starknet shadow operative" : "Communal defender"}
              </div>
            </div>
            <div>
              {impostor ? (
                <>
                  <h3 className={st.missionTitle}>Sabotage &amp; infiltration perks</h3>
                  <span className={st.sealBroke}>
                    {game.hiddenCount} hidden
                    {partners.length > 0 ? ` · partner ${partners.map((p) => p.name).join(", ")}` : ""}
                  </span>
                  <ul className={st.missionBody} style={{ marginTop: 10, paddingLeft: 18 }}>
                    <li>Stealth elimination — Poseidon nullifier kill, same room only.</li>
                    <li>Blinded vent shift — teleport with no sighting.</li>
                    <li>Lights out / reactor blackout — force the crew off their tasks.</li>
                  </ul>
                </>
              ) : (
                <>
                  <h3 className={st.missionTitle}>
                    {viewer.role === "SEER" ? "Night investigation" : "Communal reactor safeguard"}
                  </h3>
                  <span className={st.sealOpen}>{crewCount} total crew</span>
                  <p className={st.missionBody} style={{ marginTop: 10 }}>
                    {viewer.role === "SEER"
                      ? "Once each night you may check one player and learn whether they are an impostor. The answer is yours alone."
                      : "Complete station proofs around the ship. Every finished task strengthens the crew bar and can unlock the security log. Isolate the concealed impostor nullifiers at the vote."}
                  </p>
                </>
              )}
            </div>
          </div>

          <div className={st.stats}>
            <div className={st.stat}>
              <div className={st.statK}>Phase 03 night duty</div>
              <div className={`${st.statV} ${impostor ? st.statVDanger : ""}`}>
                {impostor ? "Blinded kill commitment" : "Maintain shielded stance"}
              </div>
            </div>
            <div className={st.stat}>
              <div className={st.statK}>Voting clout</div>
              <div className={st.statV}>1 STRK anonymous vote</div>
            </div>
          </div>

          <Enclave
            burner={viewer.sessionKey}
            extra={
              impostor
                ? { k: "Kill nullifier hash", v: short(viewer.payoutNoteId) }
                : { k: "Role nullifier hash", v: short(game.roleCommitment) }
            }
          />

          <div className={st.actions}>
            <button type="button" className={`${s.btn} ${impostor ? s.btnDanger : ""}`} onClick={onCommit}>
              {impostor ? "Commit & conceal identity" : "Commit & seal role (enter night)"}
            </button>
            <p className={st.hint}>
              {impostor
                ? "Your vote appears identical to crew votes in the public tally."
                : "Your secret role is retained in this browser only."}
            </p>
          </div>
        </article>

        <aside className={st.card}>
          <h3 className={st.title} style={{ fontSize: 18 }}>
            {impostor ? "Infiltration playbook" : "Cryptographic veil rules"}
          </h3>
          <p className={st.hint} style={{ marginBottom: 12 }}>
            {impostor ? "How the night kill stays unlinkable" : "How Signal guarantees fair play"}
          </p>
          {impostor ? (
            <>
              <div className={st.rule}>
                <span className={st.ruleI}>◈</span>
                <div>
                  <div className={st.ruleT}>Task mimicry</div>
                  <div className={st.ruleB}>
                    Play the minigames — they never complete. Looking busy is the disguise.
                  </div>
                </div>
              </div>
              <div className={st.rule}>
                <span className={st.ruleI}>◈</span>
                <div>
                  <div className={st.ruleT}>Nullifier deflection</div>
                  <div className={st.ruleB}>
                    The kill is a private transfer. The round contract never sees the sender.
                  </div>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className={st.rule}>
                <span className={st.ruleI}>◈</span>
                <div>
                  <div className={st.ruleT}>Homomorphic shuffle</div>
                  <div className={st.ruleB}>
                    Roles are drawn from a committed seed. The host cannot re-pick after the vote.
                  </div>
                </div>
              </div>
              <div className={st.rule}>
                <span className={st.ruleI}>◈</span>
                <div>
                  <div className={st.ruleT}>Zero RPC metadata leak</div>
                  <div className={st.ruleB}>
                    Unsealing happens on this device. No server can read your note.
                  </div>
                </div>
              </div>
              <div className={st.rule}>
                <span className={st.ruleI}>◈</span>
                <div>
                  <div className={st.ruleT}>ZK nullifier integrity</div>
                  <div className={st.ruleB}>
                    Impostors strike by submitting a proof of status — never by naming themselves.
                  </div>
                </div>
              </div>
            </>
          )}
          <div className={st.circuit}>
            <div>
              <div className={st.circuitT}>{impostor ? "SUBVERT" : "ZK-SNARK"}</div>
              <div className={st.circuitS}>
                {impostor ? "Shielded kill link active" : "100% client enclave"}
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

export function PublicLedger({
  game,
  onOpen,
  onStartNight,
}: {
  game: GameState;
  onOpen: (seat: number) => void;
  onStartNight: () => void;
}) {
  const pending = game.seats.filter((x) => !x.roleSeen);
  const opened = game.seats.length - pending.length;
  return (
    <div className={st.root}>
      <RoleCeremony game={game} />
      <div className={st.card}>
        <h2 className={st.title}>Public room ledger</h2>
        <p className={st.hint} style={{ marginBottom: 14 }}>
          What a network sniffer sees: {opened}/{game.seats.length} envelopes opened · 0 role leaks.
          The host posted <code>poseidon(hidden_seats…, salt)</code> before anyone voted.
        </p>
        <div className={st.envelopes}>
          {game.seats.map((x) => (
            <button
              key={x.seat}
              type="button"
              className={`${st.envelope} ${x.roleSeen ? st.envelopeOpen : ""}`}
              onClick={() => onOpen(x.seat)}
              disabled={x.roleSeen || x.isBot}
            >
              <CrewCard
                seat={x.seat}
                name={x.name}
                faded={x.roleSeen}
                tag={x.isBot ? (x.roleSeen ? "opened" : "opening…") : x.roleSeen ? "opened" : "sealed note"}
              />
            </button>
          ))}
        </div>
        <div className={st.actions}>
          <button type="button" className={s.btn} onClick={onStartNight} disabled={pending.length > 0}>
            Start night
          </button>
          {pending.length > 0 && (
            <span className={st.hint}>{pending.length} still to open their note</span>
          )}
        </div>
      </div>
    </div>
  );
}
