import * as THREE from 'three';
import { EntityStats } from '../systems/EntityStats.js';
import { Faction } from '../systems/FactionSystem.js';
import { buildHostileTree, buildAlliedTree } from '../systems/BehaviorTree.js';
import { GameEvent, events } from '../systems/EventSystem.js';
import monstersConfig from '../config/monsters.json';
import { createHpBar } from '../ui/HpBarSprite.js';
import { getRenderTime } from '../systems/NetClock.js';
import { wrapPosition, toroidalDelta } from '../systems/Toroid.js';

const ALLIED_TINT = 0x4488ff;

const BODY_GEOM  = new THREE.CapsuleGeometry(0.3, 0.8, 4, 8);
const SKULL_GEOM = new THREE.SphereGeometry(0.28, 12, 8);
const EYE_GEOM   = new THREE.SphereGeometry(0.07, 8, 6);
const GLOW_GEOM  = new THREE.SphereGeometry(0.16, 8, 6);

function getMonsterConfig(type) {
  return monstersConfig.types[type] || monstersConfig.types[monstersConfig.default];
}

function buildSkeletonMesh(faction, cfg) {
  const group = new THREE.Group();
  const bodyHex = faction === Faction.ALLIED ? ALLIED_TINT : cfg.bodyColor;
  const eyeHex  = faction === Faction.ALLIED ? cfg.eyeColorAllied : cfg.eyeColorHostile;

  const bodyMat = new THREE.MeshStandardMaterial({ color: bodyHex, roughness: 0.7 });
  const body = new THREE.Mesh(BODY_GEOM, bodyMat);
  body.position.y = 0.7;
  group.add(body);

  const skull = new THREE.Mesh(SKULL_GEOM, bodyMat);
  skull.position.y = 1.45;
  group.add(skull);

  const eyeMat = new THREE.MeshBasicMaterial({ color: eyeHex });
  const glowMat = new THREE.MeshBasicMaterial({
    color: eyeHex, transparent: true, opacity: 0.35,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const eyeL = new THREE.Mesh(EYE_GEOM, eyeMat);
  const eyeR = new THREE.Mesh(EYE_GEOM, eyeMat);
  const glowL = new THREE.Mesh(GLOW_GEOM, glowMat);
  const glowR = new THREE.Mesh(GLOW_GEOM, glowMat);
  glowL.position.set(-0.1, 1.48, 0.22);
  glowR.position.set( 0.1, 1.48, 0.22);
  eyeL.position.set(-0.1, 1.48, 0.22);
  eyeR.position.set( 0.1, 1.48, 0.22);
  group.add(glowL, glowR, eyeL, eyeR);

  // Uniform scale for body/skull/eyes — simpler than per-part geometry swap.
  group.scale.setScalar(cfg.scale);

  group.userData.bodyMaterial = bodyMat;
  group.userData.eyeMaterial = eyeMat;
  group.userData.eyeGlowMaterial = glowMat;
  group.userData.monsterConfig = cfg;
  return group;
}

export class Skeleton {
  constructor(position, faction, options = {}) {
    this.position = position.clone();
    this.position.y = 0;
    this.faction = faction;
    this.tier = options.tier ?? 0;
    this.type = options.type && monstersConfig.types[options.type]
      ? options.type
      : monstersConfig.default;
    this.ownerId = options.ownerId ?? null;
    this.localId = options.localId ?? null;
    this.friendly = false;

    const cfg = getMonsterConfig(this.type);

    const tierMult = 1 + this.tier * 0.3;
    const base = cfg.baseStats;
    const scaled = {
      ...base,
      strength: base.strength * tierMult,
      vitality: Math.max(1, Math.round(base.vitality * tierMult)),
    };
    this.stats = new EntityStats(scaled);

    const speedVar = 0.9 + Math.random() * 0.2;
    this.stats.moveSpeed *= speedVar;

    this.alive = true;
    this.isAttacking = false;
    this.attackTimer = 0;
    this.attackDuration = cfg.attackDuration;
    this.attackRange = cfg.attackRange;
    this.cooldownTimer = 0;
    this._cooldownMin = cfg.cooldownMin;
    this._cooldownMax = cfg.cooldownMax;

    this.aggroRadius = cfg.aggroRadius;
    this.patrolRadius = cfg.patrolRadius;
    this.patrolCenter = this.position.clone();
    this.patrolTarget = null;
    this.patrolTimer = 0;

    this.guardRadius = cfg.guardRadius;
    this.engageRadius = cfg.engageRadius;
    this.guardIdleTarget = null;
    this.guardIdleTimer = 0;
    this._attackMoveTarget = null;

    this.behaviorTree = faction === Faction.HOSTILE
      ? buildHostileTree()
      : buildAlliedTree();

    this.mesh = buildSkeletonMesh(faction, cfg);
    this.mesh.position.copy(this.position);
    this._attackTarget = null;
    this._hitFlash = 0;
    this._dying = false;
    this._deathTimer = 0;
    this._eruptTimer = 0;
    this._erupting = false;
    this.serverId = null;
    this._snaps = [];
    this._snapVx = 0;
    this._snapVz = 0;

    // HP bar is a child of the scaled mesh group. Keep its local params
    // constant so that world position (yOffset × scale) naturally rises above
    // taller monsters, and its local scale gets inverted so the bar's world
    // width stays constant regardless of monster size.
    this._hpBar = createHpBar({ width: 1.0, height: 0.13, yOffset: 1.95 });
    this._hpBar.sprite.scale.multiplyScalar(1 / cfg.scale);
    this.mesh.add(this._hpBar.sprite);
  }

  setHp(current, max) {
    this._hpBar.setHp(current, max);
  }

  setServerPosition(x, z, serverT) {
    const snaps = this._snaps;
    if (snaps.length > 0 && serverT <= snaps[snaps.length - 1].t) return;
    snaps.push({ x, z, t: serverT });
    if (snaps.length > 3) snaps.shift();

    if (snaps.length >= 2) {
      const a = snaps[snaps.length - 2];
      const b = snaps[snaps.length - 1];
      const dt = (b.t - a.t) / 1000;
      if (dt > 0.001) {
        this._snapVx = (b.x - a.x) / dt;
        this._snapVz = (b.z - a.z) / dt;
      }
    }

    if (snaps.length === 1) {
      this.position.x = x;
      this.position.z = z;
    }
  }

  beginErupt() {
    this._erupting = true;
    this._eruptTimer = 0;
    this.mesh.position.y = -1.6;
  }

  setTint(hex) {
    const mat = this.mesh.userData.bodyMaterial;
    if (mat) mat.color.setHex(hex);
    const eye = this.mesh.userData.eyeMaterial;
    const glow = this.mesh.userData.eyeGlowMaterial;
    const cfg = this.mesh.userData.monsterConfig;
    const eyeHex = hex === ALLIED_TINT ? cfg.eyeColorAllied : cfg.eyeColorHostile;
    if (eye) eye.color.setHex(eyeHex);
    if (glow) glow.color.setHex(eyeHex);
  }

  update(dt, context) {
    if (!this.alive) {
      if (this._dying) {
        this._deathTimer += dt;
        const t = Math.min(this._deathTimer / 0.3, 1);
        this.mesh.scale.y = 1 - t;
        if (t >= 1) this._dying = false;
      }
      return;
    }

    if (this.cooldownTimer > 0) this.cooldownTimer -= dt;

    const prevX = this.position.x;
    const prevZ = this.position.z;

    if (this._snaps.length >= 2) {
      const renderT = getRenderTime();
      const snaps = this._snaps;
      let a = snaps[0];
      let b = snaps[1];
      for (let i = 1; i < snaps.length; i++) {
        if (snaps[i].t >= (renderT ?? Infinity)) break;
        a = snaps[i - 1];
        b = snaps[i];
      }
      const span = b.t - a.t;
      let k;
      if (renderT == null || span <= 0) k = 1;
      else k = (renderT - a.t) / span;

      if (k >= 0 && k <= 1) {
        this.position.x = a.x + (b.x - a.x) * k;
        this.position.z = a.z + (b.z - a.z) * k;
      } else if (k > 1) {
        const latest = snaps[snaps.length - 1];
        const overshoot = Math.min(0.15, ((renderT ?? latest.t) - latest.t) / 1000);
        this.position.x = latest.x + this._snapVx * overshoot;
        this.position.z = latest.z + this._snapVz * overshoot;
      } else {
        this.position.x = a.x;
        this.position.z = a.z;
      }
    } else if (this.behaviorTree) {
      this.behaviorTree.execute({ entity: this, dt, ...context });
    }

    wrapPosition(this.position);
    this.mesh.position.copy(this.position);
    if (this._erupting) {
      this._eruptTimer += dt;
      const t = Math.min(this._eruptTimer / 0.4, 1);
      this.mesh.position.y = this.position.y + (t - 1) * 1.6;
      if (t >= 1) this._erupting = false;
    }

    if (this._attackTarget) {
      const { dx, dz } = toroidalDelta(
        this.position.x, this.position.z,
        this._attackTarget.position.x, this._attackTarget.position.z,
      );
      this.mesh.lookAt(
        this.mesh.position.x + dx,
        this.mesh.position.y,
        this.mesh.position.z + dz,
      );
    } else {
      const { dx, dz } = toroidalDelta(prevX, prevZ, this.position.x, this.position.z);
      if (dx * dx + dz * dz > 1e-5) {
        this.mesh.lookAt(
          this.mesh.position.x + dx,
          this.mesh.position.y,
          this.mesh.position.z + dz,
        );
      }
    }

    const mat = this.mesh.userData.bodyMaterial;
    if (mat && mat.emissive) {
      if (this._hitFlash > 0) {
        this._hitFlash--;
        mat.emissive.setHex(0xffffff);
      } else {
        mat.emissive.setHex(0x000000);
      }
    }
  }

  takeDamage(amount) {
    if (!this.alive) return;
    this.stats.takeDamage(amount);
    this._hitFlash = 3;
    events.emit(GameEvent.ENEMY_HIT, { skeleton: this, amount });
    if (!this.stats.isAlive()) this.die();
  }

  die() {
    if (!this.alive) return;
    this.alive = false;
    this._dying = true;
    this._deathTimer = 0;
    events.emit(GameEvent.ENEMY_DIED, { skeleton: this });
  }

  isRemovable() {
    return !this.alive && !this._dying;
  }
}
