const express = require('express');
const path = require('path');
const fs = require('fs');
const { db } = require('./db');
const { camDir } = require('./recording');
const settings = require('./settings');

const router = express.Router();

router.get('/stats', (req, res) => {
  const row = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS total_bytes FROM recordings').get();
  res.json({
    count: row.count,
    total_bytes: row.total_bytes,
    // Must match what recording.js's cleanup job actually uses (the
    // settings table, which the Pengaturan page writes to and which wins
    // over .env) — reading process.env directly here reported a stale
    // number once an admin changed retention from the Pengaturan UI.
    retention_days: Number(settings.getSetting('retention_days')) || 14,
  });
});

router.get('/', (req, res) => {
  const cameraId = req.query.camera_id ? Number(req.query.camera_id) : null;
  const rows = cameraId
    ? db.prepare('SELECT * FROM recordings WHERE camera_id = ? ORDER BY started_at DESC').all(cameraId)
    : db.prepare('SELECT * FROM recordings ORDER BY started_at DESC LIMIT 200').all();
  res.json(rows);
});

router.get('/:id/download', (req, res) => {
  const row = db.prepare('SELECT * FROM recordings WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Rekaman tidak ditemukan' });
  const filePath = path.join(camDir(row.camera_id), row.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File tidak ditemukan di disk' });
  res.download(filePath, row.filename);
});

// Same file as /download, but served inline (no Content-Disposition: attachment)
// with Range support so <video> can stream/seek instead of forcing a save-as.
router.get('/:id/stream', (req, res) => {
  const row = db.prepare('SELECT * FROM recordings WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Rekaman tidak ditemukan' });
  const filePath = path.join(camDir(row.camera_id), row.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File tidak ditemukan di disk' });
  res.sendFile(filePath);
});

module.exports = router;
