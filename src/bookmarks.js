const express = require('express');
const { db, logEvent } = require('./db');

const router = express.Router();

// ffmpeg writes recording segment filenames via `-strftime 1` (recording.js)
// as rec_YYYY-MM-DD_HH-MM-SS.mp4, in the server's *local* time (glibc
// strftime uses localtime(), not UTC) — parse that back out so a bookmark's
// timestamp lines up with where it actually falls on the recording's
// timeline, instead of drifting by however stale `recordings.started_at` is
// (that column is only set once reconcileAndCleanup's hourly scan gets
// around to registering the file, not when the segment actually started).
const FILENAME_RE = /rec_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/;

function computeOccurredAt(recording, offsetSeconds) {
  const m = recording.filename.match(FILENAME_RE);
  if (!m) return recording.started_at;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const start = new Date(y, mo - 1, d, h, mi, s);
  const occurred = new Date(start.getTime() + offsetSeconds * 1000);
  // Match the naive-but-UTC "YYYY-MM-DD HH:MM:SS" shape SQLite's
  // CURRENT_TIMESTAMP produces elsewhere, so every timestamp column in the
  // app can go through the same client-side UTC-correction helper.
  return occurred.toISOString().slice(0, 19).replace('T', ' ');
}

router.get('/', (req, res) => {
  const cameraId = req.query.camera_id ? Number(req.query.camera_id) : null;
  const rows = cameraId
    ? db.prepare(`
        SELECT b.*, r.filename
        FROM bookmarks b JOIN recordings r ON r.id = b.recording_id
        WHERE b.camera_id = ? ORDER BY b.occurred_at DESC
      `).all(cameraId)
    : db.prepare(`
        SELECT b.*, r.filename
        FROM bookmarks b JOIN recordings r ON r.id = b.recording_id
        ORDER BY b.occurred_at DESC LIMIT 200
      `).all();
  res.json(rows);
});

router.post('/', (req, res) => {
  const recording = db.prepare('SELECT * FROM recordings WHERE id = ?').get(Number(req.body.recording_id));
  if (!recording) return res.status(404).json({ error: 'Rekaman tidak ditemukan' });

  const offset = Number(req.body.offset_seconds);
  if (!Number.isFinite(offset) || offset < 0) return res.status(400).json({ error: 'Posisi waktu tidak valid' });

  const note = String(req.body.note || '').trim();
  if (!note) return res.status(400).json({ error: 'Catatan bookmark tidak boleh kosong' });

  const occurredAt = computeOccurredAt(recording, offset);
  const info = db.prepare(`
    INSERT INTO bookmarks (camera_id, recording_id, offset_seconds, occurred_at, note, created_by, created_by_username)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(recording.camera_id, recording.id, offset, occurredAt, note, req.user.id, req.user.username);

  logEvent(recording.camera_id, 'bookmark_added', `Bookmark ditambahkan: "${note}"`, req.user);
  res.status(201).json({ id: info.lastInsertRowid, occurred_at: occurredAt });
});

router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Bookmark tidak ditemukan' });
  // Anyone logged in can add a bookmark, but only its author or an admin
  // can remove one — otherwise any operator could quietly delete another
  // operator's flagged evidence.
  if (req.user.role !== 'admin' && row.created_by !== req.user.id) {
    return res.status(403).json({ error: 'Tidak punya izin menghapus bookmark ini' });
  }
  db.prepare('DELETE FROM bookmarks WHERE id = ?').run(row.id);
  logEvent(row.camera_id, 'bookmark_deleted', `Bookmark dihapus: "${row.note}"`, req.user);
  res.json({ ok: true });
});

module.exports = router;
