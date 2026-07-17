const { db } = require('./db');
const { encrypt, decrypt } = require('./crypto');

// Values that hold credentials — encrypted at rest same as camera passwords.
const SENSITIVE_KEYS = new Set(['smtp_pass']);

// Falls back to whatever was in .env at first boot, so upgrading from the
// env-var-only setup doesn't silently reset anything. After the first write
// through the Pengaturan page, the settings table is the source of truth.
const DEFAULTS = {
  app_name: 'Open VMS',
  logo_path: '',
  smtp_enabled: 'false',
  smtp_host: process.env.SMTP_HOST || 'smtp.office365.com',
  smtp_port: process.env.SMTP_PORT || '587',
  smtp_user: process.env.SMTP_USER || '',
  smtp_pass: process.env.SMTP_PASS || '',
  notify_email_to: process.env.NOTIFY_EMAIL_TO || '',
  retention_days: process.env.RETENTION_DAYS || '14',
  stream_max_width: process.env.STREAM_MAX_WIDTH || '960',
  stream_fps: process.env.STREAM_FPS || '15',
  hwaccel_mode: process.env.HWACCEL_MODE || 'auto',
  health_check_interval_min: process.env.HEALTH_CHECK_INTERVAL_MIN || '5',
  offline_threshold_checks: process.env.OFFLINE_THRESHOLD_CHECKS || '2',
};

let cache = null;

function loadCache() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const stored = {};
  for (const row of rows) stored[row.key] = row.value;
  cache = { ...DEFAULTS, ...stored };
}

function ensureLoaded() {
  if (!cache) loadCache();
}

function getSetting(key) {
  ensureLoaded();
  const val = cache[key];
  return SENSITIVE_KEYS.has(key) && val ? decrypt(val) : val;
}

// Returns everything with sensitive values decrypted — callers that expose
// this over the API (settings_routes.js) are responsible for masking them
// before sending to anyone but the value-editing form itself.
function getAllSettings() {
  ensureLoaded();
  const out = {};
  for (const key of Object.keys(cache)) out[key] = getSetting(key);
  return out;
}

const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

function setSetting(key, value) {
  const toStore = SENSITIVE_KEYS.has(key) && value ? encrypt(value) : (value ?? '');
  upsert.run(key, String(toStore));
  ensureLoaded();
  cache[key] = String(toStore);
}

function setSettings(obj) {
  const applyAll = db.transaction((entries) => {
    for (const [key, value] of entries) setSetting(key, value);
  });
  applyAll(Object.entries(obj));
}

module.exports = { getSetting, getAllSettings, setSetting, setSettings, DEFAULTS };
