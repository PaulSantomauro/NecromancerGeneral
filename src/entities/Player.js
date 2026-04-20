import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { WeaponEmitter } from '../systems/WeaponEmitter.js';
import { GameEvent, events } from '../systems/EventSystem.js';
import { Projectile } from './Projectile.js';
import ammoConfig from '../config/ammo.json';
import { toroidalDelta } from '../systems/Toroid.js';

const CAMERA_HEIGHT = 1.7;

// Procedural muzzle-flash texture: radial gradient from bright core to
// transparent edge. Generated once and shared by every Player's material.
let _muzzleTexture = null;
function getMuzzleTexture() {
  if (_muzzleTexture) return _muzzleTexture;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0,   'rgba(255,255,255,1)');
  g.addColorStop(0.3, 'rgba(255,220,120,0.85)');
  g.addColorStop(1,   'rgba(255,180,60,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  _muzzleTexture = new THREE.CanvasTexture(canvas);
  _muzzleTexture.minFilter = THREE.LinearFilter;
  _muzzleTexture.magFilter = THREE.LinearFilter;
  return _muzzleTexture;
}

const AMMO_ORDER = [
  'machine_gun',
  'conversion_bolt',
  'summon_bolt',
  'summon_runner',
  'summon_brute',
  'summon_stalker',
  'summon_giant',
];

export class Player {
  constructor({ camera, domElement, scene, projectiles, spawnPoint, playerStats, progression }) {
    this.camera = camera;
    this.scene = scene;
    this.projectiles = projectiles;
    this.stats = playerStats;
    this.progression = progression;

    this.position = new THREE.Vector3(spawnPoint[0], 0, spawnPoint[2]);
    camera.position.set(this.position.x, CAMERA_HEIGHT, this.position.z);

    this.controls = new PointerLockControls(camera, domElement);
    scene.add(this.controls.getObject());

    this.alive = true;

    this._keys = { w: false, a: false, s: false, d: false };
    this._sprintHeld = false;
    this._mouseDown = false;

    this.currentAmmoKey = 'machine_gun';
    this.emitters = {};
    for (const key of AMMO_ORDER) {
      const cfg = ammoConfig[key];
      this.emitters[key] = new WeaponEmitter({
        fireInterval: cfg.fireInterval,
        speed: cfg.speed,
        damageFn: () => this.stats.damage * cfg.damageMultiplier,
        faction: 'player',
        owner: this,
      });
    }

    this._gunGroup = new THREE.Group();
    this._gunMat = new THREE.MeshStandardMaterial({
      color: 0x333333, emissive: 0x000000, metalness: 0.6, roughness: 0.4,
    });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.06, 0.35), this._gunMat);
    body.position.set(0.18, -0.15, -0.4);
    this._gunBody = body;
    this._gunGroup.add(body);
    camera.add(this._gunGroup);

    this._gunKickZ = 0;

    this._torch = new THREE.PointLight(0xff8a3a, 2.2, 22, 1.5);
    this._torch.position.set(0, 0, 0);
    camera.add(this._torch);
    this._torchBase = 2.2;
    this._torchFlicker = 0;

    this._muzzleFlash = new THREE.PointLight(0xffd060, 0, 14, 2);
    this._muzzleFlash.position.set(0.18, -0.1, -0.55);
    camera.add(this._muzzleFlash);
    this._muzzleTimer = 0;

    // Additive sprite anchored at the muzzle. Scale-pulses and fades each
    // fire. Camera-relative so it always faces the viewer correctly.
    this._muzzleSpriteMat = new THREE.SpriteMaterial({
      map: getMuzzleTexture(), color: 0xffd060, transparent: true, opacity: 0,
      depthWrite: false, depthTest: false,
      blending: THREE.AdditiveBlending, fog: false,
    });
    this._muzzleSprite = new THREE.Sprite(this._muzzleSpriteMat);
    this._muzzleSprite.scale.set(0.55, 0.55, 1);
    this._muzzleSprite.position.set(0.18, -0.1, -0.56);
    camera.add(this._muzzleSprite);
    this._muzzleSpriteTimer = 0;
    this._muzzleSpriteLife = 0.08;

    this._bindInput(domElement);
  }

  /**
   * Apply damage to the player. Called by CombatSystem when a local hostile lands
   * a melee hit. Delegates to PlayerStats and also emits a DAMAGE_INDICATOR event
   * with the screen-relative angle toward the attacker so the HUD can draw an arc.
   *
   * This method's existence is load-bearing: without it, target.takeDamage inside
   * resolveAllCombat throws a TypeError that breaks the animate loop and stops
   * rendering until the attacker leaves range.
   */
  takeDamage(amount, source) {
    if (!this.stats) return;
    this.stats.takeDamage(amount);
    if (source && source.position && this.controls) {
      const { dx, dz } = toroidalDelta(
        this.position.x, this.position.z,
        source.position.x, source.position.z,
      );
      const worldAngle = Math.atan2(dx, -dz);
      const yaw = this.controls.getObject().rotation.y;
      events.emit(GameEvent.DAMAGE_INDICATOR, { angle: worldAngle - yaw });
    }
  }

  _bindInput(domElement) {
    window.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      if (k in this._keys) this._keys[k] = true;
      if (e.key === 'Shift') this._sprintHeld = true;
      if (k === '1') this._setAmmo(0);
      if (k === '2') this._setAmmo(1);
      if (k === '3') this._setAmmo(2);
      if (k === '4') this._setAmmo(3);
      if (k === '5') this._setAmmo(4);
      if (k === '6') this._setAmmo(5);
      if (k === '7') this._setAmmo(6);
      if (k === 'q') this._purchase('empower_self');
      if (k === 'e') this._purchase('empower_allies');
      if (k === 'r') this._purchase('reinforce_cap');
    });
    window.addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase();
      if (k in this._keys) this._keys[k] = false;
      if (e.key === 'Shift') this._sprintHeld = false;
    });
    domElement.addEventListener('mousedown', (e) => {
      if (e.button === 0) this._mouseDown = true;
    });
    domElement.addEventListener('mouseup', (e) => {
      if (e.button === 0) this._mouseDown = false;
    });
    window.addEventListener('wheel', (e) => {
      if (!this.controls.isLocked) return;
      const idx = AMMO_ORDER.indexOf(this.currentAmmoKey);
      const next = (idx + (e.deltaY > 0 ? 1 : -1) + AMMO_ORDER.length) % AMMO_ORDER.length;
      this._setAmmo(next);
    }, { passive: true });
    window.addEventListener('blur', () => this._resetKeys());
    this.controls.addEventListener('unlock', () => this._resetKeys());
  }

  _purchase(key) {
    if (!this.controls.isLocked || !this.progression) return;
    this.progression.purchase(key);
  }

  _setAmmo(index) {
    const key = AMMO_ORDER[index];
    if (!key || key === this.currentAmmoKey) return;
    this.currentAmmoKey = key;
    const cfg = ammoConfig[key];
    this._gunMat.emissive.setHex(cfg.category === 'summon' ? 0x4a1a6e : 0x000000);
    events.emit(GameEvent.AMMO_CHANGED, { key, name: cfg.name });
  }

  update(dt) {
    if (!this.controls.isLocked || !this.alive) {
      this._gunKickZ = THREE.MathUtils.lerp(this._gunKickZ, 0, Math.min(1, dt * 12));
      this._gunBody.position.z = -0.4 + this._gunKickZ;
      return;
    }

    let fwd = 0, rgt = 0;
    if (this._keys.w) fwd += 1;
    if (this._keys.s) fwd -= 1;
    if (this._keys.d) rgt += 1;
    if (this._keys.a) rgt -= 1;
    const isMoving = fwd !== 0 || rgt !== 0;

    let speedMult = 1;
    if (isMoving && this._sprintHeld) {
      const cost = this.stats.sprintEnergyPerSec * dt;
      if (this.stats.spendEnergy(cost)) {
        speedMult = this.stats.sprintMultiplier;
      }
    }
    const step = this.stats.moveSpeed * speedMult * dt;

    if (isMoving) {
      const len = Math.hypot(fwd, rgt);
      this.controls.moveForward((fwd / len) * step);
      this.controls.moveRight((rgt / len) * step);
    }

    const obj = this.controls.getObject();
    this.position.x = obj.position.x;
    this.position.z = obj.position.z;

    this._gunKickZ = THREE.MathUtils.lerp(this._gunKickZ, 0, Math.min(1, dt * 12));
    this._gunBody.position.z = -0.4 + this._gunKickZ;

    this._torchFlicker += dt * 18;
    this._torch.intensity = this._torchBase
      + Math.sin(this._torchFlicker) * 0.25
      + (Math.random() - 0.5) * 0.15;

    if (this._muzzleTimer > 0) {
      this._muzzleTimer = Math.max(0, this._muzzleTimer - dt);
      this._muzzleFlash.intensity = (this._muzzleTimer / 0.06) * 9;
    } else {
      this._muzzleFlash.intensity = 0;
    }

    if (this._muzzleSpriteTimer > 0) {
      this._muzzleSpriteTimer = Math.max(0, this._muzzleSpriteTimer - dt);
      const k = this._muzzleSpriteTimer / this._muzzleSpriteLife; // 1 → 0
      const pulse = Math.sin((1 - k) * Math.PI);
      this._muzzleSpriteMat.opacity = pulse * 0.95;
      const s = 0.4 + pulse * 0.7;
      this._muzzleSprite.scale.set(s, s, 1);
    } else if (this._muzzleSpriteMat.opacity !== 0) {
      this._muzzleSpriteMat.opacity = 0;
    }

    if (this._mouseDown) this._tryFire();
  }

  _resetKeys() {
    this._keys.w = this._keys.a = this._keys.s = this._keys.d = false;
    this._sprintHeld = false;
    this._mouseDown = false;
  }

  tickEmitters(dt) {
    for (const key of AMMO_ORDER) this.emitters[key].updateCooldown(dt);
  }

  _tryFire() {
    if (!this.alive) return;
    const emitter = this.emitters[this.currentAmmoKey];
    if (!emitter.canFire()) return;

    const cfg = ammoConfig[this.currentAmmoKey];
    const energyCost = cfg.energyCost ?? 0;
    const soulCost = cfg.soulCost ?? 0;
    if (!this.stats.canSpendEnergy(energyCost)) return;
    if (soulCost > 0 && (!this.progression || !this.progression.canAffordSouls(soulCost))) return;
    this.stats.spendEnergy(energyCost);
    if (soulCost > 0) this.progression.spendSouls(soulCost);

    const origin = new THREE.Vector3();
    this.camera.getWorldPosition(origin);
    const direction = new THREE.Vector3();
    this.camera.getWorldDirection(direction).normalize();

    const spawn = emitter.fire(origin, direction);

    let targetPoint = null;
    if (cfg.arc) {
      let aimDist = 30;
      if (direction.y < -0.01) {
        aimDist = THREE.MathUtils.clamp(-origin.y / direction.y, 6, 80);
      }
      targetPoint = origin.clone().addScaledVector(direction, aimDist);
      targetPoint.y = 0;
    }

    const proj = new Projectile({
      origin: spawn.origin,
      velocity: spawn.velocity,
      damage: spawn.damage,
      faction: spawn.faction,
      color: cfg.color,
      radius: cfg.radius,
      maxRange: cfg.maxRange,
      arc: cfg.arc,
      arcHeight: cfg.arcHeight,
      flightTime: cfg.flightTime,
      ammoKey: cfg.key,
      summonType: cfg.summonType ?? null,
      targetPoint,
      networked: !!this.networked,
    });
    this.projectiles.push(proj);
    this.scene.add(proj.mesh);

    this._gunKickZ = 0.05;
    this._muzzleTimer = 0.06;
    const flashColor = cfg.category === 'magic'  ? 0x66e8ff
                     : cfg.category === 'summon' ? 0xc080ff
                     :                             0xffd060;
    this._muzzleFlash.color.setHex(flashColor);
    this._muzzleSpriteMat.color.setHex(flashColor);
    this._muzzleSpriteTimer = this._muzzleSpriteLife;
    events.emit(GameEvent.PLAYER_FIRED, {
      ammoKey: cfg.key,
      origin:    { x: origin.x,    y: origin.y,    z: origin.z    },
      direction: { x: direction.x, y: direction.y, z: direction.z },
      targetPoint: targetPoint ? { x: targetPoint.x, z: targetPoint.z } : null,
    });
  }
}
