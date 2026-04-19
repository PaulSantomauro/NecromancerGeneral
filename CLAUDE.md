# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

This is a two-package repo: a Vite client at the repo root and a Node/Socket.io server under `server/`.

Client (run from repo root):
- `npm run dev` — Vite dev server, LAN-accessible (binds 0.0.0.0)
- `npm run build` — production build to `dist/`
- `npm run preview` — preview the built bundle

Server (run from `server/`):
- `npm start` — `node index.js`, listens on `PORT` (default 2567)
- `npm run dev` — same with `node --watch` for auto-restart

The client reads `VITE_WS_URL` to find the server. `.env.local` points at a LAN IP for multi-device testing; `.env.production` points at the deployed server. Falls back to `http://localhost:2567` if neither is set.

There are no tests, linter, or typechecker configured.

## Architecture

### Client/server split (trust-client model)
The client runs nearly the entire simulation locally — terrain, hostile AI, combat resolution, projectile physics, ally behavior trees, progression. The server is deliberately thin: it persists players + allies in SQLite, relays ally/fire messages between clients, owns the round state machine (fog + PvE→PvP→ended), and is authoritative **only** for PvP bullet-vs-player collisions for `machine_gun` ammo.

Consequences to keep in mind:
- `hp` on `state_tick` is advisory; `main.js` deliberately does **not** overwrite local HP from server state. Local hostile melee never reaches the server.
- Hostile skeletons are purely client-local. The server's `spawnSkeleton` / `seedHostiles` code exists but is no longer called (see "client-local" comment in `server/index.js`).
- Each client simulates **its own** hostiles and broadcasts a `hostile_count` so the server can detect the PvE→PvP transition (all clients report 0 hostiles for N ticks, OR fog fully shrunk + `pveTimeoutSeconds` elapsed).
- Player death is client-authoritative: client sends `player_died`; server runs the kill pipeline and blocks rejoin that round (`deadThisRound` set → `rejoin_denied`).
- `disconnect` during PvP counts as a forfeit death so a stale socket can't wedge the win check.

### Entity ownership and replication
Every ally (summoned/converted skeleton) has `{ownerId, localId}`. The owning client runs its behavior tree and broadcasts position at 20Hz via `ally_state`; other clients mirror it with `behaviorTree = null` + `setServerPosition` (interpolated). `ally_spawned` is sent once so remotes know the type/tier/maxHp. On owner disconnect, remote clients promote their mirrored copies into locally-simulated "orphaned" guard NPCs (see `NET_PLAYER_LEFT` handler in `main.js`); on reconnect they're killed and replaced by the returning owner's re-broadcast.

### Event bus
`systems/EventSystem.js` is a singleton pub/sub used as the glue between subsystems. Network arrivals become `NET_*` events; local game actions become unprefixed events. `NetworkSystem` only translates socket events ↔ event bus events — all other code subscribes to the bus, not the socket. When adding a new server message, add a GameEvent, wire it in `NetworkSystem.js`, and subscribe in `main.js`.

### Frame loop (`src/main.js`)
The order in `animate()` matters and has been tuned around subtle bugs:
1. Terrain height is applied to the camera **before** `player.update` so bullets fired inside `_tryFire()` spawn at head-height.
2. `player.update` → projectile update → AI (`skeleton.update`) → remote general interpolation → wrap positions → terrain height again → `resolveAllCombat` → fog damage → `battleDirector.update`.
3. Cleanup of dead projectiles/skeletons happens at the end so anything freshly killed still participates this frame.

### Bounded world (`systems/Toroid.js`)
Despite the filename and function names (`toroidalDelta`, `closestWrap`), the world is **bounded**, not toroidal — positions are clamped to `[-WORLD_SIZE/2, +WORLD_SIZE/2]` with a 0.5-unit edge buffer and distances are straight-line. `closestWrap(v, _)` just returns `v`. The module was repurposed without renaming to keep the diff small.

### Round / fog / PvE→PvP
Server owns round state; client mirrors it into `roundState` (mutated in place so references held by `BattleDirector` and combat code stay live). During PvE all generals are allied — friendly-fire is disabled and spawn zones outside the current fog radius are skipped (`BattleDirector._zonesInsideFog`). Fog shrinks linearly over `fogShrinkSeconds`; entities outside take `fogDamagePerSec`. Combat targeting flips at PvP: `resolveAllCombat(..., phase)` uses `!s.friendly` when PvP, `faction === HOSTILE` during PvE.

### Persistence (`server/db.js`)
SQLite via `better-sqlite3`, WAL mode. Schema is two tables: `players` (upgrades, souls, position, last_seen) and `allies` (per-owner list of `{x, z, tier, hp, type}`). The `allies.type` column is added via a try/catch `ALTER TABLE` for older DBs (SQLite has no `ADD COLUMN IF NOT EXISTS`). Offline players within `OFFLINE_WINDOW_MS` (2h) are rehydrated on boot so their persisted allies survive server restarts.

### Data-driven config
Numeric tuning lives in `src/config/*.json` (ammo, monsters, battle/round, player). The server reads `ammo.json` + `battle.json` directly from `../src/config/` at boot so ammo/round parameters stay in sync across client and server without a build step.

## Conventions

- ES modules (`"type": "module"`) everywhere, including the server.
- `import ... from '*.json'` works because Vite supports JSON imports natively; the server uses `JSON.parse(readFileSync(...))` to reach the same files.
- Positions: entities carry a logical `position` (Vector3 with y=0 in world coords) and a render `mesh.position` (set per-frame from terrain height). Don't conflate them.
- When adding a new networked action, use the ownerId+localId pattern for things the owner simulates and server only relays; reserve full server authority for cross-client state that must not diverge (currently: PvP damage, round state, souls/upgrades).
