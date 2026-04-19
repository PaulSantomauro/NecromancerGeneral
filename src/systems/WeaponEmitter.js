export class WeaponEmitter {
  constructor({ fireInterval, speed, damageFn, faction, owner, muzzleOffset = 1.2 }) {
    this.fireInterval = fireInterval;
    this.speed        = speed;
    this.damageFn     = damageFn;
    this.faction      = faction;
    this.owner        = owner;
    this.muzzleOffset = muzzleOffset;
    this._cooldown    = 0;
  }
  updateCooldown(dt) {
    this._cooldown = Math.max(0, this._cooldown - dt);
  }
  canFire() { return this._cooldown <= 0; }
  fire(origin, direction) {
    this._cooldown = this.fireInterval;
    return {
      origin: origin.clone().addScaledVector(direction, this.muzzleOffset),
      velocity: direction.clone().multiplyScalar(this.speed),
      damage: this.damageFn(),
      faction: this.faction,
      owner: this.owner,
    };
  }
}
