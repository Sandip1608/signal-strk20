/**
 * Where the round lives on chain.
 *
 * Written by `scripts/deploy.mjs` alongside `strk20.json`, because that file
 * sits at the repo root and Next cannot import from outside `app/`. Editing it
 * by hand only guarantees the two disagree — redeploy instead.
 */

export type Deployment = {
  network: "sepolia" | "mainnet";
  rpc: string;
  chainId: string;
  round: string;
  escrow: string | null;
};

export const DEPLOYMENT: Deployment | null = {
  network: "sepolia",
  rpc: "https://starknet-sepolia-rpc.publicnode.com",
  // `SN_SEPOLIA` — what a connected wallet must report, or the join will be
  // sent to a chain the contract is not on.
  chainId: "0x534e5f5345504f4c4941",
  round: "0x46094f727a8550522e1df968ab539af3967c04f52baab77b1a7ded4816990db",
  escrow: "0x598020caf411af143a8b4f6f0a1693fa044e33babcfff066a3313339839d1cc",
};
