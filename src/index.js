require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const { seedAdmin, db } = require('./db');
const { login, requireAuth, requireRole } = require('./auth');
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

seedAdmin();
recording.startCleanupScheduler();
motion.startAllEnabled();
healthcheck.startHealthCheckScheduler();

const app = express();
app.use(cors());
app.use(express.json());

// Public: login
app.post('/api/auth/login', login);

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
app.use('/api/users', requireAuth, requireRole('admin'), usersRouter);
app.use('/api/locations', requireAuth, locationsRouter);
app.use('/api/settings', requireAuth, requireRole('admin'), settingsRouter);
app.use('/api/alerts', requireAuth, alertsRouter);

app.get('/api/events', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM events ORDER BY created_at DESC LIMIT 100').all();
  res.json(rows);
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, () => {
  console.log(`[open-vms] Server berjalan di http://localhost:${PORT}`);
});

function shutdown() {
  console.log('\n[open-vms] Mematikan server, menghentikan semua stream & recording...');
  streaming.stopAll();
  recording.stopAll();
  motion.stopAll();
  healthcheck.stop();
  server.close(() => process.exit(0));
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
