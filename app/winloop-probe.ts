import * as engine from "./src/game/engine";
import { SKIP_VOTE } from "./src/game/types";
import { seedCommitment, combinedSeed, deriveRoles, poseidonCommitment } from "./src/game/crypto";
const hostSeed = "0x1234", salt = "0xabc";
let g = engine.createGame({
  host: "h", seedCommitment: seedCommitment(hostSeed),
  nightDurationSecs: 60, voteDurationSecs: 60,
  minPlayers: 5, maxPlayers: 5, hiddenCount: 1, seerCount: 0, tasksPerPlayer: 3,
});
for (let i = 0; i < 5; i++)
  g = engine.join(g, { name: "P"+i, sessionKey: "0xs"+i, wallet: "0xw"+i, payoutNoteId: "0xn"+i, entropy: "0xe"+i, isBot: false });
const combined = combinedSeed(hostSeed, g.seats.map((s) => s.entropy));
const { hidden, seers } = deriveRoles(combined, 5, 1, 0);
g = engine.assignRoles(g, { hiddenSeats: hidden, seerSeats: seers, salt, commitment: poseidonCommitment(hidden, salt) });
for (const s of g.seats) g = engine.markRoleSeen(g, s.seat);
let clock = Date.now();
const tick = () => (clock += 300000);
g = engine.startNight(g, clock);
g = engine.skipNight(g, tick());
const imp = hidden[0];
for (const s of g.seats.filter((x) => !x.dead)) {
  g = engine.handleVote(g, { voterSeat: s.seat, candidateSeat: s.seat === imp ? SKIP_VOTE : imp });
}
console.log("impostor is seat " + imp + "; the table voted them out");
const before = g.roundNumber;
g = engine.endVote(g, tick());
const impAlive = g.seats.filter((x) => !x.dead && hidden.includes(x.seat)).length;
console.log("endVote accepted -> round " + before + " -> " + g.roundNumber + ", phase " + g.phase);
console.log(impAlive === 0
  ? "BUG: crew had already won (0 impostors alive) yet the game looped into another round"
  : "impostors still alive: " + impAlive);
