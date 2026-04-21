import { getIdentity, claimIdentity } from '../systems/Identity.js';

// Picks a stable-ish placeholder name for portal arrivals that didn't send a
// `username` parameter. Uses crypto-random bytes for uniqueness on the wire
// so two nameless arrivals don't collide on the server's name→id map.
function generateWandererName() {
  const rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `Wanderer-${rnd}`;
}

export class SplashScreen {
  // `params` is an optional URLSearchParams. When present with portal=true,
  // we bypass the DOM splash entirely so the player drops straight into the
  // arena (the jam's webring requires no input screens on portal arrival).
  constructor(onReady, params = null) {
    this._onReady = onReady;

    if (params && params.get('portal') === 'true') {
      const raw = params.get('username') || '';
      const name = raw.trim().slice(0, 20) || generateWandererName();
      const identity = claimIdentity(name) || claimIdentity(generateWandererName());
      // queueMicrotask lets the caller finish wiring before onReady fires,
      // matching the timing of the normal (button-click) path.
      queueMicrotask(() => this._onReady(identity));
      return;
    }

    this._el = this._build();
    document.body.appendChild(this._el);
  }

  _build() {
    const el = document.createElement('div');
    el.id = 'splash';
    el.innerHTML = `
      <div id="splash-inner">
        <h1 class="splash-title">☠ NECROMANCER GENERAL</h1>
        <p class="splash-sub">Raise an army from the dead. Outlast the shrinking fog. Be the last general standing.</p>

        <div class="splash-phases">
          <span class="splash-phase phase-pve">PvE · Alliance</span>
          <span class="splash-arrow">▸</span>
          <span class="splash-phase phase-pvp">PvP · Last Stand</span>
          <span class="splash-arrow">▸</span>
          <span class="splash-phase phase-end">Victory</span>
        </div>
        <p class="splash-meta">7-minute rounds · 14 spawn zones · 300u arena</p>

        <div class="splash-form">
          <input
            id="splash-name"
            type="text"
            maxlength="20"
            placeholder="Enter your general's name"
            autocomplete="off"
            spellcheck="false"
          />
          <button id="splash-enter">ENTER THE BATTLEFIELD</button>
        </div>

        <div class="splash-controls">
          <div class="splash-ctrl">
            <span class="splash-ctrl-label">MOVE</span>
            <span class="splash-ctrl-keys">
              <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>
            </span>
            <span class="splash-ctrl-hint"><kbd>Shift</kbd> sprint</span>
          </div>
          <div class="splash-ctrl">
            <span class="splash-ctrl-label">COMBAT</span>
            <span class="splash-ctrl-keys">
              <kbd>LMB</kbd><kbd>RMB</kbd>
            </span>
            <span class="splash-ctrl-hint">fire · attack-move</span>
          </div>
          <div class="splash-ctrl">
            <span class="splash-ctrl-label">AMMO</span>
            <span class="splash-ctrl-keys">
              <kbd>1</kbd>–<kbd>7</kbd> / <kbd>scroll</kbd>
            </span>
            <span class="splash-ctrl-hint">gun → summons</span>
          </div>
          <div class="splash-ctrl">
            <span class="splash-ctrl-label">UPGRADE</span>
            <span class="splash-ctrl-keys">
              <kbd>Q</kbd><kbd>E</kbd><kbd>R</kbd>
            </span>
            <span class="splash-ctrl-hint">spend souls ☠</span>
          </div>
        </div>

        <p class="splash-hint">Every round is a fresh slate — souls, allies, and upgrades all reset when the next round begins.</p>
      </div>
    `;

    const input = el.querySelector('#splash-name');
    const button = el.querySelector('#splash-enter');

    const { name } = getIdentity();
    if (name) input.value = name;

    const submit = () => {
      const val = input.value.trim();
      if (!val) { input.classList.add('error'); return; }
      const identity = claimIdentity(val);
      if (!identity) { input.classList.add('error'); return; }
      this._showConnecting();
      this._onReady(identity);
    };

    button.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    setTimeout(() => input.focus(), 50);

    return el;
  }

  _showConnecting() {
    if (!this._el) return;
    const form = this._el.querySelector('.splash-form');
    if (form) {
      form.innerHTML = '<p class="splash-connecting" role="status" aria-live="polite">Connecting to server<span class="splash-dots">…</span></p>';
    }
    this._slowTimer = setTimeout(() => {
      const p = this._el?.querySelector('.splash-connecting');
      if (p) p.textContent = 'Server is waking up, hang tight…';
    }, 8000);
  }

  // Called by main.js once the socket has finished the welcome/restore
  // handshake; dismisses the splash so the player drops into the arena.
  connected() {
    if (this._slowTimer) { clearTimeout(this._slowTimer); this._slowTimer = null; }
    this._dismiss();
  }

  _dismiss() {
    if (!this._el) return;
    this._el.classList.add('splash-exit');
    const el = this._el;
    this._el = null;
    setTimeout(() => el.remove(), 400);
  }
}
