# Hosting Signal so people can play it

Two separate things live in this repo, and only one of them is hosted:

- **The game** — a Next.js app with an in-memory relay. This is what you host.
- **The contracts** — Cairo, deployed to Starknet separately (see `strk20.json`).

The game does not call the contracts. Hosting it and deploying them are
independent tasks; neither needs the other.

## The one constraint that decides the host

`app/src/server/rooms.ts` keeps rooms in module memory. It needs **one
long-lived Node process**.

That rules out **Vercel** and anything else serverless: requests spread across
instances, each with its own empty room list, so a friend who types your room
code is told it does not exist. The symptom looks like a bug and is not one.

WebSockets are *not* required — `useRoomSync` polls — so any plain Node host
works.

## Render (free)

`render.yaml` at the repo root is a blueprint: point Render at the repo and it
reads the settings from there.

1. **New → Blueprint**, connect this repository.
2. Render picks up `render.yaml`. Confirm and deploy.
3. First build takes a few minutes. The URL is `https://<name>.onrender.com`;
   the game is at `/play`.

Doing it by hand instead, the settings are:

| | |
|---|---|
| Root directory | `app` |
| Build command | `npm ci && npm run build` |
| Start command | `npm start` |
| Node version | 20 |
| Health check | `/play` |

### The free tier sleeps, and that matters here

A free Render service sleeps after ~15 minutes idle, and **sleeping wipes every
room** — they only ever existed in memory.

In practice this is survivable, because polling keeps the service awake while
anyone is playing. It only sleeps *between* sessions. So:

- Open the URL once and wait for it to wake (~30–60s cold start) **before**
  inviting anyone.
- Create the room *after* it is awake.
- Finish a game in one sitting. A room does not survive a sleep, a redeploy, or
  a crash.

If that is not acceptable, the fix is a paid always-on instance, or moving room
state out of memory — a much larger change, and deliberately out of scope while
the real shared state is meant to be the contract.

## Playing without hosting

- **Same network** — the dev server already binds `0.0.0.0:3000`. A friend on
  your wifi opens `http://<your-lan-ip>:3000/play`.
- **Anywhere** — `ngrok http 3000` and share the URL. Run `npm start` rather
  than `npm run dev`.
