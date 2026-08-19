const { spawn } = require('child_process');
const { db, logEvent, getCameraById, decryptCamera } = require('./db');
const recording = require('./recording');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const activeDetectors = new Map();
const TRIGGER_COOLDOWN_MS = 10 * 1000;

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const STABLE_AFTER_MS = 10000;

function parseMotionLine(line) {
  // ffmpeg with showinfo filter prints a selected-frame line when motion is detected
  return /Parsed_showinfo/.test(line) || /showinfo/.test(line);
}

// See the matching function in streaming.js — motion detection must never
// give up retrying on its own, but logging every attempt for a camera down
// for days is what flooded the events table before. Taper the log instead.
function shouldLogRetry(retryCount) {
  if (retryCount <= 5) return true;
  if (retryCount <= 20) return retryCount % 5 === 0;
  return retryCount % 20 === 0;
}

// See the matching function in streaming.js — spreads out retries so
// several cameras disrupted by the same event don't all reconnect in
// lockstep and re-collide on the same resource every cycle.
function withJitter(delayMs) {
  return Math.round(delayMs * (0.8 + Math.random() * 0.4));
}

function spawnDetectorProc(camera, entry) {
  // camera.motion_sensitivity of exactly 0 (max sensitivity) is a valid,
  // intentional value and must not be replaced by the default.
  const rawSensitivity = Number(camera.motion_sensitivity);
  const sensitivity = Number.isFinite(rawSensitivity) ? rawSensitivity : 0.04;
  const args = [
    '-rtsp_transport', 'tcp',
    '-i', camera.rtsp_url,
    '-an',
    '-vf', `select=gt(scene\\,${sensitivity}),showinfo`,
    '-frames:v', '999999',
    '-f', 'null',
    '-'
  ];

  const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  entry.process = proc;
  entry.buffer = '';
  const startedAt = Date.now();

  if (entry.stableTimer) clearTimeout(entry.stableTimer);
  entry.stableTimer = setTimeout(() => {
    entry.retryCount = 0;
  }, STABLE_AFTER_MS);

  proc.on('error', (err) => {
    if (entry.stableTimer) clearTimeout(entry.stableTimer);
    activeDetectors.delete(camera.id);
    logEvent(camera.id, 'motion_detector_error', `Motion detector gagal dijalankan: ${err.message}`);
  });

  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    entry.buffer += text;
    let newlineIndex;
    while ((newlineIndex = entry.buffer.indexOf('\n')) >= 0) {
      const line = entry.buffer.slice(0, newlineIndex + 1);
      entry.buffer = entry.buffer.slice(newlineIndex + 1);
      if (parseMotionLine(line)) {
        const now = Date.now();
        if (now - entry.lastTriggeredAt < TRIGGER_COOLDOWN_MS) continue;
        entry.lastTriggeredAt = now;
        db.prepare('UPDATE cameras SET motion_last_triggered_at = ? WHERE id = ?').run(now, camera.id);
        logEvent(camera.id, 'motion_detected', `Gerakan terdeteksi pada kamera "${camera.name}"`);

        const latestCam = getCameraById(camera.id);
        if (latestCam.motion_recording_enabled && !recording.isRecording(camera.id)) {
          recording.startRecording(latestCam).then((started) => {
            if (started) logEvent(camera.id, 'motion_recording_started', 'Perekaman otomatis dimulai oleh motion detection');
          });
        }
      }
    }
  });

  proc.on('exit', (code) => {
    if (entry.stableTimer) clearTimeout(entry.stableTimer);

    if (entry.stopRequested) {
      activeDetectors.delete(camera.id);
      logEvent(camera.id, 'motion_detector_stopped', 'Motion detection dihentikan');
      return;
    }

    // Unexpected disconnect (network blip, camera reboot, RTSP timeout) —
    // retry with backoff instead of leaving motion detection dead until
    // someone notices and re-enables it by hand. Never give up on its own.
    entry.retryCount = (entry.retryCount || 0) + 1;

    const delay = withJitter(Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (entry.retryCount - 1)));
    if (shouldLogRetry(entry.retryCount)) {
      logEvent(camera.id, 'motion_detector_reconnecting', `Motion detector terputus, mencoba sambung ulang dalam ${Math.round(delay / 1000)}s (percobaan ke-${entry.retryCount})`);
    }
    entry.reconnectTimer = setTimeout(() => {
      if (!activeDetectors.has(camera.id) || entry.stopRequested) return;
      // Re-fetch so credentials/RTSP path/sensitivity edited mid-outage
      // take effect, same reasoning as streaming.js.
      const fresh = getCameraById(camera.id) || camera;
      spawnDetectorProc(fresh, entry);
    }, delay);
  });
}

function startDetector(camera) {
  if (!camera || !camera.rtsp_url || activeDetectors.has(camera.id)) return;

  const entry = {
    process: null,
    buffer: '',
    lastTriggeredAt: Number(camera.motion_last_triggered_at) || 0,
    stopRequested: false,
    retryCount: 0,
    reconnectTimer: null,
    stableTimer: null,
  };
  activeDetectors.set(camera.id, entry);
  spawnDetectorProc(camera, entry);
  logEvent(camera.id, 'motion_detector_started', 'Motion detection dimulai');
}

function stopDetector(cameraId) {
  const entry = activeDetectors.get(cameraId);
  if (!entry) return false;
  entry.stopRequested = true;
  if (entry.reconnectTimer) {
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
  }
  if (entry.stableTimer) clearTimeout(entry.stableTimer);
  if (entry.process) {
    entry.process.kill('SIGTERM'); // exit handler finishes cleanup + logs motion_detector_stopped
  } else {
    activeDetectors.delete(cameraId); // mid-backoff wait, no live process to kill
    logEvent(cameraId, 'motion_detector_stopped', 'Motion detection dihentikan');
  }
  return true;
}

function isMotionActive(cameraId) {
  return activeDetectors.has(cameraId);
}

function syncCamera(camera) {
  if (!camera) return;
  if (camera.motion_detection_enabled && camera.rtsp_url && !camera.is_relay) {
    startDetector(camera);
  } else {
    stopDetector(camera.id);
  }
}

function startAllEnabled() {
  const cameras = db.prepare('SELECT * FROM cameras WHERE motion_detection_enabled = 1 AND rtsp_url IS NOT NULL AND is_relay = 0').all();
  cameras.map(decryptCamera).forEach(startDetector);
}

function stopAll() {
  for (const [cameraId] of activeDetectors) {
    stopDetector(cameraId);
  }
}

module.exports = { startDetector, stopDetector, isMotionActive, syncCamera, startAllEnabled, stopAll };
