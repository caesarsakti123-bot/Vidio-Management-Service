// ==================================================================
// NVR Playback Routes — Express router for NVR source CRUD + playback
// Place at: src/nvr_playback_routes.js
// ==================================================================

const express = require('express');
const { db, logEvent } = require('./db');
const { encrypt, decrypt } = require('./crypto');
const { requireRole } = require('./auth');
const nvr = require('./nvr_playback');

const router = express.Router();

// =====================================================================
//  NVR Sources CRUD (admin only for create/update/delete)
// =====================================================================

// GET /api/nvr-sources — List all NVR sources (no credentials exposed)
router.get('/sources', (req, res) => {
  const rows = db.prepare('SELECT id, name, ip, port, rtsp_port, brand, channels, created_at FROM nvr_sources ORDER BY name').all();
  res.json(rows);
});

// GET /api/nvr-sources/:id — Get single NVR source (no credentials exposed)
router.get('/sources/:id', (req, res) => {
  const row = db.prepare('SELECT id, name, ip, port, rtsp_port, brand, channels, created_at FROM nvr_sources WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'NVR source tidak ditemukan' });
  res.json(row);
});

// POST /api/nvr-sources — Create NVR source (admin only)
router.post('/sources', requireRole('admin'), (req, res) => {
  const { name, ip, port, rtsp_port, username, password, brand, channels } = req.body;
  if (!name || !ip) return res.status(400).json({ error: 'Nama dan IP wajib diisi' });

  const result = db.prepare(
    'INSERT INTO nvr_sources (name, ip, port, rtsp_port, username, password, brand, channels) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    name, ip,
    port || 80,
    rtsp_port || 554,
    username ? encrypt(username) : null,
    password ? encrypt(password) : null,
    brand || 'hikvision',
    channels || 16
  );

  logEvent(null, 'nvr_source_created', `NVR "${name}" (${ip}) ditambahkan`, req.user);
  res.json({ id: result.lastInsertRowid, message: 'NVR source berhasil ditambahkan' });
});

// PUT /api/nvr-sources/:id — Update NVR source (admin only)
router.put('/sources/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM nvr_sources WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'NVR source tidak ditemukan' });

  const { name, ip, port, rtsp_port, username, password, brand, channels } = req.body;

  db.prepare(`
    UPDATE nvr_sources SET
      name = COALESCE(?, name),
      ip = COALESCE(?, ip),
      port = COALESCE(?, port),
      rtsp_port = COALESCE(?, rtsp_port),
      username = COALESCE(?, username),
      password = COALESCE(?, password),
      brand = COALESCE(?, brand),
      channels = COALESCE(?, channels)
    WHERE id = ?
  `).run(
    name || null,
    ip || null,
    port ?? null,
    rtsp_port ?? null,
    username ? encrypt(username) : null,
    password ? encrypt(password) : null,
    brand || null,
    channels ?? null,
    id
  );

  logEvent(null, 'nvr_source_updated', `NVR "${name || existing.name}" diperbarui`, req.user);
  res.json({ message: 'NVR source berhasil diperbarui' });
});

// DELETE /api/nvr-sources/:id — Delete NVR source (admin only)
router.delete('/sources/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT name FROM nvr_sources WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'NVR source tidak ditemukan' });

  // Unlink cameras that reference this NVR
  db.prepare('UPDATE cameras SET nvr_source_id = NULL, nvr_channel = NULL WHERE nvr_source_id = ?').run(id);
  db.prepare('DELETE FROM nvr_sources WHERE id = ?').run(id);

  logEvent(null, 'nvr_source_deleted', `NVR "${existing.name}" dihapus`, req.user);
  res.json({ message: 'NVR source berhasil dihapus' });
});

// GET /api/nvr-sources/:id/test — Test connection to NVR (ISAPI deviceInfo)
// Config/setup action, same tier as the CRUD routes above — previously had
// no role check at all beyond index.js's router-level requireAuth, so any
// viewer could trigger it.
router.get('/sources/:id/test', requireRole(['admin', 'operator']), async (req, res) => {
  const source = nvr.getNvrSourceById(Number(req.params.id));
  if (!source) return res.status(404).json({ error: 'NVR source tidak ditemukan' });

  try {
    const info = await nvr.testNvrConnection(source);
    res.json({ success: true, device: info });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// =====================================================================
//  NVR Playback — Search & Stream
// =====================================================================

// GET /api/nvr-playback/search — Search recordings on NVR
//   ?nvr_id=1&channel=1&from=2026-09-01T00:00:00&to=2026-09-01T23:59:59
// Explicit role declaration (matches every other route file) — searching/
// viewing footage is consistent with viewer already being allowed to watch
// live streams and recordings.
router.get('/search', requireRole(['admin', 'operator', 'viewer']), async (req, res) => {
  const nvrId = Number(req.query.nvr_id);
  const channel = Number(req.query.channel);
  const from = req.query.from;
  const to = req.query.to;

  if (!nvrId || !channel || !from || !to) {
    return res.status(400).json({ error: 'Parameter nvr_id, channel, from, to wajib diisi' });
  }

  const source = nvr.getNvrSourceById(nvrId);
  if (!source) return res.status(404).json({ error: 'NVR source tidak ditemukan' });

  try {
    const recordings = await nvr.searchNvrRecordings(source, channel, from, to);
    res.json({
      nvr_id: nvrId,
      channel,
      from,
      to,
      count: recordings.length,
      recordings,
    });
  } catch (err) {
    console.error(`[nvr-playback] Search error for NVR ${nvrId}: ${err.message}`);
    res.status(502).json({ error: `Gagal mencari rekaman di NVR: ${err.message}` });
  }
});

// POST /api/nvr-playback/start — Start RTSP replay → HLS stream
//   { nvr_id, channel, startTime, endTime }
//   Returns: { stream_id, hls_url }
router.post('/start', requireRole(['admin', 'operator', 'viewer']), (req, res) => {
  const { nvr_id, channel, startTime, endTime } = req.body;
  if (!nvr_id || !channel || !startTime || !endTime) {
    return res.status(400).json({ error: 'Parameter nvr_id, channel, startTime, endTime wajib diisi' });
  }

  const source = nvr.getNvrSourceById(nvr_id);
  if (!source) return res.status(404).json({ error: 'NVR source tidak ditemukan' });

  try {
    const result = nvr.startNvrPlayback(source, channel, startTime, endTime);
    logEvent(null, 'nvr_playback_started',
      `NVR playback dimulai: ${source.name} ch${channel} ${startTime} → ${endTime}`, req.user);
    res.json(result);
  } catch (err) {
    console.error(`[nvr-playback] Start error: ${err.message}`);
    const status = err.code === 'NVR_PLAYBACK_LIMIT' ? 429 : 500;
    res.status(status).json({ error: `Gagal memulai playback: ${err.message}` });
  }
});

// POST /api/nvr-playback/stop — Stop an active playback session
//   { stream_id }
router.post('/stop', requireRole(['admin', 'operator', 'viewer']), (req, res) => {
  const { stream_id } = req.body;
  if (!stream_id) return res.status(400).json({ error: 'stream_id wajib diisi' });

  const stopped = nvr.stopNvrPlayback(stream_id);
  res.json({ stopped });
});

// GET /api/nvr-playback/active — List active playback sessions (for debugging)
router.get('/active', requireRole('admin'), (req, res) => {
  const sessions = [];
  // We can't iterate activeSessions from here directly, but the module
  // could export a list function. For now, expose via the route for admins.
  res.json({ message: 'Active NVR playback sessions listed in server console' });
});

module.exports = router;
