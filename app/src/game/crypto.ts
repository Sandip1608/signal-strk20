/**
 * The two pieces of real cryptography the game needs client-side.
 *
 * Both use starknet.js primitives rather than stand-ins, so the values here
 * are the values the deployed contract will accept: `poseidonCommitment`
 * reproduces `poseidon_hash_span([impostor_seat, salt])` from
 * `round.cairo::resolve_round`, and a burner keypair is a real Stark keypair.
 */

import { ec, encode, hash, num } from "starknet";

/** `randomPrivateKey()` hands back 32 raw bytes; the rest of the API wants a felt. */
function randomFelt(): string {
  return num.toHex(`0x${encode.buf2hex(ec.starkCurve.utils.randomPrivateKey())}`);
}

/**
 * Generate a burner session key.
 *
 * This is the whole of "session keys" in v1 — a locally-held EOA keypair, not
 * account abstraction (see the non-negotiables in CLAUDE.md). It is enough to
 * make the unlinkability claim true, because in-round actions are signed by
 * this key while the buy-in was shielded by a different wallet.
 *
 * The private key never leaves the browser.
 */
export function generateSessionKey(): { privateKey: string; publicKey: string } {
  const privateKey = randomFelt();
  const publicKey = num.toHex(ec.starkCurve.getStarkKey(privateKey));
  return { privateKey, publicKey };
}

/**
 * `poseidon_hash_span([...hidden_seats, salt])`.
 *
 * The host posts this in `assign_roles` and opens it in `resolve_round`; the
 * contract recomputes it and rejects a mismatch, which is what stops the host
 * re-picking the hidden team after seeing the vote.
 *
 * Seats must be ascending, matching the contract's `hidden seats unsorted`
 * guard. For a single hidden player this is identical to the original
 * `poseidon(impostor_seat, salt)`.
 */
export function poseidonCommitment(hiddenSeats: number[], salt: string): string {
  const ordered = [...hiddenSeats].sort((a, b) => a - b);
  return num.toHex(
    hash.computePoseidonHashOnElements([...ordered.map((s) => num.toHex(s)), salt]),
  );
}

/** `poseidon_hash_span(array![host_seed].span())` — the host's seed commitment. */
export function seedCommitment(hostSeed: string): string {
  return num.toHex(hash.computePoseidonHashOnElements([hostSeed]));
}

/**
 * `poseidon(host_seed, entropy_0, .., entropy_{n-1})`.
 *
 * The host commits to `host_seed` in the constructor, before anyone has
 * joined, so they cannot aim it at a person; each player then adds entropy the
 * host cannot predict. Neither side steers the draw alone.
 */
export function combinedSeed(hostSeed: string, entropies: string[]): string {
  return num.toHex(hash.computePoseidonHashOnElements([hostSeed, ...entropies]));
}

/**
 * Mirror of `round.cairo::derive_hidden` — partial Fisher-Yates with
 * swap-remove, returned ascending.
 *
 * This must stay byte-identical to the Cairo. `contracts/src/tests.cairo`
 * asserts the exact seat lists this function produces, so a divergence fails a
 * test rather than quietly making every round unopenable at `resolve_round`.
 */
export function deriveHidden(combined: string, n: number, k: number): number[] {
  return drawSeats(combined, n, k).sort((a, b) => a - b);
}

/**
 * Mirror of `round.cairo::draw_seats` — `count` distinct seats in *draw order*.
 *
 * Split from `deriveHidden` so several roles come off one seed: drawing
 * `k + s` continues the same sequence, so the first `k` picks are identical to
 * drawing `k` alone. That is what lets a seer be added without changing who
 * the impostors are, and a Cairo test asserts exactly that.
 */
export function drawSeats(combined: string, n: number, count: number): number[] {
  if (count > n) throw new Error("k above n");

  const pool = Array.from({ length: n }, (_, i) => i);
  const chosen: number[] = [];

  for (let t = 0; t < count; t += 1) {
    const r = BigInt(num.toHex(hash.computePoseidonHashOnElements([combined, num.toHex(t)])));
    const remaining = BigInt(n - t);
    const idx = Number(r % remaining);
    chosen.push(pool[idx]);
    // Swap the last live entry into the hole, exactly as the Cairo does.
    pool[idx] = pool[n - t - 1];
  }

  return chosen;
}

/** Deal every special role from one draw: impostors first, then seer(s). */
export function deriveRoles(
  combined: string,
  n: number,
  hiddenCount: number,
  seerCount: number,
): { hidden: number[]; seers: number[] } {
  const all = drawSeats(combined, n, hiddenCount + seerCount);
  return {
    hidden: all.slice(0, hiddenCount).sort((a, b) => a - b),
    seers: all.slice(hiddenCount).sort((a, b) => a - b),
  };
}

/** A fresh random felt, used as the commitment salt. */
export function randomSalt(): string {
  return randomFelt();
}

/**
 * A pre-created STRK20 open note id (phase 5, CreateOpenNote) that the payout
 * lands in. Until the SDK is wired (TIMELINE.md day 1) this stands in for the
 * id the pool would hand back — the contract only requires a non-zero felt it
 * can store and pass through.
 */
export function placeholderPayoutNote(): string {
  return randomFelt();
}

/** A player's public entropy contribution, supplied at `join`. */
export function randomEntropy(): string {
  return randomFelt();
}

/** A throwaway wallet address, for seats filled locally during a demo round. */
export function placeholderWallet(): string {
  return randomFelt();
}
