// Procedural audio for Necromancer General. Single AudioContext, master gain,
// every sound is synthesized in-browser so there are zero asset downloads.
//
// Browsers require a user gesture before an AudioContext can produce sound,
// so `ensure()` is called from event handlers that only fire after a click/
// keypress (pointer lock, splash enter button, etc.). All play* methods are
// no-ops until the context is live.
//
// Design notes:
//   - Ammo fire sounds are detuned per-category so the ear can distinguish
//     machine-gun rattle, conversion sparkle, and summon thump without reading
//     the HUD.
//   - Damage-taken pulse is throttled to at most once every 120ms so the fog
//     damage loop doesn't stutter into a buzzsaw.
//   - `setMasterVolume(v)` is available for a future settings toggle.

let _ctx = null;
let _master = null;
let _musicBus = null;
let _muted = false;

// Throttles (ms) — keyed sound names used to debounce rapid events.
const _lastPlayed = new Map();

// Short-lived envelope helper. Builds an oscillator (or noise buffer) driven
// into a per-voice gain with the shape { attack, peak, sustain, release }.
function _now() { return _ctx.currentTime; }

function _noiseBuffer(durationSec) {
  const sampleCount = Math.max(1, Math.floor(_ctx.sampleRate * durationSec));
  const buf = _ctx.createBuffer(1, sampleCount, _ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < sampleCount; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

function _envelope(attack, peak, sustain, release) {
  const g = _ctx.createGain();
  const t = _now();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.linearRampToValueAtTime(peak * 0.8, t + attack + sustain);
  g.gain.linearRampToValueAtTime(0, t + attack + sustain + release);
  return { gain: g, duration: attack + sustain + release };
}

function _tone(freq, type, peak, attack, sustain, release) {
  if (!_ctx) return;
  const osc = _ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const env = _envelope(attack, peak, sustain, release);
  osc.connect(env.gain).connect(_master);
  osc.start();
  osc.stop(_now() + env.duration + 0.02);
}

function _noise(peak, attack, sustain, release, filterHz = null) {
  if (!_ctx) return;
  const src = _ctx.createBufferSource();
  src.buffer = _noiseBuffer(attack + sustain + release + 0.05);
  let node = src;
  if (filterHz) {
    const filt = _ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.value = filterHz;
    filt.Q.value = 1.2;
    src.connect(filt);
    node = filt;
  }
  const env = _envelope(attack, peak, sustain, release);
  node.connect(env.gain).connect(_master);
  src.start();
  src.stop(_now() + env.duration + 0.02);
}

function _throttle(key, ms) {
  const now = performance.now();
  const last = _lastPlayed.get(key) ?? -Infinity;
  if (now - last < ms) return false;
  _lastPlayed.set(key, now);
  return true;
}

export const AudioSystem = {
  // Lazy-construct the AudioContext. Safe to call many times; first call
  // inside a user gesture actually starts audio. Before that, every play*
  // method returns silently.
  ensure() {
    if (_ctx) {
      if (_ctx.state === 'suspended') _ctx.resume().catch(() => {});
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    _ctx = new AC();
    _master = _ctx.createGain();
    _master.gain.value = _muted ? 0 : 0.6;
    _master.connect(_ctx.destination);
    // Music sits on a sub-bus so track volume can be tuned independently
    // of SFX without re-balancing every procedural cue. Keep this ratio
    // small — the round tracks are dense full-range mixes that easily
    // drown out the click-level SFX if run at parity.
    _musicBus = _ctx.createGain();
    _musicBus.gain.value = 0.35;
    _musicBus.connect(_master);
    if (_ctx.state === 'suspended') _ctx.resume().catch(() => {});
  },

  getContext() { return _ctx; },
  getMusicBus() { return _musicBus; },

  // Wire an HTMLAudioElement into the music bus. Returns a per-track gain
  // node that callers can ramp for crossfades. MediaElementAudioSource is
  // created once per element (the spec forbids multiple), so pass each
  // element through this exactly once and reuse the returned gain.
  connectMusic(audioEl) {
    if (!_ctx || !_musicBus) return null;
    const source = _ctx.createMediaElementSource(audioEl);
    const trackGain = _ctx.createGain();
    trackGain.gain.value = 0;
    source.connect(trackGain).connect(_musicBus);
    return trackGain;
  },

  setMusicVolume(v) {
    if (!_musicBus || !_ctx) return;
    _musicBus.gain.setTargetAtTime(v, _ctx.currentTime, 0.1);
  },

  setMasterVolume(v) {
    if (!_master) { _muted = v <= 0.001; return; }
    _master.gain.setTargetAtTime(v, _ctx.currentTime, 0.02);
    _muted = v <= 0.001;
  },

  // ── Weapon fire ─────────────────────────────────────────────────────────
  // Different timbre per ammo category. `ammoKey` lines up with ammo.json so
  // unknown keys fall through to a generic click.
  fire(ammoKey) {
    if (!_ctx) return;
    if (ammoKey === 'machine_gun') {
      if (!_throttle('fire_mg', 30)) return;
      _noise(0.35, 0.001, 0.02, 0.06, 2400);
      _tone(220, 'square', 0.08, 0.001, 0.01, 0.04);
    } else if (ammoKey === 'conversion_bolt') {
      _tone(880, 'sine', 0.18, 0.005, 0.04, 0.12);
      _tone(1320, 'sine', 0.12, 0.005, 0.04, 0.18);
      _noise(0.05, 0.001, 0.05, 0.12, 3600);
    } else if (ammoKey && ammoKey.startsWith('summon_')) {
      _tone(110, 'triangle', 0.28, 0.002, 0.06, 0.22);
      _tone(55, 'sine', 0.18, 0.001, 0.1, 0.24);
      _noise(0.1, 0.002, 0.04, 0.12, 400);
    } else {
      _tone(600, 'square', 0.08, 0.002, 0.01, 0.03);
    }
  },

  // ── Hit feedback ────────────────────────────────────────────────────────
  // Short high tick when my bullet connects with a remote general or a
  // hostile skeleton. Kept quiet so it layers with the fire sound.
  hitMarker() {
    if (!_ctx) return;
    if (!_throttle('hit', 35)) return;
    _tone(1760, 'sine', 0.14, 0.001, 0.01, 0.06);
    _tone(2640, 'sine', 0.08, 0.001, 0.005, 0.04);
  },

  // Self-damage: low thump, throttled so fog DPS doesn't become a drum.
  hurt() {
    if (!_ctx) return;
    if (!_throttle('hurt', 120)) return;
    _tone(140, 'triangle', 0.22, 0.002, 0.03, 0.18);
    _noise(0.1, 0.001, 0.05, 0.12, 320);
  },

  // Continuous-damage bleep — called explicitly when the fog is biting you.
  fogTick() {
    if (!_ctx) return;
    if (!_throttle('fog', 300)) return;
    _tone(220, 'sawtooth', 0.08, 0.01, 0.05, 0.1);
  },

  // Enemy died (skeleton). Soft clunk.
  enemyKill() {
    if (!_ctx) return;
    if (!_throttle('kill', 20)) return;
    _noise(0.18, 0.001, 0.04, 0.12, 600);
    _tone(180, 'sawtooth', 0.1, 0.001, 0.02, 0.14);
  },

  // You killed another general. Triumphant short fanfare.
  playerKill() {
    if (!_ctx) return;
    const t = _ctx.currentTime;
    const steps = [
      { f: 523.25, at: 0.00, len: 0.08 }, // C5
      { f: 659.26, at: 0.07, len: 0.08 }, // E5
      { f: 783.99, at: 0.14, len: 0.18 }, // G5
    ];
    for (const s of steps) {
      const osc = _ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = s.f;
      const g = _ctx.createGain();
      g.gain.setValueAtTime(0, t + s.at);
      g.gain.linearRampToValueAtTime(0.28, t + s.at + 0.01);
      g.gain.linearRampToValueAtTime(0, t + s.at + s.len);
      osc.connect(g).connect(_master);
      osc.start(t + s.at);
      osc.stop(t + s.at + s.len + 0.02);
    }
  },

  // Local player died. Slow descending tone.
  death() {
    if (!_ctx) return;
    const osc = _ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(220, _ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(60, _ctx.currentTime + 1.0);
    const g = _ctx.createGain();
    g.gain.setValueAtTime(0, _ctx.currentTime);
    g.gain.linearRampToValueAtTime(0.3, _ctx.currentTime + 0.05);
    g.gain.linearRampToValueAtTime(0, _ctx.currentTime + 1.1);
    osc.connect(g).connect(_master);
    osc.start();
    osc.stop(_ctx.currentTime + 1.15);
  },

  // Phase transition horn. `kind` picks the mood.
  //   'pvp' — sharp minor fanfare, combat alarm
  //   'victory' — open major interval
  //   'round_start' — a single low note so a new round is audibly marked
  horn(kind) {
    if (!_ctx) return;
    const t = _ctx.currentTime;
    let notes;
    if (kind === 'pvp') {
      notes = [
        { f: 196.00, at: 0.00, len: 0.35 }, // G3
        { f: 233.08, at: 0.20, len: 0.35 }, // A#3
        { f: 293.66, at: 0.40, len: 0.6 },  // D4
      ];
    } else if (kind === 'victory') {
      notes = [
        { f: 261.63, at: 0.00, len: 0.25 }, // C4
        { f: 329.63, at: 0.22, len: 0.25 }, // E4
        { f: 392.00, at: 0.44, len: 0.6 },  // G4
        { f: 523.25, at: 0.66, len: 0.8 },  // C5
      ];
    } else {
      notes = [{ f: 174.61, at: 0.00, len: 0.8 }]; // F3
    }
    for (const n of notes) {
      const osc = _ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = n.f;
      const g = _ctx.createGain();
      g.gain.setValueAtTime(0, t + n.at);
      g.gain.linearRampToValueAtTime(0.22, t + n.at + 0.03);
      g.gain.linearRampToValueAtTime(0.18, t + n.at + n.len * 0.7);
      g.gain.linearRampToValueAtTime(0, t + n.at + n.len);
      // Mild low-pass so the saw doesn't sound harsh at full volume.
      const filt = _ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = 1800;
      osc.connect(filt).connect(g).connect(_master);
      osc.start(t + n.at);
      osc.stop(t + n.at + n.len + 0.05);
    }
  },

  // Short "nope" for failed fire (insufficient souls/energy). Throttled so
  // holding the mouse while broke doesn't become a siren.
  fireFail() {
    if (!_ctx) return;
    if (!_throttle('fail', 180)) return;
    _tone(180, 'square', 0.12, 0.001, 0.02, 0.08);
    _tone(120, 'square', 0.08, 0.001, 0.02, 0.12);
  },
};
