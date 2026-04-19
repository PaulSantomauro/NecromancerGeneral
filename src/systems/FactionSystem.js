import { buildAlliedTree } from './BehaviorTree.js';
import { GameEvent, events } from './EventSystem.js';

export const Faction = Object.freeze({ HOSTILE: 'hostile', ALLIED: 'allied' });
export const MAX_ALLIES = 40;

export function convertEnemy(skeleton, allSkeletons) {
  if (!skeleton.alive) return false;
  if (skeleton.faction === Faction.ALLIED) return false;
  const alliedCount = allSkeletons.filter(s => s.alive && s.faction === Faction.ALLIED).length;
  if (alliedCount >= MAX_ALLIES) return false;
  skeleton.faction = Faction.ALLIED;
  skeleton.behaviorTree = buildAlliedTree();
  skeleton._attackTarget = null;
  skeleton.isAttacking = false;
  skeleton.setTint?.(0x4488ff);
  events.emit(GameEvent.ENEMY_CONVERTED, { skeleton });
  return true;
}
