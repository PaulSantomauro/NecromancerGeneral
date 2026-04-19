// Server-side skeleton AI. Plain JS — no THREE.
// Mirrors client BehaviorTree logic but operates on {x, z} pos objects.
// Uses toroidal wrapping.

const WORLD_SIZE = 200;
const W_HALF = WORLD_SIZE / 2;
const EDGE_BUFFER = 0.5;
const MIN_SEPARATION = 0.8;
const BODY_RADIUS = 0.4;
const PLAYER_HIT_RADIUS = 0.9;

function wrapC(v) {
  if (v > W_HALF - EDGE_BUFFER) return W_HALF - EDGE_BUFFER;
  if (v < -W_HALF + EDGE_BUFFER) return -W_HALF + EDGE_BUFFER;
  return v;
}
function wrapP(p) { p.x = wrapC(p.x); p.z = wrapC(p.z); return p; }

function tDelta(ax, az, bx, bz) {
  return { dx: bx - ax, dz: bz - az };
}

function dist(a, b) {
  const { dx, dz } = tDelta(a.x, a.z, b.x, b.z);
  return Math.hypot(dx, dz);
}

function moveToward(entity, targetX, targetZ, dt, speedScale = 1) {
  const { dx, dz } = tDelta(entity.pos.x, entity.pos.z, targetX, targetZ);
  const d = Math.hypot(dx, dz);
  if (d > 0.1) {
    const step = entity.moveSpeed * speedScale * dt;
    entity.pos.x += (dx / d) * step;
    entity.pos.z += (dz / d) * step;
    wrapP(entity.pos);
  }
}

function nearestFromList(entity, candidates, maxRange) {
  let best = null;
  let bestDsq = maxRange * maxRange;
  for (const c of candidates) {
    const { dx, dz } = tDelta(entity.pos.x, entity.pos.z, c.pos.x, c.pos.z);
    const dsq = dx * dx + dz * dz;
    if (dsq < bestDsq) {
      bestDsq = dsq;
      best = c;
    }
  }
  return best;
}

export class BattleLoop {
  constructor({ skeletons, players, emit }) {
    this.skeletons = skeletons;
    this.players = players;
    this.emit = emit;
  }

  tick(dt) {
    // Cache lists
    const hostiles = [];
    const allies = [];
    for (const sk of this.skeletons.values()) {
      if (sk.hp <= 0) continue;
      if (sk.faction === 'hostile') hostiles.push(sk);
      else allies.push(sk);
    }

    const allPlayersArr = [...this.players.values()];

    // ── Per-skeleton AI ─────────────────────────────────────────────────
    for (const sk of this.skeletons.values()) {
      if (sk.hp <= 0) continue;
      if (sk.cooldownTimer > 0) sk.cooldownTimer = Math.max(0, sk.cooldownTimer - dt);

      if (sk.isAttacking) {
        sk.attackTimer -= dt;
        if (sk.attackTimer <= 0) {
          this._resolveAttack(sk);
          sk.isAttacking = false;
          sk.cooldownTimer = 0.5 + Math.random() * 0.5;
          sk.attackTargetId = null;
          sk.attackTargetKind = null;
        }
        continue;
      }

      if (sk.faction === 'hostile') {
        this._hostileBehavior(sk, allies, allPlayersArr, dt);
      } else {
        this._alliedBehavior(sk, hostiles, dt);
      }
    }

    // ── Separation (skeleton vs skeleton, XZ only) ──────────────────────
    const alive = [...this.skeletons.values()].filter(s => s.hp > 0);
    for (let i = 0; i < alive.length; i++) {
      const a = alive[i];
      for (let j = i + 1; j < alive.length; j++) {
        const b = alive[j];
        const { dx, dz } = tDelta(b.pos.x, b.pos.z, a.pos.x, a.pos.z);
        const dsq = dx * dx + dz * dz;
        if (dsq < MIN_SEPARATION * MIN_SEPARATION && dsq > 0.0001) {
          const d = Math.sqrt(dsq);
          const push = (MIN_SEPARATION - d) / 2;
          const nx = dx / d;
          const nz = dz / d;
          a.pos.x += nx * push;
          a.pos.z += nz * push;
          b.pos.x -= nx * push;
          b.pos.z -= nz * push;
        }
      }
    }
  }

  _hostileBehavior(sk, allies, allPlayersArr, dt) {
    // Attack range check vs allies + players
    if (sk.cooldownTimer <= 0) {
      let attackTarget = null;
      let attackKind = null;
      let bestDsq = sk.attackRange * sk.attackRange;

      for (const ally of allies) {
        const dsq = (ally.pos.x - sk.pos.x) ** 2 + (ally.pos.z - sk.pos.z) ** 2;
        if (dsq < bestDsq) {
          bestDsq = dsq;
          attackTarget = ally;
          attackKind = 'skeleton';
        }
      }
      for (const p of allPlayersArr) {
        if (p.hp <= 0) continue;
        const dsq = (p.pos.x - sk.pos.x) ** 2 + (p.pos.z - sk.pos.z) ** 2;
        if (dsq < bestDsq) {
          bestDsq = dsq;
          attackTarget = p;
          attackKind = 'player';
        }
      }

      if (attackTarget) {
        sk.isAttacking = true;
        sk.attackTimer = sk.attackDuration;
        sk.attackTargetId = attackTarget.id;
        sk.attackTargetKind = attackKind;
        return;
      }
    }

    // Aggro chase
    let chaseTarget = null;
    let bestDsq = sk.aggroRadius * sk.aggroRadius;
    for (const ally of allies) {
      const dsq = (ally.pos.x - sk.pos.x) ** 2 + (ally.pos.z - sk.pos.z) ** 2;
      if (dsq < bestDsq) { bestDsq = dsq; chaseTarget = ally; }
    }
    for (const p of allPlayersArr) {
      if (p.hp <= 0) continue;
      const dsq = (p.pos.x - sk.pos.x) ** 2 + (p.pos.z - sk.pos.z) ** 2;
      if (dsq < bestDsq) { bestDsq = dsq; chaseTarget = p; }
    }
    if (chaseTarget) {
      moveToward(sk, chaseTarget.pos.x, chaseTarget.pos.z, dt);
      return;
    }

    // Patrol
    sk.patrolTimer -= dt;
    if (!sk.patrolTarget || sk.patrolTimer <= 0 ||
        dist(sk.pos, sk.patrolTarget) < 0.8) {
      const angle = Math.random() * Math.PI * 2;
      const r = 1 + Math.random() * sk.patrolRadius;
      sk.patrolTarget = {
        x: sk.patrolCenter.x + Math.cos(angle) * r,
        z: sk.patrolCenter.z + Math.sin(angle) * r,
      };
      sk.patrolTimer = 2 + Math.random() * 3;
    }
    moveToward(sk, sk.patrolTarget.x, sk.patrolTarget.z, dt, 0.4);
  }

  _alliedBehavior(sk, hostiles, dt) {
    // Attack check
    if (sk.cooldownTimer <= 0) {
      const attackTarget = nearestFromList(sk, hostiles, sk.attackRange);
      if (attackTarget) {
        sk.isAttacking = true;
        sk.attackTimer = sk.attackDuration;
        sk.attackTargetId = attackTarget.id;
        sk.attackTargetKind = 'skeleton';
        return;
      }
    }

    // Leash back to owner
    const owner = sk.ownerId ? this.players.get(sk.ownerId) : null;
    if (owner && dist(sk.pos, owner.pos) > sk.guardRadius) {
      moveToward(sk, owner.pos.x, owner.pos.z, dt);
      return;
    }

    // Engage hostile within range
    const engage = nearestFromList(sk, hostiles, sk.engageRadius);
    if (engage) {
      moveToward(sk, engage.pos.x, engage.pos.z, dt);
      return;
    }

    // Guard idle wander near owner
    if (owner) {
      sk.guardIdleTimer -= dt;
      if (!sk.guardIdleTarget || sk.guardIdleTimer <= 0 ||
          dist(sk.pos, sk.guardIdleTarget) < 0.8) {
        const angle = Math.random() * Math.PI * 2;
        const r = 3 + Math.random() * (sk.guardRadius * 0.5);
        sk.guardIdleTarget = {
          x: owner.pos.x + Math.cos(angle) * r,
          z: owner.pos.z + Math.sin(angle) * r,
        };
        sk.guardIdleTimer = 2 + Math.random() * 2;
      }
      moveToward(sk, sk.guardIdleTarget.x, sk.guardIdleTarget.z, dt, 0.35);
    }
  }

  _resolveAttack(sk) {
    if (!sk.attackTargetId) return;

    if (sk.attackTargetKind === 'skeleton') {
      const target = this.skeletons.get(sk.attackTargetId);
      if (!target || target.hp <= 0) return;
      const d = dist(sk.pos, target.pos);
      if (d > sk.attackRange + 0.5) return;
      target.hp -= sk.damage;
      if (target.hp <= 0) {
        if (target.ownerId) {
          const owner = this.players.get(target.ownerId);
          if (owner) owner.allies.delete(target.id);
        }
        this.skeletons.delete(target.id);
        this.emit('skeleton_died', { id: target.id, killerId: null });
      }
    } else if (sk.attackTargetKind === 'player') {
      const target = this.players.get(sk.attackTargetId);
      if (!target || target.hp <= 0) return;
      const d = dist(sk.pos, target.pos);
      if (d > sk.attackRange + 0.8) return;
      target.hp -= sk.damage;
      if (target.connected) {
        this.emit('player_damaged', {
          playerId: target.id,
          hp: target.hp,
          amount: sk.damage,
          source: { x: sk.pos.x, z: sk.pos.z },
        });
      }
      if (target.hp <= 0) {
        // Kill the general
        for (const sid of target.allies) {
          this.skeletons.delete(sid);
          this.emit('skeleton_died', { id: sid, killerId: null });
        }
        target.allies.clear();
        this.emit('general_died', { playerId: target.id, killedBy: null });
        this.players.delete(target.id);
      }
    }
  }
}
