const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, logEvent } = require('./db');

const STREAMS_DIR = path.join(__dirname, '..', 'public', 'streams');
const router = express.Router();

// cameraId -> last push timestamp (ms). Used to tell "actively pushed by an
// agent right now" apart from "was relayed at some point, agent is down".
const lastPushAt = new Map();
const PUSH_FRESH_MS = 8000; // no push for this long => treat as offline

// Only accept the exact filenames our own agent (and streaming.js) produce.
// Blocks path traversal and anything that isn't a segment/playlist.
const SAFE_FILENAME = /^(index\.m3u8|seg_\d+\.ts)$/;

function findCameraByToken(token) {
  return db.prepare('SELECT * FROM cameras WHERE relay_token = ? AND is_relay = 1').get(token);
}

router.post('/:token/segment', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
  const camera = findCameraByToken(req.params.token);
  if (!camera) return res.status(404).json({ error: 'Token relay tidak dikenal' });

  const name = String(req.query.name || '');
  if (!SAFE_FILENAME.test(name)) return res.status(400).json({ error: 'Nama file tidak valid' });
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'Body kosong' });

  // Segments can be up to 50MB; writing synchronously would block the
  // event loop (and every other camera's streaming/recording work) for the
  // whole write. Use the async fs API so pushes just queue up instead.
  try {
    const dir = path.join(STREAMS_DIR, String(camera.id));
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, name), req.body);
  } catch (err) {
    return res.status(500).json({ error: `Gagal menyimpan segmen: ${err.message}` });
  }

  const wasStale = !isRelayFresh(camera.id);
  lastPushAt.set(camera.id, Date.now());
  if (wasStale) logEvent(camera.id, 'stream_started', 'Agen relay mulai mengirim video');

  res.json({ ok: true });
});

function isRelayFresh(cameraId) {
  const last = lastPushAt.get(cameraId);
  return !!last && Date.now() - last < PUSH_FRESH_MS;
}

function getRelayStatus(cameraId) {
  const last = lastPushAt.get(cameraId);
  return {
    active: isRelayFresh(cameraId),
    lastPushAt: last || null,
  };
}

module.exports = { router, isRelayFresh, getRelayStatus };
