require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const pkg = require('../package.json');
const { seedAdmin, db, DB_PATH } = require('./db');
const { login, logout, changeOwnPassword, requireAuth, requireRole } = require('./auth');
const camerasRouter = require('./cameras');
const recordingsRouter = require('./recordings_routes');
const usersRouter = require('./users');
const locationsRouter = require('./locations');
const settingsRouter = require('./settings_routes');
const settings = require('./settings');
const alertsRouter = require('./alerts');
const relay = require('./relay');
const streaming = require('./streaming');
const recording = require('./recording');
const motion = require('./motion');
const healthcheck = require('./healthcheck');
const healthTrendsRouter = require('./health_routes');
const bookmarksRouter = require('./bookmarks');

seedAdmin();
recording.startCleanupScheduler();
recording.startAllEnabled();
motion.startAllEnabled();
healthcheck.startHealthCheckScheduler();

// Read once at startup (not per-request) — shelling out to git on every
// /api/about hit would be wasteful, and the commit obviously can't change
// while this process is running anyway. Falls back to null in deployments
// that don't ship a .git folder, or don't have git on PATH.
let gitInfo = null;
try {
  const commit = execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  const date = execSync('git log -1 --format=%cI', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  gitInfo = { commit, date };
} catch {
  // Not a git checkout, or git isn't installed on this machine — fine, the
  // About page just omits the commit line.
}

const app = express();
app.use(cors());
app.use(express.json());

// Public: login
app.post('/api/auth/login', login);

// Any logged-in role can change their own password — see the note on
// changeOwnPassword itself for why this isn't just PUT /api/users/:id.
app.post('/api/auth/change-password', requireAuth, changeOwnPassword);

// JWTs aren't server-tracked (no session table to invalidate), so this
// doesn't actually revoke anything — it exists purely so the activity log
// has a "logout" entry to pair with "login" instead of every session just
// trailing off with no record of when the user left.
app.post('/api/auth/logout', requireAuth, logout);

// Public (token-authenticated, not JWT): remote relay agents push HLS
// segments here for cameras on networks this server can't reach directly.
app.use('/api/relay', relay.router);

// Public: app name/logo so the login screen (before any auth) can show
// custom branding too, not just the post-login sidebar.
app.get('/api/branding', (req, res) => {
  res.json({ app_name: settings.getSetting('app_name'), logo_path: settings.getSetting('logo_path') });
});

// Static frontend
app.use(express.static(path.join(__dirname, '..', 'public')));

// HLS live-stream segments (served publicly since they're short-lived/ephemeral;
// put behind auth/reverse-proxy in production if streams are sensitive)
app.use('/streams', express.static(path.join(__dirname, '..', 'public', 'streams')));

// Protected API
app.use('/api/cameras', requireAuth, camerasRouter);
app.use('/api/recordings', requireAuth, recordingsRouter);
app.use('/api/bookmarks', requireAuth, bookmarksRouter);
app.use('/api/users', requireAuth, requireRole('admin'), usersRouter);
app.use('/api/locations', requireAuth, locationsRouter);
app.use('/api/settings', requireAuth, requireRole('admin'), settingsRouter);
app.use('/api/alerts', requireAuth, alertsRouter);
app.use('/api/health-trends', requireAuth, healthTrendsRouter);

app.get('/api/events', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM events ORDER BY created_at DESC LIMIT 100').all();
  res.json(rows);
});

// Daily event-volume counts per type, for the "Volume Kejadian per Hari"
// dashboard chart — grouped in SQL (day, type) rather than pulling raw rows,
// since the events table can run into the tens of thousands and the chart
// only needs the aggregate. created_at is stored via SQLite's
// CURRENT_TIMESTAMP (UTC, no zone suffix) and datetime('now', ...) is also
// UTC by default, so the two compare correctly as plain strings without
// going through JS Date parsing (which would read the un-suffixed string as
// local time instead of UTC — see the same note in health_routes.js).
app.get('/api/events/summary', requireAuth, (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
  const rows = db.prepare(`
    SELECT date(created_at) AS day, type, COUNT(*) AS count
    FROM events
    WHERE created_at >= datetime('now', ?)
    GROUP BY day, type
    ORDER BY day ASC
  `).all(`-${days} days`);
  res.json({ days, rows });
});

// For the "Tentang Aplikasi" modal — lets ops/IT confirm which build is
// actually running and get a quick read on server/database health without
// SSH-ing in, same reasoning as the health-check dashboard already does for
// camera reachability.
app.get('/api/about', requireAuth, (req, res) => {
  const cameraCount = db.prepare('SELECT COUNT(*) AS n FROM cameras').get().n;
  const locationCount = db.prepare('SELECT COUNT(*) AS n FROM locations').get().n;
  let dbSizeBytes = null;
  try { dbSizeBytes = fs.statSync(DB_PATH).size; } catch { /* file always exists once db.js has run; ignore if not */ }
  res.json({
    app_version: pkg.version,
    git: gitInfo,
    node_version: process.version,
    platform: process.platform,
    uptime_seconds: Math.floor(process.uptime()),
    camera_count: cameraCount,
    location_count: locationCount,
    db_size_bytes: dbSizeBytes,
  });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Without this, Express falls back to its default error handler for any
// route error — which dumps a raw stack trace to stderr and a bare HTML
// 500 to the client. That default path is hit constantly by HLS live view:
// ffmpeg's rolling delete_segments window (see streaming.js) removes old
// .ts segments continuously, so a client fetching a segment at the exact
// moment it gets rotated out hits a benign stat/open race under
// express.static('/streams'), surfacing as a scary unhandled ENOENT. Treat
// that as an ordinary 404 instead of an error; only log/500 the rest.
app.use((err, req, res, next) => {
  if (err && err.code === 'ENOENT') return res.status(404).end();
  console.error('[open-vms] Unhandled route error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = Number(process.env.PORT) || 4000;
let server;

function startServer(port) {
  server = app.listen(port, () => {
    console.log(`[open-vms] Server berjalan di http://localhost:${port}`);
  });

  server.on('error', (err) => {
    if (err?.code === 'EADDRINUSE') {
      const nextPort = port + 1;
      console.error(`[open-vms] Port ${port} sudah digunakan, mencoba port ${nextPort}...`);
      startServer(nextPort);
      return;
    }

    console.error('[open-vms] Gagal menjalankan server:', err);
    process.exitCode = 1;
  });
}

startServer(PORT);

function shutdown() {
  console.log('\n[open-vms] Mematikan server, menghentikan semua stream & recording...');
  streaming.stopAll();
  recording.stopAll();
  motion.stopAll();
  healthcheck.stop();
  if (server) {
    server.close(() => process.exit(0));
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Without this, one unhandled error anywhere in the app (a stray promise
// rejection in a route handler, a background job, etc.) silently kills the
// whole Node process — every camera stream and recording goes down with it,
// with nothing to auto-restart it. Log instead of crashing so a single bad
// error can't take the whole VMS offline.
process.on('uncaughtException', (err) => {
  console.error('[open-vms] Uncaught exception (server tetap jalan):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[open-vms] Unhandled promise rejection (server tetap jalan):', reason);
});
