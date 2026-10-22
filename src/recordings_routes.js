const express = require('express');
const path = require('path');
const fs = require('fs');
const { db } = require('./db');
const { camDir, markServing, unmarkServing } = require('./recording');
const settings = require('./settings');
const { requireRole } = require('./auth');

const router = express.Router();

// Previously relied entirely on index.js's router-level requireAuth, with no
// role declared here at all (unlike every other route file) — viewing
// recordings is consistent with viewer already being allowed to watch live
// streams, so this makes that intentional rather than incidental.
router.use(requireRole(['admin', 'operator', 'viewer']));

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
  // Same "YYYY-MM-DD HH:MM:SS" UTC shape as started_at itself — see the
  // identical from/to convention on GET /api/users/activity.
  const from = req.query.from ? String(req.query.from) : '';
  const to = req.query.to ? String(req.query.to) : '';

  const conditions = [];
  const params = [];
  if (cameraId) { conditions.push('camera_id = ?'); params.push(cameraId); }
  if (from) { conditions.push('started_at >= ?'); params.push(from); }
  if (to) { conditions.push('started_at <= ?'); params.push(to); }

  // The 200-row cap only makes sense for the unfiltered "recent across
  // every camera" view — any explicit filter (camera and/or date range) is
  // already naturally bounded by what it's scoped to, and truncating a
  // filtered investigation search silently would be worse than a long list.
  const hasFilter = conditions.length > 0;
  const sql = `SELECT * FROM recordings${hasFilter ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY started_at DESC${hasFilter ? '' : ' LIMIT 200'}`;
  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

// Shared by /download and /stream: logs + (when still possible) responds
// cleanly instead of silently truncating. The retention sweep is now kept
// from unlinking a file while markServing() below has it marked (see
// recording.js), but the existsSync-to-actual-open gap, and a mid-stream
// failure on a large/slow transfer, were previously unguarded — Express
// requires the caller to handle the response itself whenever a callback is
// passed to res.download/sendFile, so without this they'd either hang (no
// response ever sent) or fail with nothing logged server-side.
function handleSendError(err, res, filename, verb) {
  if (!err) return;
  if (res.headersSent) {
    console.error(`[recordings] ${verb} ${filename} terputus di tengah pengiriman: ${err.message}`);
    return;
  }
  console.error(`[recordings] gagal ${verb} ${filename}: ${err.message}`);
  res.status(err.status || 404).json({ error: 'File tidak ditemukan atau gagal dibaca di disk' });
}

router.get('/:id/download', (req, res) => {
  const id = Number(req.params.id);
  // A non-numeric id (e.g. "abc") becomes NaN, which better-sqlite3 throws
  // on when bound as a parameter — that surfaced as a generic 500 instead
  // of a clean 400 for what's really just a bad request.
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID rekaman tidak valid' });
  const row = db.prepare('SELECT * FROM recordings WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Rekaman tidak ditemukan' });
  const filePath = path.join(camDir(row.camera_id), row.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File tidak ditemukan di disk' });
  markServing(filePath);
  res.download(filePath, row.filename, (err) => {
    unmarkServing(filePath);
    handleSendError(err, res, row.filename, 'mengunduh');
  });
});

// Same file as /download, but served inline (no Content-Disposition: attachment)
// with Range support so <video> can stream/seek instead of forcing a save-as.
router.get('/:id/stream', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID rekaman tidak valid' });
  const row = db.prepare('SELECT * FROM recordings WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Rekaman tidak ditemukan' });
  const filePath = path.join(camDir(row.camera_id), row.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File tidak ditemukan di disk' });
  markServing(filePath);
  res.sendFile(filePath, (err) => {
    unmarkServing(filePath);
    handleSendError(err, res, row.filename, 'streaming');
  });
});

module.exports = router;
