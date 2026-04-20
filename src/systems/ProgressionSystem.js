import { GameEvent, events } from './EventSystem.js';
import { Faction } from './FactionSystem.js';
import playerConfig from '../config/player.json';

const UPGRADE_META = {
  empower_self: {
    key: 'empower_self',
    hotkey: 'Q',
    label: 'Empower Self',
  },
  empower_allies: {
    key: 'empower_allies',
    hotkey: 'E',
    label: 'Empower Allies',
  },
  reinforce_cap: {
    key: 'reinforce_cap',
    hotkey: 'R',
    label: 'Reinforce Cap',
  },
};

export class ProgressionSystem {
  constructor({ playerStats, battleDirector }) {
    this.playerStats = playerStats;
    this.battleDirector = battleDirector;
    this.config = playerConfig.upgrades;

    this.souls = 0;
    this.levels = {
      empower_self: 0,
      empower_allies: 0,
      reinforce_cap: 0,
    };
    this.allyTier = 0;
    this.networked = false;

    events.subscribe(GameEvent.ENEMY_DIED, ({ skeleton }) => {
      if (this.networked) return;
      if (skeleton && skeleton.faction === Faction.HOSTILE) {
        // Bounty scales per-type via `soulValue` on the Skeleton (see
        // monsters.json): skeleton/runner 1 → stalker 2 → brute 4 → giant 8.
        this._grantSouls(skeleton.soulValue ?? 1);
      }
    });
  }

  setNetworked(flag) {
    this.networked = flag;
  }

  _grantSoulsFromServer(amount, total) {
    if (total != null) {
      this.souls = total;
    } else {
      this.souls += amount;
    }
    events.emit(GameEvent.SOULS_CHANGED, { total: this.souls, delta: amount });
  }

  _overrideSouls(amount) {
    this.souls = amount;
    events.emit(GameEvent.SOULS_CHANGED, { total: this.souls, delta: 0 });
  }

  // Called from the round-restart path before the client rejoins. Returns
  // the system to a known baseline so the following restore_state → delta
  // apply starts from zero.
  resetForNewRound() {
    this.levels.empower_self = 0;
    this.levels.empower_allies = 0;
    this.levels.reinforce_cap = 0;
    this.allyTier = 0;
    this.souls = 0;
    if (this.battleDirector && this.battleDirector.config) {
      this.battleDirector.maxAllies = this.battleDirector.config.maxAllies;
      this.battleDirector.hostileSpawnBatchSize = this.battleDirector.config.hostileSpawnBatchSize;
    }
    events.emit(GameEvent.SOULS_CHANGED, { total: 0, delta: 0 });
    events.emit(GameEvent.UPGRADE_PURCHASED, { key: '_restore', newLevel: 0 });
  }

  _overrideUpgrades(upgrades) {
    // Apply only the delta from the previously-known levels so this is
    // idempotent across re-joins (e.g. when a round auto-restarts, the
    // server sends the same levels a second time and we must not re-stack).
    const prev = { ...this.levels };
    this.levels.empower_self   = upgrades.empower_self   ?? 0;
    this.levels.empower_allies = upgrades.empower_allies ?? 0;
    this.levels.reinforce_cap  = upgrades.reinforce_cap  ?? 0;

    const deltaSelf = Math.max(0, this.levels.empower_self  - prev.empower_self);
    const deltaCap  = Math.max(0, this.levels.reinforce_cap - prev.reinforce_cap);

    for (let i = 0; i < deltaSelf; i++) this.playerStats.applyEmpowerSelf();
    this.allyTier = this.levels.empower_allies;
    if (this.battleDirector) {
      for (let i = 0; i < deltaCap; i++) {
        this.battleDirector.maxAllies += 3;
        this.battleDirector.hostileSpawnBatchSize += 1;
      }
    }

    events.emit(GameEvent.UPGRADE_PURCHASED, { key: '_restore', newLevel: 0 });
  }

  applyServerUpgrade(key, newLevel) {
    const prev = this.levels[key] ?? 0;
    if (newLevel <= prev) return;
    const toApply = newLevel - prev;
    this.levels[key] = newLevel;

    for (let i = 0; i < toApply; i++) this._applyEffect(key);

    events.emit(GameEvent.UPGRADE_PURCHASED, { key, newLevel });
  }

  _grantSouls(n) {
    this.souls += n;
    events.emit(GameEvent.SOULS_CHANGED, { total: this.souls, delta: n });
  }

  canAffordSouls(n) {
    return this.souls >= n;
  }

  spendSouls(n) {
    if (this.souls < n) return false;
    this.souls -= n;
    events.emit(GameEvent.SOULS_CHANGED, { total: this.souls, delta: -n });
    return true;
  }

  getLevel(key) { return this.levels[key] ?? 0; }

  getCost(key) {
    const cfg = this.config[key];
    const lvl = this.getLevel(key);
    return Math.ceil(cfg.baseCost * Math.pow(cfg.scale, lvl));
  }

  getMeta(key) { return UPGRADE_META[key]; }

  canAfford(key) {
    return this.souls >= this.getCost(key);
  }

  purchase(key) {
    if (!this.config[key]) return false;
    const cost = this.getCost(key);
    if (this.souls < cost) return false;
    if (this.networked) {
      // Server is authoritative — fire request event only; wait for upgrade_applied broadcast
      events.emit(GameEvent.UPGRADE_PURCHASED, { key, newLevel: this.levels[key], _request: true });
      return true;
    }
    this.souls -= cost;
    this.levels[key] += 1;
    this._applyEffect(key);
    events.emit(GameEvent.UPGRADE_PURCHASED, { key, newLevel: this.levels[key] });
    events.emit(GameEvent.SOULS_CHANGED, { total: this.souls, delta: -cost });
    return true;
  }

  _applyEffect(key) {
    switch (key) {
      case 'empower_self':
        this.playerStats.applyEmpowerSelf();
        break;
      case 'empower_allies':
        this.allyTier += 1;
        break;
      case 'reinforce_cap':
        if (this.battleDirector) {
          this.battleDirector.maxAllies += 3;
          this.battleDirector.hostileSpawnBatchSize += 1;
        }
        break;
    }
  }

  totalLevel() {
    return this.levels.empower_self + this.levels.empower_allies + this.levels.reinforce_cap;
  }
}
