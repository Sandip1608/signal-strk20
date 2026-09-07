"use client";

/**
 * Wallet connection for the game.
 *
 * Deliberately separate from the starter kit's `walletContext`: that one is
 * wired to mainnet providers and a different screen's needs. This is a small
 * store the lobby can use, pinned to whatever network the round was deployed
 * to, and it is entirely optional — the game runs with no wallet at all, which
 * is still the normal case.
 *
 * Discovery uses `eip1193Adapters: []` for the same reason `SelectWallet` does:
 * MetaMask's Starknet Snap probing spams an unlock popup at anyone who has it
 * installed, whether or not they wanted a Starknet wallet.
 */

import { create } from "zustand";
import { WalletAccountV6, walletV6, validateAndParseAddress, RpcProvider } from "starknet";
import { createStore, type Store } from "@starknet-io/get-starknet-discovery";
import type { WalletWithStarknetFeatures } from "@starknet-io/get-starknet-wallet-standard/features";
import { DEPLOYMENT } from "./deployed";
import { seatOfAddress, type WalletLike } from "./chain";

type WalletStore = {
  /** Wallets the browser has registered. Populated on mount, then live. */
  available: WalletWithStarknetFeatures[];
  account: WalletLike | null;
  address: string | null;
  chainId: string | null;
  /** Seat this wallet already holds on the deployed round, if any. */
  onChainSeat: number | null;
  connecting: boolean;
  error: string | null;

  discover: () => () => void;
  connect: (w: WalletWithStarknetFeatures) => Promise<void>;
  disconnect: () => void;
  refreshSeat: () => Promise<void>;
  clearError: () => void;
};

/** True when the wallet is on the chain the round was deployed to. */
export function onRightChain(chainId: string | null): boolean {
  if (!DEPLOYMENT || !chainId) return false;
  return BigInt(chainId) === BigInt(DEPLOYMENT.chainId);
}

export const useWallet = create<WalletStore>((set, get) => ({
  available: [],
  account: null,
  address: null,
  chainId: null,
  onChainSeat: null,
  connecting: false,
  error: null,

  discover: () => {
    const store: Store = createStore({ eip1193Adapters: [] });
    set({ available: store.getWallets().slice() });
    return store.subscribe((next) => set({ available: next.slice() }));
  },

  connect: async (w) => {
    set({ connecting: true, error: null });
    try {
      if (!DEPLOYMENT) throw new Error("no round deployed — nothing to connect to");
      const provider = new RpcProvider({ nodeUrl: DEPLOYMENT.rpc });
      const account = await WalletAccountV6.connect(provider, w);
      const accounts = await walletV6.requestAccounts(w);
      if (!Array.isArray(accounts) || accounts.length === 0) {
        throw new Error("that wallet did not return an account");
      }
      const address = validateAndParseAddress(accounts[0]);
      let chainId: string | null = null;
      try {
        chainId = await walletV6.requestChainId(w);
      } catch {
        // Not every wallet answers; the guard below simply stays cautious.
      }
      set({
        account: account as unknown as WalletLike,
        address,
        chainId,
        connecting: false,
      });
      await get().refreshSeat();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), connecting: false });
    }
  },

  disconnect: () =>
    set({ account: null, address: null, chainId: null, onChainSeat: null, error: null }),

  refreshSeat: async () => {
    const { address } = get();
    if (!address) return;
    set({ onChainSeat: await seatOfAddress(address) });
  },

  clearError: () => set({ error: null }),
}));
