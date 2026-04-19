export class EntityStats {
  constructor(baseStats) {
    const {
      strength = 1, vitality = 1, agility = 1, defense = 0, endurance = 0,
    } = baseStats;
    this.strength  = strength;
    this.vitality  = vitality;
    this.agility   = agility;
    this.defense   = defense;
    this.endurance = endurance;
    this.maxHp           = vitality;
    this.damage          = strength;
    this.moveSpeed       = agility;
    this.damageReduction = Math.min(0.75, defense * 0.05);
    this.hp              = this.maxHp;
  }
  takeDamage(raw) {
    const actual = Math.max(1, raw * (1 - this.damageReduction));
    this.hp = Math.max(0, this.hp - actual);
    return actual;
  }
  isAlive()   { return this.hp > 0; }
  hpPercent() { return this.hp / this.maxHp; }
}
