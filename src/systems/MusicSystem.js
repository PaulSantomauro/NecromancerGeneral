import { AudioSystem } from './AudioSystem.js';

// Four-track soundtrack driver.
//
// Tracks 1–3 are the "round" tracks — any one of them plays during PvE
// gameplay. They're shuffled into a queue so the player hears variety across
// rounds without immediate repeats: once the queue empties the deck is
// reshuffled. Track 4 is the PvP track; it takes over on the pve → pvp
// transition and continues through the ended/victory phase until the next
// round kicks off a fresh round track.
//
// Each track is an HTMLAudioElement wired through a per-track gain node into
// AudioSystem's music bus (see AudioSystem.connectMusic). Crossfades are
// driven entirely by gain ramps so adjacent tracks overlap briefly instead
// of cutting abruptly.

const ROUND_TRACKS = [
  encodeURI('/audio/Track 1 - Again and Again.mp3'),
  encodeURI('/audio/Track 2 - Go Go Go.mp3'),
  encodeURI('/audio/Track 3 - Fly Higher and Higher.mp3'),
];
const PVP_TRACK = encodeURI('/audio/Track 4 - Final Reload.mp3');

const CROSSFADE_SECS = 2.5;
const TARGET_TRACK_GAIN = 1.0;

function shuffled(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

class Music {
  constructor() {
    this._tracks = new Map(); // url → { audio, gain }
    this._currentUrl = null;
    this._queue = [];
    this._inited = false;
  }

  // Safe to call many times. No-op until AudioSystem has a live context
  // (first user gesture) — the caller is responsible for calling
  // AudioSystem.ensure() first.
  init() {
    if (this._inited) return;
    if (!AudioSystem.getContext()) return;

    for (const url of [...ROUND_TRACKS, PVP_TRACK]) {
      const audio = new Audio(url);
      audio.loop = true;
      audio.preload = 'auto';
      // Same-origin, no CORS attribute needed. Kick the browser into
      // downloading now so the first crossfade isn't starved for bytes.
      audio.load();
      const gain = AudioSystem.connectMusic(audio);
      if (!gain) continue;
      this._tracks.set(url, { audio, gain });
    }
    this._inited = true;
  }

  // Called from main.js after the player locks in so we start music on the
  // very first user gesture instead of waiting for a round-phase change
  // (which might be minutes away if they joined mid-round).
  startIfSilent(phase) {
    if (!this._inited || this._currentUrl) return;
    const url = phase === 'pvp' ? PVP_TRACK : this._nextRoundTrack();
    this._crossfadeTo(url, 0.2); // very quick initial fade-in
  }

  // phase transition hook. `to` is the new phase, `from` is the old.
  //   pvp  → track 4
  //   pve  → next random round track (new round after ended, or first entry)
  //   ended → leave whatever was playing; track 4 usually continues for the
  //           victory overlay beat which sits better than an abrupt cut.
  onPhaseChange(to, from) {
    if (!this._inited) return;
    if (to === 'pvp') {
      this._crossfadeTo(PVP_TRACK);
    } else if (to === 'pve') {
      this._crossfadeTo(this._nextRoundTrack());
    }
  }

  _nextRoundTrack() {
    if (this._queue.length === 0) this._queue = shuffled(ROUND_TRACKS);
    // If the top of the new shuffle happens to be what just played, rotate
    // once so we don't repeat back-to-back across a shuffle boundary.
    if (this._queue[0] === this._currentUrl && this._queue.length > 1) {
      this._queue.push(this._queue.shift());
    }
    return this._queue.shift();
  }

  _crossfadeTo(url, duration = CROSSFADE_SECS) {
    if (url === this._currentUrl) return;
    const ctx = AudioSystem.getContext();
    const next = this._tracks.get(url);
    if (!ctx || !next) return;

    const now = ctx.currentTime;
    const fade = Math.max(0.05, duration);

    // Ramp every other track to 0 and pause once the ramp completes so we
    // don't leave inaudible tracks decoding in the background forever.
    for (const [u, t] of this._tracks) {
      if (u === url) continue;
      t.gain.gain.cancelScheduledValues(now);
      t.gain.gain.setValueAtTime(t.gain.gain.value, now);
      t.gain.gain.linearRampToValueAtTime(0, now + fade);
      setTimeout(() => {
        if (this._currentUrl !== u) {
          try { t.audio.pause(); t.audio.currentTime = 0; } catch {}
        }
      }, fade * 1000 + 50);
    }

    // Start the incoming track from 0. play() returns a promise that can
    // reject if the browser still considers audio blocked (no gesture).
    // Swallow: the user will hear music on the next gesture-triggered cue.
    try {
      next.audio.currentTime = 0;
      const p = next.audio.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {}
    next.gain.gain.cancelScheduledValues(now);
    next.gain.gain.setValueAtTime(next.gain.gain.value, now);
    next.gain.gain.linearRampToValueAtTime(TARGET_TRACK_GAIN, now + fade);

    this._currentUrl = url;
  }
}

export const MusicSystem = new Music();
