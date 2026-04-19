import * as THREE from 'three';
import { toroidalDelta, toroidalDist, toroidalDistSq, wrapPosition } from './Toroid.js';

export const BT = Object.freeze({ SUCCESS: 1, FAILURE: 2, RUNNING: 3 });

export class Sequence {
  constructor(children) { this.children = children; }
  execute(ctx) {
    for (const c of this.children) {
      const r = c.execute(ctx);
      if (r !== BT.SUCCESS) return r;
    }
    return BT.SUCCESS;
  }
}

export class Selector {
  constructor(children) { this.children = children; }
  execute(ctx) {
    for (const c of this.children) {
      const r = c.execute(ctx);
      if (r !== BT.FAILURE) return r;
    }
    return BT.FAILURE;
  }
}

export class Action {
  constructor(fn) { this.fn = fn; }
  execute(ctx) { return this.fn(ctx); }
}

export class Condition {
  constructor(fn) { this.fn = fn; }
  execute(ctx) { return this.fn(ctx) ? BT.SUCCESS : BT.FAILURE; }
}

export function pursueTarget(entity, targetPos, dt, speedScale = 1) {
  const { dx, dz } = toroidalDelta(
    entity.position.x, entity.position.z,
    targetPos.x, targetPos.z,
  );
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist > 0.1) {
    const step = entity.stats.moveSpeed * speedScale * dt;
    entity.position.x += (dx / dist) * step;
    entity.position.z += (dz / dist) * step;
    wrapPosition(entity.position);
  }
}

export function findNearest(entity, targets, maxRange) {
  let best = null;
  let bestDist = maxRange * maxRange;
  for (const t of targets) {
    if (!t || !t.alive || t === entity) continue;
    const d = toroidalDistSq(entity.position.x, entity.position.z, t.position.x, t.position.z);
    if (d < bestDist) { bestDist = d; best = t; }
  }
  return best;
}

function startAttack(entity) {
  entity.isAttacking = true;
  entity.attackTimer = entity.attackDuration;
}

function pickPatrolPoint(center, radius) {
  const angle = Math.random() * Math.PI * 2;
  const r = 1 + Math.random() * radius;
  return new THREE.Vector3(
    center.x + Math.cos(angle) * r,
    0,
    center.z + Math.sin(angle) * r,
  );
}

const attackWait = new Action(ctx => {
  if (ctx.entity.isAttacking) {
    ctx.entity.attackTimer -= ctx.dt;
    if (ctx.entity.attackTimer <= 0) ctx.entity.isAttacking = false;
    return BT.SUCCESS;
  }
  return BT.FAILURE;
});

export function buildHostileTree() {
  return new Selector([
    attackWait,

    new Sequence([
      new Condition(ctx => {
        if (ctx.entity.cooldownTimer > 0) return false;
        const enemies = [...ctx.allies, ctx.player];
        const t = findNearest(ctx.entity, enemies, ctx.entity.attackRange);
        if (t) { ctx.entity._attackTarget = t; return true; }
        return false;
      }),
      new Action(ctx => { startAttack(ctx.entity); return BT.SUCCESS; }),
    ]),

    new Action(ctx => {
      const enemies = [...ctx.allies, ctx.player];
      const t = findNearest(ctx.entity, enemies, ctx.entity.aggroRadius);
      if (t) {
        ctx.entity._attackTarget = null;
        pursueTarget(ctx.entity, t.position, ctx.dt);
        return BT.SUCCESS;
      }
      return BT.FAILURE;
    }),

    new Action(ctx => {
      const e = ctx.entity;
      e.patrolTimer -= ctx.dt;
      if (!e.patrolTarget || e.patrolTimer <= 0
          || toroidalDist(e.position.x, e.position.z, e.patrolTarget.x, e.patrolTarget.z) < 0.8) {
        e.patrolTarget = pickPatrolPoint(e.patrolCenter, e.patrolRadius);
        wrapPosition(e.patrolTarget);
        e.patrolTimer = 2 + Math.random() * 3;
      }
      pursueTarget(e, e.patrolTarget, ctx.dt, 0.4);
      return BT.SUCCESS;
    }),
  ]);
}

export function buildAlliedTree() {
  return new Selector([
    attackWait,

    new Sequence([
      new Condition(ctx => {
        if (ctx.entity.cooldownTimer > 0) return false;
        const t = findNearest(ctx.entity, ctx.hostiles, ctx.entity.attackRange);
        if (t) { ctx.entity._attackTarget = t; return true; }
        return false;
      }),
      new Action(ctx => { startAttack(ctx.entity); return BT.SUCCESS; }),
    ]),

    // Attack-move: march toward a commanded point, but intercept hostiles
    // within engageRadius along the way. On arrival, convert the target to
    // a guard point so the ally holds that ground.
    new Action(ctx => {
      const e = ctx.entity;
      const t = e._attackMoveTarget;
      if (!t) return BT.FAILURE;

      const h = findNearest(e, ctx.hostiles, e.engageRadius);
      if (h) {
        e._attackTarget = null;
        pursueTarget(e, h.position, ctx.dt);
        return BT.SUCCESS;
      }

      const dist = toroidalDist(e.position.x, e.position.z, t.x, t.z);
      if (dist < 1.5) {
        e._attackMoveTarget = null;
        e._guardPoint = { position: new THREE.Vector3(t.x, 0, t.z) };
        return BT.FAILURE;
      }

      pursueTarget(e, t, ctx.dt);
      return BT.SUCCESS;
    }),

    new Action(ctx => {
      const e = ctx.entity;
      const anchor = e._guardPoint || ctx.player;
      const distToAnchor = toroidalDist(e.position.x, e.position.z, anchor.position.x, anchor.position.z);
      if (distToAnchor > e.guardRadius) {
        e._attackTarget = null;
        pursueTarget(e, anchor.position, ctx.dt);
        return BT.SUCCESS;
      }
      return BT.FAILURE;
    }),

    new Action(ctx => {
      const e = ctx.entity;
      const anchor = e._guardPoint || ctx.player;
      const t = findNearest(e, ctx.hostiles, e.engageRadius);
      if (t) {
        const targetDistToAnchor = toroidalDist(anchor.position.x, anchor.position.z, t.position.x, t.position.z);
        if (targetDistToAnchor <= e.guardRadius + e.engageRadius) {
          e._attackTarget = null;
          pursueTarget(e, t.position, ctx.dt);
          return BT.SUCCESS;
        }
      }
      return BT.FAILURE;
    }),

    new Action(ctx => {
      const e = ctx.entity;
      const anchor = e._guardPoint || ctx.player;
      e.guardIdleTimer -= ctx.dt;
      if (!e.guardIdleTarget || e.guardIdleTimer <= 0
          || toroidalDist(e.position.x, e.position.z, e.guardIdleTarget.x, e.guardIdleTarget.z) < 0.8) {
        const angle = Math.random() * Math.PI * 2;
        const r = 3 + Math.random() * (e.guardRadius * 0.5);
        e.guardIdleTarget = new THREE.Vector3(
          anchor.position.x + Math.cos(angle) * r,
          0,
          anchor.position.z + Math.sin(angle) * r,
        );
        wrapPosition(e.guardIdleTarget);
        e.guardIdleTimer = 2 + Math.random() * 2;
      }
      pursueTarget(e, e.guardIdleTarget, ctx.dt, 0.35);
      return BT.SUCCESS;
    }),
  ]);
}
