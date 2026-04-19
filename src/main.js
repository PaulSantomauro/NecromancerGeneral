import * as THREE from 'three';
import { Battlefield } from './world/Battlefield.js';
import { Player } from './entities/Player.js';
import { Skeleton } from './entities/Skeleton.js';
import { RemoteGeneral } from './entities/RemoteGeneral.js';
import { Faction } from './systems/FactionSystem.js';
import { resolveAllCombat } from './systems/CombatSystem.js';
import { buildAlliedTree } from './systems/BehaviorTree.js';
import { BattleDirector } from './systems/BattleDirector.js';
import { PlayerStats } from './systems/PlayerStats.js';
import { ProgressionSystem } from './systems/ProgressionSystem.js';
import { NetworkSystem } from './systems/NetworkSystem.js';
import { Projectile } from './entities/Projectile.js';
import ammoConfig from './config/ammo.json';
import { HUD } from './ui/HUD.js';
import { SplashScreen } from './ui/SplashScreen.js';
import { GameEvent, events } from './systems/EventSystem.js';
import battleConfig from './config/battle.json';
import { wrapPosition, closestWrap, toroidalDelta } from './systems/Toroid.js';

const WS_URL = import.meta.env?.VITE_WS_URL || 'http://localhost:2567';

// ── Scene bootstrap ───────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const battlefield = new Battlefield(scene);

const camera = new THREE.PerspectiveCamera(
  75, window.innerWidth / window.innerHeight, 0.1, 400,
);
camera.position.set(
  battleConfig.playerSpawnPoint[0],
  1.7,
  battleConfig.playerSpawnPoint[2],
);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ── World state ────────────────────────────────────────────────────────────
const skeletons = [];
const projectiles = [];
const remoteGenerals = new Map();
const remoteAllies = new Map(); // key = `${ownerId}:${localId}`
let localKills = 0;
let nextLocalAllyId = 1;
let myId = null;
let net = null;

const playerStats = new PlayerStats();

const player = new Player({
  camera,
  domElement: renderer.domElement,
  scene,
  projectiles,
  spawnPoint: battleConfig.playerSpawnPoint,
  playerStats,
  progression: null,
});
player.networked = false; // local sim handles damage to local skeletons

// ── Attack-move command ────────────────────────────────────────────────────
// Right-click fires a ray from the camera's forward direction and steps it
// forward until it dips below the terrain; the intersection point becomes an
// attack-move target for every local ally. Allies run the engage/arrive
// logic in BehaviorTree.js; their position broadcasts as usual so remote
// clients see them move without any new network traffic.
const ATTACK_MOVE_STEP = 0.5;
const ATTACK_MOVE_MAX_DIST = 200;

function raycastToTerrain() {
  const origin = new THREE.Vector3();
  camera.getWorldPosition(origin);
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir).normalize();

  // If aiming upward, there's no terrain ahead — bail.
  if (dir.y > -0.001) return null;

  const p = origin.clone();
  const step = dir.clone().multiplyScalar(ATTACK_MOVE_STEP);
  let prevAbove = p.y - battlefield.getTerrainHeight(p.x, p.z);
  let travelled = 0;

  while (travelled < ATTACK_MOVE_MAX_DIST) {
    p.add(step);
    travelled += ATTACK_MOVE_STEP;
    const gy = battlefield.getTerrainHeight(p.x, p.z);
    const above = p.y - gy;
    if (above <= 0) {
      // Linear-interpolate back between prev (above) and current (below) for accuracy.
      const k = prevAbove / (prevAbove - above);
      const hitX = p.x - step.x * (1 - k);
      const hitZ = p.z - step.z * (1 - k);
      return { x: hitX, z: hitZ, y: battlefield.getTerrainHeight(hitX, hitZ) };
    }
    prevAbove = above;
  }
  return null;
}

// Simple fading ring marker at the commanded point.
const attackMoveMarkerGeom = new THREE.RingGeometry(0.6, 1.1, 32);
const attackMoveMarkerMat = new THREE.MeshBasicMaterial({
  color: 0xff4040, transparent: true, opacity: 0, side: THREE.DoubleSide,
  depthWrite: false,
});
const attackMoveMarker = new THREE.Mesh(attackMoveMarkerGeom, attackMoveMarkerMat);
attackMoveMarker.rotation.x = -Math.PI / 2;
attackMoveMarker.visible = false;
scene.add(attackMoveMarker);
let attackMoveMarkerTimer = 0;

function issueAttackMove(point) {
  let count = 0;
  for (const sk of skeletons) {
    if (!sk.alive) continue;
    if (sk.ownerId !== myId) continue;
    if (!sk.behaviorTree) continue; // remote-mirrored allies are position-only
    sk._attackMoveTarget = new THREE.Vector3(point.x, 0, point.z);
    sk._guardPoint = null;
    count++;
  }
  if (count > 0) {
    attackMoveMarker.position.set(point.x, point.y + 0.05, point.z);
    attackMoveMarker.visible = true;
    attackMoveMarkerTimer = 1.2;
  }
}

renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
renderer.domElement.addEventListener('mousedown', (e) => {
  if (e.button !== 2) return;
  if (!player.controls.isLocked) return;
  e.preventDefault();
  const hit = raycastToTerrain();
  if (hit) issueAttackMove(hit);
});

function spawnSkeletonLocal(position, faction, options = {}) {
  const sk = new Skeleton(position, faction, options);
  if (faction === Faction.ALLIED && !sk.ownerId) {
    sk.ownerId = myId;
    sk.localId = nextLocalAllyId++;
    sk.friendly = true;
    if (net) {
      net.sendAllySpawned({
        localId: sk.localId,
        x: sk.position.x,
        z: sk.position.z,
        tier: options.tier ?? 0,
        type: sk.type,
        maxHp: sk.stats.maxHp,
      });
    }
  }
  skeletons.push(sk);
  scene.add(sk.mesh);
  return sk;
}

// ── Round state (mirrored from server each state_tick) ────────────────────
// Mutated in place so BattleDirector and combat paths see updated values
// without re-subscribing. `fogRadius` starts at the configured max so
// pre-server-connection spawning still obeys the fog rule.
const roundState = {
  phase: 'pve',
  fogRadius: battleConfig.round?.fogStartRadius ?? 95,
  fogStartRadius: battleConfig.round?.fogStartRadius ?? 95,
  fogMinRadius: battleConfig.round?.fogMinRadius ?? 10,
  fogShrinkSecs: battleConfig.round?.fogShrinkSeconds ?? 300,
  startedAt: Date.now(),
  pvpStartedAt: 0,
  winnerId: null,
  aliveGenerals: 1,
  ended: false,
};

const battleDirector = new BattleDirector({
  config: battleConfig,
  skeletons,
  player,
  spawnSkeleton: spawnSkeletonLocal,
  roundState,
});

const progression = new ProgressionSystem({ playerStats, battleDirector });
battleDirector.progression = progression;
player.progression = progression;

const hud = new HUD({ playerStats, progression, roundState });

// Hide lock prompt until welcome/restore
const lockPrompt = document.getElementById('lock-prompt');
lockPrompt.classList.add('hidden');
lockPrompt.addEventListener('click', () => player.controls.lock());
player.controls.addEventListener('lock',   () => hud.showLockPrompt(false));
player.controls.addEventListener('unlock', () => hud.showLockPrompt(true));

events.emit(GameEvent.AMMO_CHANGED, { key: 'machine_gun', name: 'Machine Gun' });

// ── Helpers ────────────────────────────────────────────────────────────────
function reconcileRemotes({ worldPlayers }) {
  const t0 = Date.now();
  for (const p of worldPlayers) {
    if (remoteGenerals.has(p.id)) continue;
    const rg = new RemoteGeneral(p);
    rg.setTarget(p.pos.x, p.pos.z, t0, p.yaw);
    remoteGenerals.set(p.id, rg);
    scene.add(rg.mesh);
  }
}

function spawnRemoteAlly(ownerId, localId, x, z, tier, maxHp, type) {
  const key = `${ownerId}:${localId}`;
  if (remoteAllies.has(key)) return remoteAllies.get(key);
  const pos = new THREE.Vector3(x, 0, z);
  const sk = new Skeleton(pos, Faction.ALLIED, { tier, type });
  sk.behaviorTree = null;
  sk.ownerId = ownerId;
  sk.localId = localId;
  sk.friendly = false; // not mine — valid target
  if (typeof maxHp === 'number') {
    sk.stats.maxHp = maxHp;
    sk.stats.hp = maxHp;
  }
  sk.setServerPosition(x, z, Date.now());
  skeletons.push(sk);
  scene.add(sk.mesh);
  remoteAllies.set(key, sk);
  return sk;
}

events.subscribe(GameEvent.MINION_SPAWNED, ({ position, type }) => {
  const sk = spawnSkeletonLocal(position, Faction.ALLIED, {
    tier: progression.allyTier,
    type,
  });
  sk.beginErupt();
});

// When a hostile gets converted, it becomes mine — assign id and broadcast
events.subscribe(GameEvent.ENEMY_CONVERTED, ({ skeleton }) => {
  if (!skeleton || skeleton.ownerId) return;
  skeleton.ownerId = myId;
  skeleton.localId = nextLocalAllyId++;
  skeleton.friendly = true;
  if (net) {
    net.sendAllySpawned({
      localId: skeleton.localId,
      x: skeleton.position.x,
      z: skeleton.position.z,
      tier: skeleton.tier,
      type: skeleton.type,
      maxHp: skeleton.stats.maxHp,
    });
  }
});

// Local kill counter — every hostile death I caused (or any local hostile death) ticks it
events.subscribe(GameEvent.ENEMY_DIED, ({ skeleton }) => {
  if (!skeleton) return;
  if (skeleton.faction === Faction.HOSTILE) localKills++;
});

// On any allied death, broadcast ally_died (works for both my own and remote)
events.subscribe(GameEvent.ENEMY_DIED, ({ skeleton }) => {
  if (!skeleton || !net || skeleton.localId == null) return;
  if (skeleton.faction !== Faction.ALLIED) return;
  net.sendAllyDied(skeleton.ownerId ?? myId, skeleton.localId);

  // Cleanup remoteAllies map if it was a remote one
  if (skeleton.ownerId && skeleton.ownerId !== myId) {
    remoteAllies.delete(`${skeleton.ownerId}:${skeleton.localId}`);
  }
});

// ── Splash → network boot ──────────────────────────────────────────────────
function onServerReady(data) {
  reconcileRemotes(data);
  progression._overrideSouls(data.player.souls);
  progression._overrideUpgrades(data.player.upgrades);

  // Reposition player to server-stored location BEFORE seeding allies
  if (data.player.pos) {
    player.position.set(data.player.pos.x, 0, data.player.pos.z);
    player.controls.getObject().position.set(data.player.pos.x, 1.7, data.player.pos.z);
  }

  if (!battleDirector._seeded) {
    // Restore persisted allies or seed fresh ones
    if (data.allies && data.allies.length > 0) {
      for (const a of data.allies) {
        const pos = new THREE.Vector3(a.x, 0, a.z);
        const sk = spawnSkeletonLocal(pos, Faction.ALLIED, {
          tier: a.tier ?? 0,
          type: a.type,
        });
        if (typeof a.hp === 'number') {
          sk.stats.hp = Math.min(a.hp, sk.stats.maxHp);
        }
      }
    } else {
      battleDirector.seed();
    }
    battleDirector._seeded = true;
  }

  hud.showLockPrompt(true);

  // Broadcast our allies so other connected players can see them
  setTimeout(() => broadcastAllyState(), 100);
}

new SplashScreen(({ id, name }) => {
  myId = id;
  hud.setMyId(id);

  net = new NetworkSystem({
    serverUrl: WS_URL,
    playerId: id,
    name,
    onWelcome: onServerReady,
    onRestore: onServerReady,
  });
});

// ── Input → network forwarding ─────────────────────────────────────────────
events.subscribe(GameEvent.PLAYER_FIRED, (payload) => {
  if (!net) return;
  net.sendFire(payload.ammoKey, payload.origin, payload.direction, payload.targetPoint);
});

events.subscribe(GameEvent.UPGRADE_PURCHASED, (payload) => {
  if (!net || !payload.key || payload.key === '_restore') return;
  net.sendClaimUpgrade(payload.key, payload.newLevel);
});

events.subscribe(GameEvent.SOULS_CHANGED, ({ total }) => {
  if (!net || total == null) return;
  net.sendClaimSouls(total);
});

// ── Net event handlers ─────────────────────────────────────────────────────
events.subscribe(GameEvent.NET_STATE_TICK, ({ players: serverPlayers, round: serverRound }) => {
  if (serverRound) {
    const wasEnded = roundState.phase === 'ended';
    roundState.phase = serverRound.phase;
    roundState.fogRadius = serverRound.fogRadius;
    roundState.fogStartRadius = serverRound.fogStartRadius;
    roundState.fogMinRadius = serverRound.fogMinRadius;
    roundState.fogShrinkSecs = serverRound.fogShrinkSecs;
    roundState.startedAt = serverRound.startedAt;
    roundState.pvpStartedAt = serverRound.pvpStartedAt;
    roundState.winnerId = serverRound.winnerId;
    roundState.aliveGenerals = serverRound.aliveGenerals;
    if (!wasEnded && roundState.phase === 'ended') {
      events.emit(GameEvent.NET_ROUND_ENDED, { winnerId: serverRound.winnerId });
    }
    battlefield.setFogRadius(roundState.fogRadius);
  }
  if (!serverPlayers) return;

  let activePlayers = 0;
  for (const sp of serverPlayers) if (sp.connected !== false) activePlayers++;

  // HP is client-authoritative (trust-client model). Server's `hp` field is
  // advisory only and can diverge; we deliberately don't overwrite local HP
  // from state_tick because local hostile damage never reaches the server.

  for (const sp of serverPlayers) {
    if (sp.id === myId) continue;
    let rg = remoteGenerals.get(sp.id);
    if (!rg) {
      rg = new RemoteGeneral(sp);
      remoteGenerals.set(sp.id, rg);
      scene.add(rg.mesh);
    }
    rg.setTarget(sp.pos.x, sp.pos.z, Date.now(), sp.yaw);
    rg.setConnected(sp.connected);
    if (sp.hp != null && sp.maxHp != null) rg.setHp(sp.hp, sp.maxHp);
  }

  // Drop remote generals that vanished from state
  const seen = new Set(serverPlayers.map(p => p.id));
  for (const [id, rg] of remoteGenerals) {
    if (!seen.has(id)) {
      scene.remove(rg.mesh);
      remoteGenerals.delete(id);
    }
  }
});

events.subscribe(GameEvent.NET_GENERAL_DIED, ({ playerId, killedBy }) => {
  const rg = remoteGenerals.get(playerId);
  if (rg) {
    scene.remove(rg.mesh);
    remoteGenerals.delete(playerId);
  }
  // Drop any remote allies belonging to that player
  for (const [key, sk] of remoteAllies) {
    if (sk.ownerId === playerId) {
      sk.die();
      remoteAllies.delete(key);
    }
  }
  if (killedBy && killedBy === myId) localKills++;
});

events.subscribe(GameEvent.NET_PLAYER_JOINED, ({ player: p }) => {
  if (p.id === myId) return;
  if (!remoteGenerals.has(p.id)) {
    const rg = new RemoteGeneral(p);
    rg.setTarget(p.pos.x, p.pos.z, Date.now(), p.yaw);
    remoteGenerals.set(p.id, rg);
    scene.add(rg.mesh);
  }

  // Reconnecting player — kill our local orphaned copies of their allies.
  // They'll be replaced by the player's own restored + broadcast allies.
  for (let i = skeletons.length - 1; i >= 0; i--) {
    const sk = skeletons[i];
    if (sk._orphaned && sk.ownerId === p.id && sk.alive) {
      sk.die();
    }
  }

  // Re-broadcast our allies so the newcomer sees them
  broadcastAllyState();
  for (const sk of skeletons) {
    if (!sk.alive || sk.ownerId !== myId || sk.localId == null) continue;
    if (net) {
      net.sendAllySpawned({
        localId: sk.localId,
        x: sk.position.x,
        z: sk.position.z,
        tier: sk.tier,
        type: sk.type,
        maxHp: sk.stats.maxHp,
      });
    }
  }
});

events.subscribe(GameEvent.NET_PLAYER_LEFT, ({ playerId }) => {
  const rg = remoteGenerals.get(playerId);
  if (rg) rg.setConnected(false);

  // Convert orphaned remote allies into locally-simulated guard NPCs.
  // Keep ownerId so we can clean them up when the player reconnects.
  for (const [key, sk] of remoteAllies) {
    if (sk.ownerId !== playerId) continue;
    sk._guardPoint = { position: sk.position.clone() };
    sk._snaps = [];
    sk._snapVx = 0;
    sk._snapVz = 0;
    sk.behaviorTree = buildAlliedTree();
    sk.friendly = false;
    sk._orphaned = true;
    remoteAllies.delete(key);
  }
});

// Local death — fires the first time the player's HP hits zero from any
// source (server PvP damage, local fog, future local hostile melee).
// Disables controls, pops the pointer lock, and informs the server so the
// round state machine can update the alive count.
let _playerDeathReported = false;
events.subscribe(GameEvent.PLAYER_DIED, () => {
  if (_playerDeathReported) return;
  _playerDeathReported = true;
  player.alive = false;
  if (player.controls.isLocked) player.controls.unlock();
  if (net) net.sendPlayerDied(null);
});

events.subscribe(GameEvent.NET_PLAYER_DAMAGED, ({ playerId, amount, source }) => {
  if (playerId !== myId) return;
  // Subtract locally — HP is client-authoritative. Route through player.takeDamage
  // so the directional indicator + damage flash fire the same way as local hits.
  const sourceObj = (source && typeof source.x === 'number' && typeof source.z === 'number')
    ? { position: { x: source.x, z: source.z } }
    : null;
  player.takeDamage(amount, sourceObj);
});

events.subscribe(GameEvent.NET_PLAYER_FIRED_REMOTE, ({ ownerId, ammoKey, origin, direction, targetPoint, t }) => {
  if (ownerId === myId) return;
  const cfg = ammoConfig[ammoKey];
  if (!cfg) return;

  // Dead-reckon the bullet forward by the network latency so it appears
  // near the shooter's muzzle rather than delayed.
  let forwardOffset = 0;
  if (!cfg.arc && t) {
    const latency = Math.max(0, (Date.now() - t) / 1000);
    forwardOffset = latency * cfg.speed;
  }

  const dlen = Math.hypot(direction.x, direction.y, direction.z) || 1;
  const nx = direction.x / dlen;
  const ny = direction.y / dlen;
  const nz = direction.z / dlen;

  const originVec = new THREE.Vector3(
    origin.x + nx * forwardOffset,
    origin.y + ny * forwardOffset,
    origin.z + nz * forwardOffset,
  );
  const dirVec = new THREE.Vector3(nx, ny, nz);
  const velocityVec = dirVec.clone().multiplyScalar(cfg.speed);
  const targetVec = targetPoint
    ? new THREE.Vector3(targetPoint.x, 0, targetPoint.z)
    : null;

  const proj = new Projectile({
    origin: originVec,
    velocity: velocityVec,
    damage: 0,
    faction: 'player',
    color: cfg.color,
    radius: cfg.radius,
    maxRange: cfg.maxRange,
    arc: cfg.arc,
    arcHeight: cfg.arcHeight,
    flightTime: cfg.flightTime,
    ammoKey,
    targetPoint: targetVec,
    networked: true, // server authoritative — local sim is visual only
  });
  proj.remoteOwnerId = ownerId;
  projectiles.push(proj);
  scene.add(proj.mesh);
});

// ── Ally networking ────────────────────────────────────────────────────────
events.subscribe(GameEvent.NET_ALLY_SPAWNED, ({ ownerId, localId, x, z, tier, maxHp, type }) => {
  if (ownerId === myId) return;
  spawnRemoteAlly(ownerId, localId, x, z, tier ?? 0, maxHp, type);
});

events.subscribe(GameEvent.NET_ALLY_STATE, ({ ownerId, t, allies }) => {
  if (ownerId === myId || !allies) return;
  for (const a of allies) {
    const key = `${ownerId}:${a.localId}`;
    let sk = remoteAllies.get(key);
    if (!sk) {
      // Fallback spawn — ally_state doesn't carry type; remote will re-broadcast
      // ally_spawned shortly so default is fine.
      sk = spawnRemoteAlly(ownerId, a.localId, a.x, a.z, 0, undefined, undefined);
    }
    sk.setServerPosition(a.x, a.z, t || Date.now());
  }
});

events.subscribe(GameEvent.NET_ALLY_DIED, ({ ownerId, localId }) => {
  const key = `${ownerId}:${localId}`;
  const sk = remoteAllies.get(key);
  if (sk && sk.alive) {
    sk.die();
    remoteAllies.delete(key);
    return;
  }
  // It might be one of MY allies that someone else killed
  if (ownerId === myId) {
    for (const s of skeletons) {
      if (s.ownerId === myId && s.localId === localId && s.alive) {
        s.die();
        return;
      }
    }
  }
});

function broadcastAllyState() {
  if (!net) return;
  const myAllies = [];
  for (const sk of skeletons) {
    if (!sk.alive) continue;
    if (sk.ownerId !== myId || sk.localId == null) continue;
    myAllies.push({
      localId: sk.localId,
      x: sk.position.x,
      z: sk.position.z,
    });
  }
  if (myAllies.length === 0) return;
  net.sendAllyState(myAllies, Date.now());
}

// ── Frame loop ─────────────────────────────────────────────────────────────
let last = performance.now();
let netSendTimer = 0;
let allyStateTimer = 0;
let battleTickTimer = 0;
let hostileCountTimer = 0;

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  playerStats.update(dt);

  // Apply terrain height to the camera BEFORE player.update runs, so that
  // bullets fired inside _tryFire() spawn at the correct head-height y
  // instead of the flat-ground default.
  {
    const camObj = player.controls.getObject();
    const gy = battlefield.getTerrainHeight(player.position.x, player.position.z);
    camObj.position.y = gy + 1.7;
    player.position.y = gy;
  }

  player.update(dt);
  player.tickEmitters(dt);

  if (net && player.controls.isLocked) {
    netSendTimer += dt;
    if (netSendTimer >= 0.05) {
      netSendTimer = 0;
      net.sendMove(player.position, player.controls.getObject().rotation.y);
    }

    allyStateTimer += dt;
    if (allyStateTimer >= 0.05) {
      allyStateTimer = 0;
      broadcastAllyState();
    }

    hostileCountTimer += dt;
    if (hostileCountTimer >= 1.0) {
      hostileCountTimer = 0;
      let hc = 0;
      for (const s of skeletons) {
        if (s.alive && s.faction === Faction.HOSTILE) hc++;
      }
      net.sendHostileCount(hc);
    }
  }

  for (const p of projectiles) p.update(dt);

  // Build targeting lists for AI.
  // ctx.hostiles = what allied AI attacks (hostiles + non-friendly allies = remote/orphaned)
  // ctx.allies   = what hostile AI attacks (all ALLIED skeletons)
  const alliedTargets = []; // for my allies to attack
  const hostileTargets = []; // for hostiles to attack
  for (const s of skeletons) {
    if (!s.alive) continue;
    if (!s.friendly) alliedTargets.push(s); // hostiles + remote allies + orphaned
    if (s.faction === Faction.ALLIED) hostileTargets.push(s); // any ally is fair game for hostiles
  }
  const ctx = { player, hostiles: alliedTargets, allies: hostileTargets, attackRange: 2.5 };

  for (const s of skeletons) s.update(dt, ctx);

  for (const rg of remoteGenerals.values()) rg.update(dt);

  // Wrap player position on the torus
  wrapPosition(player.position);
  const camObj = player.controls.getObject();
  camObj.position.x = player.position.x;
  camObj.position.z = player.position.z;

  // Terrain height
  const playerGroundY = battlefield.getTerrainHeight(player.position.x, player.position.z);
  camObj.position.y = playerGroundY + 1.7;
  player.position.y = playerGroundY;

  const camX = camObj.position.x;
  const camZ = camObj.position.z;

  // Skeletons: terrain height + toroidal render position
  for (const s of skeletons) {
    if (!s.alive) continue;
    const gy = battlefield.getTerrainHeight(s.position.x, s.position.z);
    s.position.y = gy;
    s.mesh.position.x = closestWrap(s.position.x, camX);
    s.mesh.position.y = gy;
    s.mesh.position.z = closestWrap(s.position.z, camZ);
  }

  // Remote generals: toroidal render position
  for (const rg of remoteGenerals.values()) {
    const gy = battlefield.getTerrainHeight(rg.position.x, rg.position.z);
    rg.mesh.position.x = closestWrap(rg.position.x, camX);
    rg.mesh.position.y = gy;
    rg.mesh.position.z = closestWrap(rg.position.z, camZ);
  }

  resolveAllCombat(skeletons, projectiles, player, dt, false, roundState.phase);

  // Fog damage — anything more than fogRadius from world origin takes
  // `fogDamagePerSec` hp/sec. Applied locally: remote allies are handled
  // on their owning client (behaviorTree=null is our proxy for remote-owned).
  if (roundState.phase !== 'ended') {
    const fogR = roundState.fogRadius;
    const dps = battleConfig.round?.fogDamagePerSec ?? 3;
    if (player.alive) {
      const pd = Math.hypot(player.position.x, player.position.z);
      if (pd > fogR) player.stats.takeDamage(dps * dt);
    }
    for (const s of skeletons) {
      if (!s.alive || !s.behaviorTree) continue;
      const sd = Math.hypot(s.position.x, s.position.z);
      if (sd > fogR) s.takeDamage(dps * dt);
    }
  }

  if (battleDirector && myId) battleDirector.update(dt);

  battleTickTimer += dt;
  if (battleTickTimer >= 0.1) {
    battleTickTimer = 0;
    let hostileCount = 0, allyCount = 0;
    for (const s of skeletons) {
      if (!s.alive) continue;
      if (s.faction === Faction.HOSTILE) hostileCount++;
      else allyCount++;
    }
    events.emit(GameEvent.BATTLE_TICK, {
      hostiles: hostileCount,
      allies: allyCount,
      killed: localKills,
    });
  }

  // Visual: stop bullets passing through other players' bodies (server resolves the damage).
  // Only blocks during PvP — during PvE generals are allied and their bodies are pass-through.
  const bulletBlockGenerals = roundState.phase === 'pvp';
  for (const proj of projectiles) {
    if (!proj.alive || proj.arc) continue;
    // Render projectile at toroidal closest position
    proj.mesh.position.x = closestWrap(proj.position.x, camX);
    proj.mesh.position.z = closestWrap(proj.position.z, camZ);

    if (!bulletBlockGenerals) continue;
    for (const rg of remoteGenerals.values()) {
      const { dx, dz } = toroidalDelta(rg.position.x, rg.position.z, proj.position.x, proj.position.z);
      if (dx * dx + dz * dz > 0.85 * 0.85) continue;
      const dy = proj.position.y;
      if (dy < -0.2 || dy > 1.9) continue;
      proj.alive = false;
      events.emit(GameEvent.PROJECTILE_HIT, { projectile: proj, target: rg });
      break;
    }
  }

  hud.tickRound();

  if (attackMoveMarkerTimer > 0) {
    attackMoveMarkerTimer -= dt;
    const k = Math.max(0, attackMoveMarkerTimer / 1.2);
    attackMoveMarkerMat.opacity = k * 0.85;
    const pulse = 1 + (1 - k) * 0.4;
    attackMoveMarker.scale.setScalar(pulse);
    if (attackMoveMarkerTimer <= 0) attackMoveMarker.visible = false;
  }

  battlefield.update(dt, player.position);

  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    if (!p.alive) {
      if (p.mesh) scene.remove(p.mesh);
      p.dispose();
      projectiles.splice(i, 1);
    }
  }
  for (let i = skeletons.length - 1; i >= 0; i--) {
    const s = skeletons[i];
    if (s.isRemovable()) {
      scene.remove(s.mesh);
      skeletons.splice(i, 1);
    }
  }

  renderer.render(scene, camera);
}
animate();
