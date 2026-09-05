# Starknet Privacy Starter Kit

A lean Next.js starter for building privacy dApps on Starknet with [STRK20](https://eprint.iacr.org/2026/474) via `WalletAccountV6` (starknet.js v10). Shield, unshield, privately transfer, read shielded balances, and run an anonymizer (`privacy_invoke`) — all through the user's wallet, never touching a viewing key.

> Demo defaults (fixed token, fixed amounts, and an *echo* helper that just round-trips) are marked `DEMO` in the code — swap them for your own.

## Quick start

```bash
npm install
cp .env.example .env.local     # add your Alchemy key
npm run dev                    # http://localhost:3000
```

Needs a free [Alchemy](https://alchemy.com) Starknet RPC key and a privacy-enabled wallet (Ready) on Sepolia or Mainnet.

## What's inside

- **Connect** — `get-starknet` v6 discovery + wallet picker, with `eip1193Adapters: []` to stop MetaMask popups → `SelectWallet.tsx`
- **Actions** — shield / unshield / private transfer / echo / balances via `strk20InvokeTransaction` → `WalletAccountV6Tag.tsx`
- **Config** — token, RPC providers, helper addresses (all `DEMO`-labelled) → `src/utils/constants.ts`
- **Anonymizer** — a minimal `privacy_invoke` contract you can deploy from the UI → `cairo/src/lib.cairo`

Stack: Next.js 16 · React 19 · TypeScript · starknet.js 10 · zustand. No component framework.

## Gotchas worth knowing

- **Placeholders are literal strings.** In the `invoke` action, `"OPEN"`, `"${poolAddress}"`, `"${openNoteIds[0]}"` are substituted by the wallet — never `num.toHex` them. Only real token/amounts get hex-normalized.
- The echo helper is a **no-op demo** — replace its body with a real action (swap/vault/lend); the `privacy_invoke` shape stays the same. You own the tests and audit.
- Ready wallet works today (Xverse's Wallet API is landing); the app degrades gracefully for others.

## Deploy

Standard Next.js on [Vercel](https://vercel.com/new) — set `NEXT_PUBLIC_PROVIDER_URL` (and optionally `NEXT_PUBLIC_STRK20_ECHO_HELPER_SEPOLIA`).

## Links

[STRK20 by example](https://strk20-by-example.org/) · [Privacy SDK](https://github.com/starkware-libs/starknet-privacy) · [WalletAccount guide](https://starknet-js.com/docs/next/guides/account/walletAccount/#with-get-starknet-v6)

Bootstrapped from [PhilippeR26/Starknet-WalletAccount](https://github.com/PhilippeR26/Starknet-WalletAccount).
