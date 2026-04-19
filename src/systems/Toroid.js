// Bounded-world utilities. Module name kept for minimal-diff: the old toroidal
// names are repurposed as euclidean + boundary clamp. Positions are restricted
// to a [-HALF, +HALF] square. Distance is straight-line.

import battleConfig from '../config/battle.json';

export const WORLD_SIZE = battleConfig.worldSize ?? 200;
export const HALF = WORLD_SIZE / 2;

const EDGE_BUFFER = 0.5; // keep entities slightly inside the wall

export function wrapCoord(v) {
  if (v > HALF - EDGE_BUFFER) return HALF - EDGE_BUFFER;
  if (v < -HALF + EDGE_BUFFER) return -HALF + EDGE_BUFFER;
  return v;
}

export function wrapPosition(pos) {
  pos.x = wrapCoord(pos.x);
  pos.z = wrapCoord(pos.z);
  return pos;
}

export function toroidalDelta(ax, az, bx, bz) {
  return { dx: bx - ax, dz: bz - az };
}

export function toroidalDistSq(ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  return dx * dx + dz * dz;
}

export function toroidalDist(ax, az, bx, bz) {
  return Math.sqrt(toroidalDistSq(ax, az, bx, bz));
}

/** Rendering: entity renders at its actual world position. */
export function closestWrap(entityV, _cameraV) {
  return entityV;
}
