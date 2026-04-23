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
`);

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

export default db;
