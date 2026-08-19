const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');
const { decrypt } = require('./crypto');

const DB_PATH = path.join(__dirname, '..', 'data', 'vms.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
// SQLite disables foreign-key enforcement per-connection by default — without
// this, the ON DELETE CASCADE (recordings.camera_id) and ON DELETE SET NULL
// (cameras.location_id) declared below are silently decorative: deleting a
// camera would leave its recordings rows (and deleting a location would
// leave its cameras' location_id) orphaned forever instead of actually
// cascading/nulling.
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'operator',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cameras (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  brand TEXT,
  ip TEXT NOT NULL,
  rtsp_port INTEGER DEFAULT 554,
  onvif_port INTEGER DEFAULT 80,
  username TEXT,
  password TEXT,
  rtsp_path TEXT,
  rtsp_url TEXT,
  ptz_supported INTEGER DEFAULT 0,
  recording_enabled INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS recordings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  camera_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  started_at TEXT DEFAULT CURRENT_TIMESTAMP,
  size_bytes INTEGER DEFAULT 0,
  FOREIGN KEY(camera_id) REFERENCES cameras(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  camera_id INTEGER,
  type TEXT NOT NULL,
  message TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Simple key/value store for settings editable from the Pengaturan page
-- (SMTP, branding, retention, ...) so changing them doesn't require editing
-- .env and restarting the process.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- A marked moment inside one recording file (camera_id/occurred_at are
-- denormalized off recording_id purely so listing/filtering bookmarks
-- doesn't need a JOIN on the hot path). ON DELETE CASCADE on both FKs is
-- deliberate: a bookmark pointing at a camera or recording that no longer
-- exists (camera deleted, file purged by retention) is dead weight, not
-- evidence worth keeping — there's no video left for it to point into.
CREATE TABLE IF NOT EXISTS bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  camera_id INTEGER NOT NULL,
  recording_id INTEGER NOT NULL,
  offset_seconds REAL NOT NULL DEFAULT 0,
  occurred_at TEXT NOT NULL,
  note TEXT NOT NULL,
  created_by INTEGER,
  created_by_username TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(camera_id) REFERENCES cameras(id) ON DELETE CASCADE,
  FOREIGN KEY(recording_id) REFERENCES recordings(id) ON DELETE CASCADE
);
`);

function ensureColumn(table, name, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = columns.some((col) => col.name === name);
  if (!exists) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`).run();
  }
}

ensureColumn('cameras', 'motion_detection_enabled', 'INTEGER DEFAULT 0');
ensureColumn('cameras', 'motion_sensitivity', 'REAL DEFAULT 0.04');
ensureColumn('cameras', 'motion_recording_enabled', 'INTEGER DEFAULT 0');
ensureColumn('cameras', 'motion_last_triggered_at', 'INTEGER DEFAULT 0');
ensureColumn('cameras', 'location_id', 'INTEGER REFERENCES locations(id) ON DELETE SET NULL');
ensureColumn('cameras', 'sort_order', 'INTEGER DEFAULT 0');
ensureColumn('cameras', 'is_relay', 'INTEGER DEFAULT 0');
ensureColumn('cameras', 'relay_token', 'TEXT');
ensureColumn('cameras', 'building', 'TEXT');
ensureColumn('cameras', 'serial_number', 'TEXT');
ensureColumn('cameras', 'firmware_version', 'TEXT');
ensureColumn('cameras', 'channel_count', 'INTEGER DEFAULT 1');
ensureColumn('events', 'acknowledged', 'INTEGER DEFAULT 0');
ensureColumn('events', 'actor_id', 'INTEGER');
ensureColumn('events', 'actor_username', 'TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_events_actor_id ON events(actor_id)');
// health_routes.js's /trends query filters `WHERE type IN (camera_offline,
// camera_online)` over the *entire* events table — it can't bound by
// created_at the way other endpoints do (it needs each camera's last
// transition before the window too, to know whether it was already offline
// when the window opened), so the type filter is what needs to be cheap
// instead. Without this, that's a full table scan of every event ever
// logged (motion/recording/stream events included), growing forever.
db.exec('CREATE INDEX IF NOT EXISTS idx_events_type_created ON events(type, created_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_bookmarks_camera_id ON bookmarks(camera_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_bookmarks_recording_id ON bookmarks(recording_id)');

function seedAdmin() {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(process.env.ADMIN_USERNAME || 'admin');
  if (!existing) {
    const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10);
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run(process.env.ADMIN_USERNAME || 'admin', hash, 'admin');
    console.log(`[db] Seeded admin user "${process.env.ADMIN_USERNAME || 'admin'}"`);
  }
}

// `actor` is the acting user (req.user from the verified JWT — {id, username}),
// passed by routes that handle a deliberate user action (create/edit/delete,
// settings changes, login) so the activity log can show who did it. System-
// generated events (stream reconnects, health checks, scheduled purges) have
// no actor and are left null, same as before this parameter existed.
function logEvent(cameraId, type, message, actor = null) {
  db.prepare('INSERT INTO events (camera_id, type, message, actor_id, actor_username) VALUES (?, ?, ?, ?, ?)')
    .run(cameraId, type, message, actor?.id ?? null, actor?.username ?? null);
}

// password and rtsp_url (which embeds the same password) are stored
// encrypted at rest — this is the one place that decrypts them, so every
// caller that needs to actually connect to the camera (ffmpeg, ONVIF) goes
// through here instead of reading the raw row and risking a spot that
// forgets to decrypt.
function decryptCamera(cam) {
  if (!cam) return cam;
  return { ...cam, password: decrypt(cam.password), rtsp_url: decrypt(cam.rtsp_url) };
}

function getCameraById(id) {
  return decryptCamera(db.prepare('SELECT * FROM cameras WHERE id = ?').get(id));
}

module.exports = { db, DB_PATH, seedAdmin, logEvent, decryptCamera, getCameraById };
