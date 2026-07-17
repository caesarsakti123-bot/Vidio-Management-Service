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

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => cb(null, `logo${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => {
    cb(null, /^image\/(png|jpe?g|svg\+xml|webp)$/.test(file.mimetype));
  },
});

router.get('/', (req, res) => {
  const all = settings.getAllSettings();
  // Never round-trip the real SMTP password to the browser — the form only
  // needs to know whether one is already set, and re-sends a new value on
  // save only if the admin actually typed one.
  const smtpPassSet = !!all.smtp_pass;
  res.json({ ...all, smtp_pass: '', smtp_pass_set: smtpPassSet });
});

router.put('/', (req, res) => {
  const body = { ...req.body };
  delete body.smtp_pass_set; // not a real setting, just a UI hint
  if (!body.smtp_pass) delete body.smtp_pass; // blank = "keep existing password"

  settings.setSettings(body);
  if ('health_check_interval_min' in body) healthcheck.reschedule();
  logEvent(null, 'settings_updated', 'Pengaturan aplikasi diperbarui');
  res.json({ ok: true });
});

router.post('/logo', (req, res) => {
  upload.single('logo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Ukuran file logo maksimal 2MB' : err.message });
    if (!req.file) return res.status(400).json({ error: 'File logo tidak valid (harus PNG/JPG/SVG/WebP, maks 2MB)' });
    const logoPath = `/uploads/${req.file.filename}?v=${Date.now()}`; // cache-bust on re-upload
    settings.setSetting('logo_path', logoPath);
    logEvent(null, 'settings_updated', 'Logo aplikasi diperbarui');
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
