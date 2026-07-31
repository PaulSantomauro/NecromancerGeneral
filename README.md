# Necromancer General

Persistent-battlefield multiplayer: summon armies, convert the fallen, outlast the fog.

> **Archived.** Vibe Jam 2026 entry; the hosting was decommissioned on 2026-07-31 and
> `necromancer.paulsantomauro.com` no longer resolves. The game still runs locally — see
> [Local development](#local-development).

Three.js + Socket.io, Vite client, Node server, AWS-native hosting.

## Architecture

- **Client** — Vite SPA, Three.js simulation running nearly the entire game (terrain, AI, projectile physics, combat). Static-hosted on S3 + CloudFront.
- **Server** — thin Node/Socket.io relay on a `t4g.nano` EC2 instance behind nginx with a Let's Encrypt cert. Persists players + allies in SQLite, owns the round state machine, and is authoritative for PvP damage only.
- **Trust-client model** — full details in `CLAUDE.md`; short version: local hostile melee never hits the server, HP is client-authoritative, and the server is deliberately light.

## Local development

Client (repo root):

```bash
npm install
npm run dev         # Vite, LAN-accessible on 0.0.0.0:5173
```

Server (`server/`):

```bash
cd server
npm install
npm run dev         # node --watch index.js, listens on :2567
```

The client reads `VITE_WS_URL` to find the server (defaults to `http://localhost:2567`). `.env.local` can point at a LAN IP for multi-device testing.

## Production (decommissioned)

While the jam ran, this was deployed on AWS:

- Client: `https://necromancer.paulsantomauro.com` (S3 + CloudFront, Route53 alias).
- Server: `wss://api.necromancer.paulsantomauro.com` (EC2 `t4g.nano` + nginx + WSS).
- Deploys were automated via GitHub Actions on push to `main` — client rebuild + S3 sync +
  CloudFront invalidation, and an SSM SendCommand pull/restart for the server.

All of it was torn down on 2026-07-31: stacks destroyed, DNS records removed, the site bucket
deleted, and the SQLite world (careers and leaderboard) discarded with the instance. The CDK app
under [`infra/`](./infra) is kept as the reproducible record — `npx cdk deploy --all` stands the
whole thing back up. See [`infra/README.md`](./infra/README.md).

## Repo layout

```
src/             Client (Vite + Three.js)
server/          Node/Socket.io server
infra/           AWS CDK app (frontend, server, OIDC stacks) — not currently deployed
src/config/*.json   Data-driven tuning (ammo, monsters, battle, round, player)
```
