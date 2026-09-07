/**
 * Declare + deploy SignalRound and SignalEscrow to Starknet.
 *
 * Deliberately uses starknet.js and the *already compiled* artifacts in
 * `contracts/target/dev` rather than scarb/sncast: the sierra and casm JSON are
 * committed, starknet.js is already a dependency, and installing a Rust
 * toolchain on deadline day is risk we do not need.
 *
 * Usage (from app/):
 *   node scripts/deploy.mjs --dry-run          # class hashes + plan, no keys
 *   node scripts/deploy.mjs                    # declare + deploy + set_escrow
 *
 * Reads from the environment (put these in app/.env.deploy, which is
 * gitignored — never paste a mainnet key into a shell history):
 *   STARKNET_ACCOUNT_ADDRESS   your funded account
 *   STARKNET_PRIVATE_KEY       its private key
 *   STARKNET_RPC               optional, defaults to a public mainnet node
 *   POT_NOTE_ID                optional, random felt if unset
 *   NIGHT_SECS / VOTE_SECS     optional round timers
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Account, Contract, RpcProvider, ec, encode, hash, num } from "starknet";

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = resolve(HERE, "../../contracts/target/dev");
const STRK20_JSON = resolve(HERE, "../../strk20.json");

/** STRK20 privacy pool, Starknet mainnet. Verified live before hard-coding. */
const NETWORKS = {
  mainnet: {
    rpc: "https://rpc.starknet.lava.build:443",
    // Verified live before hard-coding: class hash 0x67dd...554d at this address.
    pool: "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a",
  },
  sepolia: {
    rpc: "https://starknet-sepolia-rpc.publicnode.com",
    // The docs do publish a Sepolia pool, "for SDK and integration testing".
    // Verified live before hard-coding: class hash 0x7e2bbd...33f at this
    // address. An earlier note here said no testnet pool existed, which meant
    // SignalEscrow was skipped on Sepolia and the only rehearsal available was
    // of the half that never touches the pool.
    pool: "0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91",
  },
};

const DRY = process.argv.includes("--dry-run");

// ── env ────────────────────────────────────────────────────────────────────
loadEnvFile(resolve(HERE, "../.env.deploy"));

const NETWORK = (process.env.STARKNET_NETWORK || "mainnet").toLowerCase();
if (!NETWORKS[NETWORK]) {
  console.error(`Unknown STARKNET_NETWORK "${NETWORK}" - use mainnet or sepolia.`);
  process.exit(1);
}
const RPC = process.env.STARKNET_RPC || NETWORKS[NETWORK].rpc;
const POOL = process.env.POOL_ADDRESS || NETWORKS[NETWORK].pool;
const ADDRESS = process.env.STARKNET_ACCOUNT_ADDRESS;
const PK = process.env.STARKNET_PRIVATE_KEY;
const NIGHT_SECS = Number(process.env.NIGHT_SECS ?? 600);
const VOTE_SECS = Number(process.env.VOTE_SECS ?? 240);
// Variant = constructor configuration. Defaults to Among Us at RFP bounds.
const MIN_PLAYERS = Number(process.env.MIN_PLAYERS ?? 5);
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS ?? 15);
const HIDDEN_COUNT = Number(process.env.HIDDEN_COUNT ?? 1);
// The RFP's investigative role. 0 is vanilla Among Us; the constructor asserts
// `hidden_count + seer_count < min_players`.
const SEER_COUNT = Number(process.env.SEER_COUNT ?? 0);
// Tasks each crewmate is dealt. 0 switches off the crew's task win entirely.
const TASKS_PER_PLAYER = Number(process.env.TASKS_PER_PLAYER ?? 3);
const POT_NOTE_ID =
  process.env.POT_NOTE_ID || num.toHex(`0x${encode.buf2hex(ec.starkCurve.utils.randomPrivateKey())}`);

/**
 * The host's secret seed and its on-chain commitment.
 *
 * Committed in the constructor, i.e. before a single player joins, so the host
 * cannot aim the role draw at anyone. KEEP THE SEED: `resolve_round` will not
 * open the round without it, and it is not recoverable from the chain.
 */
const HOST_SEED =
  process.env.HOST_SEED || num.toHex(`0x${encode.buf2hex(ec.starkCurve.utils.randomPrivateKey())}`);
const SEED_COMMITMENT = num.toHex(hash.computePoseidonHashOnElements([HOST_SEED]));

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function artifact(name) {
  return {
    sierra: JSON.parse(readFileSync(`${ARTIFACTS}/signal_${name}.contract_class.json`, "utf8")),
    casm: JSON.parse(readFileSync(`${ARTIFACTS}/signal_${name}.compiled_contract_class.json`, "utf8")),
  };
}

const round = artifact("SignalRound");
const escrow = artifact("SignalEscrow");

console.log("Signal — deploy\n");
console.log(`  network    ${NETWORK}`);
console.log(`  rpc        ${RPC}`);
console.log(`  pool       ${POOL ?? "(none - SignalEscrow will be skipped)"}`);
console.log(
  `  players    ${MIN_PLAYERS}-${MAX_PLAYERS}, hidden team ${HIDDEN_COUNT}, seers ${SEER_COUNT}, tasks ${TASKS_PER_PLAYER}`,
);
console.log(`  timers     night ${NIGHT_SECS}s / vote ${VOTE_SECS}s`);
console.log(`  pot note   ${POT_NOTE_ID}`);
console.log(`  seed commit ${SEED_COMMITMENT}`);
console.log(`  SignalRound  class ${hash.computeContractClassHash(round.sierra)}`);
console.log(`  SignalEscrow class ${hash.computeContractClassHash(escrow.sierra)}\n`);

if (DRY) {
  console.log("Dry run. Plan:");
  console.log("  1. declare SignalRound            -> tx #1");
  console.log("  2. deploy  SignalRound(host, seed_commit, min, max, hidden, seer, tasks, night, vote) -> tx #2");
  if (POOL) {
    console.log("  3. declare SignalEscrow           -> tx #3");
    console.log("  4. deploy  SignalEscrow(pool, round, pot_note) -> tx #4");
    console.log("  5. round.set_escrow(escrow)       -> tx #5");
  } else {
    console.log("  (SignalEscrow skipped - no pool address for this network)");
  }
  console.log("\nSet STARKNET_ACCOUNT_ADDRESS and STARKNET_PRIVATE_KEY, then re-run without --dry-run.");
  process.exit(0);
}

if (!ADDRESS || !PK) {
  console.error(
    "Missing STARKNET_ACCOUNT_ADDRESS / STARKNET_PRIVATE_KEY.\n" +
      "Put them in app/.env.deploy (gitignored) and re-run, or use --dry-run.",
  );
  process.exit(1);
}

const provider = new RpcProvider({ nodeUrl: RPC });
// starknet.js v10 takes an options object; the old positional form throws
// "Cannot read properties of undefined" at construction. --dry-run never builds
// an Account, so this only ever failed on a real run.
const account = new Account({ provider, address: ADDRESS, signer: PK });
const txs = [];

const chainId = await provider.getChainId();
console.log(`connected — chain ${chainId}\n`);

// ── 1-2. SignalRound ───────────────────────────────────────────────────────
console.log("declaring SignalRound…");
const roundDecl = await account.declareIfNot({ contract: round.sierra, casm: round.casm });
if (roundDecl.transaction_hash) {
  txs.push(roundDecl.transaction_hash);
  console.log(`  declared  ${roundDecl.transaction_hash}`);
  await provider.waitForTransaction(roundDecl.transaction_hash);
} else {
  console.log("  already declared");
}

console.log("deploying SignalRound…");
const roundDep = await account.deployContract({
  classHash: roundDecl.class_hash,
  constructorCalldata: [
    ADDRESS,
    SEED_COMMITMENT,
    String(MIN_PLAYERS),
    String(MAX_PLAYERS),
    String(HIDDEN_COUNT),
    String(SEER_COUNT),
    String(TASKS_PER_PLAYER),
    String(NIGHT_SECS),
    String(VOTE_SECS),
  ],
});
txs.push(roundDep.transaction_hash);
await provider.waitForTransaction(roundDep.transaction_hash);
console.log(`  deployed  ${roundDep.contract_address}\n            ${roundDep.transaction_hash}`);

// ── 3-4. SignalEscrow ──────────────────────────────────────────────────────
let escrowAddress = null;
let escDecl = null;
if (!POOL) {
  console.log("no pool address for this network - skipping SignalEscrow.\n");
} else {
console.log("declaring SignalEscrow…");
  escDecl = await account.declareIfNot({ contract: escrow.sierra, casm: escrow.casm });
if (escDecl.transaction_hash) {
  txs.push(escDecl.transaction_hash);
  console.log(`  declared  ${escDecl.transaction_hash}`);
  await provider.waitForTransaction(escDecl.transaction_hash);
} else {
  console.log("  already declared");
}

console.log("deploying SignalEscrow…");
const escDep = await account.deployContract({
  classHash: escDecl.class_hash,
  constructorCalldata: [POOL, roundDep.contract_address, POT_NOTE_ID],
});
txs.push(escDep.transaction_hash);
await provider.waitForTransaction(escDep.transaction_hash);
console.log(`  deployed  ${escDep.contract_address}\n            ${escDep.transaction_hash}\n`);

// ── 5. link them ───────────────────────────────────────────────────────────
console.log("linking escrow to round (set_escrow)…");
// v10 options form, like Account above. The positional form throws
// "Cannot read properties of undefined (reading 'find')" — and it does so at
// step 5, after the four transactions before it have already been paid for.
const roundContract = new Contract({
  abi: round.sierra.abi,
  address: roundDep.contract_address,
  providerOrAccount: account,
});
const link = await roundContract.set_escrow(escDep.contract_address);
txs.push(link.transaction_hash);
await provider.waitForTransaction(link.transaction_hash);
console.log(`  linked    ${link.transaction_hash}\n`);
escrowAddress = escDep.contract_address;
}

// ── record it ──────────────────────────────────────────────────────────────
const manifest = existsSync(STRK20_JSON)
  ? JSON.parse(readFileSync(STRK20_JSON, "utf8"))
  : { transactions: [], contracts: [], demo_video: "", demo_url: "" };

manifest.transactions = [...new Set([...(manifest.transactions ?? []), ...txs])];
manifest.network = NETWORK;
manifest.contracts = [
  { name: "SignalRound", address: roundDep.contract_address, class_hash: roundDecl.class_hash },
  ...(escrowAddress
    ? [{ name: "SignalEscrow", address: escrowAddress, class_hash: escDecl.class_hash }]
    : []),
];
writeFileSync(STRK20_JSON, `${JSON.stringify(manifest, null, 2)}\n`);

console.log("done.");
console.log(`  SignalRound   ${roundDep.contract_address}`);
if (escrowAddress) console.log(`  SignalEscrow  ${escrowAddress}`);
console.log(`  ${txs.length} transactions written to strk20.json`);
console.log(`\n  pot note id (keep this): ${POT_NOTE_ID}`);
