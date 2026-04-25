import * as THREE from 'three';
import battleConfig from '../config/battle.json';

// Reused vector for the player-arrow direction read each frame so we
// don't allocate a fresh Vector3 per redraw.
const _fwd = new THREE.Vector3();

const WORLD_SIZE = battleConfig.worldSize ?? 300;
const HALF = WORLD_SIZE / 2;
const ZONES = battleConfig.hostileSpawnZones ?? [];

// Inset margin so rings/zones near the world edge don't get clipped at
// the canvas border. Tuned so a zone sitting at world (±150, ±150) still
// renders fully inside the panel.
const MARGIN = 8;

// Top-right minimap. North-up — world +Z (south) maps to canvas +Y, and
// world +X (east) maps to canvas +X. The local player is a triangle
// pointing in their facing direction; everyone else is a dot.
//
// Read-only on game state — pulls live data each `update()` call from
// the references handed in at construction. Cheap to call every frame
// (~25 draw ops); main.js drives it from the animate loop.
export class Minimap {
  constructor({ canvas, player, roundState, zoneCapture, remoteGenerals, getMyId }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.player = player;
    this.roundState = roundState;
    this.zoneCapture = zoneCapture;
    this.remoteGenerals = remoteGenerals;
    this.getMyId = getMyId ?? (() => null);

    this._setupRetina();
    window.addEventListener('resize', () => this._setupRetina());
  }

  // Match the canvas backing store to devicePixelRatio so circles/lines
  // stay crisp on retina without scaling the CSS box. We cache the
  // logical (CSS) width/height so all the drawing math can stay in CSS
  // pixels and ignore DPR entirely.
  _setupRetina() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._w = w;
    this._h = h;
  }

  // World (x, z) → canvas pixel. World axes: +X east, +Z south.
  // Canvas axes: +x east, +y south. Direct linear mapping.
  _toMap(x, z) {
    const drawSize = this._w - MARGIN * 2;
    return {
      x: MARGIN + ((x + HALF) / WORLD_SIZE) * drawSize,
      y: MARGIN + ((z + HALF) / WORLD_SIZE) * drawSize,
    };
  }

  _toMapRadius(r) {
    const drawSize = this._w - MARGIN * 2;
    return (r / WORLD_SIZE) * drawSize;
  }

  update() {
    const ctx = this.ctx;
    const w = this._w, h = this._h;
    const rs = this.roundState;
    const origin = this._toMap(0, 0);

    // Clear with a subtle inset background so anti-aliased ring edges
    // show against a stable color.
    ctx.clearRect(0, 0, w, h);

    // Starting fog radius — dashed faint outline so the player sees
    // how much of the arena USED to be safe.
    if (rs?.fogStartRadius) {
      ctx.strokeStyle = 'rgba(180, 100, 90, 0.3)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(origin.x, origin.y, this._toMapRadius(rs.fogStartRadius), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Current fog radius — solid red, the live shrinking ring. The
    // safe area is INSIDE this circle.
    if (rs?.fogRadius) {
      ctx.strokeStyle = 'rgba(255, 90, 70, 0.85)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(origin.x, origin.y, this._toMapRadius(rs.fogRadius), 0, Math.PI * 2);
      ctx.stroke();
    }

    // Spawn zones. Active = red hollow ring; captured = solid green
    // disc. Indexes match battleConfig.hostileSpawnZones, which is the
    // same source ZoneCaptureSystem keys captures off — no risk of
    // index drift between client systems.
    for (let i = 0; i < ZONES.length; i++) {
      const z = ZONES[i];
      const captured = this.zoneCapture?.isCaptured(i) ?? false;
      const p = this._toMap(z.center[0], z.center[2]);
      const r = Math.max(2.5, this._toMapRadius(z.radius));
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      if (captured) {
        ctx.fillStyle = 'rgba(80, 220, 130, 0.55)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(140, 255, 180, 0.75)';
        ctx.lineWidth = 1;
        ctx.stroke();
      } else {
        ctx.strokeStyle = 'rgba(255, 110, 90, 0.85)';
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }
    }

    // Other generals. Filter the local player out by id; the remote
    // map can briefly contain a self-entry on rejoin races. Black
    // outline so the dots read against any background tint.
    const myId = this.getMyId();
    if (this.remoteGenerals) {
      ctx.fillStyle = '#7fb8ff';
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
      ctx.lineWidth = 1;
      for (const [id, rg] of this.remoteGenerals) {
        if (id === myId) continue;
        if (!rg?.position) continue;
        const p = this._toMap(rg.position.x, rg.position.z);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }

    // Local player — triangle pointing in facing direction. Read the
    // forward direction from the camera's quaternion via
    // getWorldDirection(): PointerLockControls writes the camera
    // quaternion from a 'YXZ' Euler, so reading camera.rotation.y back
    // (default 'XYZ' order) gives the wrong yaw whenever pitch is
    // non-zero. The world-direction projection is order-agnostic.
    // Project out pitch by normalizing the (x, z) horizontal slice so
    // the arrow length stays stable when looking up/down.
    const camera = this.player.controls.getObject();
    camera.getWorldDirection(_fwd);
    const horizLen = Math.hypot(_fwd.x, _fwd.z) || 1;
    // World +X → canvas +x (east), world +Z → canvas +y (south).
    const fwdX = _fwd.x / horizLen;
    const fwdY = _fwd.z / horizLen;
    const perpX = -fwdY;
    const perpY = fwdX;

    const pp = this._toMap(this.player.position.x, this.player.position.z);
    const tipLen = 7;
    const tailLen = 3;
    const halfWide = 4;

    ctx.fillStyle = '#ffd27a';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pp.x + fwdX * tipLen,                       pp.y + fwdY * tipLen);
    ctx.lineTo(pp.x - fwdX * tailLen + perpX * halfWide,   pp.y - fwdY * tailLen + perpY * halfWide);
    ctx.lineTo(pp.x - fwdX * tailLen - perpX * halfWide,   pp.y - fwdY * tailLen - perpY * halfWide);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}
