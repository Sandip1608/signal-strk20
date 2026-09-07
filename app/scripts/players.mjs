/**
 * Provision real player wallets on Sepolia and seat them in the deployed round.
 *
 * What this does, headless, from the funder in `.env.deploy`:
 *   1. generates N burner keypairs and their OpenZeppelin account addresses
 *   2. splits a small amount of STRK from the funder to each (one multicall)
 *   3. deploys each account (DEPLOY_ACCOUNT, paying its own gas from the split)
 *   4. --join: each player takes a seat on the deployed SignalRound, with its
 *      own fresh session key — a different signer per seat, as the contract
 *      demands (`session_key != caller`)
 *
 * What this deliberately does NOT do: deposit into the privacy pool. Verified
 * on-chain (2026-09-07): the Sepolia pool's `get_screener_public_key` is
 * 0x62f1e7ca…, not the SDK testing key, so a deposit needs a screening
 * signature only StarkWare's hosted proving service can produce — there is no
 * public endpoint. Shielding therefore goes through a privacy-enabled wallet
 * (Ready), which carries its own proving; see the Shield tab on the app's
 * landing page, which already works on Sepolia.
 *
 * Keys land in `app/.players.json` (gitignored). Idempotent: re-running skips
 * funded balances, deployed accounts and taken seats.
 *
 * Usage (from app/):
 *   node scripts/players.mjs                 # 4 players, 10 STRK each
 *   node scripts/players.mjs --count 5 --strk 10
 *   node scripts/players.mjs --join          # also seat them in the round
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Account, RpcProvider, ec, encode, hash, num } from "starknet";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLAYERS_FILE = resolve(HERE, "../.players.json");

// ── config ─────────────────────────────────────────────────────────────────
loadEnvFile(resolve(HERE, "../.env.deploy"));

const RPC = process.env.STARKNET_RPC || "https://starknet-sepolia-rpc.publicnode.com";
const FUNDER_ADDRESS = process.env.STARKNET_ACCOUNT_ADDRESS;
const FUNDER_PK = process.env.STARKNET_PRIVATE_KEY;

/** STRK on Sepolia (same address as mainnet). */
const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
/** OpenZeppelin account v0.8.1 — declared on Sepolia, constructor(public_key). */
const OZ_ACCOUNT_CLASS = "0x061dac032f228abef9c6626f995015233097ae253a7f72d68552db02f2971b8f";

const COUNT = Number(argOf("--count") ?? 4);
const STRK_EACH = BigInt(Math.round(Number(argOf("--strk") ?? 10) * 100)) * 10n ** 16n;
const JOIN = process.argv.includes("--join");

function argOf(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

/** The round address, from the module deploy.mjs generates. */
function roundAddress() {
  const src = readFileSync(resolve(HERE, "../src/game/deployed.ts"), "utf8");
  const m = src.match(/round:\s*"(0x[0-9a-fA-F]+)"/);
  if (!m) throw new Error("no round address in deployed.ts — deploy first");
  return m[1];
}

function randomFelt() {
  return num.toHex(`0x${encode.buf2hex(ec.starkCurve.utils.randomPrivateKey())}`);
}

function newKeypair() {
  const privateKey = randomFelt();
  return { privateKey, publicKey: ec.starkCurve.getStarkKey(privateKey) };
}

if (!FUNDER_ADDRESS || !FUNDER_PK) {
  console.error("Missing STARKNET_ACCOUNT_ADDRESS / STARKNET_PRIVATE_KEY in app/.env.deploy.");
  process.exit(1);
}

const provider = new RpcProvider({ nodeUrl: RPC });
const funder = new Account({ provider, address: FUNDER_ADDRESS, signer: FUNDER_PK });
const ROUND = roundAddress();

console.log("Signal — players\n");
console.log(`  rpc     ${RPC}`);
console.log(`  round   ${ROUND}`);
console.log(`  funder  ${FUNDER_ADDRESS.slice(0, 10)}…  splitting ${fmt(STRK_EACH)} STRK to each of ${COUNT}\n`);

// ── 1. keys ────────────────────────────────────────────────────────────────
const players = existsSync(PLAYERS_FILE) ? JSON.parse(readFileSync(PLAYERS_FILE, "utf8")) : [];
while (players.length < COUNT) {
  const wallet = newKeypair();
  const session = newKeypair();
  players.push({
    name: `Player ${players.length + 1}`,
    ...wallet,
    address: num.toHex(
      hash.calculateContractAddressFromHash(wallet.publicKey, OZ_ACCOUNT_CLASS, [wallet.publicKey], 0),
    ),
    sessionPrivateKey: session.privateKey,
    sessionPublicKey: session.publicKey,
    payoutNoteId: randomFelt(),
    entropy: randomFelt(),
  });
}
save();
for (const p of players) console.log(`  ${p.name}  ${p.address}`);
console.log();

// ── 2. fund ────────────────────────────────────────────────────────────────
const needs = [];
for (const p of players) {
  const bal = await strkBalance(p.address);
  if (bal < STRK_EACH) needs.push({ p, missing: STRK_EACH - bal });
}
if (needs.length === 0) {
  console.log("funding: everyone already holds their split.\n");
} else {
  console.log(`funding ${needs.length} player(s) from the funder (one multicall)…`);
  const tx = await funder.execute(
    needs.map(({ p, missing }) => ({
      contractAddress: STRK,
      entrypoint: "transfer",
      calldata: [p.address, num.toHex(missing & ((1n << 128n) - 1n)), num.toHex(missing >> 128n)],
    })),
  );
  await provider.waitForTransaction(tx.transaction_hash);
  console.log(`  funded    ${tx.transaction_hash}\n`);
}

// ── 3. deploy accounts ─────────────────────────────────────────────────────
for (const p of players) {
  if (await isDeployed(p.address)) {
    console.log(`${p.name}: account already deployed`);
    continue;
  }
  console.log(`${p.name}: deploying account…`);
  const acc = new Account({ provider, address: p.address, signer: p.privateKey });
  const dep = await acc.deployAccount({
    classHash: OZ_ACCOUNT_CLASS,
    constructorCalldata: [p.publicKey],
    addressSalt: p.publicKey,
  });
  await provider.waitForTransaction(dep.transaction_hash);
  console.log(`  deployed  ${dep.transaction_hash}`);
}
console.log();

// ── 4. join the round ──────────────────────────────────────────────────────
if (!JOIN) {
  console.log("done. Re-run with --join to seat them in the round.");
} else {
  const taken = await seatAddresses();
  for (const p of players) {
    if (taken.has(BigInt(p.address))) {
      console.log(`${p.name}: already seated`);
      continue;
    }
    console.log(`${p.name}: joining the round…`);
    const acc = new Account({ provider, address: p.address, signer: p.privateKey });
    const tx = await acc.execute({
      contractAddress: ROUND,
      entrypoint: "join",
      calldata: [p.sessionPublicKey, p.payoutNoteId, p.entropy],
    });
    await provider.waitForTransaction(tx.transaction_hash);
    console.log(`  joined    ${tx.transaction_hash}`);
  }
  console.log(`\ndone. seats taken: ${(await seatAddresses()).size}`);
}

// ── chain helpers ──────────────────────────────────────────────────────────
async function strkBalance(address) {
  const r = await provider.callContract({
    contractAddress: STRK,
    entrypoint: "balanceOf",
    calldata: [address],
  });
  return BigInt(r[0]) + (BigInt(r[1] ?? 0) << 128n);
}

async function isDeployed(address) {
  try {
    await provider.getClassHashAt(address);
    return true;
  } catch {
    return false;
  }
}

async function seatAddresses() {
  const out = new Set();
  const count = Number(
    (await provider.callContract({ contractAddress: ROUND, entrypoint: "player_count", calldata: [] }))[0],
  );
  for (let seat = 0; seat < count; seat += 1) {
    const r = await provider.callContract({
      contractAddress: ROUND,
      entrypoint: "seat_address",
      calldata: [String(seat)],
    });
    out.add(BigInt(r[0]));
  }
  return out;
}

function fmt(wei) {
  return (Number(wei) / 1e18).toString();
}

function save() {
  writeFileSync(PLAYERS_FILE, `${JSON.stringify(players, null, 2)}\n`);
}
