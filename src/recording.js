const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { db, logEvent, getCameraById, decryptCamera } = require('./db');
const settings = require('./settings');

const RECORDINGS_DIR = path.join(__dirname, '..', 'recordings');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || deriveFfprobePath(FFMPEG);
const SEGMENT_SECONDS = 600; // 10 minutes per file

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const STABLE_AFTER_MS = 10000;

// cameraId -> { process, starting, stopRequested, retryCount, reconnectTimer, stableTimer, encoder }
const activeRecorders = new Map();
// QSV is a host-level hardware capability — once proven unusable here it
// will fail identically for every camera/reconnect, so don't retry it.
let qsvKnownUnavailable = false;

// See the matching function in streaming.js — recording must never give up
// retrying on its own (a silent recording gap is worse than a live-view
// gap), but logging every single attempt for a camera down for days is what
// flooded the events table before. Taper off the log instead of the retry.
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

function deriveFfprobePath(ffmpegPath) {
  if (/ffmpeg(\.exe)?$/i.test(ffmpegPath)) {
    return ffmpegPath.replace(/ffmpeg(\.exe)?$/i, (m, ext) => `ffprobe${ext || ''}`);
  }
  return 'ffprobe';
}

function camDir(cameraId) {
  return path.join(RECORDINGS_DIR, String(cameraId));
}

// Cheap metadata-only probe to decide whether the source can be archived
// as-is or needs transcoding for in-app playback (browsers can't decode
// HEVC/H.265, which many modern cameras default to).
function probeVideoCodec(rtspUrl) {
  return new Promise((resolve) => {
    execFile(FFPROBE, [
      '-v', 'error',
      '-rtsp_transport', 'tcp',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'csv=p=0',
      rtspUrl
    ], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout.trim() || null);
    });
  });
}

function buildArgs(camera, pattern, encoder) {
  // Fragmented MP4: the moov index is written up front (empty) and media
  // data is flushed incrementally in self-contained fragments, instead of
  // only finalizing the index when the file closes cleanly. Without this,
  // a segment killed mid-recording (crash, power loss, forced process
  // kill) ends up as an unplayable "moov atom not found" file.
  const movflags = 'movflags=frag_keyframe+empty_moov+default_base_moof';
  const codecArgs = encoder === 'copy'
    ? ['-c', 'copy']
    : encoder === 'qsv'
      ? ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '20', '-c:a', 'aac']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac'];

  return [
    '-rtsp_transport', 'tcp',
    '-timeout', '10000000', // microseconds; fail fast instead of hanging on unreachable cameras
    '-i', camera.rtsp_url,
    ...codecArgs,
    '-f', 'segment',
    '-segment_time', String(SEGMENT_SECONDS),
    '-segment_format', 'mp4',
    '-segment_format_options', movflags,
    '-strftime', '1',
    '-reset_timestamps', '1',
    pattern
  ];
}

function spawnRecorder(camera, entry, pattern, encoder) {
  const args = buildArgs(camera, pattern, encoder);
  const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  entry.process = proc;
  entry.starting = false;
  entry.encoder = encoder;
  const startedAt = Date.now();
  let fellBack = false;

  if (entry.stableTimer) clearTimeout(entry.stableTimer);
  entry.stableTimer = setTimeout(() => {
    entry.retryCount = 0;
  }, STABLE_AFTER_MS);

  proc.on('error', (err) => {
    if (entry.stableTimer) clearTimeout(entry.stableTimer);
    activeRecorders.delete(camera.id);
    logEvent(camera.id, 'recording_error', `Gagal menjalankan ffmpeg: ${err.message}`);
  });

  proc.on('exit', (code) => {
    if (entry.stableTimer) clearTimeout(entry.stableTimer);
    const ranMs = Date.now() - startedAt;

    if (encoder === 'qsv' && code !== 0 && ranMs < 4000 && !fellBack) {
      fellBack = true;
      qsvKnownUnavailable = true;
      logEvent(camera.id, 'recording_error', 'Hardware encoder (QSV) gagal, beralih ke software (libx264) untuk rekaman');
      spawnRecorder(camera, entry, pattern, 'x264');
      return;
    }

    if (entry.stopRequested) {
      activeRecorders.delete(camera.id);
      logEvent(camera.id, 'recording_stopped', `Recorder exited with code ${code}`);
      return;
    }

    // Unexpected disconnect (network blip, camera reboot, RTSP timeout) —
    // retry with backoff instead of leaving recording dead until someone
    // notices and restarts it by hand. Never give up on its own: a
    // recording that silently stopped is far worse than one that took a
    // while to reconnect.
    entry.retryCount = (entry.retryCount || 0) + 1;

    const delay = withJitter(Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (entry.retryCount - 1)));
    if (shouldLogRetry(entry.retryCount)) {
      logEvent(camera.id, 'recording_reconnecting', `Rekaman terputus, mencoba sambung ulang dalam ${Math.round(delay / 1000)}s (percobaan ke-${entry.retryCount})`);
    }
    entry.reconnectTimer = setTimeout(() => {
      if (!activeRecorders.has(camera.id) || entry.stopRequested) return;
      // Re-fetch so credentials/RTSP path edited mid-outage take effect,
      // same reasoning as streaming.js.
      const fresh = getCameraById(camera.id) || camera;
      // codec (copy vs transcode) doesn't change camera-side between
      // reconnects, so keep using the encoder already settled on above
      // instead of re-probing.
      spawnRecorder(fresh, entry, pattern, entry.encoder === 'qsv' && qsvKnownUnavailable ? 'x264' : entry.encoder);
    }, delay);
  });
}

async function startRecording(camera) {
  if (activeRecorders.has(camera.id)) return false;

  const entry = { process: null, starting: true, stopRequested: false, retryCount: 0, reconnectTimer: null, stableTimer: null, encoder: null };
  activeRecorders.set(camera.id, entry);

  const dir = camDir(camera.id);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    activeRecorders.delete(camera.id);
    logEvent(camera.id, 'recording_error', `Gagal menyiapkan folder rekaman: ${err.message}`);
    return false;
  }
  const pattern = path.join(dir, 'rec_%Y-%m-%d_%H-%M-%S.mp4');

  const codec = await probeVideoCodec(camera.rtsp_url);
  // Compare identity, not just presence: stopRecording()+startRecording()
  // firing again while this probe was in flight would otherwise let this
  // call spawn ffmpeg under an entry activeRecorders no longer points at,
  // orphaning an untracked, un-killable recorder process.
  if (activeRecorders.get(camera.id) !== entry) return false;

  // h264 sources are archived as-is (no re-encode cost); anything else
  // (hevc, mjpeg, unknown probe failure, ...) is transcoded to h264 so
  // recordings are always playable in-browser, not just downloadable.
  const encoder = codec === 'h264' ? 'copy' : ((settings.getSetting('hwaccel_mode') === 'software' || qsvKnownUnavailable) ? 'x264' : 'qsv');
  spawnRecorder(camera, entry, pattern, encoder);
  logEvent(camera.id, 'recording_started', `Perekaman berkelanjutan dimulai (${encoder})`);
  return true;
}

function stopRecording(cameraId) {
  const entry = activeRecorders.get(cameraId);
  if (!entry) return false;
  entry.stopRequested = true;
  if (entry.reconnectTimer) {
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
  }
  if (entry.stableTimer) clearTimeout(entry.stableTimer);
  const proc = entry.process;
  // A process can still be sitting on `entry` after it already exited once
  // (mid reconnect-backoff — e.g. a camera whose RTSP connection times out
  // repeatedly — with the next spawn just cancelled above via
  // reconnectTimer). kill() on an already-dead process is a silent no-op,
  // and since its 'exit' event already fired once, no new one will ever
  // come to run the cleanup that normally deletes this entry — without this
  // check, the "Stop rekam" button would leave the camera stuck reporting
  // recording_active forever, with nothing actually running and no way to
  // stop it short of a server restart. See the identical guard in
  // stopRecordingAndWait() below.
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
    activeRecorders.delete(cameraId); // still probing codec, or mid-backoff wait with no live process
    return true;
  }
  proc.kill('SIGTERM');
  return true;
}

// Force-stops the recorder and resolves only once ffmpeg has actually
// exited, unlike stopRecording() which fires SIGTERM without waiting. See
// the matching function in streaming.js — DELETE /api/cameras/:id needs
// this so it doesn't rm() the recordings directory while ffmpeg still has
// the current segment file open.
function stopRecordingAndWait(cameraId) {
  const entry = activeRecorders.get(cameraId);
  if (!entry) return Promise.resolve();
  entry.stopRequested = true;
  if (entry.reconnectTimer) {
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
  }
  if (entry.stableTimer) clearTimeout(entry.stableTimer);
  const proc = entry.process;
  // A process can still be sitting on `entry` after it already exited once
  // (mid reconnect-backoff, next spawn was just cancelled above via
  // reconnectTimer) — its 'exit' event already fired, so kill()+once('exit')
  // would never resolve and this would hang the DELETE request forever.
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
    activeRecorders.delete(cameraId);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    proc.once('exit', () => resolve());
    proc.kill('SIGTERM');
  });
}

function isRecording(cameraId) {
  return activeRecorders.has(cameraId);
}

// Scan recordings directories, register new files into DB, and delete files older than retention.
function reconcileAndCleanup() {
  const rawRetentionDays = Number(settings.getSetting('retention_days'));
  const retentionDays = Number.isFinite(rawRetentionDays) && rawRetentionDays >= 1 ? rawRetentionDays : 14;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  const cameras = db.prepare('SELECT id FROM cameras').all();
  for (const cam of cameras) {
    const dir = camDir(cam.id);
    if (!fs.existsSync(dir)) continue;

    for (const filename of fs.readdirSync(dir)) {
      // One bad file (locked by an in-progress download, transient fs
      // error, ...) must not abort cleanup for every other file/camera in
      // this pass.
      try {
        const fullPath = path.join(dir, filename);
        const stat = fs.statSync(fullPath);

        // Register in DB if not present
        const existing = db.prepare('SELECT id FROM recordings WHERE camera_id = ? AND filename = ?').get(cam.id, filename);
        if (!existing) {
          db.prepare('INSERT INTO recordings (camera_id, filename, size_bytes) VALUES (?, ?, ?)')
            .run(cam.id, filename, stat.size);
        }

        // Delete + deregister if past retention
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(fullPath);
          db.prepare('DELETE FROM recordings WHERE camera_id = ? AND filename = ?').run(cam.id, filename);
          logEvent(cam.id, 'recording_purged', `${filename} dihapus (melewati retensi ${retentionDays} hari)`);
        }
      } catch (err) {
        console.error(`[recording] gagal proses ${filename} (kamera ${cam.id}): ${err.message}`);
      }
    }
  }
}

function startCleanupScheduler() {
  reconcileAndCleanup();
  setInterval(reconcileAndCleanup, 60 * 60 * 1000); // hourly
}

function stopAll() {
  for (const [, entry] of activeRecorders) {
    entry.stopRequested = true;
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
    if (entry.stableTimer) clearTimeout(entry.stableTimer);
    if (entry.process) entry.process.kill('SIGTERM');
  }
  activeRecorders.clear();
}

// Auto-resume recording after a server restart. motion.js already does this
// for motion detection (its own startAllEnabled) — recording didn't: a
// camera with recording_enabled=1 in the DB just sat idle after any restart
// (crash, deploy, maintenance) until an operator happened to notice the gap
// and clicked "Rekam" again by hand, silently losing footage in the
// meantime. Staggered like streaming.js's "Nyalakan Semua" fix — starting
// every enabled recorder at once would risk the same connection/CPU burst
// that made already-stable live streams flap when many ffmpeg processes
// spawn together at once.
const RESUME_STAGGER_MS = 400;

async function startAllEnabled() {
  const rows = db.prepare('SELECT * FROM cameras WHERE recording_enabled = 1 AND rtsp_url IS NOT NULL AND is_relay = 0').all();
  const cameras = rows.map(decryptCamera);
  for (const cam of cameras) {
    const started = await startRecording(cam);
    if (started) logEvent(cam.id, 'recording_resumed', `Rekaman "${cam.name}" dilanjutkan otomatis setelah server restart`);
    await new Promise((resolve) => setTimeout(resolve, RESUME_STAGGER_MS));
  }
}

module.exports = { startRecording, stopRecording, stopRecordingAndWait, isRecording, startCleanupScheduler, startAllEnabled, stopAll, camDir };
