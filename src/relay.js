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

// The relay agent's own `-hls_flags delete_segments` only prunes *its*
// local WORK_DIR as its rolling window advances — it has no idea those
// segments were already copied here. Every agent restart/reconnect also
// resets its segment counter back to seg_000.ts, so without this, each
// past agent process leaves its last few pushed segments behind forever,
// unreferenced by the current index.m3u8 and never reclaimed until the
// camera itself is deleted. Mirrors clearStreamDir's role in streaming.js,
// just driven by what the playlist currently references instead of owning
// the ffmpeg process directly.
const SEGMENT_NAME_RE = /^seg_\d+\.ts$/;
// Only reclaim segments old enough that they can't be one still in transit
// from the agent (pushed moments after the playlist that doesn't yet
// mention it, or about to be overwritten by the agent's own counter wrap) —
// avoids racing a legitimately-about-to-be-referenced file.
const ORPHAN_SEGMENT_AGE_MS = 30000;

async function cleanupOrphanedSegments(cameraId, playlistText) {
  const dir = path.join(STREAMS_DIR, String(cameraId));
  let entries;
  try {
    entries = await fs.promises.readdir(dir);
  } catch (_err) {
    return;
  }
  const referenced = new Set(
    String(playlistText)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => SEGMENT_NAME_RE.test(line))
  );
  const now = Date.now();
  for (const name of entries) {
    if (!SEGMENT_NAME_RE.test(name) || referenced.has(name)) continue;
    const full = path.join(dir, name);
    try {
      const stat = await fs.promises.stat(full);
      if (now - stat.mtimeMs > ORPHAN_SEGMENT_AGE_MS) {
        await fs.promises.unlink(full);
      }
    } catch (_err) {
      // already gone, fine
    }
  }
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

  if (name === 'index.m3u8') {
    cleanupOrphanedSegments(camera.id, req.body).catch(() => {});
  }

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

// Called by DELETE /api/cameras/:id so lastPushAt doesn't keep an entry for
// a camera id that no longer exists.
function forgetCamera(cameraId) {
  lastPushAt.delete(cameraId);
}

module.exports = { router, isRelayFresh, getRelayStatus, forgetCamera };
