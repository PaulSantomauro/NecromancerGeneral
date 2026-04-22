export const GameEvent = Object.freeze({
  PLAYER_FIRED:       'player_fired',
  PROJECTILE_HIT:     'projectile_hit',
  PROJECTILE_EXPIRED: 'projectile_expired',
  ENEMY_HIT:          'enemy_hit',
  ENEMY_DIED:         'enemy_died',
  ENEMY_CONVERTED:    'enemy_converted',
  MINION_SPAWNED:     'minion_spawned',
  AMMO_CHANGED:       'ammo_changed',
  BATTLE_TICK:        'battle_tick',
  ENERGY_CHANGED:     'energy_changed',
  ENERGY_EXHAUSTED:   'energy_exhausted',
  SOULS_CHANGED:      'souls_changed',
  UPGRADE_PURCHASED:  'upgrade_purchased',
  PLAYER_DAMAGED:     'player_damaged',
  PLAYER_DIED:        'player_died',
  NET_STATE_TICK:         'net_state_tick',
  NET_SKELETON_DIED:      'net_skeleton_died',
  NET_SKELETON_CONVERTED: 'net_skeleton_converted',
  NET_SKELETON_SPAWNED:   'net_skeleton_spawned',
  NET_GENERAL_DIED:       'net_general_died',
  NET_SOULS_GRANTED:      'net_souls_granted',
  NET_PLAYER_JOINED:      'net_player_joined',
  NET_PLAYER_LEFT:        'net_player_left',
  NET_UPGRADE_APPLIED:    'net_upgrade_applied',
  NET_PLAYER_DAMAGED:     'net_player_damaged',
  NET_ALLY_STATE:         'net_ally_state',
  NET_ALLY_SPAWNED:       'net_ally_spawned',
  NET_ALLY_DIED:          'net_ally_died',
  NET_PLAYER_FIRED_REMOTE:'net_player_fired_remote',
  NET_ROUND_ENDED:        'net_round_ended',
  DAMAGE_INDICATOR:       'damage_indicator',
  PLAYER_KILL:            'player_kill',
  FIRE_FAILED:            'fire_failed',
  HIT_MARKER:             'hit_marker',
  PHASE_TRANSITION:       'phase_transition',
});

export class EventSystem {
  constructor() { this._listeners = {}; }
  subscribe(event, cb) {
    (this._listeners[event] ??= []).push(cb);
    return () => this.unsubscribe(event, cb);
  }
  unsubscribe(event, cb) {
    if (this._listeners[event])
      this._listeners[event] = this._listeners[event].filter(f => f !== cb);
  }
  emit(event, data = {}) {
    this._listeners[event]?.slice().forEach(cb => cb(data));
  }
}

export const events = new EventSystem();
