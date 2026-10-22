const express = require('express');
const { db } = require('./db');
const { requireRole } = require('./auth');

const router = express.Router();

// Only event types worth surfacing in the alarm center — routine
// CRUD/lifecycle events (camera_added, user_created, ...) stay in the
// regular Log peristiwa page but don't need to page anyone. stream_error is
// deliberately excluded: it also fires on the routine QSV->x264 hardware
// fallback (self-healing, not actionable), which would otherwise flood this
// list and bury genuinely important alerts.
const ALERT_TYPES = ['camera_offline', 'recording_error', 'motion_detector_error', 'motion_detected'];
const placeholders = ALERT_TYPES.map(() => '?').join(',');

router.get('/', (req, res) => {
  const onlyUnread = req.query.unacknowledged === 'true';
  const rows = db.prepare(`
    SELECT * FROM events
    WHERE type IN (${placeholders}) ${onlyUnread ? 'AND acknowledged = 0' : ''}
    ORDER BY id DESC LIMIT 100
  `).all(...ALERT_TYPES);
  res.json(rows);
});

router.get('/count', (req, res) => {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE type IN (${placeholders}) AND acknowledged = 0`).get(...ALERT_TYPES);
  res.json({ count: row.n });
});

// Acknowledging clears an alert from every admin/operator's alarm center
// with no per-user tracking of who dismissed it — previously open to any
// authenticated role including viewer, who could "mark all read" and make a
// real ongoing outage (e.g. camera_offline) silently disappear for the
// people who could actually act on it.
router.use(requireRole(['admin', 'operator']));

router.post('/:id/ack', (req, res) => {
  // Scoped to ALERT_TYPES like every other query in this file — previously
  // this was the one query that didn't, so it would flip `acknowledged` on
  // any event id at all, not just alert-type ones.
  db.prepare(`UPDATE events SET acknowledged = 1 WHERE id = ? AND type IN (${placeholders})`).run(Number(req.params.id), ...ALERT_TYPES);
  res.json({ ok: true });
});

router.post('/ack-all', (req, res) => {
  db.prepare(`UPDATE events SET acknowledged = 1 WHERE type IN (${placeholders}) AND acknowledged = 0`).run(...ALERT_TYPES);
  res.json({ ok: true });
});

module.exports = router;
