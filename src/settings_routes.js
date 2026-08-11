const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { logEvent } = require('./db');
const settings = require('./settings');
const notifications = require('./notifications');
const healthcheck = require('./healthcheck');

const router = express.Router();

const UPLOADS_DIR = path.join(__dirname, '..', 'public', 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// SVG is deliberately excluded: it's an XML document that can embed
// <script>/onload/etc., and public/ is served statically with no auth
// (index.js), so an uploaded SVG would execute as script on this origin for
// any visitor who opens it directly — there's no safe way to "validate" that
// away short of a full sanitizer, so raster-only is the simple fix.
const ALLOWED_LOGO_TYPES = {
  'image/png': { ext: '.png', magic: [0x89, 0x50, 0x4e, 0x47] },
  'image/jpeg': { ext: '.jpg', magic: [0xff, 0xd8, 0xff] },
  'image/webp': { ext: '.webp', magic: [0x52, 0x49, 0x46, 0x46] }, // "RIFF" (WEBP check follows at byte 8)
};

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => cb(null, `logo${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => {
    cb(null, file.mimetype in ALLOWED_LOGO_TYPES);
  },
});

// multer's fileFilter only sees the client-supplied Content-Type header —
// trivially spoofable — so it can't be trusted alone to keep non-image files
// (or an SVG relabeled as image/png) out. Check the actual bytes on disk
// after upload instead, and reject/delete anything that doesn't match.
function verifyImageMagicBytes(filePath, mimetype) {
  const spec = ALLOWED_LOGO_TYPES[mimetype];
  if (!spec) return false;
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(12);
    fs.readSync(fd, buf, 0, 12, 0);
    const headMatches = spec.magic.every((byte, i) => buf[i] === byte);
    if (mimetype === 'image/webp') {
      return headMatches && buf.toString('ascii', 8, 12) === 'WEBP';
    }
    return headMatches;
  } finally {
    fs.closeSync(fd);
  }
}

router.get('/', (req, res) => {
  const all = settings.getAllSettings();
  // Never round-trip the real SMTP password to the browser — the form only
  // needs to know whether one is already set, and re-sends a new value on
  // save only if the admin actually typed one.
  const smtpPassSet = !!all.smtp_pass;
  res.json({ ...all, smtp_pass: '', smtp_pass_set: smtpPassSet });
});

// Keys in DEFAULTS that this generic endpoint must never accept — each has
// its own dedicated route that validates the value before it's allowed to
// reach settings.setSetting, so a value arriving through here instead would
// skip that validation entirely.
const PUT_EXCLUDED_KEYS = new Set(['logo_path']); // must only come from POST /logo, which validates the uploaded file's actual bytes

router.put('/', (req, res) => {
  // Allowlist against the known setting keys instead of trusting whatever
  // keys the caller sends — without this, a PUT could pollute the settings
  // table with arbitrary junk keys the app never reads back.
  const body = {};
  for (const key of Object.keys(settings.DEFAULTS)) {
    if (key in req.body && !PUT_EXCLUDED_KEYS.has(key)) body[key] = req.body[key];
  }
  if (!body.smtp_pass) delete body.smtp_pass; // blank = "keep existing password"

  // These two gate setInterval()/comparison loops in healthcheck.js — a
  // 0 or negative interval collapses to Node's minimum timer delay and
  // hammers every camera's health probe (and possibly notification email)
  // in a near-tight loop instead of every N minutes.
  if ('health_check_interval_min' in body) {
    const n = Number(body.health_check_interval_min);
    if (!Number.isFinite(n) || n < 1) {
      return res.status(400).json({ error: 'Interval health check minimal 1 menit' });
    }
  }
  if ('offline_threshold_checks' in body) {
    const n = Number(body.offline_threshold_checks);
    if (!Number.isFinite(n) || n < 1) {
      return res.status(400).json({ error: 'Ambang gagal berturut-turut minimal 1' });
    }
  }
  // recording.js computes cutoff = now - retentionDays*24h and deletes every
  // file older than that. A 0/negative/non-numeric value here isn't caught
  // by `Number(x) || 14` (negative is truthy) and pushes cutoff into the
  // future, which deletes every recording for every camera on the very next
  // cleanup pass — validate it the same way as the interval guards above.
  if ('retention_days' in body) {
    const n = Number(body.retention_days);
    if (!Number.isFinite(n) || n < 1) {
      return res.status(400).json({ error: 'Retensi rekaman minimal 1 hari' });
    }
  }

  settings.setSettings(body);
  if ('health_check_interval_min' in body) healthcheck.reschedule();
  logEvent(null, 'settings_updated', 'Pengaturan aplikasi diperbarui', req.user);
  res.json({ ok: true });
});

router.post('/logo', (req, res) => {
  upload.single('logo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Ukuran file logo maksimal 2MB' : err.message });
    if (!req.file) return res.status(400).json({ error: 'File logo tidak valid (harus PNG/JPG/WebP, maks 2MB)' });

    if (!verifyImageMagicBytes(req.file.path, req.file.mimetype)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Isi file tidak cocok dengan format gambar yang diklaim — upload dibatalkan' });
    }

    const logoPath = `/uploads/${req.file.filename}?v=${Date.now()}`; // cache-bust on re-upload
    settings.setSetting('logo_path', logoPath);
    logEvent(null, 'settings_updated', 'Logo aplikasi diperbarui', req.user);
    res.json({ ok: true, logo_path: logoPath });
  });
});

router.post('/test-email', async (req, res) => {
  try {
    await notifications.sendTestEmail();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
