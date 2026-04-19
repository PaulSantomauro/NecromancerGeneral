import { Faction } from './FactionSystem.js';
import { toroidalDelta, toroidalDistSq } from './Toroid.js';

const MIN_SEPARATION = 0.8;

export function resolveAllCombat(skeletons, projectiles, player, dt, networked = false, phase = 'pvp') {
  const hostiles = [];
  const allies = [];
  for (const s of skeletons) {
    if (!s.alive) continue;
    if (s.faction === Faction.HOSTILE) hostiles.push(s);
    else allies.push(s);
  }

  if (networked) {
    // Server is authoritative on damage; we still run the projectile loop
    // so bullets visually disappear on contact. Projectile.onHit skips
    // local damage when its `networked` flag is set.
    runProjectileHits(skeletons, projectiles, hostiles, allies, phase);
    runSeparation(skeletons);
    return;
  }

  for (const attacker of skeletons) {
    if (!attacker.alive || !attacker.isAttacking || !attacker._attackTarget) continue;
    const target = attacker._attackTarget;
    if (!target.alive) { attacker._attackTarget = null; continue; }
    const dist = Math.sqrt(toroidalDistSq(attacker.position.x, attacker.position.z, target.position.x, target.position.z));
    if (dist <= attacker.attackRange + 0.5) {
      target.takeDamage(attacker.stats.damage, attacker);
      attacker.isAttacking = false;
      const cdMin = attacker._cooldownMin ?? 0.5;
      const cdMax = attacker._cooldownMax ?? 1.0;
      attacker.cooldownTimer = cdMin + Math.random() * (cdMax - cdMin);
      attacker._attackTarget = null;
    }
  }

  runProjectileHits(skeletons, projectiles, hostiles, allies, phase);
  runSeparation(skeletons);
}

const BODY_RADIUS = 0.55;
const BODY_LOW = -0.2;
const BODY_HIGH = 1.8;

function runProjectileHits(skeletons, projectiles, hostiles, allies, phase) {
  // During PvE all generals are allied, so remote allies (other players'
  // minions) are untargetable — only local hostiles count. During PvP,
  // everything that isn't tagged friendly is fair game, including remote
  // allies we can shoot to thin the enemy's army.
  const playerTargets = phase === 'pvp'
    ? skeletons.filter(s => s.alive && !s.friendly)
    : skeletons.filter(s => s.alive && s.faction === Faction.HOSTILE);
  for (const proj of projectiles) {
    if (!proj.alive || proj.arc) continue;
    const targets = proj.faction === 'player' ? playerTargets : allies;
    for (const sk of targets) {
      if (!sk.alive) continue;
      const { dx, dz } = toroidalDelta(sk.position.x, sk.position.z, proj.position.x, proj.position.z);
      const horizSq = dx * dx + dz * dz;
      const r = proj.radius + BODY_RADIUS;
      if (horizSq > r * r) continue;
      const dy = proj.position.y - sk.position.y;
      if (dy < BODY_LOW || dy > BODY_HIGH) continue;
      proj.onHit(sk, skeletons);
      proj.alive = false;
      break;
    }
  }
}

function runSeparation(skeletons) {
  for (let i = 0; i < skeletons.length; i++) {
    const a = skeletons[i];
    if (!a.alive) continue;
    for (let j = i + 1; j < skeletons.length; j++) {
      const b = skeletons[j];
      if (!b.alive) continue;
      const { dx, dz } = toroidalDelta(b.position.x, b.position.z, a.position.x, a.position.z);
      const dsq = dx * dx + dz * dz;
      if (dsq < MIN_SEPARATION * MIN_SEPARATION && dsq > 0.0001) {
        const dist = Math.sqrt(dsq);
        const push = (MIN_SEPARATION - dist) / 2;
        const nx = dx / dist;
        const nz = dz / dist;
        a.position.x += nx * push;
        a.position.z += nz * push;
        b.position.x -= nx * push;
        b.position.z -= nz * push;
      }
    }
  }
}
