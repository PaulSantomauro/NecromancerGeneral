# Necromancer General

Persistent-battlefield multiplayer: summon armies, convert the fallen, outlast the fog.

> **Play:** <https://necromancer.paulsantomauro.com>

Vibe Jam 2026 entry. Three.js + Socket.io, Vite client, Node server, AWS-native hosting.

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

## Production

- Client: `https://necromancer.paulsantomauro.com` (S3 + CloudFront, Route53 alias).
- Server: `wss://api.necromancer.paulsantomauro.com` (EC2 + nginx + WSS).
- Deploys are automated via GitHub Actions on push to `main`:
  - `src/**` / `index.html` / `vite.config.js` → rebuilds client, syncs to S3, invalidates CloudFront.
  - `server/**` → SSM SendCommand pulls + restarts the service on EC2.
- Infra is CDK (TypeScript) under [`infra/`](./infra). See [`infra/README.md`](./infra/README.md) for deploy commands.

## Repo layout

```
src/             Client (Vite + Three.js)
server/          Node/Socket.io server
infra/           AWS CDK app (frontend, server, OIDC stacks)
.github/workflows/  GitHub Actions deploy pipelines
src/config/*.json   Data-driven tuning (ammo, monsters, battle, round, player)
```
