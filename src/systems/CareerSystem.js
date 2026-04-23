import { GameEvent, events } from './EventSystem.js';
import { progressFor, levelFor, titleFor, xpFor } from '../config/ranks.js';

// Client-side store for career-progression data. Holds:
//   - myCareer: the local player's full stats snapshot (latest known)
//   - ranksByPid: compact {level,title} for every other general we've
//     learned about (via player_joined payloads, state_tick, and
//     `career_promoted` broadcasts). Used to render rank badges in the
//     kill feed and round-end leaderboard without roundtripping the DB.
//
// Authority lives on the server; this class is a pure cache. Anything
// that needs the current rank of "me" or "that player over there" reads
// from here and re-renders on CAREER_UPDATED.
export class CareerSystem {
  constructor() {
    this.myId = null;
    this.myCareer = null;          // full stats object (see rankPayload on server)
    this.ranksByPid = new Map();   // pid → { level, title }

    // Server broadcasts `career_promoted` to the whole room whenever any
    // player crosses a rank threshold. Update the cache and fan out a
    // single CAREER_UPDATED event so every UI surface (kill feed, HUD
    // badge, round-end leaderboard) re-renders off one signal.
    events.subscribe(GameEvent.NET_CAREER_PROMOTED, ({ playerId, level, title }) => {
      if (!playerId) return;
      this.ranksByPid.set(playerId, { level, title });
      if (playerId === this.myId && this.myCareer) {
        // Recompute derived fields so the HUD/splash card show the new
        // rank even before the next round_summary lands.
        this.myCareer = { ...this.myCareer, level, title };
      }
      events.emit(GameEvent.CAREER_UPDATED, {
        playerId, level, title, isMe: playerId === this.myId, reason: 'promoted',
      });
    });

    // Round-summary carries the freshly committed career snapshot for
    // this player — always authoritative, use it to overwrite myCareer.
    events.subscribe(GameEvent.NET_CAREER_SUMMARY, ({ career, delta }) => {
      if (!career) return;
      const prevLevel = this.myCareer?.level ?? 0;
      this.myCareer = career;
      this.ranksByPid.set(this.myId, { level: career.level, title: career.title });
      events.emit(GameEvent.CAREER_UPDATED, {
        playerId: this.myId,
        level: career.level,
        title: career.title,
        isMe: true,
        delta,
        prevLevel,
        reason: 'round_summary',
      });
    });
  }

  setMyId(id) { this.myId = id; }

  // Called by main.js when welcome/restore_state lands with the server's
  // authoritative career snapshot for the local player.
  setMyCareer(career) {
    this.myCareer = career;
    if (career && this.myId) {
      this.ranksByPid.set(this.myId, { level: career.level, title: career.title });
    }
    events.emit(GameEvent.CAREER_UPDATED, {
      playerId: this.myId, level: career?.level ?? 0, title: career?.title ?? 'Conscript',
      isMe: true, reason: 'initial',
    });
  }

  // Ingest the rank field from a serializePlayer payload. Used on
  // player_joined and every state_tick so that when a player's rank is
  // already cached server-side, we learn it without needing a separate
  // broadcast.
  noteRankFromPlayer(pid, rank) {
    if (!pid || !rank) return;
    const prev = this.ranksByPid.get(pid);
    if (prev && prev.level === rank.level) return;
    this.ranksByPid.set(pid, rank);
    events.emit(GameEvent.CAREER_UPDATED, {
      playerId: pid, level: rank.level, title: rank.title,
      isMe: pid === this.myId, reason: 'player_payload',
    });
  }

  getRank(pid) {
    return this.ranksByPid.get(pid) ?? null;
  }

  getMyCareer() {
    return this.myCareer;
  }

  getMyProgress() {
    if (!this.myCareer) return null;
    return progressFor(this.myCareer.xp ?? xpFor(this.myCareer));
  }

  // Utility for UI code that wants a rank derived purely from raw stats
  // (e.g. splash-screen cache from the server's career_response).
  static rankFromStats(stats) {
    if (!stats) return null;
    const xp = stats.xp ?? xpFor(stats);
    const level = levelFor(xp);
    return { level, title: titleFor(level) };
  }
}
