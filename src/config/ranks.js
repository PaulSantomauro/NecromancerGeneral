// Shared rank ladder + XP formula for career progression.
//
// Imported by both the browser client and the Node server (both are ES
// modules). Kept dependency-free so server imports don't pull in any DOM,
// Three.js, or build-only code.
//
// XP is never stored directly — it's a pure function of the career_stats
// columns below. That way "what the player sees" and "what's in the DB"
// can never drift.

export const RANKS = [
  { level: 0,  title: 'Conscript',           xp: 0 },
  { level: 1,  title: 'Graveborn',           xp: 1000 },
  { level: 2,  title: 'Bonecaller',          xp: 3000 },
  { level: 3,  title: 'Lichsworn',           xp: 7000 },
  { level: 4,  title: 'Shadewright',         xp: 15000 },
  { level: 5,  title: 'Gravekeeper',         xp: 30000 },
  { level: 6,  title: 'Deathbinder',         xp: 55000 },
  { level: 7,  title: 'Crypt Marshal',       xp: 95000 },
  { level: 8,  title: 'Warlord of the Dead', xp: 160000 },
  { level: 9,  title: 'Necromancer General', xp: 260000 },
  { level: 10, title: 'Eternal Emperor',     xp: 400000 },
];

export const MAX_LEVEL = RANKS[RANKS.length - 1].level;

// XP formula — applied uniformly server- and client-side.
//   100 per round played (shows up + survives through end)
//   +10 per PvE kill
//   +250 per PvP kill (generals are rare and hard)
//   +100 per round won (stacks with rounds_played)
export function xpFor(stats) {
  if (!stats) return 0;
  const rp  = stats.rounds_played ?? 0;
  const pve = stats.pve_kills     ?? 0;
  const pvp = stats.pvp_kills     ?? 0;
  const rw  = stats.rounds_won    ?? 0;
  return rp * 100 + pve * 10 + pvp * 250 + rw * 100;
}

export function levelFor(xp) {
  let lvl = 0;
  for (const r of RANKS) {
    if (xp >= r.xp) lvl = r.level;
    else break;
  }
  return lvl;
}

export function rankFor(xp) {
  return RANKS[levelFor(xp)];
}

// Returns { current, next, progress } so the UI can render a progress bar
// toward the next rank without recomputing thresholds. `progress` is a
// 0–1 fraction; always 1 when the player is at MAX_LEVEL.
export function progressFor(xp) {
  const lvl = levelFor(xp);
  const current = RANKS[lvl];
  const next = RANKS[lvl + 1] ?? null;
  if (!next) return { current, next: null, progress: 1, xpIntoLevel: 0, xpForLevel: 0 };
  const span = next.xp - current.xp;
  const into = xp - current.xp;
  return {
    current,
    next,
    progress: Math.max(0, Math.min(1, into / span)),
    xpIntoLevel: into,
    xpForLevel: span,
  };
}

export function titleFor(level) {
  const l = Math.max(0, Math.min(MAX_LEVEL, level | 0));
  return RANKS[l].title;
}
