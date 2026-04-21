import * as THREE from 'three';
import { Faction } from './FactionSystem.js';
import monstersConfig from '../config/monsters.json';

// Pre-compute weighted type roster once so spawning is O(log n) per pick.
const _typeEntries = Object.entries(monstersConfig.types).map(
  ([key, cfg]) => ({ key, weight: cfg.spawnWeight ?? 0 }),
);
const _totalWeight = _typeEntries.reduce((s, e) => s + e.weight, 0);

function pickMonsterType() {
  let r = Math.random() * _totalWeight;
  for (const entry of _typeEntries) {
    r -= entry.weight;
    if (r <= 0) return entry.key;
  }
  return monstersConfig.default;
}

function randomPointInZone(zone) {
  const angle = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * zone.radius;
  return new THREE.Vector3(
    zone.center[0] + Math.cos(angle) * r,
    zone.center[1],
    zone.center[2] + Math.sin(angle) * r,
  );
}

export class BattleDirector {
  constructor({ config, skeletons, player, spawnSkeleton, progression = null, roundState = null }) {
    this.config = config;
    this.skeletons = skeletons;
    this.player = player;
    this.spawnSkeleton = spawnSkeleton;
    this.progression = progression;
    // roundState is a live reference updated by main.js on each NET_ROUND_STATE.
    // Used to gate spawn zones by the current fog radius and to freeze spawning
    // once PvE ends.
    this.roundState = roundState;

    this.maxHostiles = config.maxHostiles;
    this.maxAllies = config.maxAllies;
    this.hostileSpawnBatchSize = config.hostileSpawnBatchSize;

    this._hostileSpawnTimer = config.hostileSpawnInterval;
    this._allyReinforceTimer = config.allyReinforcementInterval;
  }

  // Returns zones whose outer edge fits inside the current fog radius. A zone
  // straddling the fog boundary is excluded so enemies don't spawn in the
  // lethal ring. Falls back to the full list if roundState isn't connected yet.
  _zonesInsideFog() {
    if (!this.roundState || typeof this.roundState.fogRadius !== 'number') {
      return this.config.hostileSpawnZones;
    }
    const R = this.roundState.fogRadius;
    return this.config.hostileSpawnZones.filter(z => {
      const dx = z.center[0];
      const dz = z.center[2];
      const distFromOrigin = Math.hypot(dx, dz);
      return distFromOrigin + z.radius <= R;
    });
  }

  _allyOptions() {
    return {
      tier: this.progression ? this.progression.allyTier : 0,
      type: monstersConfig.default,
    };
  }

  seed() {
    for (let i = 0; i < this.config.initialHostileCount; i++) {
      const zone = this.config.hostileSpawnZones[i % this.config.hostileSpawnZones.length];
      this.spawnSkeleton(randomPointInZone(zone), Faction.HOSTILE, { type: pickMonsterType() });
    }
    for (let i = 0; i < this.config.initialAlliedCount; i++) {
      const angle = (i / this.config.initialAlliedCount) * Math.PI * 2;
      const pos = this.player.position.clone();
      pos.x += Math.cos(angle) * 3;
      pos.z += Math.sin(angle) * 3;
      pos.y = 0;
      this.spawnSkeleton(pos, Faction.ALLIED, this._allyOptions());
    }
  }

  counts() {
    let hostiles = 0, allies = 0;
    for (const s of this.skeletons) {
      if (!s.alive) continue;
      if (s.faction === Faction.HOSTILE) hostiles++;
      else allies++;
    }
    return { hostiles, allies };
  }

  update(dt) {
    const { hostiles, allies } = this.counts();

    // Hostile spawning halts once PvP begins — no new monsters in the arena.
    const phase = this.roundState?.phase ?? 'pve';
    this._hostileSpawnTimer -= dt;
    if (this._hostileSpawnTimer <= 0) {
      this._hostileSpawnTimer = this.config.hostileSpawnInterval;
      if (phase === 'pve' && hostiles < this.maxHostiles) {
        const validZones = this._zonesInsideFog();
        if (validZones.length > 0) {
          const zone = validZones[Math.floor(Math.random() * validZones.length)];
          const batch = Math.min(
            this.hostileSpawnBatchSize,
            this.maxHostiles - hostiles,
          );
          for (let i = 0; i < batch; i++) {
            this.spawnSkeleton(randomPointInZone(zone), Faction.HOSTILE, { type: pickMonsterType() });
          }
        }
      }
    }

    this._allyReinforceTimer -= dt;
    if (this._allyReinforceTimer <= 0) {
      this._allyReinforceTimer = this.config.allyReinforcementInterval;
      if (allies < this.config.allyReinforcementThreshold && allies < this.maxAllies) {
        for (let i = 0; i < this.config.allyReinforcementBatchSize; i++) {
          const angle = Math.random() * Math.PI * 2;
          const pos = this.player.position.clone();
          pos.x += Math.cos(angle) * 4;
          pos.z += Math.sin(angle) * 4;
          pos.y = 0;
          this.spawnSkeleton(pos, Faction.ALLIED, this._allyOptions());
        }
      }
    }

    // BATTLE_TICK is authoritative from main.js (which owns localKills and
    // the live scene counts). Emitting a duplicate here raced with that
    // emit and overwrote the HUD with stale values on round restart.
  }
}
