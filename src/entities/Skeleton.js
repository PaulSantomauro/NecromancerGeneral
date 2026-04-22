import * as THREE from 'three';
import { EntityStats } from '../systems/EntityStats.js';
import { Faction } from '../systems/FactionSystem.js';
import { buildHostileTree, buildAlliedTree } from '../systems/BehaviorTree.js';
import { GameEvent, events } from '../systems/EventSystem.js';
import monstersConfig from '../config/monsters.json';
import { createHpBar } from '../ui/HpBarSprite.js';
import { getRenderTime } from '../systems/NetClock.js';
import { wrapPosition, toroidalDelta } from '../systems/Toroid.js';
import { FxPool } from '../systems/FxPool.js';

const ALLIED_TINT = 0x4488ff;

// ── Shared primitive geometries ──────────────────────────────────────────
// Eyes/glow stay as small spheres across every type — the creepy glow is
// effective as-is and a unified eye shape reads as "same family of enemy".
const EYE_GEOM   = new THREE.SphereGeometry(0.07, 8, 6);
const GLOW_GEOM  = new THREE.SphereGeometry(0.16, 8, 6);

// ── Per-type lathe profiles ──────────────────────────────────────────────
// LatheGeometry rotates a 2D profile (Vector2 list, x = radius, y = height)
// 360° around the Y axis. Profiles are authored for each type so silhouettes
// read distinctly at a glance.
function lathe(profile, segments = 12) {
  return new THREE.LatheGeometry(profile, segments);
}

// Standard skeletal torso — pinched waist, flared chest, closed top/bottom.
const SKELETON_BODY_GEOM = lathe([
  new THREE.Vector2(0.00, 0.00),
  new THREE.Vector2(0.22, 0.00),
  new THREE.Vector2(0.25, 0.12),
  new THREE.Vector2(0.20, 0.35),
  new THREE.Vector2(0.26, 0.62),
  new THREE.Vector2(0.28, 0.92),
  new THREE.Vector2(0.20, 1.18),
  new THREE.Vector2(0.14, 1.30),
  new THREE.Vector2(0.00, 1.30),
]);
const SKELETON_SKULL_GEOM = new THREE.SphereGeometry(0.26, 14, 10);

// Small extruded rib arc, reused L/R on chest.
function extrudeRib() {
  const shape = new THREE.Shape();
  shape.moveTo(-0.12, 0);
  shape.quadraticCurveTo(0, 0.06, 0.12, 0);
  shape.lineTo(0.10, -0.02);
  shape.quadraticCurveTo(0, 0.02, -0.10, -0.02);
  shape.closePath();
  return new THREE.ExtrudeGeometry(shape, {
    depth: 0.04, bevelEnabled: false, curveSegments: 4,
  });
}
const RIB_GEOM = extrudeRib();

// Arm / leg cylinders — standard skeleton dimensions.
const SK_ARM_GEOM = new THREE.CylinderGeometry(0.05, 0.045, 0.55, 6);
const SK_LEG_GEOM = new THREE.CylinderGeometry(0.06, 0.055, 0.45, 6);

function getMonsterConfig(type) {
  return monstersConfig.types[type] || monstersConfig.types[monstersConfig.default];
}

// ── Material helpers ─────────────────────────────────────────────────────
// Every body-colored part of an instance shares this material so hit-flash
// (emissive swap) and setTint() continue to work with a single mutation.
function makeBodyMat(faction, cfg) {
  const bodyHex = faction === Faction.ALLIED ? ALLIED_TINT : cfg.bodyColor;
  return new THREE.MeshStandardMaterial({ color: bodyHex, roughness: 0.7 });
}

function makeEyeMats(faction, cfg) {
  const eyeHex = faction === Faction.ALLIED ? cfg.eyeColorAllied : cfg.eyeColorHostile;
  const eyeMat = new THREE.MeshBasicMaterial({ color: eyeHex });
  const glowMat = new THREE.MeshBasicMaterial({
    color: eyeHex, transparent: true, opacity: 0.35,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  return { eyeMat, glowMat };
}

// Build two eye/glow pairs on the skull face. `y` is the world-Y of the eye
// line, `forward` is the +Z offset, `spread` is the ±X offset, `scale` is
// an extra multiplier applied to the glow meshes only.
function addEyes(group, eyeMat, glowMat, { y, forward = 0.22, spread = 0.1, scale = 1 } = {}) {
  const eyeL = new THREE.Mesh(EYE_GEOM, eyeMat);
  const eyeR = new THREE.Mesh(EYE_GEOM, eyeMat);
  const glowL = new THREE.Mesh(GLOW_GEOM, glowMat);
  const glowR = new THREE.Mesh(GLOW_GEOM, glowMat);
  eyeL.position.set(-spread, y, forward);
  eyeR.position.set( spread, y, forward);
  glowL.position.copy(eyeL.position);
  glowR.position.copy(eyeR.position);
  if (scale !== 1) { glowL.scale.setScalar(scale); glowR.scale.setScalar(scale); }
  group.add(eyeL, eyeR, glowL, glowR);
}

// Finalize a builder's output: uniform scale, userData contract, return.
function finalize(group, cfg, bodyMat, eyeMat, glowMat) {
  group.scale.setScalar(cfg.scale);
  group.userData.bodyMaterial = bodyMat;
  group.userData.eyeMaterial = eyeMat;
  group.userData.eyeGlowMaterial = glowMat;
  group.userData.monsterConfig = cfg;
  return group;
}

// ── Per-type builders ────────────────────────────────────────────────────

// Default used for the baseline "skeleton" type AND as the safe fallback
// when an unknown type key is encountered — keeps unknown enemies from
// crashing the render pipeline.
function buildStandardSkeleton(faction, cfg) {
  const group = new THREE.Group();
  const bodyMat = makeBodyMat(faction, cfg);
  const { eyeMat, glowMat } = makeEyeMats(faction, cfg);

  const body = new THREE.Mesh(SKELETON_BODY_GEOM, bodyMat);
  body.position.y = 0.0;
  group.add(body);

  // Skull flattened slightly at the back for a human-ish profile.
  const skull = new THREE.Mesh(SKELETON_SKULL_GEOM, bodyMat);
  skull.position.y = 1.48;
  skull.scale.set(1.0, 1.0, 0.88);
  group.add(skull);

  // Chest ribcage hint — two small extruded arcs stacked.
  const rib1 = new THREE.Mesh(RIB_GEOM, bodyMat);
  rib1.position.set(0, 0.88, 0.24);
  const rib2 = new THREE.Mesh(RIB_GEOM, bodyMat);
  rib2.position.set(0, 0.76, 0.23);
  rib2.scale.set(0.95, 0.85, 1);
  group.add(rib1, rib2);

  // Arms hanging at sides.
  const armL = new THREE.Mesh(SK_ARM_GEOM, bodyMat);
  armL.position.set(-0.30, 0.80, 0.0);
  const armR = new THREE.Mesh(SK_ARM_GEOM, bodyMat);
  armR.position.set( 0.30, 0.80, 0.0);
  group.add(armL, armR);

  // Legs.
  const legL = new THREE.Mesh(SK_LEG_GEOM, bodyMat);
  legL.position.set(-0.12, -0.22, 0);
  const legR = new THREE.Mesh(SK_LEG_GEOM, bodyMat);
  legR.position.set( 0.12, -0.22, 0);
  group.add(legL, legR);

  addEyes(group, eyeMat, glowMat, { y: 1.52, forward: 0.22, spread: 0.10 });

  return finalize(group, cfg, bodyMat, eyeMat, glowMat);
}

// Dispatcher — picks a per-type builder; unknown types fall through to the
// standard builder so a typo in monsters.json can't crash rendering.
function buildSkeletonMesh(faction, cfg, type) {
  switch (type) {
    case 'runner':  return buildRunner(faction, cfg);
    case 'brute':   return buildBrute(faction, cfg);
    case 'stalker': return buildStalker(faction, cfg);
    case 'giant':   return buildGiant(faction, cfg);
    case 'skeleton':
    default:        return buildStandardSkeleton(faction, cfg);
  }
}

// ── Runner ───────────────────────────────────────────────────────────────
// Slim dagger-like torso, hound snout, bent-knee legs. No arms — keeps the
// darting silhouette unambiguous at range.
const RUNNER_BODY_GEOM = lathe([
  new THREE.Vector2(0.00, 0.00),
  new THREE.Vector2(0.16, 0.00),
  new THREE.Vector2(0.14, 0.20),
  new THREE.Vector2(0.18, 0.45),
  new THREE.Vector2(0.22, 0.70),
  new THREE.Vector2(0.18, 0.95),
  new THREE.Vector2(0.10, 1.08),
  new THREE.Vector2(0.00, 1.08),
]);
const RUNNER_SKULL_GEOM = new THREE.SphereGeometry(0.20, 12, 8);
const RUNNER_SNOUT_GEOM = new THREE.ConeGeometry(0.12, 0.22, 8).rotateX(Math.PI / 2);
const RUNNER_LEG_UPPER_GEOM = new THREE.CylinderGeometry(0.055, 0.05, 0.30, 6);
const RUNNER_LEG_LOWER_GEOM = new THREE.CylinderGeometry(0.05, 0.045, 0.28, 6);
const RUNNER_KNEE_GEOM = new THREE.SphereGeometry(0.055, 8, 6);

function buildRunner(faction, cfg) {
  const group = new THREE.Group();
  const bodyMat = makeBodyMat(faction, cfg);
  const { eyeMat, glowMat } = makeEyeMats(faction, cfg);

  const body = new THREE.Mesh(RUNNER_BODY_GEOM, bodyMat);
  body.position.y = 0.0;
  group.add(body);

  // Hound skull: small sphere + forward-pointing snout.
  const skull = new THREE.Mesh(RUNNER_SKULL_GEOM, bodyMat);
  skull.position.y = 1.20;
  skull.scale.set(0.9, 0.95, 1.05);
  group.add(skull);
  const snout = new THREE.Mesh(RUNNER_SNOUT_GEOM, bodyMat);
  snout.position.set(0, 1.16, 0.18);
  group.add(snout);

  // Bent-knee two-segment legs. Upper angled slightly back, lower forward —
  // reads as mid-stride without any animation.
  const mkLeg = (sideX) => {
    const upper = new THREE.Mesh(RUNNER_LEG_UPPER_GEOM, bodyMat);
    upper.position.set(sideX, -0.05, -0.02);
    upper.rotation.x = 0.18;
    const knee = new THREE.Mesh(RUNNER_KNEE_GEOM, bodyMat);
    knee.position.set(sideX, -0.22, 0.04);
    const lower = new THREE.Mesh(RUNNER_LEG_LOWER_GEOM, bodyMat);
    lower.position.set(sideX, -0.38, 0.02);
    lower.rotation.x = -0.12;
    group.add(upper, knee, lower);
  };
  mkLeg(-0.10);
  mkLeg( 0.10);

  // Eyes sit on the skull-to-snout transition.
  addEyes(group, eyeMat, glowMat, { y: 1.22, forward: 0.14, spread: 0.07 });

  return finalize(group, cfg, bodyMat, eyeMat, glowMat);
}

// ── Brute ────────────────────────────────────────────────────────────────
// Keg-bodied tank with wide pauldrons, thick muscled arms, and a chest plate.
const BRUTE_BODY_GEOM = lathe([
  new THREE.Vector2(0.00, 0.00),
  new THREE.Vector2(0.34, 0.00),
  new THREE.Vector2(0.38, 0.20),
  new THREE.Vector2(0.48, 0.50),
  new THREE.Vector2(0.46, 0.80),
  new THREE.Vector2(0.36, 1.05),
  new THREE.Vector2(0.22, 1.20),
  new THREE.Vector2(0.00, 1.20),
]);
const BRUTE_SKULL_GEOM = new THREE.SphereGeometry(0.28, 14, 10);
const BRUTE_JAW_GEOM = new THREE.BoxGeometry(0.28, 0.12, 0.22);

// Pauldron = short wide lathe dome. Rotated to sit on top of the shoulder.
const BRUTE_PAULDRON_GEOM = lathe([
  new THREE.Vector2(0.00, 0.00),
  new THREE.Vector2(0.18, 0.00),
  new THREE.Vector2(0.20, 0.04),
  new THREE.Vector2(0.16, 0.10),
  new THREE.Vector2(0.00, 0.10),
], 10);

// Muscled arm: wider at the bicep, tapering at the forearm.
const BRUTE_ARM_GEOM = lathe([
  new THREE.Vector2(0.00, 0.00),
  new THREE.Vector2(0.11, 0.00),
  new THREE.Vector2(0.13, 0.08),
  new THREE.Vector2(0.10, 0.32),
  new THREE.Vector2(0.12, 0.46),
  new THREE.Vector2(0.09, 0.58),
  new THREE.Vector2(0.00, 0.58),
], 10);
const BRUTE_LEG_GEOM = new THREE.CylinderGeometry(0.12, 0.11, 0.44, 8);

// Chest plate — simple armored shape stretched across the torso.
function extrudeBrutePlate() {
  const s = new THREE.Shape();
  s.moveTo(-0.22, 0.00);
  s.lineTo(-0.26, 0.14);
  s.lineTo(-0.18, 0.34);
  s.lineTo( 0.18, 0.34);
  s.lineTo( 0.26, 0.14);
  s.lineTo( 0.22, 0.00);
  s.closePath();
  return new THREE.ExtrudeGeometry(s, { depth: 0.06, bevelEnabled: false, curveSegments: 4 });
}
const BRUTE_PLATE_GEOM = extrudeBrutePlate();

function buildBrute(faction, cfg) {
  const group = new THREE.Group();
  const bodyMat = makeBodyMat(faction, cfg);
  const { eyeMat, glowMat } = makeEyeMats(faction, cfg);

  const body = new THREE.Mesh(BRUTE_BODY_GEOM, bodyMat);
  body.position.y = 0.0;
  group.add(body);

  const skull = new THREE.Mesh(BRUTE_SKULL_GEOM, bodyMat);
  skull.position.y = 1.38;
  skull.scale.set(1.15, 0.9, 1.0);
  group.add(skull);
  const jaw = new THREE.Mesh(BRUTE_JAW_GEOM, bodyMat);
  jaw.position.set(0, 1.26, 0.10);
  group.add(jaw);

  const pL = new THREE.Mesh(BRUTE_PAULDRON_GEOM, bodyMat);
  pL.position.set(-0.40, 1.06, 0);
  pL.rotation.z = 0.35;
  const pR = new THREE.Mesh(BRUTE_PAULDRON_GEOM, bodyMat);
  pR.position.set(0.40, 1.06, 0);
  pR.rotation.z = -0.35;
  group.add(pL, pR);

  // Arms — lathe hangs downward by rotating π (180°) around Z.
  const armL = new THREE.Mesh(BRUTE_ARM_GEOM, bodyMat);
  armL.position.set(-0.42, 1.04, 0);
  armL.rotation.z = Math.PI;
  const armR = new THREE.Mesh(BRUTE_ARM_GEOM, bodyMat);
  armR.position.set(0.42, 1.04, 0);
  armR.rotation.z = Math.PI;
  group.add(armL, armR);

  const legL = new THREE.Mesh(BRUTE_LEG_GEOM, bodyMat);
  legL.position.set(-0.18, -0.22, 0);
  const legR = new THREE.Mesh(BRUTE_LEG_GEOM, bodyMat);
  legR.position.set(0.18, -0.22, 0);
  group.add(legL, legR);

  const plate = new THREE.Mesh(BRUTE_PLATE_GEOM, bodyMat);
  plate.position.set(0, 0.55, 0.42);
  group.add(plate);

  addEyes(group, eyeMat, glowMat, { y: 1.40, forward: 0.22, spread: 0.11 });

  return finalize(group, cfg, bodyMat, eyeMat, glowMat);
}

// ── Stalker ──────────────────────────────────────────────────────────────
// Two stacked lathes give it a low centre of mass — spider/predator profile.
// Multi-segment arms reach past its feet, claws and a third eye glow finish
// the "something is watching" silhouette.
const STALKER_THORAX_GEOM = lathe([
  new THREE.Vector2(0.00, 0.00),
  new THREE.Vector2(0.30, 0.00),
  new THREE.Vector2(0.36, 0.10),
  new THREE.Vector2(0.34, 0.26),
  new THREE.Vector2(0.20, 0.38),
  new THREE.Vector2(0.00, 0.38),
]);
const STALKER_ABDOMEN_GEOM = lathe([
  new THREE.Vector2(0.00, 0.00),
  new THREE.Vector2(0.22, 0.00),
  new THREE.Vector2(0.26, 0.08),
  new THREE.Vector2(0.20, 0.22),
  new THREE.Vector2(0.10, 0.30),
  new THREE.Vector2(0.00, 0.30),
]);
const STALKER_SKULL_GEOM = new THREE.SphereGeometry(0.20, 12, 8);

// Pointed muzzle extruded forward.
function extrudeStalkerMuzzle() {
  const s = new THREE.Shape();
  s.moveTo(-0.08, 0.06);
  s.lineTo(-0.04, -0.04);
  s.lineTo( 0.04, -0.04);
  s.lineTo( 0.08, 0.06);
  s.closePath();
  return new THREE.ExtrudeGeometry(s, { depth: 0.22, bevelEnabled: false, curveSegments: 2 });
}
const STALKER_MUZZLE_GEOM = extrudeStalkerMuzzle();

const STALKER_ARM_UPPER_GEOM = new THREE.CylinderGeometry(0.04, 0.035, 0.32, 6);
const STALKER_ARM_MID_GEOM   = new THREE.CylinderGeometry(0.035, 0.03, 0.30, 6);
const STALKER_ARM_LOWER_GEOM = new THREE.CylinderGeometry(0.03, 0.025, 0.26, 6);
const STALKER_JOINT_GEOM     = new THREE.SphereGeometry(0.04, 8, 6);
const STALKER_CLAW_GEOM      = new THREE.ConeGeometry(0.04, 0.12, 6);
const STALKER_LEG_GEOM       = new THREE.CylinderGeometry(0.05, 0.04, 0.50, 6);

function buildStalker(faction, cfg) {
  const group = new THREE.Group();
  const bodyMat = makeBodyMat(faction, cfg);
  const { eyeMat, glowMat } = makeEyeMats(faction, cfg);

  // Thorax stacks above the abdomen — the "spider body" read.
  const abdomen = new THREE.Mesh(STALKER_ABDOMEN_GEOM, bodyMat);
  abdomen.position.y = 0.30;
  group.add(abdomen);
  const thorax = new THREE.Mesh(STALKER_THORAX_GEOM, bodyMat);
  thorax.position.y = 0.62;
  group.add(thorax);

  // Elongated head pushed slightly forward (the hunch, baked into position
  // rather than group rotation so future attack-pitch can own rotation.x).
  const skull = new THREE.Mesh(STALKER_SKULL_GEOM, bodyMat);
  skull.position.set(0, 1.12, 0.08);
  skull.scale.set(0.9, 1.25, 0.95);
  group.add(skull);
  const muzzle = new THREE.Mesh(STALKER_MUZZLE_GEOM, bodyMat);
  muzzle.position.set(0, 1.08, 0.16);
  group.add(muzzle);

  // Multi-segment arms reaching down past the body.
  const mkArm = (sideX) => {
    const upper = new THREE.Mesh(STALKER_ARM_UPPER_GEOM, bodyMat);
    upper.position.set(sideX, 0.78, 0);
    const joint1 = new THREE.Mesh(STALKER_JOINT_GEOM, bodyMat);
    joint1.position.set(sideX, 0.62, 0);
    const mid = new THREE.Mesh(STALKER_ARM_MID_GEOM, bodyMat);
    mid.position.set(sideX * 1.12, 0.47, 0);
    mid.rotation.z = -sideX * 0.3;
    const joint2 = new THREE.Mesh(STALKER_JOINT_GEOM, bodyMat);
    joint2.position.set(sideX * 1.25, 0.33, 0);
    const lower = new THREE.Mesh(STALKER_ARM_LOWER_GEOM, bodyMat);
    lower.position.set(sideX * 1.15, 0.20, 0.04);
    lower.rotation.z = sideX * 0.12;
    const claw = new THREE.Mesh(STALKER_CLAW_GEOM, bodyMat);
    claw.position.set(sideX * 1.10, 0.06, 0.08);
    claw.rotation.x = Math.PI / 2;
    group.add(upper, joint1, mid, joint2, lower, claw);
  };
  mkArm(-0.28);
  mkArm( 0.28);

  // Legs — short, positioned under the abdomen.
  const legL = new THREE.Mesh(STALKER_LEG_GEOM, bodyMat);
  legL.position.set(-0.12, 0.02, 0);
  const legR = new THREE.Mesh(STALKER_LEG_GEOM, bodyMat);
  legR.position.set(0.12, 0.02, 0);
  group.add(legL, legR);

  // Enlarged main eyes + a third, smaller glow at the muzzle base.
  addEyes(group, eyeMat, glowMat, { y: 1.14, forward: 0.18, spread: 0.08, scale: 1.5 });
  const extraGlow = new THREE.Mesh(GLOW_GEOM, glowMat);
  extraGlow.scale.setScalar(0.7);
  extraGlow.position.set(0, 1.04, 0.26);
  group.add(extraGlow);

  return finalize(group, cfg, bodyMat, eyeMat, glowMat);
}

// ── Giant ────────────────────────────────────────────────────────────────
// Boss-tier silhouette: massive chest shelf, horned/crowned skull, stone
// pauldrons, thick limbs, emblem on the chest plate.
const GIANT_BODY_GEOM = lathe([
  new THREE.Vector2(0.00, 0.00),
  new THREE.Vector2(0.38, 0.00),
  new THREE.Vector2(0.42, 0.20),
  new THREE.Vector2(0.40, 0.45),
  new THREE.Vector2(0.55, 0.78),
  new THREE.Vector2(0.50, 1.05),
  new THREE.Vector2(0.35, 1.25),
  new THREE.Vector2(0.22, 1.40),
  new THREE.Vector2(0.00, 1.40),
]);
const GIANT_SKULL_GEOM = new THREE.SphereGeometry(0.34, 16, 12);
const GIANT_HORN_GEOM = new THREE.ConeGeometry(0.07, 0.30, 8);

// Armored pauldron — angular shard rather than a smooth dome.
function extrudeGiantPauldron() {
  const s = new THREE.Shape();
  s.moveTo(-0.18, 0.00);
  s.lineTo(-0.24, 0.10);
  s.lineTo(-0.20, 0.22);
  s.lineTo( 0.00, 0.30);
  s.lineTo( 0.20, 0.22);
  s.lineTo( 0.24, 0.10);
  s.lineTo( 0.18, 0.00);
  s.closePath();
  return new THREE.ExtrudeGeometry(s, { depth: 0.30, bevelEnabled: false, curveSegments: 4 });
}
const GIANT_PAULDRON_GEOM = extrudeGiantPauldron();

// Chest plate (bigger than the brute's) with an emblem slot in the middle.
function extrudeGiantPlate() {
  const s = new THREE.Shape();
  s.moveTo(-0.30, 0.00);
  s.lineTo(-0.36, 0.16);
  s.lineTo(-0.26, 0.42);
  s.lineTo( 0.26, 0.42);
  s.lineTo( 0.36, 0.16);
  s.lineTo( 0.30, 0.00);
  s.closePath();
  return new THREE.ExtrudeGeometry(s, { depth: 0.08, bevelEnabled: false, curveSegments: 4 });
}
const GIANT_PLATE_GEOM = extrudeGiantPlate();
const GIANT_EMBLEM_GEOM = new THREE.BoxGeometry(0.14, 0.14, 0.04);
const GIANT_ARM_GEOM = lathe([
  new THREE.Vector2(0.00, 0.00),
  new THREE.Vector2(0.15, 0.00),
  new THREE.Vector2(0.17, 0.12),
  new THREE.Vector2(0.14, 0.40),
  new THREE.Vector2(0.16, 0.58),
  new THREE.Vector2(0.12, 0.70),
  new THREE.Vector2(0.00, 0.70),
], 10);
const GIANT_LEG_GEOM = new THREE.CylinderGeometry(0.16, 0.14, 0.52, 8);
const GIANT_CROWN_GEOM = new THREE.TorusGeometry(0.28, 0.04, 8, 24);

function buildGiant(faction, cfg) {
  const group = new THREE.Group();
  const bodyMat = makeBodyMat(faction, cfg);
  const { eyeMat, glowMat } = makeEyeMats(faction, cfg);

  const body = new THREE.Mesh(GIANT_BODY_GEOM, bodyMat);
  body.position.y = 0.0;
  group.add(body);

  // Skull + two horns + an emissive crown that reads at distance.
  const skull = new THREE.Mesh(GIANT_SKULL_GEOM, bodyMat);
  skull.position.y = 1.60;
  group.add(skull);

  const hornL = new THREE.Mesh(GIANT_HORN_GEOM, bodyMat);
  hornL.position.set(-0.22, 1.82, 0);
  hornL.rotation.z = -0.35;
  const hornR = new THREE.Mesh(GIANT_HORN_GEOM, bodyMat);
  hornR.position.set( 0.22, 1.82, 0);
  hornR.rotation.z =  0.35;
  group.add(hornL, hornR);

  const crownMat = new THREE.MeshBasicMaterial({
    color: 0xffb060, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const crown = new THREE.Mesh(GIANT_CROWN_GEOM, crownMat);
  crown.position.y = 1.88;
  crown.rotation.x = Math.PI / 2;
  group.add(crown);

  // Shoulders — angular extruded plates sitting flat on top of the shoulders.
  const padL = new THREE.Mesh(GIANT_PAULDRON_GEOM, bodyMat);
  padL.position.set(-0.55, 1.18, -0.15);
  const padR = new THREE.Mesh(GIANT_PAULDRON_GEOM, bodyMat);
  padR.position.set(0.25, 1.18, -0.15);
  group.add(padL, padR);

  // Thick arms hang from under the pauldrons.
  const armL = new THREE.Mesh(GIANT_ARM_GEOM, bodyMat);
  armL.position.set(-0.52, 1.18, 0);
  armL.rotation.z = Math.PI;
  const armR = new THREE.Mesh(GIANT_ARM_GEOM, bodyMat);
  armR.position.set(0.52, 1.18, 0);
  armR.rotation.z = Math.PI;
  group.add(armL, armR);

  // Thick legs.
  const legL = new THREE.Mesh(GIANT_LEG_GEOM, bodyMat);
  legL.position.set(-0.22, -0.26, 0);
  const legR = new THREE.Mesh(GIANT_LEG_GEOM, bodyMat);
  legR.position.set(0.22, -0.26, 0);
  group.add(legL, legR);

  // Chest plate + emblem (emblem is mildly emissive additive, picks up bloom
  // if post-processing is later re-enabled).
  const plate = new THREE.Mesh(GIANT_PLATE_GEOM, bodyMat);
  plate.position.set(0, 0.72, 0.48);
  group.add(plate);
  const emblemMat = new THREE.MeshBasicMaterial({
    color: 0xffd080, transparent: true, opacity: 0.85,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const emblem = new THREE.Mesh(GIANT_EMBLEM_GEOM, emblemMat);
  emblem.position.set(0, 0.96, 0.55);
  group.add(emblem);

  addEyes(group, eyeMat, glowMat, { y: 1.62, forward: 0.28, spread: 0.13 });

  return finalize(group, cfg, bodyMat, eyeMat, glowMat);
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

    // Bounty for killing this monster. Read by ProgressionSystem on
    // ENEMY_DIED; scales with the monster's relative size/power (configured
    // per-type in monsters.json).
    this.soulValue = cfg.soulValue ?? 1;

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

    this.mesh = buildSkeletonMesh(faction, cfg, this.type);
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

    // Ground dust ring + rising dust column. Allied summons also get a
    // colored rune ring so different minion types read visually on spawn.
    const cfg = this.mesh.userData.monsterConfig;
    const groundPos = this.position.clone();
    groundPos.y = 0.04;
    FxPool.expandingRing({
      position: groundPos, color: 0xa88a5a, maxRadius: 2.4, duration: 0.4,
    });
    if (this.faction === Faction.ALLIED && cfg?.bodyColor) {
      FxPool.expandingRing({
        position: groundPos, color: cfg.bodyColor, maxRadius: 1.7,
        duration: 0.55, yOffset: 0.12,
      });
    }
    FxPool.burst({
      position: groundPos, count: 14, color: 0xb09a7a,
      spread: 1.4, lifetime: 0.7, kind: 'dust', velocityY: 3.2, gravity: false,
    });
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

  // `cause` is passed through to die() so the ENEMY_DIED subscriber can tell
  // fog/environmental deaths apart from player-caused kills. Always overwrite
  // so the final damage source wins — a hostile that ate fog damage but was
  // finished off by a bullet should still credit the shooter, not the fog.
  takeDamage(amount, cause = null) {
    if (!this.alive) return;
    this.stats.takeDamage(amount);
    this._hitFlash = 3;
    this._deathCause = cause;
    events.emit(GameEvent.ENEMY_HIT, { skeleton: this, amount });
    if (!this.stats.isAlive()) this.die();
  }

  die() {
    if (!this.alive) return;
    this.alive = false;
    this._dying = true;
    this._deathTimer = 0;

    // Bone fragments + ground dust. The existing y-scale collapse on the
    // main mesh still plays; these particles carry the visual weight so
    // deaths don't feel weightless.
    const cfg = this.mesh.userData.monsterConfig;
    const s = cfg?.scale ?? 1;
    const center = this.position.clone();
    center.y = 0.7 * s;
    FxPool.burst({
      position: center, count: 6, color: cfg?.bodyColor ?? 0xdddd6c,
      spread: 2.6, lifetime: 0.8, kind: 'bone', velocityY: 3.5, gravity: true,
      scale: s,
    });
    const ground = this.position.clone();
    ground.y = 0.05;
    FxPool.burst({
      position: ground, count: 10, color: 0xb0a090,
      spread: 1.4, lifetime: 0.55, kind: 'dust', velocityY: 1.0, gravity: false,
    });

    events.emit(GameEvent.ENEMY_DIED, { skeleton: this, cause: this._deathCause ?? null });
  }

  isRemovable() {
    return !this.alive && !this._dying;
  }
}
