const net = require('net');
const { db, logEvent } = require('./db');
const relay = require('./relay');
const notifications = require('./notifications');
const settings = require('./settings');

// Independent of whether anyone has the live view open — reachability is
// checked directly so a camera going dark gets noticed even if nobody is
// watching it at the time.
const CHECK_TIMEOUT_MS = 5000;

// cameraId -> { consecutiveFailures, isOffline }
const state = new Map();

function tcpReachable(ip, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: ip, port, timeout: CHECK_TIMEOUT_MS });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

async function checkCamera(cam) {
  if (cam.is_relay) return relay.isRelayFresh(cam.id);
  return tcpReachable(cam.ip, cam.rtsp_port || 554);
}

async function checkOneCamera(cam, threshold) {
  let entry = state.get(cam.id);
  if (!entry) {
    entry = { consecutiveFailures: 0, isOffline: false };
    state.set(cam.id, entry);
  }

  const reachable = await checkCamera(cam);

  if (reachable) {
    if (entry.isOffline) {
      entry.isOffline = false;
      logEvent(cam.id, 'camera_online', `Kamera "${cam.name}" kembali online`);
      notifications.sendCameraRecoveredAlert(cam);
    }
    entry.consecutiveFailures = 0;
  } else {
    entry.consecutiveFailures += 1;
    if (!entry.isOffline && entry.consecutiveFailures >= threshold) {
      entry.isOffline = true;
      logEvent(cam.id, 'camera_offline', `Kamera "${cam.name}" tidak bisa dijangkau (${entry.consecutiveFailures}x percobaan)`);
      notifications.sendCameraOfflineAlert(cam);
    }
  }
}

async function runHealthCheck() {
  const threshold = Number(settings.getSetting('offline_threshold_checks')) || 2;
  const cameras = db.prepare('SELECT id, name, ip, rtsp_port, is_relay FROM cameras').all();
  // Independent per-camera network checks — run concurrently so N cameras
  // don't take N * CHECK_TIMEOUT_MS in the worst case.
  await Promise.all(cameras.map((cam) => checkOneCamera(cam, threshold)));
}

// `state` above is in-memory only, so a server restart (deploy, crash
// recovery) always starts it empty — without this, a camera that was
// already offline when the process restarted reads as "online" until
// `threshold` consecutive failures accumulate again, firing a second
// "camera offline" email for the exact same ongoing outage with no actual
// new transition, and no matching "online" event in between. Seed from
// whichever of camera_offline/camera_online was logged most recently per
// camera so that state survives a restart.
function loadPersistedOfflineState() {
  const rows = db.prepare(`
    SELECT camera_id, type FROM events
    WHERE id IN (
      SELECT MAX(id) FROM events
      WHERE type IN ('camera_offline', 'camera_online')
      GROUP BY camera_id
    )
  `).all();
  for (const row of rows) {
    if (row.type === 'camera_offline') {
      state.set(row.camera_id, { consecutiveFailures: 1, isOffline: true });
    }
  }
}

let intervalHandle = null;
function startHealthCheckScheduler() {
  loadPersistedOfflineState();
  runHealthCheck();
  const minutes = Number(settings.getSetting('health_check_interval_min')) || 5;
  intervalHandle = setInterval(runHealthCheck, minutes * 60 * 1000);
}

// Called after the Pengaturan page saves a new interval — clears the old
// timer and starts a fresh one at the new interval, so the change takes
// effect immediately instead of on next restart.
function reschedule() {
  if (intervalHandle) clearInterval(intervalHandle);
  const minutes = Number(settings.getSetting('health_check_interval_min')) || 5;
  intervalHandle = setInterval(runHealthCheck, minutes * 60 * 1000);
}

function stop() {
  if (intervalHandle) clearInterval(intervalHandle);
}

// No entry yet (never checked, e.g. a camera added since the last pass)
// reads as online — same "innocent until proven offline" default the
// consecutiveFailures/isOffline state starts at above.
function isOnline(cameraId) {
  return !state.get(cameraId)?.isOffline;
}

module.exports = { startHealthCheckScheduler, reschedule, stop, runHealthCheck, isOnline };
