import { io } from 'socket.io-client';
import { GameEvent, events } from './EventSystem.js';
import { syncClock } from './NetClock.js';

export class NetworkSystem {
  constructor({ serverUrl, playerId, name, onRestore, onWelcome }) {
    this.playerId = playerId;
    this._name = name;
    this._onRestore = onRestore;
    this._onWelcome = onWelcome;
    this.connected = false;

    this.socket = io(serverUrl, { transports: ['websocket'] });

    this.socket.on('connect', () => {
      this.connected = true;
      // `connect` fires for the initial connection and every auto-reconnect
      // after a transient drop (wifi blip, tab suspend). Re-emitting `join`
      // here is the single path that restores our state on the server: the
      // initial handshake, a mid-session reconnect, and the explicit
      // rejoin() call below all land here.
      this.socket.emit('join', { playerId: this.playerId, name: this._name });
    });

    this.socket.on('disconnect', () => {
      this.connected = false;
    });

    this.socket.on('restore_state', (data) => this._onRestore(data));
    this.socket.on('welcome',       (data) => this._onWelcome(data));

    this.socket.on('state_tick',          (d) => {
      if (d && typeof d.t === 'number') syncClock(d.t);
      events.emit(GameEvent.NET_STATE_TICK, d);
    });
    this.socket.on('skeleton_died',       (d) => events.emit(GameEvent.NET_SKELETON_DIED, d));
    this.socket.on('skeleton_converted',  (d) => events.emit(GameEvent.NET_SKELETON_CONVERTED, d));
    this.socket.on('skeleton_spawned',    (d) => events.emit(GameEvent.NET_SKELETON_SPAWNED, d));
    this.socket.on('general_died',        (d) => events.emit(GameEvent.NET_GENERAL_DIED, d));
    this.socket.on('souls_granted',       (d) => events.emit(GameEvent.NET_SOULS_GRANTED, d));
    this.socket.on('player_joined',       (d) => events.emit(GameEvent.NET_PLAYER_JOINED, d));
    this.socket.on('player_left',         (d) => events.emit(GameEvent.NET_PLAYER_LEFT, d));
    this.socket.on('upgrade_applied',     (d) => events.emit(GameEvent.NET_UPGRADE_APPLIED, d));
    this.socket.on('player_damaged',      (d) => events.emit(GameEvent.NET_PLAYER_DAMAGED, d));
    this.socket.on('ally_state',          (d) => events.emit(GameEvent.NET_ALLY_STATE, d));
    this.socket.on('ally_spawned',        (d) => events.emit(GameEvent.NET_ALLY_SPAWNED, d));
    this.socket.on('ally_died',           (d) => events.emit(GameEvent.NET_ALLY_DIED, d));
    this.socket.on('player_fire_remote',  (d) => events.emit(GameEvent.NET_PLAYER_FIRED_REMOTE, d));
    this.socket.on('round_ended',         (d) => events.emit(GameEvent.NET_ROUND_ENDED, d));
    this.socket.on('rejoin_denied',       (d) => events.emit(GameEvent.NET_ROUND_ENDED, { ...d, rejoinDenied: true }));
  }

  sendMove(position, yaw) {
    if (!this.connected) return;
    this.socket.emit('player_move', {
      playerId: this.playerId,
      pos: { x: position.x, z: position.z },
      yaw,
    });
  }

  sendFire(ammoKey, origin, direction, targetPoint) {
    if (!this.connected) return;
    this.socket.emit('player_fire', {
      playerId: this.playerId,
      ammoKey,
      origin,
      direction,
      targetPoint,
    });
  }

  sendUpgrade(key) {
    if (!this.connected) return;
    this.socket.emit('upgrade_purchase', {
      playerId: this.playerId,
      key,
    });
  }

  sendHostileKilled(bounty) {
    if (!this.connected) return;
    this.socket.emit('hostile_killed', {
      playerId: this.playerId,
      bounty,
    });
  }

  sendAllyState(allies, t) {
    if (!this.connected) return;
    this.socket.emit('ally_state', {
      ownerId: this.playerId,
      t,
      allies,
    });
  }

  sendAllySpawned(spawn) {
    if (!this.connected) return;
    this.socket.emit('ally_spawned', {
      ownerId: this.playerId,
      ...spawn,
    });
  }

  sendAllyDied(ownerId, localId) {
    if (!this.connected) return;
    this.socket.emit('ally_died', {
      ownerId,
      localId,
    });
  }

  sendHostileCount(count) {
    if (!this.connected) return;
    this.socket.emit('hostile_count', {
      playerId: this.playerId,
      count,
    });
  }

  sendPlayerDied(killedBy) {
    if (!this.connected) return;
    this.socket.emit('player_died', {
      playerId: this.playerId,
      killedBy: killedBy || null,
    });
  }

  rejoin() {
    if (!this.connected) return;
    this.socket.emit('join', { playerId: this.playerId, name: this._name });
  }
}
