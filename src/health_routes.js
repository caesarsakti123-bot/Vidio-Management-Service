const express = require('express');
const { db } = require('./db');

const router = express.Router();

const MAX_DAYS = 90;

// Reconstructs uptime/downtime for one camera from its ordered
// camera_offline/camera_online transition events (healthcheck.js only logs
// transitions, not every check, so a period of silence between two events
// means "still in whatever state the last event left it in").
function computeTrend(events, windowStart, windowEnd) {
  let isOffline = false;
  let offlineSince = null;
  let downtimeMs = 0;
  let offlineCount = 0;
  const intervals = [];

  // Determine the state the camera was already in when the window opened —
  // otherwise a camera that went offline before the window and is still
  // offline now would look like it's had zero downtime.
  for (const ev of events) {
    if (ev.ts >= windowStart) break;
    isOffline = ev.type === 'camera_offline';
  }
  if (isOffline) offlineSince = windowStart;

  for (const ev of events) {
    if (ev.ts < windowStart) continue;
    if (ev.ts > windowEnd) break;
    if (ev.type === 'camera_offline' && !isOffline) {
      isOffline = true;
      offlineSince = ev.ts;
      offlineCount += 1;
    } else if (ev.type === 'camera_online' && isOffline) {
      isOffline = false;
      downtimeMs += ev.ts - offlineSince;
      intervals.push({ start: offlineSince, end: ev.ts });
      offlineSince = null;
    }
  }
  // Still offline at the end of the window — count the open interval up to
  // windowEnd instead of dropping it (this is also how "currently offline"
  // is derived: no matching camera_online event ever closed it).
  if (isOffline && offlineSince !== null) {
    downtimeMs += windowEnd - offlineSince;
    intervals.push({ start: offlineSince, end: windowEnd });
  }

  const windowMs = windowEnd - windowStart;
  const uptimePct = windowMs > 0 ? Math.max(0, Math.min(100, ((windowMs - downtimeMs) / windowMs) * 100)) : 100;
  return { uptime_pct: uptimePct, downtime_ms: downtimeMs, offline_count: offlineCount, currently_offline: isOffline, intervals };
}

router.get('/trends', (req, res) => {
  const days = Math.min(MAX_DAYS, Math.max(1, Number(req.query.days) || 7));
  const windowEnd = Date.now();
  const windowStart = windowEnd - days * 24 * 60 * 60 * 1000;

  const cameras = db.prepare('SELECT id, name, location_id, is_relay FROM cameras ORDER BY name').all();

  // Pull the full transition history in one query (not one query per camera)
  // and group in JS — cheap even at thousands of rows, and avoids an N+1
  // query per camera. strftime('%s', ...) converts SQLite's stored UTC
  // timestamp to a true epoch directly in SQL, so it lines up with
  // Date.now() below without going through JS's ambiguous parsing of
  // "YYYY-MM-DD HH:MM:SS" (which Node reads as local time, not UTC).
  const allEvents = db.prepare(`
    SELECT camera_id, type, CAST(strftime('%s', created_at) AS INTEGER) * 1000 AS ts
    FROM events
    WHERE type IN ('camera_offline', 'camera_online')
    ORDER BY camera_id ASC, created_at ASC
  `).all();

  const byCamera = new Map();
  for (const ev of allEvents) {
    if (!byCamera.has(ev.camera_id)) byCamera.set(ev.camera_id, []);
    byCamera.get(ev.camera_id).push(ev);
  }

  const results = cameras.map((cam) => {
    const events = byCamera.get(cam.id) || [];
    const trend = computeTrend(events, windowStart, windowEnd);
    return {
      camera_id: cam.id,
      name: cam.name,
      location_id: cam.location_id,
      is_relay: !!cam.is_relay,
      ...trend,
    };
  });

  res.json({ days, window_start: windowStart, window_end: windowEnd, cameras: results });
});

module.exports = router;
