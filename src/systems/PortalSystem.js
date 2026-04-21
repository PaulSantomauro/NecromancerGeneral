import * as THREE from 'three';

// Vibe Jam 2026 webring portals. Two types of ring mesh in the scene:
//
//   • Exit portal (always present): walking in redirects to
//     https://vibejam.cc/portal/2026?... so players can hop to the next
//     jam entry.
//   • Entry portal (only when arrived via ?portal=true&ref=...): placed
//     near spawn; walking back in returns to the referring game.
//
// Collision: simple XZ distance check each frame. One-shot redirect via an
// _armed flag so a player lingering in the ring doesn't spam navigation.
// Both portals have a brief arming delay so an arriving player doesn't
// immediately re-trigger an exit.

const WEBRING_URL = 'https://vibejam.cc/portal/2026';
const TRIGGER_RADIUS = 2.0;
const ARM_DELAY = 0.5; // seconds before a freshly-built portal can fire

function labelTexture(text, fillStyle = '#ffdcaa', fontPx = 28) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 96;
  const ctx = c.getContext('2d');
  ctx.fillStyle = fillStyle;
  ctx.font = `bold ${fontPx}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur = 10;
  ctx.fillText(text, c.width / 2, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

function refHost(refUrl) {
  try {
    return new URL(refUrl).host || refUrl;
  } catch {
    return refUrl;
  }
}

function buildPortalMesh(scene, { position, color, labelText, labelColor }) {
  const group = new THREE.Group();
  group.position.copy(position);

  // Torus standing vertically, facing +Z. TorusGeometry defaults to the XY
  // plane so we rotate into the XZ-facing orientation by rotating -PI/2
  // around X (the ring now faces the player as they approach from +Z).
  const ringMat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false,
    side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(2.0, 0.15, 8, 48), ringMat);
  ring.position.y = 2.0;
  group.add(ring);

  // Inner disc — faint additive plane so the ring looks "portal-ish"
  // instead of a hoop with nothing inside.
  const discMat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.18,
    blending: THREE.AdditiveBlending, depthWrite: false,
    side: THREE.DoubleSide,
  });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(1.9, 32), discMat);
  disc.position.y = 2.0;
  group.add(disc);

  // Point light in the ring centre — gives the otherwise-matte environment
  // a visible glow at night.
  const glow = new THREE.PointLight(color, 2.0, 14, 1.8);
  glow.position.y = 2.0;
  group.add(glow);

  // Floating label.
  const label = new THREE.Sprite(new THREE.SpriteMaterial({
    map: labelTexture(labelText, labelColor),
    transparent: true, depthWrite: false, depthTest: false, fog: false,
  }));
  label.position.y = 4.2;
  label.scale.set(5, 0.9, 1);
  group.add(label);

  scene.add(group);
  return { group, ring, disc, glow };
}

export class PortalSystem {
  constructor({ scene, player, params, playerName = null }) {
    this._scene = scene;
    this._player = player;
    this._params = params;
    this._playerName = playerName;

    this._exit = null;
    this._entry = null;
    this._exitArmedAt = -Infinity;
    this._entryArmedAt = -Infinity;
    this._time = 0;
    this._redirecting = false;

    this._originRef = window.location.origin + window.location.pathname;
  }

  init() {
    // Always-present exit into the webring.
    this._exit = buildPortalMesh(this._scene, {
      position: new THREE.Vector3(0, 0, -25),
      color: 0xff8a3a,
      labelText: 'VIBE JAM PORTAL →',
      labelColor: '#ffc890',
    });
    this._exitArmedAt = this._time + ARM_DELAY;

    // Entry/return portal only when we arrived from somewhere.
    const ref = this._params?.get('ref');
    const fromPortal = this._params?.get('portal') === 'true';
    if (fromPortal && ref) {
      this._entry = buildPortalMesh(this._scene, {
        position: new THREE.Vector3(0, 0, -8),
        color: 0x3ad1ff,
        labelText: `← RETURN TO ${refHost(ref)}`,
        labelColor: '#b8f0ff',
      });
      this._entryRef = ref;
      this._entryArmedAt = this._time + ARM_DELAY;
    }
  }

  update(dt) {
    if (this._redirecting) return;
    this._time += dt;

    // Idle spin on each ring so it reads as active.
    const spin = this._time * 0.7;
    if (this._exit) this._exit.ring.rotation.z = spin;
    if (this._entry) this._entry.ring.rotation.z = -spin;

    const px = this._player.position.x;
    const pz = this._player.position.z;

    if (this._exit && this._time >= this._exitArmedAt) {
      const dx = px - this._exit.group.position.x;
      const dz = pz - this._exit.group.position.z;
      if (dx * dx + dz * dz < TRIGGER_RADIUS * TRIGGER_RADIUS) {
        this._fire(WEBRING_URL);
        return;
      }
    }

    if (this._entry && this._time >= this._entryArmedAt) {
      const dx = px - this._entry.group.position.x;
      const dz = pz - this._entry.group.position.z;
      if (dx * dx + dz * dz < TRIGGER_RADIUS * TRIGGER_RADIUS) {
        this._fire(this._entryRef);
        return;
      }
    }
  }

  _fire(targetUrl) {
    this._redirecting = true;
    const params = new URLSearchParams();
    if (this._playerName) params.set('username', this._playerName);
    params.set('color', 'purple');
    params.set('ref', this._originRef);
    const s = this._player.stats;
    if (s) {
      params.set('speed', String(Math.round(s.moveSpeed * 100) / 100));
      // Normalise local hp to the 1..100 range the jam uses.
      const hp01 = Math.max(1, Math.min(100, Math.round((s.hp / s.maxHp) * 100)));
      params.set('hp', String(hp01));
    }
    const yawObj = this._player.controls?.getObject?.();
    if (yawObj) {
      params.set('rotation_y', String(Math.round(yawObj.rotation.y * 1000) / 1000));
    }

    const sep = targetUrl.includes('?') ? '&' : '?';
    window.location.href = `${targetUrl}${sep}${params.toString()}`;
  }
}
