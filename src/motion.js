const { spawn } = require('child_process');
const { db, logEvent, getCameraById, decryptCamera } = require('./db');
const recording = require('./recording');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const activeDetectors = new Map();
const TRIGGER_COOLDOWN_MS = 10 * 1000;

function parseMotionLine(line) {
  // ffmpeg with showinfo filter prints a selected-frame line when motion is detected
  return /Parsed_showinfo/.test(line) || /showinfo/.test(line);
}

function startDetector(camera) {
  if (!camera || !camera.rtsp_url || activeDetectors.has(camera.id)) return;

  const sensitivity = Number(camera.motion_sensitivity) || 0.04;
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
  const entry = {
    process: proc,
    buffer: '',
    lastTriggeredAt: Number(camera.motion_last_triggered_at) || 0,
  };

  proc.on('error', (err) => {
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
    activeDetectors.delete(camera.id);
    logEvent(camera.id, 'motion_detector_stopped', `Motion detector berhenti dengan code ${code}`);
  });

  activeDetectors.set(camera.id, entry);
  logEvent(camera.id, 'motion_detector_started', 'Motion detection dimulai');
}

function stopDetector(cameraId) {
  const entry = activeDetectors.get(cameraId);
  if (!entry) return false;
  entry.process.kill('SIGTERM');
  activeDetectors.delete(cameraId);
  logEvent(cameraId, 'motion_detector_stopped', 'Motion detection dihentikan');
  return true;
}

function isMotionActive(cameraId) {
  return activeDetectors.has(cameraId);
}

function syncCamera(camera) {
  if (!camera) return;
  if (camera.motion_detection_enabled && camera.rtsp_url) {
    startDetector(camera);
  } else {
    stopDetector(camera.id);
  }
}

function startAllEnabled() {
  const cameras = db.prepare('SELECT * FROM cameras WHERE motion_detection_enabled = 1 AND rtsp_url IS NOT NULL').all();
  cameras.map(decryptCamera).forEach(startDetector);
}

function stopAll() {
  for (const [cameraId] of activeDetectors) {
    stopDetector(cameraId);
  }
}

module.exports = { startDetector, stopDetector, isMotionActive, syncCamera, startAllEnabled, stopAll };