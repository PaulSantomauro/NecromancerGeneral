import * as THREE from 'three';
import battleConfig from '../config/battle.json';

const GROUND_SIZE = 700;
const GROUND_SEGMENTS = 150;

const HILLS = [
  // Every hostile spawn zone gets a matching mound so the zones sit on
  // elevated ground.
  ...battleConfig.hostileSpawnZones.map(z => ({
    x: z.center[0], z: z.center[2], r: z.radius * 1.2, h: 2.5 + z.radius * 0.12,
  })),
  // Central ridges — low rolling features near the safe-spawn core.
  { x:  0,    z:  0,    r: 20, h: 1.4 },
  { x: -30,   z:  22,   r: 16, h: 2.2 },
  { x:  28,   z:  32,   r: 14, h: 2.0 },
  { x:  0,    z: -40,   r: 18, h: 1.7 },
  // Mid-arena mounds — break sightlines around the meeting ground.
  { x: -75,   z: -50,   r: 22, h: 3.0 },
  { x:  75,   z: -50,   r: 22, h: 3.0 },
  { x: -30,   z:  78,   r: 16, h: 2.4 },
  { x:  30,   z:  78,   r: 16, h: 2.4 },
  { x: -82,   z:  30,   r: 18, h: 2.6 },
  { x:  82,   z:  30,   r: 18, h: 2.6 },
  // Outer reaches — bigger bluffs near the arena edge.
  { x: -115,  z:  60,   r: 22, h: 3.2 },
  { x:  115,  z:  60,   r: 22, h: 3.2 },
  { x: -110,  z: -110,  r: 24, h: 3.6 },
  { x:  110,  z: -110,  r: 24, h: 3.6 },
  { x:  0,    z:  130,  r: 20, h: 2.8 },
  { x: -128,  z:  -8,   r: 20, h: 2.8 },
  { x:  128,  z:  -8,   r: 20, h: 2.8 },
  { x:  0,    z: -138,  r: 22, h: 3.2 },
];

// Evaluate terrain height at any world (x, z) using the same formula as the mesh
function computeHeight(wx, wz) {
  // Plane local coords: localX = worldX, localY = -worldZ (due to -PI/2 X rotation)
  const x = wx;
  const y = -wz;

  let h = Math.sin(x * 0.06) * 0.4 +
          Math.cos(y * 0.05) * 0.35 +
          Math.sin((x + y) * 0.12) * 0.2 +
          Math.sin(x * 0.18) * Math.cos(y * 0.14) * 0.15;

  for (const hill of HILLS) {
    const dx = x - hill.x;
    const dz = y + hill.z; // localY = -worldZ, so to match worldZ=hill.z: localY = -hill.z
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < hill.r) {
      const t = 1 - d / hill.r;
      h += hill.h * t * t * (3 - 2 * t);
    }
  }
  return h;
}

export class Battlefield {
  constructor(scene) {
    scene.background = new THREE.Color(0x140e1a);
    scene.fog = new THREE.FogExp2(0x2a1210, 0.011);

    this._buildSky(scene);
    this._buildStars(scene);
    this._buildGround(scene);
    this._buildLights(scene);
    this._buildSpawnRings(scene);
    this._buildScatter(scene);
    this._buildBoundary(scene);
    this._buildFog(scene);
    this._buildFogEdgeRing(scene);
    this.embers = this._buildEmbers(scene);
    this.wisps = this._buildWisps(scene);
    this._spawnRingTime = 0;
    this.setFogRadius(95);
  }

  setFogRadius(r) {
    this._fogRadius = r;
    if (this._fogMesh) {
      this._fogMesh.scale.x = r;
      this._fogMesh.scale.z = r;
    }
    // Ground-edge ring tracks the fog cylinder so the ember wall feels
    // anchored to terrain instead of floating.
    if (this._fogEdgeRing) {
      this._fogEdgeRing.scale.x = r;
      this._fogEdgeRing.scale.z = r;
    }
  }

  getTerrainHeight(wx, wz) {
    return computeHeight(wx, wz);
  }

  _buildSky(scene) {
    // Sky radius sized so the player stays inside the dome even at the far
    // corners (diagonal ≈ 212 units for a 300-wide world).
    const skyGeom = new THREE.SphereGeometry(400, 32, 20);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor:    { value: new THREE.Color(0x0e0818) },
        midColor:    { value: new THREE.Color(0x351222) },
        horizonColor:{ value: new THREE.Color(0x8a3818) },
      },
      vertexShader: `
        varying vec3 vWorldPos;
        void main() {
          vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vWorldPos;
        uniform vec3 topColor;
        uniform vec3 midColor;
        uniform vec3 horizonColor;
        void main() {
          float h = normalize(vWorldPos).y;
          vec3 col;
          if (h < 0.12) {
            col = mix(horizonColor, midColor, smoothstep(-0.02, 0.12, h));
          } else {
            col = mix(midColor, topColor, smoothstep(0.12, 0.6, h));
          }
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    scene.add(new THREE.Mesh(skyGeom, skyMat));

    const moonMat = new THREE.MeshBasicMaterial({
      color: 0xffe0b0, fog: false, transparent: true, opacity: 0.95,
    });
    const moon = new THREE.Mesh(new THREE.CircleGeometry(9, 32), moonMat);
    moon.position.set(-70, 100, -220);
    moon.lookAt(0, 0, 0);
    scene.add(moon);

    const haloMat = new THREE.MeshBasicMaterial({
      color: 0xffb077, fog: false, transparent: true, opacity: 0.22,
    });
    const halo = new THREE.Mesh(new THREE.CircleGeometry(18, 32), haloMat);
    halo.position.copy(moon.position).add(new THREE.Vector3(0, 0, 0.2));
    halo.lookAt(0, 0, 0);
    scene.add(halo);
  }

  // Faint additive stars across the upper hemisphere of the sky dome. Dim
  // in the direction of the moon so the moon still anchors the sky composition.
  _buildStars(scene) {
    const count = 400;
    const geom = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const moonDir = new THREE.Vector3(-70, 100, -220).normalize();
    for (let i = 0; i < count; i++) {
      const u = Math.random();
      const v = 0.08 + Math.random() * 0.72;
      const theta = u * Math.PI * 2;
      const phi = Math.acos(1 - v);
      const x = Math.sin(phi) * Math.cos(theta) * 380;
      const y = Math.cos(phi) * 380;
      const z = Math.sin(phi) * Math.sin(theta) * 380;
      positions[i * 3]     = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      const dir = new THREE.Vector3(x, y, z).normalize();
      const nearMoon = Math.max(0, dir.dot(moonDir));
      const base = 0.4 + Math.random() * 0.55;
      const k = base * (1 - nearMoon * 0.7);
      colors[i * 3]     = k;
      colors[i * 3 + 1] = k * 0.95;
      colors[i * 3 + 2] = k * 0.85;
    }
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.PointsMaterial({
      size: 1.3, sizeAttenuation: false,
      vertexColors: true, transparent: true, opacity: 0.9,
      fog: false, depthWrite: false,
    });
    scene.add(new THREE.Points(geom, mat));
  }

  // Ground-aligned additive ring sized to match the current fog radius.
  // Scaled from setFogRadius so it always traces the ember wall base.
  _buildFogEdgeRing(scene) {
    const geom = new THREE.RingGeometry(0.96, 1.0, 96);
    const mat = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      fog: false,
      uniforms: {
        edgeColor: { value: new THREE.Color(0x8a2a10) },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 edgeColor;
        varying vec2 vUv;
        void main() {
          float inner = smoothstep(0.0, 1.0, vUv.y);
          gl_FragColor = vec4(edgeColor, inner * 0.75);
        }
      `,
    });
    const ring = new THREE.Mesh(geom, mat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    ring.renderOrder = 1;
    scene.add(ring);
    this._fogEdgeRing = ring;
  }

  // Small number of warm "wisp" particles drifting near the player.
  // Regenerated when they drift out of a 14-unit radius so they always
  // feel near the viewer. Animated in update().
  _buildWisps(scene) {
    const count = 60;
    const geom = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    const life = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      positions[i * 3]     = (Math.random() - 0.5) * 28;
      positions[i * 3 + 1] = Math.random() * 3;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 28;
      velocities[i * 3]     = (Math.random() - 0.5) * 0.15;
      velocities[i * 3 + 1] = 0.08 + Math.random() * 0.18;
      velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.15;
      life[i] = Math.random() * 4;
    }
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xffc48c, size: 0.08,
      transparent: true, opacity: 0.6, fog: true,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geom, mat);
    scene.add(points);
    return { points, velocities, life, count };
  }

  _buildGround(scene) {
    const geom = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE, GROUND_SEGMENTS, GROUND_SEGMENTS);
    const pos = geom.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const base   = new THREE.Color(0x483020);
    const dark   = new THREE.Color(0x281410);
    const green  = new THREE.Color(0x2a3018);
    const path   = new THREE.Color(0x5a4030);
    const scorch = new THREE.Color(0x1a0c08); // burnt ring around spawn zones

    // Precompute spawn zone centers in plane-local coords so we can tint
    // scorched earth around them without doing it per-frame.
    // PlaneGeometry local (x, y) maps to world (x, -z).
    const scorchZones = battleConfig.hostileSpawnZones.map(z => ({
      lx: z.center[0],
      ly: -z.center[2],
      r: z.radius + 6,
    }));

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);

      let h = Math.sin(x * 0.06) * 0.4 +
              Math.cos(y * 0.05) * 0.35 +
              Math.sin((x + y) * 0.12) * 0.2 +
              Math.sin(x * 0.18) * Math.cos(y * 0.14) * 0.15;

      for (const hill of HILLS) {
        const dx = x - hill.x;
        const dz = y + hill.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < hill.r) {
          const t = 1 - d / hill.r;
          h += hill.h * t * t * (3 - 2 * t);
        }
      }

      pos.setZ(i, h);

      const distFromCenter = Math.sqrt(x * x + y * y);
      const greenMix = Math.max(0, Math.sin(x * 0.04 + 1.5) * Math.cos(y * 0.035) * 0.6);
      const pathMix = Math.max(0, 1 - Math.abs(x * 0.015) - Math.abs(y * 0.015)) * 0.3;
      const edgeDark = Math.min(1, Math.max(0, (distFromCenter - 80) / 40));

      // Scorch falloff — nearest spawn zone, smooth ramp toward the center.
      let scorchMix = 0;
      for (const z of scorchZones) {
        const dx = x - z.lx;
        const dy = y - z.ly;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < z.r) {
          const t = 1 - d / z.r;
          const s = t * t * (3 - 2 * t) * 0.55;
          if (s > scorchMix) scorchMix = s;
        }
      }

      const c = base.clone();
      c.lerp(green, greenMix);
      c.lerp(path, pathMix);
      c.lerp(dark, edgeDark);
      c.lerp(scorch, scorchMix);
      colors[i * 3]     = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geom.computeVertexNormals();

    // Procedural dirt texture tiles across the plane and multiplies with the
    // vertex colors. Gives near-field detail (pebbles, cracks, stains) that
    // the vertex palette alone can't, while preserving the existing regional
    // color mixing.
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0,
      map: this._buildGroundTexture(),
    });
    const ground = new THREE.Mesh(geom, mat);
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);
  }

  // Procedural 1024² canvas texture used as the ground colour map. Combines
  // low-frequency noise (regional variation), scattered pebble specks, thin
  // cracks, and occasional dark bloodstain blobs. Generated once at boot.
  _buildGroundTexture() {
    const size = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');

    // Base fill: multi-octave sin-noise producing a mottled dirt look. Range
    // is warm brown with enough per-pixel variation to read as surface
    // texture up close without looking like TV static.
    const img = ctx.createImageData(size, size);
    const data = img.data;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let n = 0;
        n += Math.sin(x * 0.03) * Math.cos(y * 0.025) * 0.4;
        n += Math.sin(x * 0.09 + y * 0.07) * 0.25;
        n += Math.sin(x * 0.25 + y * 0.33) * 0.15;
        n += (Math.random() - 0.5) * 0.18;
        const v = 0.5 + n * 0.5; // ~0..1
        const i = (y * size + x) * 4;
        data[i]     = Math.min(255, 110 + v * 95);   // R
        data[i + 1] = Math.min(255,  75 + v * 70);   // G
        data[i + 2] = Math.min(255,  45 + v * 45);   // B
        data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    // Dark pebble specks.
    ctx.fillStyle = 'rgba(25, 15, 10, 0.6)';
    for (let i = 0; i < 2000; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const r = 0.6 + Math.random() * 2.5;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Lighter pebble highlights (catches the torch light nicely).
    ctx.fillStyle = 'rgba(195, 170, 135, 0.5)';
    for (let i = 0; i < 850; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const r = 0.5 + Math.random() * 1.8;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Thin surface cracks — short dark strokes with random angles.
    ctx.strokeStyle = 'rgba(20, 10, 8, 0.55)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 700; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const len = 6 + Math.random() * 44;
      const angle = Math.random() * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(angle) * len, y + Math.sin(angle) * len);
      ctx.stroke();
    }

    // Occasional dark bloodstain blobs — radial gradient so edges dissolve.
    for (let i = 0; i < 50; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const r = 10 + Math.random() * 28;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0,   'rgba(95, 15, 10, 0.55)');
      g.addColorStop(0.6, 'rgba(60, 10,  8, 0.28)');
      g.addColorStop(1,   'rgba(40, 10,  8, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Scattered ash flecks — tiny, near-white dots.
    ctx.fillStyle = 'rgba(210, 200, 180, 0.4)';
    for (let i = 0; i < 400; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      ctx.fillRect(x, y, 1, 1);
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(10, 10); // ~50u per tile on the 500u plane
    tex.anisotropy = 4;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  _buildLights(scene) {
    // Brightened pass — pre-PostFX the scene leaned darker because there
    // was no bloom-derived ambient lift. With the composer chain in
    // place the world was reading as gloomy/oppressive instead of
    // atmospheric, so hemi/ambient are bumped to put more readable light
    // on terrain and skeletons. Key/rim hold their direction so the
    // sunset-hellscape silhouette still reads.
    const hemi = new THREE.HemisphereLight(0xffd0a0, 0x281820, 0.95);
    scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffaa66, 1.4);
    key.position.set(-50, 60, -40);
    scene.add(key);

    const rim = new THREE.DirectionalLight(0x6688cc, 0.55);
    rim.position.set(50, 30, 50);
    scene.add(rim);

    const ambient = new THREE.AmbientLight(0x4a3040, 0.95);
    scene.add(ambient);
  }

  _buildSpawnRings(scene) {
    this._spawnRings = [];
    for (const zone of battleConfig.hostileSpawnZones) {
      const [cx, , cz] = zone.center;
      const r = zone.radius;
      const groundY = computeHeight(cx, cz) + 0.1;

      const ringGeom = new THREE.RingGeometry(r - 0.3, r + 0.3, 48);
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0xcc4422, side: THREE.DoubleSide,
        transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending,
      });
      const ring = new THREE.Mesh(ringGeom, ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(cx, groundY, cz);
      scene.add(ring);

      const discGeom = new THREE.CircleGeometry(r * 0.85, 48);
      const discMat = new THREE.MeshBasicMaterial({
        color: 0x881100, side: THREE.DoubleSide,
        transparent: true, opacity: 0.08, depthWrite: false, blending: THREE.AdditiveBlending,
      });
      const disc = new THREE.Mesh(discGeom, discMat);
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(cx, groundY - 0.02, cz);
      scene.add(disc);

      const pulseGeom = new THREE.RingGeometry(r * 0.5, r * 0.55, 48);
      const pulseMat = new THREE.MeshBasicMaterial({
        color: 0xff6633, side: THREE.DoubleSide,
        transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending,
      });
      const pulse = new THREE.Mesh(pulseGeom, pulseMat);
      pulse.rotation.x = -Math.PI / 2;
      pulse.position.set(cx, groundY + 0.03, cz);
      scene.add(pulse);

      this._spawnRings.push({
        ring, disc, pulse, mat: ringMat, pulseMat, discMat, cx, cz, r,
        captured: false,
        captureProgress: 0,
        // Reference hues for the capture progress lerp. Every frame the
        // update loop interpolates ring/pulse/disc colors from the red
        // "from" to the green "to" using captureProgress as t. Keeping
        // Color instances per ring avoids thrashing the GC with new
        // THREE.Color() allocations each tick.
        _colorFromRing:  new THREE.Color(0xcc4422),
        _colorToRing:    new THREE.Color(0x33cc88),
        _colorFromPulse: new THREE.Color(0xff6633),
        _colorToPulse:   new THREE.Color(0x66ff99),
        _colorFromDisc:  new THREE.Color(0x881100),
        _colorToDisc:    new THREE.Color(0x114422),
      });
    }
  }

  // Toggle a zone into its captured state — static safe-color ring and a
  // still pulse so the eye reads "this ain't spawning anymore." Idempotent.
  setZoneCaptured(zoneIndex) {
    const r = this._spawnRings?.[zoneIndex];
    if (!r || r.captured) return;
    r.captured = true;
    r.captureProgress = 1;
    r.mat.color.setHex(0x33cc88);       // ring — safe green
    r.pulseMat.color.setHex(0x66ff99);   // inner pulse
    r.discMat.color.setHex(0x114422);    // disc
    r.mat.opacity = 0.5;
    r.pulseMat.opacity = 0.35;
    r.discMat.opacity = 0.15;
  }

  // Track how close the local player is to capturing a zone. Drives a
  // brighter, faster pulse so the zone visibly "heats up" as the timer
  // advances. No effect on already-captured zones.
  setZoneCaptureProgress(zoneIndex, progress) {
    const r = this._spawnRings?.[zoneIndex];
    if (!r || r.captured) return;
    r.captureProgress = Math.max(0, Math.min(1, progress));
  }

  // Clear any in-flight capture progress on a zone (player stepped out
  // before the threshold). Captured zones stay captured.
  clearZoneCaptureProgress(zoneIndex) {
    const r = this._spawnRings?.[zoneIndex];
    if (!r || r.captured) return;
    r.captureProgress = 0;
  }

  // Reset every zone back to the uncaptured red aesthetic. Called on
  // round restart when the server's capturedZones set is wiped.
  resetAllZones() {
    if (!this._spawnRings) return;
    for (const r of this._spawnRings) {
      r.captured = false;
      r.captureProgress = 0;
      r.mat.color.setHex(0xcc4422);
      r.pulseMat.color.setHex(0xff6633);
      r.discMat.color.setHex(0x881100);
      r.discMat.opacity = 0.08;
    }
  }

  _buildScatter(scene) {
    const rng = mulberry32(42);

    const bonePositions = [];
    const skullPositions = [];
    const rockPositions = [];
    const stumpPositions = [];

    for (let i = 0; i < 1200; i++) {
      const r = 6 + Math.pow(rng(), 0.5) * 220;
      const a = rng() * Math.PI * 2;
      const wx = Math.cos(a) * r;
      const wz = Math.sin(a) * r;
      const gy = computeHeight(wx, wz);
      const p = [wx, wz, gy]; // include ground Y
      const kind = rng();
      if (kind < 0.45) bonePositions.push(p);
      else if (kind < 0.65) skullPositions.push(p);
      else if (kind < 0.88) rockPositions.push(p);
      else stumpPositions.push(p);
    }

    const addInstanced = (geom, mat, positions, yOffset, scaleRange, randomRot = true) => {
      if (positions.length === 0) return;
      const mesh = new THREE.InstancedMesh(geom, mat, positions.length);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      const t = new THREE.Vector3();
      for (let i = 0; i < positions.length; i++) {
        const [x, z, gy] = positions[i];
        const scale = scaleRange[0] + rng() * (scaleRange[1] - scaleRange[0]);
        s.set(scale, scale, scale);
        t.set(x, (gy ?? 0) + yOffset, z);
        const rotY = rng() * Math.PI * 2;
        const rotZ = randomRot ? (rng() - 0.5) * 0.6 : 0;
        q.setFromEuler(new THREE.Euler(0, rotY, rotZ));
        m.compose(t, q, s);
        mesh.setMatrixAt(i, m);
      }
      mesh.instanceMatrix.needsUpdate = true;
      scene.add(mesh);
    };

    const boneMat  = new THREE.MeshStandardMaterial({ color: 0xbba890, roughness: 0.9 });
    const skullMat = new THREE.MeshStandardMaterial({ color: 0xd0c0a0, roughness: 0.85 });
    const rockMat  = new THREE.MeshStandardMaterial({ color: 0x4a3838, roughness: 1 });
    const stumpMat = new THREE.MeshStandardMaterial({ color: 0x241808, roughness: 1 });

    addInstanced(new THREE.CapsuleGeometry(0.08, 0.5, 3, 6).rotateZ(Math.PI / 2), boneMat, bonePositions, 0.08, [0.6, 1.3]);
    addInstanced(new THREE.SphereGeometry(0.18, 8, 6), skullMat, skullPositions, 0.12, [0.7, 1.2], false);
    addInstanced(new THREE.DodecahedronGeometry(0.4, 0), rockMat, rockPositions, 0.15, [0.5, 2.2]);
    addInstanced(new THREE.CylinderGeometry(0.3, 0.5, 1.5, 6), stumpMat, stumpPositions, 0.75, [0.6, 1.5], false);
  }

  _buildBoundary(scene) {
    const worldSize = (typeof battleConfig.worldSize === 'number' ? battleConfig.worldSize : 200);
    const half = worldSize / 2;
    const wallHeight = 40;

    // Shader material: dark at the ground, glowing ember red at the top,
    // fading transparent upward. Faces inward.
    const mat = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      fog: false,
      uniforms: {
        time: { value: 0 },
        bottomColor: { value: new THREE.Color(0x120305) },
        topColor:    { value: new THREE.Color(0x6a1a0a) },
      },
      vertexShader: `
        varying vec3 vLocal;
        varying vec2 vUv;
        void main() {
          vLocal = position;
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float time;
        uniform vec3 bottomColor;
        uniform vec3 topColor;
        varying vec3 vLocal;
        varying vec2 vUv;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          float a = hash(i);
          float b = hash(i + vec2(1.0, 0.0));
          float c = hash(i + vec2(0.0, 1.0));
          float d = hash(i + vec2(1.0, 1.0));
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }

        void main() {
          float heightN = clamp(vUv.y, 0.0, 1.0);
          // Vertical gradient
          vec3 col = mix(bottomColor, topColor, pow(heightN, 1.6));

          // Animated noise overlay — drifting fog
          float n = noise(vec2(vUv.x * 10.0 + time * 0.15, heightN * 6.0 - time * 0.3));
          col += vec3(0.25, 0.08, 0.04) * n * (1.0 - heightN);

          // Alpha: opaque near ground, fades to zero at top
          float alpha = smoothstep(1.0, 0.2, heightN) * 0.88;
          // Add flicker
          alpha *= 0.85 + 0.15 * n;

          gl_FragColor = vec4(col, alpha);
        }
      `,
    });
    this._boundaryMat = mat;

    // Four walls forming a box around the world.
    const wallGeom = new THREE.PlaneGeometry(worldSize, wallHeight, 1, 1);
    const walls = [
      { pos: [0, wallHeight / 2, -half], rotY: 0 },          // north, faces +Z (inward)
      { pos: [0, wallHeight / 2,  half], rotY: Math.PI },    // south
      { pos: [-half, wallHeight / 2, 0], rotY: Math.PI / 2 }, // west
      { pos: [ half, wallHeight / 2, 0], rotY: -Math.PI / 2 },// east
    ];
    for (const w of walls) {
      const mesh = new THREE.Mesh(wallGeom, mat);
      mesh.position.set(w.pos[0], w.pos[1], w.pos[2]);
      mesh.rotation.y = w.rotY;
      mesh.renderOrder = 1; // draw after ground
      scene.add(mesh);
    }
  }

  // Cylindrical ember wall that marks the battle-royale fog boundary.
  // Unit radius / unit height — main.js scales it each frame to track the
  // authoritative fogRadius from the server.
  _buildFog(scene) {
    const wallHeight = 30;
    const mat = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      fog: false,
      uniforms: {
        time: { value: 0 },
        bottomColor: { value: new THREE.Color(0x3a0a05) },
        topColor:    { value: new THREE.Color(0xbb3d1c) },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float time;
        uniform vec3 bottomColor;
        uniform vec3 topColor;
        varying vec2 vUv;

        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p); vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          float a = hash(i);
          float b = hash(i + vec2(1.0, 0.0));
          float c = hash(i + vec2(0.0, 1.0));
          float d = hash(i + vec2(1.0, 1.0));
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }

        void main() {
          float h = clamp(vUv.y, 0.0, 1.0);
          vec3 col = mix(bottomColor, topColor, pow(h, 1.2));
          float n = noise(vec2(vUv.x * 14.0 + time * 0.4, h * 6.0 - time * 0.7));
          col += vec3(0.45, 0.18, 0.08) * n * (1.0 - h * 0.6);
          float alpha = smoothstep(1.0, 0.1, h) * 0.82;
          alpha *= 0.75 + 0.25 * n;
          gl_FragColor = vec4(col, alpha);
        }
      `,
    });
    this._fogMat = mat;

    // radialSegments=64, 1 height segment, openEnded=true
    const geom = new THREE.CylinderGeometry(1, 1, wallHeight, 64, 1, true);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.y = wallHeight / 2;
    mesh.renderOrder = 2;
    this._fogMesh = mesh;
    scene.add(mesh);
  }

  _buildEmbers(scene) {
    const count = 300;
    const geom = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3]     = (Math.random() - 0.5) * 120;
      positions[i * 3 + 1] = Math.random() * 20;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 120;
      velocities[i * 3]     = (Math.random() - 0.5) * 0.4;
      velocities[i * 3 + 1] = 0.3 + Math.random() * 0.7;
      velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.4;
    }
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const mat = new THREE.PointsMaterial({
      color: 0xff8833, size: 0.14,
      transparent: true, opacity: 0.8, fog: true,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geom, mat);
    scene.add(points);
    return { points, velocities, count };
  }

  update(dt, playerPos) {
    const { points, velocities, count } = this.embers;
    const pos = points.geometry.attributes.position;
    const arr = pos.array;
    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      arr[i3]     += velocities[i3] * dt;
      arr[i3 + 1] += velocities[i3 + 1] * dt;
      arr[i3 + 2] += velocities[i3 + 2] * dt;
      if (arr[i3 + 1] > 24) {
        arr[i3]     = playerPos.x + (Math.random() - 0.5) * 100;
        arr[i3 + 1] = 0.2;
        arr[i3 + 2] = playerPos.z + (Math.random() - 0.5) * 100;
      }
      const dx = arr[i3]     - playerPos.x;
      const dz = arr[i3 + 2] - playerPos.z;
      if (dx * dx + dz * dz > 100 * 100) {
        arr[i3]     = playerPos.x + (Math.random() - 0.5) * 80;
        arr[i3 + 2] = playerPos.z + (Math.random() - 0.5) * 80;
      }
    }
    pos.needsUpdate = true;

    this._spawnRingTime += dt;
    const pulse = (Math.sin(this._spawnRingTime * 2.0) + 1) * 0.5;
    for (const ring of this._spawnRings) {
      if (ring.captured) {
        // Static safe colors set in setZoneCaptured(); just hold the pulse
        // mesh at a steady scale so it doesn't twitch.
        ring.pulse.scale.set(1, 1, 1);
        continue;
      }
      // Capture in progress: lerp hue red → green proportional to
      // progress. Frequency, amplitude, and scale stay at the normal
      // uncaptured baseline so the ring doesn't shake or jitter while
      // being captured — only its color shifts.
      const t = ring.captureProgress;
      ring.mat.color.lerpColors(ring._colorFromRing,  ring._colorToRing,  t);
      ring.pulseMat.color.lerpColors(ring._colorFromPulse, ring._colorToPulse, t);
      ring.discMat.color.lerpColors(ring._colorFromDisc,  ring._colorToDisc,  t);
      ring.mat.opacity = 0.2 + pulse * 0.2;
      ring.pulseMat.opacity = 0.15 + pulse * 0.25;
      const s = 0.8 + pulse * 0.4;
      ring.pulse.scale.set(s, s, 1);
    }

    if (this._boundaryMat) {
      this._boundaryMat.uniforms.time.value = this._spawnRingTime;
    }
    if (this._fogMat) {
      this._fogMat.uniforms.time.value = this._spawnRingTime;
    }

    // Wisps drift and respawn inside a radius around the player. Cheap —
    // 60 points, single buffer update per frame.
    if (this.wisps) {
      const { points, velocities, life, count } = this.wisps;
      const pos = points.geometry.attributes.position;
      const arr = pos.array;
      for (let i = 0; i < count; i++) {
        const i3 = i * 3;
        life[i] += dt;
        arr[i3]     += velocities[i3] * dt;
        arr[i3 + 1] += velocities[i3 + 1] * dt;
        arr[i3 + 2] += velocities[i3 + 2] * dt;
        const dx = arr[i3]     - playerPos.x;
        const dz = arr[i3 + 2] - playerPos.z;
        if (arr[i3 + 1] > 4 || life[i] > 6 || dx * dx + dz * dz > 14 * 14) {
          const a = Math.random() * Math.PI * 2;
          const r = 2 + Math.random() * 10;
          arr[i3]     = playerPos.x + Math.cos(a) * r;
          arr[i3 + 1] = 0.1 + Math.random() * 0.8;
          arr[i3 + 2] = playerPos.z + Math.sin(a) * r;
          life[i] = 0;
        }
      }
      pos.needsUpdate = true;
    }
  }
}

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
