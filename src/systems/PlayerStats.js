import { GameEvent, events } from './EventSystem.js';
import playerConfig from '../config/player.json';

function derive(formulas, baseStats, stat) {
  const f = formulas[stat];
  const base = f.base;
  const src = baseStats[f.stat] ?? 0;
  return base + src * f.scale;
}

export class PlayerStats {
  constructor() {
    this.config = playerConfig;
    this.baseStats = { ...playerConfig.baseStats };

    this.regenDelay = playerConfig.regenDelay;
    this.sprintMultiplier = playerConfig.sprintMultiplier;
    this.sprintEnergyPerSec = playerConfig.sprintEnergyPerSec;

    this.damageBonus = 0;
    this.maxEnergyBonus = 0;
    this.energyRegenBonus = 0;

    this._recompute();

    this.hp = this.maxHp;
    this.energy = this.maxEnergy;
    this._regenCooldown = 0;
    this._exhaustedEmitted = false;
  }

  _recompute() {
    const f = playerConfig.formulas;
    const b = this.baseStats;
    this.maxHp        = derive(f, b, 'maxHp');
    this.damage       = derive(f, b, 'damage') + this.damageBonus;
    this.moveSpeed    = derive(f, b, 'moveSpeed');
    this.maxEnergy    = derive(f, b, 'maxEnergy') + this.maxEnergyBonus;
    this.energyRegen  = derive(f, b, 'energyRegen') + this.energyRegenBonus;
    this.damageReduction = Math.min(0.75, (b.defense ?? 0) * 0.05);
  }

  update(dt) {
    if (this._regenCooldown > 0) {
      this._regenCooldown = Math.max(0, this._regenCooldown - dt);
      return;
    }
    if (this.energy < this.maxEnergy) {
      const prev = this.energy;
      this.energy = Math.min(this.maxEnergy, this.energy + this.energyRegen * dt);
      if (this.energy !== prev) this._emitEnergy();
      if (this.energy > 0) this._exhaustedEmitted = false;
    }
  }

  canSpendEnergy(amount) {
    return this.energy >= amount;
  }

  spendEnergy(amount) {
    if (!this.canSpendEnergy(amount)) return false;
    this.energy -= amount;
    this._regenCooldown = this.regenDelay;
    this._emitEnergy();
    if (this.energy <= 0 && !this._exhaustedEmitted) {
      this._exhaustedEmitted = true;
      events.emit(GameEvent.ENERGY_EXHAUSTED, {});
    }
    return true;
  }

  _emitEnergy() {
    events.emit(GameEvent.ENERGY_CHANGED, {
      current: this.energy,
      max: this.maxEnergy,
    });
  }

  applyEmpowerSelf() {
    this.maxEnergyBonus += 12;
    this.energyRegenBonus += 3;
    this.damageBonus += 0.15;
    this._recompute();
    this.energy = Math.min(this.maxEnergy, this.energy + 12);
    this._emitEnergy();
  }

  takeDamage(amount) {
    const actual = amount * (1 - this.damageReduction);
    this.hp = Math.max(0, this.hp - actual);
    events.emit(GameEvent.PLAYER_DAMAGED, { amount: actual, hp: this.hp, max: this.maxHp });
    if (this.hp <= 0) events.emit(GameEvent.PLAYER_DIED, {});
    return actual;
  }

  setHp(hp) {
    const prev = this.hp;
    this.hp = Math.max(0, Math.min(this.maxHp, hp));
    events.emit(GameEvent.PLAYER_DAMAGED, { amount: prev - this.hp, hp: this.hp, max: this.maxHp });
    if (this.hp <= 0 && prev > 0) events.emit(GameEvent.PLAYER_DIED, {});
  }
}
