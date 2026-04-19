import { GameEvent, events } from '../systems/EventSystem.js';
import ammoConfig from '../config/ammo.json';

const AMMO_CLASSES = Object.keys(ammoConfig).map(k => `ammo-${k}`);

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
    this._lastPhase = null;
    this._deathShown = false;
    this._winnerShown = false;

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
      this.hostiles.textContent = `⚔ ${d.hostiles} hostiles`;
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
          : (winnerId ? 'Round over — another general won' : 'Round over — no winner');
      }
      // Seed the countdown subtitle so there's no blank frame before _renderRound ticks.
      const secs = restartAt
        ? Math.max(0, Math.ceil((restartAt - Date.now()) / 1000))
        : 30;
      this.roundOverlaySub.textContent = `New round in ${secs}s`;
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

  tickRound() {
    this._renderRound();
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
