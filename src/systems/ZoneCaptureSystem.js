import { GameEvent, events } from './EventSystem.js';
import battleConfig from '../config/battle.json';

const CAPTURE_SECONDS = 10;

// Client-side capture bookkeeper. Each frame we check the local player's
// distance against every spawn zone; whichever zone we're inside, its
// timer ticks up, all others reset. When a zone's timer reaches
// CAPTURE_SECONDS we fire sendZoneCapture() once and stop ticking that
// zone locally — the server's zone_captured broadcast adds it to the
// shared `captured` set so BattleDirector + Battlefield update.
//
// No partial-progress broadcast: other players only see a zone flip
// when it actually captures. Kept deliberately simple per spec.
export class ZoneCaptureSystem {
  constructor({ net, player, battlefield = null }) {
    this.net = net;
    this.player = player;
    // Battlefield reference is late-bound via main.js (constructed in the
    // same system-wiring block) so the ZoneCaptureSystem can lock the
    // ring visual to green on the OPTIMISTIC local-flip frame — without
    // this, the frame between local timer hitting 10s and the server
    // echo sees the ring lerp briefly back to red (captureProgress is
    // cleared in that window by the ZONE_CAPTURE_ENDED handler because
    // r.captured is still false until the echo arrives). Idempotent
    // with the server-triggered setZoneCaptured that fires ~1 RTT later.
    this.battlefield = battlefield;
    this.zones = battleConfig.hostileSpawnZones ?? [];

    // Per-zone local timer state. Parallel array to `zones` — index i
    // corresponds to zones[i].
    this._timers      = new Array(this.zones.length).fill(0);
    // Set of zone indices already captured (ours or anyone's). We learn
    // these from the server via NET_ZONE_CAPTURED and the initial welcome
    // payload. BattleDirector reads `capturedZones` directly.
    this.capturedZones = new Set();
    // Single-shot guard: don't send zone_capture twice for the same zone
    // if the server's broadcast lags the local 10s threshold.
    this._captureSent = new Set();
    // The zone the player is currently inside (and thus whose timer is
    // ticking). -1 if outside all zones. Used to fire progress events
    // with enough info for the HUD to label the zone.
    this._activeZone  = -1;

    events.subscribe(GameEvent.NET_ZONE_CAPTURED, ({ zoneIndex }) => {
      this.capturedZones.add(zoneIndex);
      this._timers[zoneIndex] = 0;
      this._captureSent.add(zoneIndex);
    });
  }

  // Called from main.js when welcome/restore_state lands with the current
  // set of zones already captured this round (mid-round joiner).
  ingestInitial(list) {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      const i = entry?.zoneIndex;
      if (Number.isInteger(i)) {
        this.capturedZones.add(i);
        this._captureSent.add(i);
      }
    }
  }

  // Full round reset — new round, all zones back in play.
  resetForNewRound() {
    this.capturedZones.clear();
    this._captureSent.clear();
    this._timers.fill(0);
    this._activeZone = -1;
    events.emit(GameEvent.ZONE_CAPTURE_ENDED, { zoneIndex: -1 });
  }

  // Per-frame update. Dead players can't capture; if the local player is
  // dead we just reset any in-progress timer and bail. Otherwise pick the
  // nearest zone the player is inside (zones don't overlap in our config,
  // but the "first match" rule is defensive) and tick its timer.
  update(dt) {
    if (!this.player?.alive) {
      if (this._activeZone !== -1) {
        this._timers[this._activeZone] = 0;
        this._activeZone = -1;
        events.emit(GameEvent.ZONE_CAPTURE_ENDED, { zoneIndex: -1 });
      }
      return;
    }

    const px = this.player.position.x;
    const pz = this.player.position.z;
    let inside = -1;
    for (let i = 0; i < this.zones.length; i++) {
      if (this.capturedZones.has(i)) continue;
      const z = this.zones[i];
      const dx = px - z.center[0];
      const dz = pz - z.center[2];
      if (dx * dx + dz * dz <= z.radius * z.radius) {
        inside = i;
        break;
      }
    }

    if (inside !== this._activeZone) {
      // Stepped out of (or into a new) zone — the consecutive-seconds
      // rule means the old timer resets hard. No grace period.
      if (this._activeZone !== -1) {
        this._timers[this._activeZone] = 0;
        events.emit(GameEvent.ZONE_CAPTURE_ENDED, { zoneIndex: this._activeZone });
      }
      this._activeZone = inside;
    }

    if (inside === -1) return;

    this._timers[inside] += dt;
    const t = this._timers[inside];
    const zone = this.zones[inside];
    events.emit(GameEvent.ZONE_CAPTURE_PROGRESS, {
      zoneIndex: inside,
      label: zone.label,
      elapsed: t,
      total: CAPTURE_SECONDS,
      progress: Math.min(1, t / CAPTURE_SECONDS),
    });

    if (t >= CAPTURE_SECONDS && !this._captureSent.has(inside)) {
      this._captureSent.add(inside);
      this.net?.sendZoneCapture(inside);
      // Optimistic local flip so the Battlefield can recolor immediately
      // instead of waiting for the server echo. The authoritative
      // NET_ZONE_CAPTURED event will redundantly mark it again — both
      // paths are idempotent via the Set and via setZoneCaptured's
      // early-return on already-captured rings.
      this.capturedZones.add(inside);
      // Lock the ring to green NOW, in the same frame we added to the
      // local captured set. Otherwise the very next frame sees inside=-1
      // (this zone gets skipped in the scan), emits ZONE_CAPTURE_ENDED
      // for this zone, and main.js's handler calls
      // clearZoneCaptureProgress — which resets captureProgress to 0
      // because r.captured is still false until the server echo lands.
      // The result is a visible red flash between local flip and server
      // confirmation. setZoneCaptured sets r.captured=true, which makes
      // the follow-up clearZoneCaptureProgress a no-op (guarded) and
      // the per-frame color lerp skipped entirely.
      this.battlefield?.setZoneCaptured?.(inside);
    }
  }

  isCaptured(zoneIndex) {
    return this.capturedZones.has(zoneIndex);
  }
}

export { CAPTURE_SECONDS };
