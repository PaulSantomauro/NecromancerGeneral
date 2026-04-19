import { getIdentity, claimIdentity } from '../systems/Identity.js';

export class SplashScreen {
  constructor(onReady) {
    this._onReady = onReady;
    this._el = this._build();
    document.body.appendChild(this._el);
  }

  _build() {
    const el = document.createElement('div');
    el.id = 'splash';
    el.innerHTML = `
      <div id="splash-inner">
        <h1 class="splash-title">☠ NECROMANCER GENERAL</h1>
        <p class="splash-sub">A persistent battlefield. All generals are enemies.</p>
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
        <p class="splash-hint">Your progress is saved. Return to reclaim your army.</p>
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
      this._dismiss();
      this._onReady(identity);
    };

    button.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    setTimeout(() => input.focus(), 50);

    return el;
  }

  _dismiss() {
    this._el.classList.add('splash-exit');
    setTimeout(() => this._el.remove(), 400);
  }
}
