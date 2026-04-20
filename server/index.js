import { createServer } from 'http';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import * as db from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ammoConfig = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'src', 'config', 'ammo.json'), 'utf8')
);
const battleConfig = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'src', 'config', 'battle.json'), 'utf8')
);
const ROUND_CFG = battleConfig.round || {};
const FOG_START  = ROUND_CFG.fogStartRadius ?? 95;
const FOG_MIN    = ROUND_CFG.fogMinRadius ?? 10;
const FOG_TIME   = ROUND_CFG.fogShrinkSeconds ?? 300;
const PVE_TIMEOUT = ROUND_CFG.pveTimeoutSeconds ?? 60;
const CLEAR_TICKS = ROUND_CFG.hostileCountClearTicks ?? 2;
const MUZZLE_OFFSET = 1.2;
const WORLD_SIZE = battleConfig.worldSize ?? 200;
const W_HALF = WORLD_SIZE / 2;
const EDGE_BUFFER = 0.5;
// Safe spawn radius — generous but well inside the initial fog radius so
// no player is dropped into the lethal ring.
const SPAWN_RADIUS = Math.min(100, (FOG_START ?? 95) * 0.55);

function randomSpawn() {
  const r = Math.sqrt(Math.random()) * SPAWN_RADIUS;
  const a = Math.random() * Math.PI * 2;
  return { x: Math.cos(a) * r, z: Math.sin(a) * r };
}
function wrapC(v) {
  if (v > W_HALF - EDGE_BUFFER) return W_HALF - EDGE_BUFFER;
  if (v < -W_HALF + EDGE_BUFFER) return -W_HALF + EDGE_BUFFER;
  return v;
}
function wrapPos(p) { p.x = wrapC(p.x); p.z = wrapC(p.z); return p; }
function tDelta(ax, az, bx, bz) {
  return { dx: bx - ax, dz: bz - az };
}
const SK_BODY_RADIUS = 0.55;
const SK_BODY_LOW = -0.2;
const SK_BODY_HIGH = 1.8;
const PLAYER_BODY_RADIUS = 0.85;
const PLAYER_BODY_LOW = -0.2;
const PLAYER_BODY_HIGH = 1.9;

const PORT              = process.env.PORT || 2567;
const ROOM              = 'BATTLE';
const TICK_HZ           = 20;
const TICK_MS           = 1000 / TICK_HZ;
const FLUSH_MS          = 8000;
const OFFLINE_WINDOW_MS = 2 * 60 * 60 * 1000;

const HOSTILE_SPAWN_MS  = 4000;
const HOSTILE_CAP       = 80;
const HOSTILE_BATCH     = 3;

const RESTART_DELAY_MS  = 30000;

const HOSTILE_ZONES = [
  { cx: 0,   cz: -80, r: 15 },
  { cx: -60, cz: -70, r: 12 },
  { cx: 60,  cz: -70, r: 12 },
];

// ── In-memory world ────────────────────────────────────────────────────────
const players = new Map();
const skeletons = new Map();
const projectilesById = new Map();
let nextSkeletonId = 1;
let nextProjectileId = 1;

// ── Round state (battle-royale) ────────────────────────────────────────────
// Single active round per server process. Phase progresses:
//   pve  — all generals allied, fog shrinking, hostiles spawn inside fog
//   pvp  — all generals turn on each other (triggered when hostiles cleared
//          or pveTimeoutSeconds elapsed after fog reached min)
//   ended — one general left standing; winnerId is set
const round = {
  phase: 'pve',
  fogRadius: FOG_START,
  startedAt: Date.now(),
  pvpStartedAt: 0,
  endedAt: 0,
  winnerId: null,
  // Epoch ms at which an ended round auto-resets. 0 when not pending.
  restartAt: 0,
  // Number of consecutive state ticks with zero total hostiles across clients.
  clearTicks: 0,
  // How long PvE has continued after fog reached the minimum radius.
  pveOvertime: 0,
};
// Aggregated hostile count from connected clients — refreshed by hostile_count.
const hostilesByPlayer = new Map(); // pid → count
// Players who died this round; rejected from rejoin as active generals until round end.
const deadThisRound = new Set();

function computeFogRadius() {
  const elapsed = (Date.now() - round.startedAt) / 1000;
  const k = Math.max(0, Math.min(1, elapsed / FOG_TIME));
  return FOG_START + (FOG_MIN - FOG_START) * k;
}

function totalHostiles() {
  let total = 0;
  for (const n of hostilesByPlayer.values()) total += n;
  return total;
}

function activeGeneralCount() {
  let n = 0;
  for (const p of players.values()) {
    if (p.hp > 0) n++;
  }
  return n;
}

function startNewRound() {
  round.phase = 'pve';
  round.fogRadius = FOG_START;
  round.startedAt = Date.now();
  round.pvpStartedAt = 0;
  round.endedAt = 0;
  round.winnerId = null;
  round.restartAt = 0;
  round.clearTicks = 0;
  round.pveOvertime = 0;
  hostilesByPlayer.clear();
  deadThisRound.clear();
}

// Called RESTART_DELAY_MS after endRound. Wipes per-round progression
// (souls + allies) for every player (connected and offline), restores hp
// on still-connected generals, and flips phase back to pve. Dead players'
// clients re-join in response to the phase flip; their deadThisRound entry
// is cleared by startNewRound().
function resetRound() {
  // Wipe ALL per-round progression in the DB: souls, persisted allies, and
  // every upgrade level. Dead-and-rejoining players inherit the same clean
  // slate as survivors.
  db.default.exec(`
    UPDATE players SET
      souls = 0,
      upgrade_empower_self = 0,
      upgrade_empower_allies = 0,
      upgrade_reinforce_cap = 0
  `);
  db.default.exec('DELETE FROM allies');

  // Randomize the stored position for everyone still in the DB so dead
  // players get a fresh spawn when they rejoin after the round restarts.
  const setPos = db.default.prepare('UPDATE players SET position_x = ?, position_z = ? WHERE id = ?');
  for (const row of db.default.prepare('SELECT id FROM players').all()) {
    const s = randomSpawn();
    setPos.run(s.x, s.z, row.id);
  }

  // Reset surviving (connected) players' in-memory state.
  for (const p of players.values()) {
    p.hp = p.maxHp;
    p.souls = 0;
    p.upgrades = { empower_self: 0, empower_allies: 0, reinforce_cap: 0 };
    p.allies.clear();
    p.pos = randomSpawn();
  }

  startNewRound();
  io.to(ROOM).emit('round_restarted', { t: Date.now() });
  console.log('[round] reset — new round begins');
}

function transitionToPvp() {
  if (round.phase !== 'pve') return;
  round.phase = 'pvp';
  round.pvpStartedAt = Date.now();
  console.log('[round] PvE cleared — all generals now hostile.');
}

function endRound(winnerId) {
  if (round.phase === 'ended') return;
  round.phase = 'ended';
  round.endedAt = Date.now();
  round.restartAt = round.endedAt + RESTART_DELAY_MS;
  round.winnerId = winnerId;
  io.to(ROOM).emit('round_ended', { winnerId, t: round.endedAt, restartAt: round.restartAt });
  console.log(`[round] winner = ${winnerId || '(none)'} — next round in ${RESTART_DELAY_MS / 1000}s`);
}

function serializeRound() {
  return {
    phase:          round.phase,
    fogRadius:      round.fogRadius,
    fogStartRadius: FOG_START,
    fogMinRadius:   FOG_MIN,
    fogShrinkSecs:  FOG_TIME,
    startedAt:      round.startedAt,
    pvpStartedAt:   round.pvpStartedAt,
    winnerId:       round.winnerId,
    restartAt:      round.restartAt,
    aliveGenerals:  activeGeneralCount(),
  };
}

function spawnSkeleton(faction, pos, ownerId, tier = 0) {
  const id = nextSkeletonId++;
  const patrolCenter = { x: pos.x, z: pos.z };
  const sk = {
    id,
    faction,
    pos: { x: pos.x, z: pos.z },
    hp: faction === 'hostile' ? 1 : Math.max(1, Math.round(1 * (1 + tier * 0.3))),
    maxHp: faction === 'hostile' ? 1 : Math.max(1, Math.round(1 * (1 + tier * 0.3))),
    ownerId,
    tier,
    attackRange: 2.5,
    attackDuration: 0.8,
    attackTimer: 0,
    isAttacking: false,
    cooldownTimer: 0,
    damage: 1 * (1 + tier * 0.3),
    moveSpeed: 7 * (0.9 + Math.random() * 0.2),
    aggroRadius: 22,
    patrolRadius: 7,
    patrolCenter,
    patrolTarget: null,
    patrolTimer: 0,
    guardRadius: 12,
    engageRadius: 10,
    guardIdleTarget: null,
    guardIdleTimer: 0,
    attackTargetId: null,
    attackTargetKind: null, // 'skeleton' | 'player'
  };
  skeletons.set(id, sk);
  return id;
}

// ── Hydrate world from SQLite ───────────────────────────────────────────────
function hydrateWorld() {
  const cutoff = Date.now() - OFFLINE_WINDOW_MS;
  const offlinePlayers = db.getAllOfflinePlayers.all(cutoff);

  for (const row of offlinePlayers) {
    players.set(row.id, {
      id: row.id,
      name: row.name,
      pos: { x: row.position_x, z: row.position_z },
      yaw: 0,
      hp: 30,
      maxHp: 30,
      souls: row.souls,
      energy: row.energy,
      upgrades: {
        empower_self:   row.upgrade_empower_self,
        empower_allies: row.upgrade_empower_allies,
        reinforce_cap:  row.upgrade_reinforce_cap,
      },
      connected: false,
      socketId: null,
      allies: new Set(),
    });
  }

  console.log(`[world] hydrated — ${players.size} offline generals (skeletons are client-local)`);
}

function seedHostiles() {
  const hostileCount = [...skeletons.values()].filter(s => s.faction === 'hostile').length;
  const toSpawn = Math.max(0, 20 - hostileCount);
  for (let i = 0; i < toSpawn; i++) {
    const z = HOSTILE_ZONES[i % HOSTILE_ZONES.length];
    const angle = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * z.r;
    spawnSkeleton('hostile', { x: z.cx + Math.cos(angle) * r, z: z.cz + Math.sin(angle) * r }, null, 0);
  }
}

function persistAllies(ownerId) {
  const p = players.get(ownerId);
  if (!p) return;
  db.deleteAllies.run(ownerId);
  for (const sid of p.allies) {
    const sk = skeletons.get(sid);
    if (sk && sk.hp > 0) {
      db.insertAlly.run(ownerId, sk.pos.x, sk.pos.z, sk.tier, sk.hp, sk.type ?? 'skeleton');
    }
  }
}

function serializePlayer(p) {
  return {
    id: p.id,
    name: p.name,
    pos: p.pos,
    yaw: p.yaw,
    hp: p.hp,
    maxHp: p.maxHp,
    souls: p.souls,
    upgrades: p.upgrades,
    connected: p.connected,
  };
}

function serializeSkeleton(s) {
  return {
    id: s.id,
    faction: s.faction,
    pos: s.pos,
    hp: s.hp,
    maxHp: s.maxHp,
    ownerId: s.ownerId,
    tier: s.tier,
  };
}

// ── Socket.io setup ─────────────────────────────────────────────────────────
const httpServer = createServer();
const io = new Server(httpServer, { cors: { origin: '*' } });

io.on('connection', (socket) => {
  console.log(`[io] connection ${socket.id}`);

  socket.on('join', ({ playerId, name }) => {
    socket.join(ROOM);

    // Permadeath: players killed this round cannot rejoin as active
    // combatants. Send them the current round state so the client can
    // display the spectator/winner banner, then stop.
    if (deadThisRound.has(playerId) && round.phase !== 'ended') {
      socket.emit('rejoin_denied', {
        reason: 'dead_this_round',
        round: serializeRound(),
      });
      return;
    }

    const existing = db.getPlayer.get(playerId);

    let playerState;
    if (existing) {
      const mem = players.get(playerId);
      playerState = {
        id:        playerId,
        name:      name || existing.name,
        pos:       mem ? mem.pos : { x: existing.position_x, z: existing.position_z },
        yaw:       0,
        hp:        mem ? mem.hp : 30,
        maxHp:     30,
        souls:     mem ? mem.souls : existing.souls,
        energy:    existing.energy,
        upgrades: {
          empower_self:   existing.upgrade_empower_self,
          empower_allies: existing.upgrade_empower_allies,
          reinforce_cap:  existing.upgrade_reinforce_cap,
        },
        connected: true,
        socketId:  socket.id,
        allies:    mem ? mem.allies : new Set(),
      };
    } else {
      playerState = {
        id: playerId, name,
        pos: randomSpawn(),
        yaw: 0,
        hp: 30,
        maxHp: 30,
        souls: 0,
        energy: 80,
        upgrades: { empower_self: 0, empower_allies: 0, reinforce_cap: 0 },
        connected: true,
        socketId: socket.id,
        allies: new Set(),
      };
    }

    players.set(playerId, playerState);

    db.upsertPlayer.run({
      id: playerId,
      name: playerState.name,
      position_x: playerState.pos.x,
      position_z: playerState.pos.z,
      last_seen: Date.now(),
    });

    const allPlayers = [...players.values()].map(serializePlayer);

    const payload = {
      player: serializePlayer(playerState),
      worldPlayers: allPlayers.filter(p => p.id !== playerId),
    };

    if (existing) {
      const storedAllies = db.getAllies.all(playerId);
      payload.allies = storedAllies.map(a => ({
        x: a.position_x,
        z: a.position_z,
        tier: a.tier,
        hp: a.hp,
        type: a.type ?? 'skeleton',
      }));
      socket.emit('restore_state', payload);
    } else {
      socket.emit('welcome', payload);
    }

    socket.to(ROOM).emit('player_joined', { player: serializePlayer(playerState) });
    console.log(`[io] ${playerState.name} (${playerId.slice(0, 8)}) joined — ${existing ? 'restored' : 'new'}`);
  });

  socket.on('player_move', ({ playerId, pos, yaw }) => {
    const p = players.get(playerId);
    if (p && p.socketId === socket.id) {
      p.pos = wrapPos({ x: pos.x, z: pos.z });
      p.yaw = yaw;
    }
  });

  socket.on('player_fire', (msg) => {
    handleFire(socket, msg);
  });

  socket.on('ally_state', (msg) => {
    msg.t = Date.now(); // stamp in server-clock domain so receivers' NetClock works
    socket.to(ROOM).emit('ally_state', msg);
  });

  socket.on('ally_spawned', (msg) => {
    socket.to(ROOM).emit('ally_spawned', msg);
  });

  socket.on('ally_died', (msg) => {
    socket.to(ROOM).emit('ally_died', msg);
  });

  socket.on('hostile_count', ({ playerId, count }) => {
    const p = players.get(playerId);
    if (!p || p.socketId !== socket.id) return;
    if (typeof count !== 'number') return;
    hostilesByPlayer.set(playerId, Math.max(0, Math.floor(count)));
  });

  // Client-authoritative self-death — for damage sources the server doesn't
  // simulate (fog, local hostile melee, etc). The killed player reports the
  // event; server treats it as authoritative and runs the death pipeline.
  socket.on('player_died', ({ playerId, killedBy }) => {
    const p = players.get(playerId);
    if (!p || p.socketId !== socket.id) return;
    p.hp = 0;
    killGeneral(p, killedBy || null);
  });

  socket.on('claim_souls', ({ playerId, total }) => {
    const p = players.get(playerId);
    if (!p || p.socketId !== socket.id) return;
    if (typeof total !== 'number' || total < 0) return;
    p.souls = Math.floor(total);
    db.updateSoulsAbs.run(p.souls, playerId);
  });

  socket.on('claim_upgrade', ({ playerId, key, newLevel }) => {
    const p = players.get(playerId);
    if (!p || p.socketId !== socket.id) return;
    if (!(key in (p.upgrades || {}))) return;
    if (typeof newLevel !== 'number' || newLevel < 0) return;
    p.upgrades[key] = newLevel;
    db.saveUpgrade.run({
      id: playerId,
      empower_self:   p.upgrades.empower_self,
      empower_allies: p.upgrades.empower_allies,
      reinforce_cap:  p.upgrades.reinforce_cap,
    });
  });

  socket.on('upgrade_purchase', ({ playerId, key }) => {
    const p = players.get(playerId);
    if (!p || p.socketId !== socket.id) return;

    const costs  = { empower_self: 5, empower_allies: 8, reinforce_cap: 10 };
    const scales = { empower_self: 1.6, empower_allies: 1.7, reinforce_cap: 1.5 };
    if (!(key in costs)) return;

    const current = p.upgrades[key] ?? 0;
    const cost = Math.ceil(costs[key] * Math.pow(scales[key], current));
    if (p.souls < cost) return;

    p.souls -= cost;
    p.upgrades[key] = current + 1;

    db.saveUpgrade.run({
      id: playerId,
      empower_self:   p.upgrades.empower_self,
      empower_allies: p.upgrades.empower_allies,
      reinforce_cap:  p.upgrades.reinforce_cap,
    });
    db.updateSoulsAbs.run(p.souls, playerId);

    io.to(ROOM).emit('upgrade_applied', { playerId, key, newLevel: p.upgrades[key], souls: p.souls });
  });

  socket.on('disconnect', () => {
    for (const [pid, p] of players) {
      if (p.socketId !== socket.id) continue;
      // During PvP, a disconnect counts as a forfeit/death so a single
      // abandoned socket can't block the win condition.
      if (round.phase === 'pvp' && p.hp > 0) {
        p.hp = 0;
        killGeneral(p, null);
        break;
      }
      p.connected = false;
      p.socketId = null;
      db.setDisconnected.run(Date.now(), pid);
      db.updatePosition.run(p.pos.x, p.pos.z, Date.now(), pid);
      db.updateSoulsAbs.run(p.souls, pid);
      persistAllies(pid);
      io.to(ROOM).emit('player_left', { playerId: pid });
      console.log(`[io] ${p.name} (${pid.slice(0, 8)}) disconnected`);
      break;
    }
  });
});

// ── Fire handling — relays all fires for visibility; sims PvP for machine_gun ─
function handleFire(socket, { playerId, ammoKey, origin, direction, targetPoint }) {
  const shooter = players.get(playerId);
  if (!shooter || shooter.socketId !== socket.id) return;
  if (!ammoConfig[ammoKey]) return;

  // Broadcast the fire to every other client so they can render a local tracer
  socket.to(ROOM).emit('player_fire_remote', {
    ownerId: playerId,
    ammoKey,
    origin,
    direction,
    targetPoint,
    t: Date.now(),
  });

  // Only machine_gun runs the server PvP collision sim. Conversion + summon
  // are client-local and the server only relays them as visuals.
  if (ammoKey !== 'machine_gun') return;
  spawnProjectile(playerId, ammoKey, origin, direction, targetPoint);
}

function spawnProjectile(ownerId, ammoKey, origin, direction, targetPoint) {
  const cfg = ammoConfig[ammoKey];
  const id = nextProjectileId++;

  // Apply muzzle offset to match client visual spawn
  const dlen3 = Math.hypot(direction.x, direction.y, direction.z) || 1;
  const ndx = direction.x / dlen3;
  const ndy = direction.y / dlen3;
  const ndz = direction.z / dlen3;
  const startX = origin.x + ndx * MUZZLE_OFFSET;
  const startY = origin.y + ndy * MUZZLE_OFFSET;
  const startZ = origin.z + ndz * MUZZLE_OFFSET;

  if (cfg.arc) {
    if (!targetPoint) return;
    projectilesById.set(id, {
      id, ownerId, ammoKey,
      arc: true,
      pos: { x: startX, y: startY, z: startZ },
      startPos: { x: startX, y: startY, z: startZ },
      targetPos: { x: targetPoint.x, y: 0, z: targetPoint.z },
      arcHeight: cfg.arcHeight ?? 0.25,
      flightTime: cfg.flightTime ?? 0.5,
      elapsed: 0,
      alive: true,
    });
  } else {
    projectilesById.set(id, {
      id, ownerId, ammoKey,
      arc: false,
      pos: { x: startX, y: startY, z: startZ },
      startPos: { x: startX, y: startY, z: startZ },
      velocity: { x: ndx * cfg.speed, y: ndy * cfg.speed, z: ndz * cfg.speed },
      maxRange: cfg.maxRange,
      traveled: 0,
      alive: true,
    });
  }
}

function tickProjectiles(dt) {
  for (const proj of projectilesById.values()) {
    if (!proj.alive) continue;
    if (!players.has(proj.ownerId)) { proj.alive = false; continue; }
    stepProjectile(proj, dt);
  }
  for (const [pid, proj] of projectilesById) {
    if (!proj.alive) projectilesById.delete(pid);
  }
}

function stepProjectile(proj, dt) {
  if (proj.arc) {
    proj.elapsed += dt;
    const t = Math.min(proj.elapsed / proj.flightTime, 1);
    const sx = proj.startPos.x;
    const sz = proj.startPos.z;
    const sy = proj.startPos.y;
    const tx = proj.targetPos.x;
    const tz = proj.targetPos.z;
    proj.pos.x = sx + (tx - sx) * t;
    proj.pos.z = sz + (tz - sz) * t;
    const dist = Math.hypot(tx - sx, tz - sz);
    proj.pos.y = sy * (1 - t) + Math.sin(t * Math.PI) * proj.arcHeight * dist;
    if (t >= 1) {
      landSummonBolt(proj);
      proj.alive = false;
    }
    return;
  }

  // Straight projectile — swept collision against the segment p0 → p1
  const p0x = proj.pos.x, p0y = proj.pos.y, p0z = proj.pos.z;
  const dx = proj.velocity.x * dt;
  const dy = proj.velocity.y * dt;
  const dz = proj.velocity.z * dt;
  const stepLen = Math.hypot(dx, dy, dz);

  // Cap step at remaining range
  let usableDt = dt;
  let scale = 1;
  if (proj.traveled + stepLen >= proj.maxRange) {
    scale = (proj.maxRange - proj.traveled) / stepLen;
    usableDt = dt * scale;
  }
  const sdx = dx * scale;
  const sdy = dy * scale;
  const sdz = dz * scale;
  const p1x = p0x + sdx;
  const p1y = p0y + sdy;
  const p1z = p0z + sdz;

  const hit = sweptCollision(proj, p0x, p0y, p0z, p1x, p1y, p1z);
  if (hit) {
    proj.pos.x = p0x + sdx * hit.t;
    proj.pos.y = p0y + sdy * hit.t;
    proj.pos.z = p0z + sdz * hit.t;
    proj.traveled += stepLen * scale * hit.t;
    applyProjectileHit(proj, hit);
    proj.alive = false;
    return;
  }

  proj.pos.x = p1x;
  proj.pos.y = p1y;
  proj.pos.z = p1z;
  wrapPos(proj.pos);
  proj.traveled += stepLen * scale;
  if (proj.traveled >= proj.maxRange) proj.alive = false;
}

// Closest-approach test of moving point (line segment p0→p1) vs upright cylinder
// at center s with radius r and y range [yLow, yHigh] above s.y.
// Returns the smallest t in [0,1] at which the segment first enters the cylinder,
// or null if it doesn't.
function sweptHitT(p0x, p0y, p0z, dx, dy, dz, sx, sz, sFootY, r, yLow, yHigh) {
  // Quadratic in t: |((p0 - s) + d * t)_xz|^2 = r^2
  const ox = p0x - sx;
  const oz = p0z - sz;
  const a = dx * dx + dz * dz;
  if (a < 1e-9) {
    // Stationary segment — just check current XZ distance
    if (ox * ox + oz * oz <= r * r) {
      const yAtP0 = p0y - sFootY;
      if (yAtP0 >= yLow && yAtP0 <= yHigh) return 0;
    }
    return null;
  }
  const b = 2 * (ox * dx + oz * dz);
  const c = ox * ox + oz * oz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  let t = (-b - sq) / (2 * a);
  if (t > 1) return null;
  if (t < 0) {
    // Started inside the XZ cylinder; treat entry as t=0 if y range matches
    t = 0;
  }
  const yAtT = p0y + dy * t - sFootY;
  if (yAtT < yLow || yAtT > yHigh) {
    // Try the exit root in case we entered later
    const t2 = (-b + sq) / (2 * a);
    if (t2 < 0 || t2 > 1) return null;
    const yAtT2 = p0y + dy * t2 - sFootY;
    if (yAtT2 < yLow || yAtT2 > yHigh) return null;
    return t2;
  }
  return t;
}

function sweptCollision(proj, p0x, p0y, p0z, p1x, p1y, p1z) {
  const dx = p1x - p0x;
  const dy = p1y - p0y;
  const dz = p1z - p0z;

  let bestT = Infinity;
  let bestHit = null;

  if (proj.ammoKey === 'machine_gun') {
    for (const p of players.values()) {
      if (p.id === proj.ownerId) continue;
      if (p.hp <= 0) continue;

      // Toroidal closest position of target relative to projectile path
      const { dx: tdx, dz: tdz } = tDelta(p0x, p0z, p.pos.x, p.pos.z);
      const adjX = p0x + tdx;
      const adjZ = p0z + tdz;

      const t = sweptHitT(p0x, p0y, p0z, dx, dy, dz, adjX, adjZ, 0, PLAYER_BODY_RADIUS, PLAYER_BODY_LOW, PLAYER_BODY_HIGH);
      if (t != null && t < bestT) {
        bestT = t;
        bestHit = { kind: 'player', id: p.id, t };
      }
    }
  }

  return bestHit;
}

function applyProjectileHit(proj, hit) {
  const shooter = players.get(proj.ownerId);
  if (!shooter) return;
  if (proj.ammoKey !== 'machine_gun' || hit.kind !== 'player') return;

  // Generals are allied during PvE — no friendly-fire between clients' bodies
  // until the PvP phase begins.
  if (round.phase !== 'pvp') return;

  const baseDamage = 2.0 * (1 + (shooter.upgrades.empower_self ?? 0) * 0.075) * 0.42;
  const target = players.get(hit.id);
  if (!target || target.hp <= 0) return;

  target.hp -= baseDamage;
  if (target.connected) {
    io.to(ROOM).emit('player_damaged', {
      playerId: target.id,
      hp: target.hp,
      amount: baseDamage,
      source: { x: proj.startPos.x, z: proj.startPos.z },
    });
  }
  if (target.hp <= 0) {
    killGeneral(target, proj.ownerId);
  }
}

// Shared kill path for general deaths from any damage source. Removes the
// player from the active pool, broadcasts the death, and checks win condition.
function killGeneral(target, killerId) {
  if (!target || target.hp > 0) return;
  db.setKilled.run(target.id);
  db.deleteAllies.run(target.id);
  target.allies.clear();
  deadThisRound.add(target.id);
  io.to(ROOM).emit('general_died', { playerId: target.id, killedBy: killerId || null });
  players.delete(target.id);
  hostilesByPlayer.delete(target.id);
  if (killerId) {
    const shooter = players.get(killerId);
    if (shooter) {
      shooter.souls += 3;
      db.updateSoulsAbs.run(shooter.souls, killerId);
      io.to(ROOM).emit('souls_granted', { playerId: killerId, amount: 3, total: shooter.souls });
    }
  }
  maybeEndRound();
}

function maybeEndRound() {
  if (round.phase !== 'pvp') return;
  const alive = [...players.values()].filter(p => p.hp > 0);
  if (alive.length <= 1) {
    endRound(alive[0]?.id ?? null);
  }
}

function landSummonBolt(_proj) {
  // Summon bolts are now client-local; this should never be invoked.
}

// ── Tick loop ───────────────────────────────────────────────────────────────
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.1, (now - lastTick) / 1000);
  lastTick = now;

  tickProjectiles(dt);
  tickRound(dt);

  const playerList = [...players.values()].map(serializePlayer);

  io.to(ROOM).emit('state_tick', {
    t: now,
    players: playerList,
    round: serializeRound(),
  });
}, TICK_MS);

function tickRound(dt) {
  if (round.phase === 'ended') {
    if (round.restartAt && Date.now() >= round.restartAt) {
      resetRound();
    }
    return;
  }

  if (round.phase === 'pve') {
    round.fogRadius = computeFogRadius();

    // Condition 1: all clients report zero hostiles for CLEAR_TICKS ticks.
    if (hostilesByPlayer.size > 0 && totalHostiles() === 0) {
      round.clearTicks++;
      if (round.clearTicks >= CLEAR_TICKS) transitionToPvp();
    } else {
      round.clearTicks = 0;
    }

    // Condition 2: fog has fully shrunk AND pveTimeout elapsed — safety
    // valve so a disconnected client's never-reported hostiles can't wedge us.
    const fogAtMin = round.fogRadius <= FOG_MIN + 0.01;
    if (fogAtMin) {
      round.pveOvertime += dt;
      if (round.pveOvertime >= PVE_TIMEOUT) transitionToPvp();
    }
  }

  if (round.phase === 'pvp') {
    // If everyone disconnected / died during PvP, end the round.
    maybeEndRound();
  }
}

// (Hostile spawn is now client-local — server no longer spawns skeletons)

// ── SQLite flush ────────────────────────────────────────────────────────────
setInterval(() => {
  for (const [pid, p] of players) {
    if (!p.connected) continue;
    db.updatePosition.run(p.pos.x, p.pos.z, Date.now(), pid);
  }
}, FLUSH_MS);

// ── Boot ────────────────────────────────────────────────────────────────────
hydrateWorld();
httpServer.listen(PORT, () => {
  console.log(`[server] Necromancer General listening on :${PORT}`);
});
