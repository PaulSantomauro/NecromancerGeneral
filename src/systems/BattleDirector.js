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
  constructor({ config, skeletons, player, spawnSkeleton, progression = null, roundState = null, zoneCapture = null }) {
    this.config = config;
    this.skeletons = skeletons;
    this.player = player;
    this.spawnSkeleton = spawnSkeleton;
    this.progression = progression;
    // roundState is a live reference updated by main.js on each NET_STATE_TICK.
    // Used to gate spawn zones by the current fog radius and to freeze spawning
    // once PvE ends.
    this.roundState = roundState;
    // ZoneCaptureSystem reference — used to filter captured zones out of
    // the spawn pool. Each client maintains its own capturedZones set but
    // keeps it in sync with everyone else's via NET_ZONE_CAPTURED broadcasts,
    // so two players watching the same zone see it stop spawning together.
    this.zoneCapture = zoneCapture;

    this.maxHostiles = config.maxHostiles;
    this.maxAllies = config.maxAllies;
    this.hostileSpawnBatchSize = config.hostileSpawnBatchSize;

    this._hostileSpawnTimer = config.hostileSpawnInterval;
    this._allyReinforceTimer = config.allyReinforcementInterval;
  }

  // Returns zones whose outer edge fits inside the current fog radius AND
  // that have not been captured. A zone straddling the fog boundary is
  // excluded so enemies don't spawn in the lethal ring; captured zones are
  // excluded because capturing them is supposed to make the horde stop
  // coming from that direction for the rest of the round.
  _zonesInsideFog() {
    const all = this.config.hostileSpawnZones;
    const R = (this.roundState && typeof this.roundState.fogRadius === 'number')
      ? this.roundState.fogRadius
      : Infinity;
    const zc = this.zoneCapture;
    const result = [];
    for (let i = 0; i < all.length; i++) {
      if (zc && zc.isCaptured(i)) continue;
      const z = all[i];
      const distFromOrigin = Math.hypot(z.center[0], z.center[2]);
      if (distFromOrigin + z.radius > R) continue;
      result.push(z);
    }
    return result;
  }

  _allyOptions() {
    return {
      tier: this.progression ? this.progression.allyTier : 0,
      type: monstersConfig.default,
    };
  }

  seed() {
    // Filter the initial-spawn pool the same way `_zonesInsideFog` does so
    // a mid-round joiner's fresh BattleDirector doesn't seed hostiles into
    // zones other players have already captured.
    const zc = this.zoneCapture;
    const allZones = this.config.hostileSpawnZones;
    const activeZones = [];
    for (let i = 0; i < allZones.length; i++) {
      if (zc && zc.isCaptured(i)) continue;
      activeZones.push(allZones[i]);
    }
    const pool = activeZones.length > 0 ? activeZones : allZones;
    for (let i = 0; i < this.config.initialHostileCount; i++) {
      const zone = pool[i % pool.length];
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
      // Match the hostile-spawn gate: no free reinforcements once PvP starts.
      // The last-standing phase is supposed to be decided by what's on the
      // field at the transition, not by passive ally top-ups.
      if (phase === 'pve'
          && allies < this.config.allyReinforcementThreshold
          && allies < this.maxAllies) {
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
