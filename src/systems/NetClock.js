// Server-time anchor used for snapshot interpolation.
//
// Snapshots are timestamped with the server's `Date.now()` at emit time.
// On the first packet we compute baseOffset = serverT - performance.now(), so
// `performance.now() + baseOffset` is a continuous estimate of "current server
// time" that advances at 60fps regardless of TCP packet bursting.
//
// Render time is then serverNow - INTERP_DELAY_MS, which keeps us slightly
// behind the latest snapshot so we always have two snaps to lerp between.

const INTERP_DELAY_MS = 100;

let baseOffset = null;

export function syncClock(serverT) {
  if (typeof serverT !== 'number') return;
  if (baseOffset === null) {
    baseOffset = serverT - performance.now();
    return;
  }
  // Soft re-anchor: if we drifted forward (server is ahead of where we
  // thought), pull baseOffset toward the new sample. Never go backward —
  // that would cause render time to jump back and stutter.
  const sample = serverT - performance.now();
  if (sample > baseOffset) {
    baseOffset = baseOffset + (sample - baseOffset) * 0.05;
  }
}

export function getRenderTime() {
  if (baseOffset === null) return null;
  return performance.now() + baseOffset - INTERP_DELAY_MS;
}

export function isReady() {
  return baseOffset !== null;
}
