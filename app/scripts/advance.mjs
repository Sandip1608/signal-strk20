/**
 * Advance the deployed round to its VOTE phase, so a real pool vote leg
 * (`voteThroughPool` in the UI) has an open ballot to land in.
 *
 * Run scripts/players.mjs first (players 1-4 seated). This script then:
 *   1. creates Player 5 with a DEPLOYED session account — `call_meeting` is
 *      signed by the session key, so unlike players 1-4's bare burner pubkeys,
 *      this one has to be an account that can send a transaction
 *   2. joins Player 5 with that session account's address as its session key
 *   3. host: assign_roles (rehearsal commitment — this round is for testing
 *      the vote leg, not for resolving)
 *   4. host: start_night
 *   5. session account: call_meeting → VOTE opens
 *
 * The ballot stays open for `vote_duration` (240s as deployed) — run this only
 * when the voting wallet is ready, with shielded STRK already matured (notes
 * are spendable 10 blocks after the shield).
 *
 * Usage (from app/):
 *   node scripts/advance.mjs          # seat Player 5 only (safe any time)
 *   node scripts/advance.mjs --open   # ALSO open the ballot — 240s window
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Account, RpcProvider, ec, encode, hash, num } from "starknet";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLAYERS_FILE = resolve(HERE, "../.players.json");

loadEnvFile(resolve(HERE, "../.env.deploy"));
const RPC = process.env.STARKNET_RPC || "https://starknet-sepolia-rpc.publicnode.com";
const FUNDER_ADDRESS = process.env.STARKNET_ACCOUNT_ADDRESS;
const FUNDER_PK = process.env.STARKNET_PRIVATE_KEY;
const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const OZ_ACCOUNT_CLASS = "0x061dac032f228abef9c6626f995015233097ae253a7f72d68552db02f2971b8f";
const FUND_WEI = 5n * 10n ** 18n;

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function roundAddress() {
  const src = readFileSync(resolve(HERE, "../src/game/deployed.ts"), "utf8");
  return src.match(/round:\s*"(0x[0-9a-fA-F]+)"/)[1];
}

const randomFelt = () => num.toHex(`0x${encode.buf2hex(ec.starkCurve.utils.randomPrivateKey())}`);
function newAccountSpec() {
  const privateKey = randomFelt();
  const publicKey = ec.starkCurve.getStarkKey(privateKey);
  return {
    privateKey,
    publicKey,
    address: num.toHex(
      hash.calculateContractAddressFromHash(publicKey, OZ_ACCOUNT_CLASS, [publicKey], 0),
    ),
  };
}

const provider = new RpcProvider({ nodeUrl: RPC });
const funder = new Account({ provider, address: FUNDER_ADDRESS, signer: FUNDER_PK });
const ROUND = roundAddress();

const view = async (entrypoint, calldata = []) =>
  provider.callContract({ contractAddress: ROUND, entrypoint, calldata });
const phaseName = ["LOBBY", "ASSIGNED", "NIGHT", "VOTE", "RESOLVED"];
const phase = async () => Number((await view("phase"))[0]);

async function ensureFundedAndDeployed(spec, label) {
  const bal = BigInt((await provider.callContract({
    contractAddress: STRK, entrypoint: "balanceOf", calldata: [spec.address],
  }))[0]);
  if (bal < FUND_WEI) {
    const missing = FUND_WEI - bal;
    const tx = await funder.execute({
      contractAddress: STRK,
      entrypoint: "transfer",
      calldata: [spec.address, num.toHex(missing), "0x0"],
    });
    await provider.waitForTransaction(tx.transaction_hash);
    console.log(`  ${label}: funded       ${tx.transaction_hash}`);
  }
  try {
    await provider.getClassHashAt(spec.address);
  } catch {
    const acc = new Account({ provider, address: spec.address, signer: spec.privateKey });
    const dep = await acc.deployAccount({
      classHash: OZ_ACCOUNT_CLASS,
      constructorCalldata: [spec.publicKey],
      addressSalt: spec.publicKey,
    });
    await provider.waitForTransaction(dep.transaction_hash);
    console.log(`  ${label}: deployed     ${dep.transaction_hash}`);
  }
}

console.log("Signal — advance to VOTE\n");
console.log(`  round  ${ROUND}`);
console.log(`  phase  ${phaseName[await phase()]}\n`);

const players = JSON.parse(readFileSync(PLAYERS_FILE, "utf8"));

// ── 1-2. Player 5, with a session key that can actually sign ───────────────
if (players.length < 5) {
  const wallet = newAccountSpec();
  players.push({
    name: "Player 5",
    ...wallet,
    sessionAccount: newAccountSpec(),
    payoutNoteId: randomFelt(),
    entropy: randomFelt(),
  });
  writeFileSync(PLAYERS_FILE, `${JSON.stringify(players, null, 2)}\n`);
}
const p5 = players[4];
if (!p5.sessionAccount) {
  p5.sessionAccount = newAccountSpec();
  writeFileSync(PLAYERS_FILE, `${JSON.stringify(players, null, 2)}\n`);
}
await ensureFundedAndDeployed(p5, "Player 5");
await ensureFundedAndDeployed(p5.sessionAccount, "session 5");

const count = Number((await view("player_count"))[0]);
let seated = false;
for (let seat = 0; seat < count; seat += 1) {
  if (BigInt((await view("seat_address", [String(seat)]))[0]) === BigInt(p5.address)) seated = true;
}
if (!seated) {
  const acc = new Account({ provider, address: p5.address, signer: p5.privateKey });
  const tx = await acc.execute({
    contractAddress: ROUND,
    entrypoint: "join",
    calldata: [p5.sessionAccount.address, p5.payoutNoteId, p5.entropy],
  });
  await provider.waitForTransaction(tx.transaction_hash);
  console.log(`  Player 5: joined       ${tx.transaction_hash}`);
}

// ── 3-5. LOBBY → ASSIGNED → NIGHT → VOTE ───────────────────────────────────
let ph = await phase();
if (!process.argv.includes("--open")) {
  console.log(`\n  phase  ${phaseName[ph]}`);
  console.log("  Player 5 is seated. Re-run with --open when the voting wallet is");
  console.log("  ready — the ballot only stays open for the 240s vote window.");
  process.exit(0);
}
if (ph === 0) {
  // A rehearsal commitment: nonzero, recorded, honest about what it is. This
  // round exists to test the vote leg; it is not meant to be resolved.
  const salt = randomFelt();
  const commitment = num.toHex(hash.computePoseidonHashOnElements([salt]));
  const tx = await funder.execute({
    contractAddress: ROUND, entrypoint: "assign_roles", calldata: [commitment],
  });
  await provider.waitForTransaction(tx.transaction_hash);
  console.log(`  assign_roles           ${tx.transaction_hash}`);
  ph = await phase();
}
if (ph === 1) {
  const tx = await funder.execute({ contractAddress: ROUND, entrypoint: "start_night", calldata: [] });
  await provider.waitForTransaction(tx.transaction_hash);
  console.log(`  start_night            ${tx.transaction_hash}`);
  ph = await phase();
}
if (ph === 2) {
  const sess = new Account({
    provider, address: p5.sessionAccount.address, signer: p5.sessionAccount.privateKey,
  });
  const tx = await sess.execute({ contractAddress: ROUND, entrypoint: "call_meeting", calldata: [] });
  await provider.waitForTransaction(tx.transaction_hash);
  console.log(`  call_meeting           ${tx.transaction_hash}`);
  ph = await phase();
}

const deadline = Number((await view("vote_deadline"))[0]);
console.log(`\n  phase  ${phaseName[ph]}`);
if (ph === 3) {
  const left = deadline - Math.floor(Date.now() / 1000);
  console.log(`  ballot open — ${left}s left to land a pool vote leg.`);
}
