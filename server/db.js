import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'world.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id                      TEXT PRIMARY KEY,
    name                    TEXT NOT NULL,
    position_x              REAL DEFAULT 0,
    position_z              REAL DEFAULT 40,
    souls                   INTEGER DEFAULT 0,
    energy                  REAL DEFAULT 80,
    upgrade_empower_self    INTEGER DEFAULT 0,
    upgrade_empower_allies  INTEGER DEFAULT 0,
    connected               INTEGER DEFAULT 0,
    last_seen               INTEGER
  );

  CREATE TABLE IF NOT EXISTS allies (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id    TEXT NOT NULL,
    position_x  REAL DEFAULT 0,
    position_z  REAL DEFAULT 40,
    tier        INTEGER DEFAULT 0,
    hp          REAL DEFAULT 1,
    type        TEXT DEFAULT 'skeleton',
    FOREIGN KEY (owner_id) REFERENCES players(id)
  );

  CREATE TABLE IF NOT EXISTS career_stats (
    player_id         TEXT PRIMARY KEY,
    rounds_played     INTEGER DEFAULT 0,
    rounds_won        INTEGER DEFAULT 0,
    pve_kills         INTEGER DEFAULT 0,
    pvp_kills         INTEGER DEFAULT 0,
    deaths            INTEGER DEFAULT 0,
    souls_lifetime    INTEGER DEFAULT 0,
    best_round_kills  INTEGER DEFAULT 0,
    best_round_souls  INTEGER DEFAULT 0,
    time_played_sec   INTEGER DEFAULT 0,
    zones_captured    INTEGER DEFAULT 0,
    first_played      INTEGER,
    last_played       INTEGER,
    FOREIGN KEY (player_id) REFERENCES players(id)
  );
`);

// Migrate older DBs that were created before the `zones_captured` column
// existed. SQLite can't ADD COLUMN IF NOT EXISTS — swallow the duplicate-
// column error on subsequent boots.
try {
  db.exec('ALTER TABLE career_stats ADD COLUMN zones_captured INTEGER DEFAULT 0');
} catch (e) {
  if (!String(e.message).includes('duplicate column')) throw e;
}

// Migrate older DBs that were created before the `type` column existed.
// SQLite doesn't support `ADD COLUMN IF NOT EXISTS`, so swallow the "duplicate
// column" error the second time it runs.
try {
  db.exec("ALTER TABLE allies ADD COLUMN type TEXT DEFAULT 'skeleton'");
} catch (e) {
  if (!String(e.message).includes('duplicate column')) throw e;
}

export const getPlayer = db.prepare('SELECT * FROM players WHERE id = ?');

export const upsertPlayer = db.prepare(`
  INSERT INTO players (id, name, position_x, position_z, last_seen, connected)
  VALUES (@id, @name, @position_x, @position_z, @last_seen, 1)
  ON CONFLICT(id) DO UPDATE SET
    name       = excluded.name,
    connected  = 1,
    last_seen  = excluded.last_seen
`);

export const updatePosition = db.prepare(`
  UPDATE players SET position_x = ?, position_z = ?, last_seen = ? WHERE id = ?
`);

export const updateSoulsAbs = db.prepare(`
  UPDATE players SET souls = ? WHERE id = ?
`);

export const saveUpgrade = db.prepare(`
  UPDATE players SET
    upgrade_empower_self   = @empower_self,
    upgrade_empower_allies = @empower_allies
  WHERE id = @id
`);

export const setDisconnected = db.prepare(`
  UPDATE players SET connected = 0, last_seen = ? WHERE id = ?
`);

export const setKilled = db.prepare(`
  UPDATE players SET
    position_x = 0, position_z = 40,
    souls = MAX(0, souls - 5),
    connected = 0
  WHERE id = ?
`);

export const getAllOfflinePlayers = db.prepare(
  'SELECT * FROM players WHERE connected = 0 AND last_seen > ?'
);

export const getAllies = db.prepare('SELECT * FROM allies WHERE owner_id = ?');
export const insertAlly = db.prepare(
  'INSERT INTO allies (owner_id, position_x, position_z, tier, hp, type) VALUES (?,?,?,?,?,?)'
);
export const deleteAllies = db.prepare('DELETE FROM allies WHERE owner_id = ?');

// ── Career stats ──────────────────────────────────────────────────────────
// Seed a career row the first time we see a player so subsequent UPDATE
// increments have something to hit. first_played / last_played timestamps
// are epoch ms.
export const seedCareer = db.prepare(`
  INSERT OR IGNORE INTO career_stats (player_id, first_played, last_played)
  VALUES (@player_id, @now, @now)
`);

export const getCareer = db.prepare('SELECT * FROM career_stats WHERE player_id = ?');

// Full-row read joined with the player's display name for leaderboard
// queries. Name lives on the players table; stats live here. LEFT JOIN so
// a stats row without a matching player (shouldn't happen, but defensive)
// still comes back with a null name instead of being dropped silently.
const leaderboardSelect = `
  SELECT c.*, p.name AS name
  FROM career_stats c
  LEFT JOIN players p ON p.id = c.player_id
`;
// Leaderboard queries. XP is derived, so we can't sort by it in SQL —
// instead the server sorts the rows in JS. These statements just fetch a
// superset large enough for a top-20 + a handful of ties.
export const getLeaderboardByWins = db.prepare(
  `${leaderboardSelect} WHERE c.rounds_played > 0 ORDER BY c.rounds_won DESC, c.pve_kills DESC LIMIT 100`
);
export const getLeaderboardByPveKills = db.prepare(
  `${leaderboardSelect} WHERE c.rounds_played > 0 ORDER BY c.pve_kills DESC LIMIT 100`
);
export const getLeaderboardAll = db.prepare(
  `${leaderboardSelect} WHERE c.rounds_played > 0`
);

// Per-event increments. Using a single statement per action keeps writes
// cheap and avoids re-reading rows just to do +1. All increments assume
// the row exists; seedCareer runs in the join handler before any of these.
export const incPveKill = db.prepare(
  'UPDATE career_stats SET pve_kills = pve_kills + 1, souls_lifetime = souls_lifetime + ?, last_played = ? WHERE player_id = ?'
);
// PvP kill always carries the +3 soul bounty with it — bundle them into
// one UPDATE to keep the write cost flat with a PvE kill.
export const incPvpKill = db.prepare(
  'UPDATE career_stats SET pvp_kills = pvp_kills + 1, souls_lifetime = souls_lifetime + ?, last_played = ? WHERE player_id = ?'
);
export const incDeath = db.prepare(
  'UPDATE career_stats SET deaths = deaths + 1, last_played = ? WHERE player_id = ?'
);
// End-of-round commit: rounds_played always, rounds_won if they're the
// victor, and best_round_* upgraded if this round beat their personal
// record. MAX() is SQLite's built-in.
export const commitRoundPlayed = db.prepare(`
  UPDATE career_stats SET
    rounds_played    = rounds_played + 1,
    rounds_won       = rounds_won + ?,
    best_round_kills = MAX(best_round_kills, ?),
    best_round_souls = MAX(best_round_souls, ?),
    last_played      = ?
  WHERE player_id = ?
`);
export const addTimePlayed = db.prepare(
  'UPDATE career_stats SET time_played_sec = time_played_sec + ?, last_played = ? WHERE player_id = ?'
);
export const incZoneCaptured = db.prepare(
  'UPDATE career_stats SET zones_captured = zones_captured + 1, last_played = ? WHERE player_id = ?'
);

export default db;
