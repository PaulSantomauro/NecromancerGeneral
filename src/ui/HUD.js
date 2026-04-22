import { GameEvent, events } from '../systems/EventSystem.js';
import ammoConfig from '../config/ammo.json';

const AMMO_CLASSES = Object.keys(ammoConfig).map(k => `ammo-${k}`);

const KILL_FEED_MAX = 4;
const KILL_FEED_TTL_MS = 7000;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export class HUD {
  constructor({ playerStats, progression, roundState = null }) {
    this.playerStats = playerStats;
    this.progression = progression;
    this.roundState = roundState;

    this.hostiles = document.getElementById('battle-hostiles');
    this.allies   = document.getElementById('battle-allies');
    this.ammoName = document.getElementById('ammo-name');
    this.ammoCost = document.getElementById('ammo-cost');
    this.killCount = document.getElementById('kill-count');
    this.crosshair = document.getElementById('crosshair');
    this.lockPrompt = document.getElementById('lock-prompt');

    this.roundBanner   = document.getElementById('round-banner');
    this.roundPhase    = document.getElementById('round-phase');
    this.roundAlive    = document.getElementById('round-alive');
    this.roundTimerTxt = document.getElementById('round-timer-text');
    this.roundOverlay  = document.getElementById('round-overlay');
    this.roundOverlayTitle = document.getElementById('round-overlay-title');
    this.roundOverlaySub   = document.getElementById('round-overlay-sub');
    this.roundOverlayLeaderboard = document.getElementById('round-overlay-leaderboard');
    this._lastPhase = null;
    this._deathShown = false;
    this._winnerShown = false;
    this._nameById = new Map(); // id → name cache, fed by state_tick

    this.killFeed = document.getElementById('kill-feed');
    this._killFeedEntries = [];

    this.crosshairWrap = document.getElementById('crosshair-wrap');
    this.crosshairCooldown = document.getElementById('crosshair-cooldown');
    this.crosshairHitmark = document.getElementById('crosshair-hitmark');
    this._cooldown = { active: false, elapsed: 0, duration: 0 };
    this._hitmarkTimer = 0;
    this._phaseFlash = document.getElementById('phase-flash');
    this._ammoCostFlashTimer = null;

    this.soulCount = document.getElementById('soul-count');
    this.levelCount = document.getElementById('level-count');
    this.energyFill = document.getElementById('energy-bar-fill');
    this.energyCurrent = document.getElementById('energy-current');
    this.energyMax = document.getElementById('energy-max');
    this.hpFill = document.getElementById('hp-bar-fill');
    this.hpCurrent = document.getElementById('hp-current');
    this.hpMax = document.getElementById('hp-max');
    this.hpPanel = document.getElementById('hud-hp');
    this.damageFlash = document.getElementById('damage-flash');
    this.damageIndicators = document.getElementById('damage-indicators');
    this._lastHp = playerStats.hp;
    this._activeArcs = [];
    this._flashTimeout = null;

    this.upgradeRows = {};
    document.querySelectorAll('.upgrade-row').forEach(row => {
      this.upgradeRows[row.dataset.key] = {
        el: row,
        label: row.querySelector('.upgrade-label'),
        level: row.querySelector('.upgrade-level'),
        cost:  row.querySelector('.upgrade-cost'),
      };
    });

    events.subscribe(GameEvent.BATTLE_TICK, (d) => {
      // When the local horde is cleared but the field total (summed across
      // every player) isn't, tell the player explicitly rather than leaving
      // them staring at "0 hostiles" wondering why PvP hasn't started.
      // Hostiles are client-local (each player fights their own instance),
      // so "0 local" ≠ "round over" — the server waits for everyone.
      const rs = this.roundState;
      const fieldTotal = rs?.totalHostiles ?? d.hostiles;
      const waitingForStragglers =
        d.hostiles === 0 && rs?.phase === 'pve' && fieldTotal > 0;
      this.hostiles.textContent = waitingForStragglers
        ? `⚔ 0 · awaiting generals (${fieldTotal} on field)`
        : `⚔ ${d.hostiles} hostiles`;
      this.hostiles.classList.toggle('awaiting', waitingForStragglers);
      this.allies.textContent   = `▲ ${d.allies} allies`;
      this.killCount.textContent = d.killed;
    });

    events.subscribe(GameEvent.AMMO_CHANGED, ({ key, name }) => {
      this.ammoName.textContent = name;
      for (const cls of AMMO_CLASSES) {
        this.ammoName.classList.remove(cls);
        this.crosshair.classList.remove(cls);
      }
      this.ammoName.classList.add(`ammo-${key}`);
      this.crosshair.classList.add(`ammo-${key}`);
      this._renderAmmoCost(key);
      // Resetting the cooldown on ammo switch prevents a stale ring from
      // sticking around through a switch-mid-cooldown.
      this._cooldown = { active: false, elapsed: 0, duration: 0 };
      this._renderCrosshairCooldown();
    });

    events.subscribe(GameEvent.PLAYER_FIRED, ({ ammoKey }) => {
      const cfg = ammoConfig[ammoKey];
      if (!cfg) return;
      this._cooldown = { active: true, elapsed: 0, duration: cfg.fireInterval };
      this._renderCrosshairCooldown();
    });

    // Failed-fire feedback: short red pulse on the ammo cost pill plus the
    // audio "nope" (raised separately in the AudioSystem subscription).
    events.subscribe(GameEvent.FIRE_FAILED, ({ reason }) => {
      if (!this.ammoCost) return;
      this.ammoCost.classList.remove('fire-fail');
      void this.ammoCost.offsetWidth;
      this.ammoCost.classList.add('fire-fail');
      if (this._ammoCostFlashTimer) clearTimeout(this._ammoCostFlashTimer);
      this._ammoCostFlashTimer = setTimeout(() => {
        this.ammoCost.classList.remove('fire-fail');
      }, 280);
    });

    events.subscribe(GameEvent.HIT_MARKER, () => {
      if (!this.crosshairHitmark) return;
      this.crosshairHitmark.classList.remove('active');
      void this.crosshairHitmark.offsetWidth;
      this.crosshairHitmark.classList.add('active');
      this._hitmarkTimer = 0.18;
    });

    events.subscribe(GameEvent.NET_STATE_TICK, ({ players: serverPlayers }) => {
      if (!serverPlayers) return;
      // Cache id → name so the kill-feed and leaderboard can resolve names
      // for players who aren't currently rendered (disconnected, dead).
      for (const p of serverPlayers) {
        if (p && p.id && p.name) this._nameById.set(p.id, p.name);
      }
      // Keep the most recent known list around for the leaderboard render.
      this._lastPlayers = serverPlayers;
    });

    events.subscribe(GameEvent.NET_GENERAL_DIED, ({ playerId, killedBy }) => {
      const victim = this._resolveName(playerId);
      const killer = killedBy ? this._resolveName(killedBy) : null;
      const text = killer ? `${victim} fell to ${killer}` : `${victim} was claimed by the fog`;
      const mine = (this._myId && (playerId === this._myId || killedBy === this._myId));
      this._addKillFeedEntry(text, mine);
    });

    events.subscribe(GameEvent.PHASE_TRANSITION, ({ to }) => {
      if (!this._phaseFlash) return;
      this._phaseFlash.classList.remove('flash-pvp', 'flash-victory');
      void this._phaseFlash.offsetWidth;
      if (to === 'pvp') this._phaseFlash.classList.add('flash-pvp');
      else if (to === 'ended') this._phaseFlash.classList.add('flash-victory');
    });

    events.subscribe(GameEvent.ENERGY_CHANGED, ({ current, max }) => {
      this._renderEnergy(current, max);
    });

    events.subscribe(GameEvent.PLAYER_DAMAGED, ({ hp, max, amount }) => {
      this._renderHp(hp, max ?? this.playerStats.maxHp);
      // Only flash on HP decrease (setHp can also fire on heal/init)
      const dropped = hp < this._lastHp;
      this._lastHp = hp;
      if (dropped && amount > 0) this._triggerDamageFlash();
    });

    events.subscribe(GameEvent.DAMAGE_INDICATOR, ({ angle }) => {
      this._addDamageArc(angle);
    });

    // Kill-confirm crosshair pulse. Emitted only from Projectile.onHit when
    // my own shot drops a hostile, so it fires once per kill cleanly.
    events.subscribe(GameEvent.PLAYER_KILL, () => {
      if (!this.crosshair) return;
      this.crosshair.classList.remove('kill-confirm');
      // Force reflow so the CSS animation restarts on each kill.
      void this.crosshair.offsetWidth;
      this.crosshair.classList.add('kill-confirm');
      if (this._killConfirmTimer) clearTimeout(this._killConfirmTimer);
      this._killConfirmTimer = setTimeout(() => {
        this.crosshair.classList.remove('kill-confirm');
      }, 360);
    });

    events.subscribe(GameEvent.SOULS_CHANGED, ({ total }) => {
      this.soulCount.textContent = total;
      this._renderUpgrades();
    });

    events.subscribe(GameEvent.UPGRADE_PURCHASED, () => {
      this.levelCount.textContent = this.progression.totalLevel();
      this._renderUpgrades();
      this._renderEnergy(this.playerStats.energy, this.playerStats.maxEnergy);
    });

    events.subscribe(GameEvent.PLAYER_DIED, () => {
      if (this._deathShown || this._winnerShown) return;
      this._deathShown = true;
      this.roundOverlay.classList.remove('hidden', 'victory');
      this.roundOverlayTitle.textContent = 'You have fallen';
      this.roundOverlaySub.textContent   = 'Spectating — await the round\u2019s end.';
    });

    events.subscribe(GameEvent.NET_ROUND_ENDED, ({ winnerId, rejoinDenied, restartAt }) => {
      this._winnerShown = true;
      this._rejoinDenied = !!rejoinDenied;
      this.roundOverlay.classList.remove('hidden');
      if (rejoinDenied) {
        this.roundOverlayTitle.textContent = 'You were killed this round';
        this.roundOverlay.classList.remove('victory');
      } else {
        const amWinner = winnerId && this._myId && winnerId === this._myId;
        this._overlayIsWinner = !!amWinner;
        this.roundOverlay.classList.toggle('victory', !!amWinner);
        this.roundOverlayTitle.textContent = amWinner
          ? 'VICTORY · Last general standing'
          : (winnerId ? `Round over — ${this._resolveName(winnerId)} won` : 'Round over — no winner');
      }
      // Seed the countdown subtitle so there's no blank frame before _renderRound ticks.
      const secs = restartAt
        ? Math.max(0, Math.ceil((restartAt - Date.now()) / 1000))
        : 30;
      this.roundOverlaySub.textContent = `New round in ${secs}s`;
      this._renderLeaderboard(winnerId);
    });

    this.ammoName.textContent = ammoConfig.machine_gun.name;
    this._renderAmmoCost('machine_gun');
    this._renderEnergy(this.playerStats.energy, this.playerStats.maxEnergy);
    this._renderHp(this.playerStats.hp, this.playerStats.maxHp);
    this._renderUpgrades();
    this._renderRound();
  }

  setMyId(id) {
    this._myId = id;
  }

  tickRound(dt = 0) {
    this._renderRound();
    if (this._cooldown.active) {
      this._cooldown.elapsed += dt;
      if (this._cooldown.elapsed >= this._cooldown.duration) {
        this._cooldown = { active: false, elapsed: 0, duration: 0 };
      }
      this._renderCrosshairCooldown();
    }
    if (this._hitmarkTimer > 0) {
      this._hitmarkTimer = Math.max(0, this._hitmarkTimer - dt);
      if (this._hitmarkTimer === 0 && this.crosshairHitmark) {
        this.crosshairHitmark.classList.remove('active');
      }
    }
    if (this._killFeedEntries.length > 0) {
      const now = performance.now();
      for (let i = this._killFeedEntries.length - 1; i >= 0; i--) {
        const e = this._killFeedEntries[i];
        if (now - e.at > KILL_FEED_TTL_MS) {
          if (e.el && e.el.parentNode) e.el.parentNode.removeChild(e.el);
          this._killFeedEntries.splice(i, 1);
        }
      }
    }
  }

  _resolveName(id) {
    if (!id) return '';
    if (id === this._myId) return 'You';
    return this._nameById.get(id) || id.slice(0, 6);
  }

  _addKillFeedEntry(text, mine) {
    if (!this.killFeed) return;
    const el = document.createElement('div');
    el.className = mine ? 'kill-feed-entry mine' : 'kill-feed-entry';
    el.textContent = text;
    this.killFeed.appendChild(el);
    this._killFeedEntries.push({ el, at: performance.now() });
    while (this._killFeedEntries.length > KILL_FEED_MAX) {
      const old = this._killFeedEntries.shift();
      if (old.el && old.el.parentNode) old.el.parentNode.removeChild(old.el);
    }
  }

  _renderCrosshairCooldown() {
    if (!this.crosshairCooldown) return;
    if (!this._cooldown.active || this._cooldown.duration <= 0) {
      this.crosshairCooldown.style.opacity = '0';
      return;
    }
    const k = Math.min(1, this._cooldown.elapsed / this._cooldown.duration);
    const deg = Math.max(0, 360 * (1 - k));
    // Conic-gradient arc from 12 o'clock clockwise, shrinking as the cooldown
    // elapses. Goes fully transparent on completion; the CSS fade handles the
    // tail.
    this.crosshairCooldown.style.background =
      `conic-gradient(from -90deg, rgba(255, 235, 59, 0.55) ${deg}deg, transparent ${deg}deg)`;
    this.crosshairCooldown.style.opacity = k < 1 ? '1' : '0';
  }

  _renderLeaderboard(winnerId) {
    if (!this.roundOverlayLeaderboard) return;
    const list = this._lastPlayers || [];
    if (list.length === 0) {
      this.roundOverlayLeaderboard.innerHTML = '';
      return;
    }
    const rows = [...list].sort((a, b) => {
      // Winner first, then souls desc, then name.
      if (a.id === winnerId) return -1;
      if (b.id === winnerId) return 1;
      return (b.souls ?? 0) - (a.souls ?? 0) || (a.name || '').localeCompare(b.name || '');
    }).slice(0, 8);
    const html = rows.map((p, i) => {
      const isMe = p.id === this._myId;
      const isWin = p.id === winnerId;
      const classes = ['lb-row'];
      if (isWin) classes.push('lb-winner');
      if (isMe) classes.push('lb-me');
      const displayName = p.name || p.id.slice(0, 6);
      const medal = isWin ? '♚' : `${i + 1}.`;
      return `
        <div class="${classes.join(' ')}">
          <span class="lb-rank">${medal}</span>
          <span class="lb-name">${escapeHtml(displayName)}${isMe ? ' <em>(you)</em>' : ''}</span>
          <span class="lb-souls">${p.souls ?? 0}☠</span>
        </div>`;
    }).join('');
    this.roundOverlayLeaderboard.innerHTML = html;
  }

  _renderRound() {
    const rs = this.roundState;
    if (!rs || !this.roundBanner) return;

    if (rs.phase !== this._lastPhase) {
      // Round restarted — hide the end-of-round overlay and clear flags so
      // the next death/victory re-populates it cleanly.
      if (this._lastPhase === 'ended' && rs.phase === 'pve') {
        this._deathShown = false;
        this._winnerShown = false;
        this._rejoinDenied = false;
        this._overlayIsWinner = false;
        this.roundOverlay.classList.add('hidden');
        this.roundOverlay.classList.remove('victory');
        if (this.roundOverlayLeaderboard) this.roundOverlayLeaderboard.innerHTML = '';
        // Clear the kill-feed on round restart so old deaths don't bleed
        // into the new round.
        if (this.killFeed) {
          for (const e of this._killFeedEntries) {
            if (e.el && e.el.parentNode) e.el.parentNode.removeChild(e.el);
          }
          this._killFeedEntries.length = 0;
        }
      }
      // Fire a transition event the first time we see each phase so the
      // audio system (and anyone else subscribed) can react once per flip.
      if (this._lastPhase !== null) {
        events.emit(GameEvent.PHASE_TRANSITION, { from: this._lastPhase, to: rs.phase });
      }
      this.roundBanner.classList.remove('phase-pve', 'phase-pvp', 'phase-ended');
      this.roundBanner.classList.add(`phase-${rs.phase}`);
      this._lastPhase = rs.phase;
    }

    const phaseLabel = rs.phase === 'pve'
      ? 'PvE · ALLIANCE'
      : rs.phase === 'pvp'
        ? 'PvP · LAST STANDING'
        : 'ROUND OVER';
    this.roundPhase.textContent = phaseLabel;
    this.roundAlive.textContent = rs.aliveGenerals ?? 1;

    if (rs.phase === 'pve') {
      const elapsed = Math.max(0, (Date.now() - rs.startedAt) / 1000);
      const remain = Math.max(0, rs.fogShrinkSecs - elapsed);
      const m = Math.floor(remain / 60);
      const s = Math.floor(remain % 60).toString().padStart(2, '0');
      this.roundTimerTxt.textContent = `${m}:${s}`;
    } else {
      this.roundTimerTxt.textContent = '--:--';
    }

    // Countdown for end-of-round restart, displayed in the overlay subtitle.
    if (rs.phase === 'ended' && rs.restartAt && this._winnerShown) {
      const secs = Math.max(0, Math.ceil((rs.restartAt - Date.now()) / 1000));
      this.roundOverlaySub.textContent = `New round in ${secs}s`;
    }
  }

  _renderHp(current, max) {
    const pct = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
    this.hpFill.style.width = `${pct * 100}%`;
    this.hpCurrent.textContent = Math.round(current);
    this.hpMax.textContent = Math.round(max);
  }

  _triggerDamageFlash() {
    if (!this.damageFlash) return;
    this.damageFlash.classList.remove('flash');
    // Force reflow so the animation restarts
    void this.damageFlash.offsetWidth;
    this.damageFlash.classList.add('flash');
    if (this._flashTimeout) clearTimeout(this._flashTimeout);
    this._flashTimeout = setTimeout(() => {
      this.damageFlash.classList.remove('flash');
    }, 20);

    if (this.hpPanel) {
      this.hpPanel.classList.remove('hit');
      void this.hpPanel.offsetWidth;
      this.hpPanel.classList.add('hit');
    }
  }

  _addDamageArc(angleRadians) {
    if (!this.damageIndicators) return;
    // Convert radians → degrees for CSS
    const deg = (angleRadians * 180) / Math.PI;
    const el = document.createElement('div');
    el.className = 'damage-arc';
    el.style.setProperty('--a', `${deg}deg`);
    this.damageIndicators.appendChild(el);

    // Cap concurrent arcs
    this._activeArcs.push(el);
    while (this._activeArcs.length > 6) {
      const old = this._activeArcs.shift();
      if (old.parentNode) old.parentNode.removeChild(old);
    }

    // Remove after animation finishes
    setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
      const idx = this._activeArcs.indexOf(el);
      if (idx >= 0) this._activeArcs.splice(idx, 1);
    }, 1700);
  }

  _renderAmmoCost(key) {
    const cfg = ammoConfig[key];
    const energy = cfg.energyCost ?? 0;
    const souls = cfg.soulCost ?? 0;
    if (energy <= 0 && souls <= 0) {
      this.ammoCost.innerHTML = '';
      return;
    }
    const parts = [];
    if (energy > 0) parts.push(`<span class="cost-energy">${energy}⚡</span>`);
    if (souls > 0) parts.push(`<span class="cost-souls">${souls}☠</span>`);
    this.ammoCost.innerHTML = `cost: ${parts.join('<span class="cost-souls"> + </span>')}`;
  }

  _renderEnergy(current, max) {
    const pct = Math.max(0, Math.min(1, current / max));
    this.energyFill.style.width = `${pct * 100}%`;
    this.energyCurrent.textContent = Math.round(current);
    this.energyMax.textContent = Math.round(max);
  }

  _renderUpgrades() {
    for (const key of Object.keys(this.upgradeRows)) {
      const row = this.upgradeRows[key];
      const lvl = this.progression.getLevel(key);
      const cost = this.progression.getCost(key);
      row.level.textContent = `L${lvl}`;
      row.cost.textContent = `${cost}☠`;
      const afford = this.progression.canAfford(key);
      row.el.classList.toggle('affordable', afford);
      row.el.classList.toggle('unaffordable', !afford);
    }
  }

  showLockPrompt(visible) {
    this.lockPrompt.classList.toggle('hidden', !visible);
  }
}
