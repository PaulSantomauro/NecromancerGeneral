import * as THREE from 'three';

// Shared short-lived particle emitter. Reuses meshes across emits so steady
// state has near-zero per-frame allocation. Five particle kinds:
//   'spark' — tiny additive sphere, optional gravity
//   'dust'  — soft grey additive sphere, rises and fades
//   'bone'  — lit capsule fragment with tumble + gravity (death bursts)
//   'ring'  — ground-aligned additive disc that expands and fades
//   'soul'  — additive orb that homes on a live target Vector3 (typically
//             the player's position), arcs upward on spawn, then seeks
//             after a short delay. Used for harvest streams on kills.
//
// Call FxPool.init(scene) once at boot, FxPool.update(dt) each frame.
// This module only touches the scene graph via scene.add/remove and its own
// meshes — it never mutates existing objects or swaps render paths.

const MAX_ACTIVE = 256;

let _scene = null;
const _active = [];
const _free = { spark: [], dust: [], bone: [], ring: [], soul: [] };

const _sparkGeom = new THREE.SphereGeometry(0.07, 6, 4);
const _dustGeom  = new THREE.SphereGeometry(0.12, 6, 4);
const _boneGeom  = new THREE.CapsuleGeometry(0.055, 0.22, 3, 4);
const _ringGeom  = new THREE.RingGeometry(0.85, 1.0, 32);
const _soulGeom  = new THREE.SphereGeometry(0.12, 8, 6);

function makeMesh(kind, color) {
  if (kind === 'bone') {
    const mat = new THREE.MeshStandardMaterial({
      color, roughness: 0.85, transparent: true, opacity: 1,
    });
    return new THREE.Mesh(_boneGeom, mat);
  }
  const geom = kind === 'spark' ? _sparkGeom
             : kind === 'dust'  ? _dustGeom
             : kind === 'soul'  ? _soulGeom
             :                     _ringGeom;
  const mat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 1,
    blending: THREE.AdditiveBlending, depthWrite: false,
    side: kind === 'ring' ? THREE.DoubleSide : THREE.FrontSide,
  });
  return new THREE.Mesh(geom, mat);
}

function acquire(kind, color) {
  const free = _free[kind];
  const mesh = free && free.length > 0 ? free.pop() : makeMesh(kind, color);
  mesh.material.color.setHex(color);
  mesh.material.opacity = 1;
  mesh.scale.set(1, 1, 1);
  mesh.rotation.set(0, 0, 0);
  mesh.visible = true;
  return mesh;
}

function release(kind, mesh) {
  mesh.visible = false;
  _free[kind].push(mesh);
}

function recycleOldestIfFull() {
  if (_active.length < MAX_ACTIVE) return;
  const old = _active.shift();
  if (_scene) _scene.remove(old.mesh);
  release(old.kind, old.mesh);
}

export const FxPool = {
  init(scene) { _scene = scene; },

  burst({
    position, count = 6, color = 0xffffff, spread = 1.8,
    lifetime = 0.4, kind = 'spark', gravity = true, velocityY = 2.2,
    scale = 1.0,
  }) {
    if (!_scene) return;
    for (let i = 0; i < count; i++) {
      recycleOldestIfFull();
      const mesh = acquire(kind, color);
      mesh.position.copy(position);
      mesh.scale.multiplyScalar(scale);
      _scene.add(mesh);

      const angle = Math.random() * Math.PI * 2;
      const r = spread * (0.4 + Math.random() * 0.9);
      _active.push({
        kind, mesh,
        vx: Math.cos(angle) * r,
        vy: velocityY * (0.55 + Math.random() * 0.9),
        vz: Math.sin(angle) * r,
        gravity,
        rotX: (Math.random() - 0.5) * 8,
        rotY: (Math.random() - 0.5) * 8,
        rotZ: (Math.random() - 0.5) * 8,
        age: 0, lifetime,
      });
    }
  },

  // Harvest stream: spawn `count` additive orbs at `position` with a small
  // upward/outward pop, then after a brief delay accelerate toward `target`
  // (which is expected to be a live Vector3 — usually the player's position
  // — so the stream tracks movement mid-flight). Particles fade out near
  // the end of their lifetime and despawn early if they reach the target.
  soulStream({
    position, target, color = 0xd6a8ff, count = 5,
    duration = 0.9, spread = 0.6, seek = 14.0,
  }) {
    if (!_scene) return;
    for (let i = 0; i < count; i++) {
      recycleOldestIfFull();
      const mesh = acquire('soul', color);
      const angle = Math.random() * Math.PI * 2;
      const r = spread * Math.random();
      mesh.position.set(
        position.x + Math.cos(angle) * r,
        position.y + 0.8 + Math.random() * 0.6,
        position.z + Math.sin(angle) * r,
      );
      mesh.scale.setScalar(0.8 + Math.random() * 0.6);
      _scene.add(mesh);
      _active.push({
        kind: 'soul', mesh, target,
        // Initial pop — small outward + solid upward impulse.
        vx: Math.cos(angle) * (1.2 + Math.random() * 0.9),
        vy: 1.8 + Math.random() * 1.6,
        vz: Math.sin(angle) * (1.2 + Math.random() * 0.9),
        gravity: false,
        rotX: 0, rotY: 0, rotZ: 0,
        age: 0, lifetime: duration,
        // Stagger the homing start so orbs appear to "lift off" one by one
        // before committing toward the player.
        seekDelay: 0.12 + Math.random() * 0.18,
        seekStrength: seek,
      });
    }
  },

  expandingRing({ position, color = 0xffffff, maxRadius = 2.5, duration = 0.35, yOffset = 0.05 }) {
    if (!_scene) return;
    recycleOldestIfFull();
    const mesh = acquire('ring', color);
    mesh.position.copy(position);
    mesh.position.y += yOffset;
    mesh.rotation.x = -Math.PI / 2;
    mesh.scale.set(0.01, 0.01, 1);
    _scene.add(mesh);
    _active.push({
      kind: 'ring', mesh,
      vx: 0, vy: 0, vz: 0,
      gravity: false,
      rotX: 0, rotY: 0, rotZ: 0,
      age: 0, lifetime: duration,
      ringMax: maxRadius,
    });
  },

  update(dt) {
    if (!_scene) return;
    for (let i = _active.length - 1; i >= 0; i--) {
      const p = _active[i];
      p.age += dt;
      const t = p.age / p.lifetime;
      if (t >= 1) {
        _scene.remove(p.mesh);
        release(p.kind, p.mesh);
        _active.splice(i, 1);
        continue;
      }

      if (p.kind === 'ring') {
        const s = p.ringMax * t;
        p.mesh.scale.set(s, s, 1);
        p.mesh.material.opacity = (1 - t) * 0.75;
        continue;
      }

      if (p.kind === 'soul') {
        // Seek toward the live target after seekDelay. Target is expected
        // to be a Vector3-ish object mutated in place (player.position),
        // so we just read its x/y/z every frame without copying. Aim at
        // chest height (+1.4u) so absorbed souls visibly land on the body.
        if (p.target && p.age > p.seekDelay) {
          const dx = p.target.x - p.mesh.position.x;
          const dy = (p.target.y + 1.4) - p.mesh.position.y;
          const dz = p.target.z - p.mesh.position.z;
          const d = Math.hypot(dx, dy, dz) || 1;
          p.vx += (dx / d) * p.seekStrength * dt;
          p.vy += (dy / d) * p.seekStrength * dt;
          p.vz += (dz / d) * p.seekStrength * dt;
          // Critical damping so they don't overshoot past the player.
          const damp = 0.88;
          p.vx *= damp; p.vy *= damp; p.vz *= damp;
          // Close enough → finish early so the tail of a kill batch
          // doesn't hang around after the player has sprinted off.
          if (d < 0.6) p.age = p.lifetime;
        }
        p.mesh.position.x += p.vx * dt;
        p.mesh.position.y += p.vy * dt;
        p.mesh.position.z += p.vz * dt;
        // Hold opacity through most of the life, fade out in the last 30%.
        p.mesh.material.opacity = t < 0.7 ? 1 : Math.max(0, (1 - t) / 0.3);
        continue;
      }

      if (p.gravity) p.vy -= 9.8 * dt;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      if (p.kind === 'bone') {
        p.mesh.rotation.x += p.rotX * dt;
        p.mesh.rotation.y += p.rotY * dt;
        p.mesh.rotation.z += p.rotZ * dt;
        p.mesh.material.opacity = t < 0.75 ? 1 : (1 - t) / 0.25;
      } else {
        p.mesh.material.opacity = 1 - t * t;
      }
    }
  },
};
