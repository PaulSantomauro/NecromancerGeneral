// Camera jitter helper. Call `trigger(amp, dur)` on a hit event; call
// `apply(obj, dt)` once per frame AFTER normal camera positioning but
// BEFORE renderer.render(). The offset is additive and is overwritten
// each frame by the usual player-follow camera update, so no drift
// compensation is needed.

let _amp = 0;
let _remaining = 0;
let _duration = 0;

export const ScreenShake = {
  trigger(amplitude = 0.08, duration = 0.12) {
    if (amplitude > _amp) _amp = amplitude;
    if (duration > _remaining) {
      _remaining = duration;
      _duration = duration;
    }
  },

  apply(obj, dt) {
    if (_remaining <= 0) return;
    _remaining -= dt;
    const k = Math.max(0, _remaining / _duration);
    const a = _amp * k;
    obj.position.x += (Math.random() - 0.5) * a;
    obj.position.y += (Math.random() - 0.5) * a * 0.6;
    obj.position.z += (Math.random() - 0.5) * a;
    if (_remaining <= 0) {
      _amp = 0;
      _duration = 0;
    }
  },
};
