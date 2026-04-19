import * as THREE from 'three';
import { GameEvent, events } from '../systems/EventSystem.js';
import { convertEnemy } from '../systems/FactionSystem.js';
import { wrapPosition } from '../systems/Toroid.js';

// ── Mesh pool ─────────────────────────────────────────────────────────────
// Recycles projectile meshes by ammoKey to avoid per-shot allocation.
const meshPool = new Map(); // ammoKey → array of free meshes
const POOL_CAP = 64;

// Shared geometries by radius — keyed by `${radius}` since each ammo type has
// fixed radius. Three.js handles shared geometries fine.
const coreGeomCache = new Map();
const glowGeomCache = new Map();

function getCoreGeom(radius) {
  let g = coreGeomCache.get(radius);
  if (!g) { g = new THREE.SphereGeometry(radius, 10, 8); coreGeomCache.set(radius, g); }
  return g;
}
function getGlowGeom(radius) {
  let g = glowGeomCache.get(radius);
  if (!g) { g = new THREE.SphereGeometry(radius * 2.2, 10, 8); glowGeomCache.set(radius, g); }
  return g;
}

function buildProjectileMesh(color, radius) {
  const mat = new THREE.MeshBasicMaterial({ color });
  const mesh = new THREE.Mesh(getCoreGeom(radius), mat);
  const glowMat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.35,
  });
  const glow = new THREE.Mesh(getGlowGeom(radius), glowMat);
  mesh.add(glow);
  mesh.userData.coreMat = mat;
  mesh.userData.glowMat = glowMat;
  return mesh;
}

function acquireProjectileMesh(ammoKey, color, radius) {
  const free = meshPool.get(ammoKey);
  if (free && free.length > 0) {
    const mesh = free.pop();
    // In case the color (e.g. for variants) needs an update; cheap to set every time
    mesh.userData.coreMat?.color.setHex(color);
    mesh.userData.glowMat?.color.setHex(color);
    mesh.visible = true;
    return mesh;
  }
  return buildProjectileMesh(color, radius);
}

function releaseProjectileMesh(ammoKey, mesh) {
  if (!mesh) return;
  let pool = meshPool.get(ammoKey);
  if (!pool) { pool = []; meshPool.set(ammoKey, pool); }
  if (pool.length >= POOL_CAP) return; // bounded
  mesh.visible = false;
  pool.push(mesh);
}

export class Projectile {
  constructor({
    origin, velocity, damage, faction, color, radius, maxRange,
    arc = false, arcHeight = 0, flightTime = 1, ammoKey, targetPoint = null,
    networked = false, summonType = null,
  }) {
    this.position = origin.clone();
    this.velocity = velocity.clone();
    this.damage = damage;
    this.faction = faction;
    this.radius = radius;
    this.maxRange = maxRange;
    this.alive = true;
    this.travelled = 0;
    this.ammoKey = ammoKey;
    this.networked = networked;
    this.summonType = summonType;
    this.remoteOwnerId = null;

    this.arc = arc;
    this._arcHeight = arcHeight;
    this._flightTime = flightTime;
    this._elapsed = 0;
    this._startPos = origin.clone();

    if (arc) {
      this._targetPos = targetPoint
        ? targetPoint.clone()
        : origin.clone().addScaledVector(
            velocity.clone().normalize(),
            velocity.length() * flightTime,
          );
      this._targetPos.y = 0;
    }

    this.mesh = acquireProjectileMesh(ammoKey, color, radius);
    this.mesh.position.copy(this.position);
  }

  dispose() {
    releaseProjectileMesh(this.ammoKey, this.mesh);
    this.mesh = null;
  }

  update(dt) {
    if (!this.alive) return;

    if (this.arc) {
      this._elapsed += dt;
      const t = Math.min(this._elapsed / this._flightTime, 1);
      this.position.lerpVectors(this._startPos, this._targetPos, t);
      const dist = this._startPos.distanceTo(this._targetPos);
      this.position.y += Math.sin(t * Math.PI) * this._arcHeight * dist;
      this.mesh.position.copy(this.position);
      if (t >= 1) {
        this._onLand();
        this.alive = false;
      }
      return;
    }

    const step = this.velocity.clone().multiplyScalar(dt);
    this.position.add(step);
    wrapPosition(this.position);
    this.travelled += step.length();
    this.mesh.position.copy(this.position);
    if (this.travelled >= this.maxRange) {
      events.emit(GameEvent.PROJECTILE_EXPIRED, { projectile: this });
      this.alive = false;
    }
  }

  onHit(target, allSkeletons) {
    if (this.networked) {
      events.emit(GameEvent.PROJECTILE_HIT, { projectile: this, target });
      return;
    }
    if (this.ammoKey === 'machine_gun') {
      target.takeDamage(this.damage);
      events.emit(GameEvent.PROJECTILE_HIT, { projectile: this, target });
    } else if (this.ammoKey === 'conversion_bolt') {
      convertEnemy(target, allSkeletons);
    }
  }

  _onLand() {
    // A summon projectile fired by a remote player lands on every client,
    // but only the owning client should spawn the minion (it will broadcast
    // the resulting ally via sendAllySpawned). Skipping here avoids duplicate
    // allies appearing on observers.
    if (this.remoteOwnerId) return;
    const pos = this.position.clone();
    pos.y = 0;
    events.emit(GameEvent.MINION_SPAWNED, { position: pos, type: this.summonType });
  }
}
