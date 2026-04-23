import { io } from 'socket.io-client';
import { getIdentity, claimIdentity } from '../systems/Identity.js';
import { WS_URL } from '../config/serverUrl.js';
import { progressFor } from '../config/ranks.js';

// Picks a stable-ish placeholder name for portal arrivals that didn't send a
// `username` parameter. Uses crypto-random bytes for uniqueness on the wire
// so two nameless arrivals don't collide on the server's name→id map.
function generateWandererName() {
  const rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `Wanderer-${rnd}`;
}

// Resolve the id for a given name from the localStorage name→id map that
// Identity writes. Used to fetch a returning player's career stats before
// they've clicked "Enter" — we know their id even if they haven't "claimed"
// the name this session yet.
function resolveIdForName(name) {
  try {
    const map = JSON.parse(localStorage.getItem('ng_name_to_id') || '{}');
    return map[name] || null;
  } catch {
    return null;
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatDuration(sec) {
  if (!sec || sec < 60) return `${sec | 0}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m - h * 60;
  return mm ? `${h}h ${mm}m` : `${h}h`;
}

export class SplashScreen {
  // `params` is an optional URLSearchParams. When present with portal=true,
  // we bypass the DOM splash entirely so the player drops straight into the
  // arena (the jam's webring requires no input screens on portal arrival).
  constructor(onReady, params = null) {
    this._onReady = onReady;
    this._infoSocket = null;

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
    this._openInfoSocketAndFetch();
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
        <p class="splash-meta">7-minute rounds · 18 spawn zones · 300u arena</p>

        <div id="splash-career" class="splash-career hidden" aria-live="polite"></div>

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

        <div class="splash-leaderboard">
          <div class="splash-lb-head">
            <span class="splash-lb-title">Leaderboard</span>
            <div class="splash-lb-tabs" role="tablist">
              <button class="splash-lb-tab active" data-tab="rank" role="tab">Rank</button>
              <button class="splash-lb-tab" data-tab="wins" role="tab">Wins</button>
              <button class="splash-lb-tab" data-tab="pve" role="tab">PvE Kills</button>
            </div>
          </div>
          <ol id="splash-lb-list" class="splash-lb-list"></ol>
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
            <span class="splash-ctrl-hint"><kbd>LMB</kbd> fire · <kbd>RMB</kbd> attack-move army</span>
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
              <kbd>Q</kbd><kbd>E</kbd>
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
    // Re-fetch the career card when the player types a different existing
    // name — cheap and lets them see their previous identity's stats.
    let typingTimer;
    input.addEventListener('input', () => {
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => this._refreshCareer(input.value), 400);
    });

    // Tab wiring — re-query on click. Socket is already open from the
    // constructor, so this is just one emit + one re-render.
    el.querySelectorAll('.splash-lb-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        el.querySelectorAll('.splash-lb-tab').forEach(t => t.classList.toggle('active', t === tab));
        this._fetchLeaderboard(tab.dataset.tab);
      });
    });

    setTimeout(() => input.focus(), 50);
    return el;
  }

  // Open a short-lived socket just to fetch career + leaderboard. This is
  // a separate connection from the game's NetworkSystem (which isn't built
  // until after the player clicks Enter), and it's closed on submit so we
  // don't leak a dangling socket into the main session.
  _openInfoSocketAndFetch() {
    try {
      this._infoSocket = io(WS_URL, { transports: ['websocket'] });
    } catch {
      return; // Offline / dev server down — splash still works, just no stats.
    }
    this._infoSocket.on('connect', () => {
      const { name } = getIdentity();
      if (name) this._refreshCareer(name);
      this._fetchLeaderboard('rank');
    });
    this._infoSocket.on('career_response', ({ career }) => this._renderCareer(career));
    this._infoSocket.on('leaderboard_response', ({ entries }) => this._renderLeaderboard(entries));
  }

  _refreshCareer(nameRaw) {
    const name = (nameRaw || '').trim();
    if (!name) { this._renderCareer(null); return; }
    const id = resolveIdForName(name);
    if (!id || !this._infoSocket?.connected) { this._renderCareer(null); return; }
    this._infoSocket.emit('career_fetch', { playerId: id });
  }

  _fetchLeaderboard(tab) {
    if (!this._infoSocket?.connected) return;
    this._infoSocket.emit('leaderboard_fetch', { tab });
  }

  _renderCareer(career) {
    if (!this._el) return;
    const box = this._el.querySelector('#splash-career');
    if (!box) return;
    // Hide the card if we have no career yet, or they've played zero rounds.
    if (!career || (career.rounds_played | 0) === 0) {
      box.classList.add('hidden');
      box.innerHTML = '';
      return;
    }
    const { name } = getIdentity();
    const prog = progressFor(career.xp ?? 0);
    const pct = Math.round(prog.progress * 100);
    const nextLine = prog.next
      ? `${prog.current.title} · L${prog.current.level} → <span class="c-next">${prog.next.title}</span> (${prog.xpForLevel - prog.xpIntoLevel} XP to go)`
      : `${prog.current.title} · L${prog.current.level} · <em>max rank</em>`;
    box.classList.remove('hidden');
    box.innerHTML = `
      <div class="c-top">
        <span class="c-welcome">Welcome back, <strong>${escapeHtml(name || 'General')}</strong></span>
        <span class="c-xp">${career.xp.toLocaleString()} XP</span>
      </div>
      <div class="c-rank">${nextLine}</div>
      <div class="c-bar"><div class="c-bar-fill" style="width:${pct}%"></div></div>
      <div class="c-stats">
        <span><strong>${career.rounds_won}</strong> wins</span>
        <span><strong>${career.pve_kills.toLocaleString()}</strong> PvE kills</span>
        <span><strong>${career.pvp_kills}</strong> PvP kills</span>
        <span><strong>${formatDuration(career.time_played_sec)}</strong> played</span>
      </div>
    `;
  }

  _renderLeaderboard(entries) {
    if (!this._el) return;
    const list = this._el.querySelector('#splash-lb-list');
    if (!list) return;
    if (!entries || entries.length === 0) {
      list.innerHTML = '<li class="splash-lb-empty">No generals have marched yet.</li>';
      return;
    }
    list.innerHTML = entries.map((e, i) => `
      <li class="splash-lb-row">
        <span class="lb-rank">${i + 1}</span>
        <span class="lb-title">L${e.level} ${escapeHtml(e.title)}</span>
        <span class="lb-name">${escapeHtml(e.name)}</span>
        <span class="lb-stat">${(e.xp ?? 0).toLocaleString()} XP</span>
        <span class="lb-stat">${e.rounds_won} W</span>
        <span class="lb-stat">${(e.pve_kills ?? 0).toLocaleString()} K</span>
      </li>
    `).join('');
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
    // Close the info socket — NetworkSystem owns the game socket now.
    try { this._infoSocket?.disconnect(); } catch {}
    this._infoSocket = null;
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
