const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { logEvent, getCameraById } = require('./db');
const settings = require('./settings');

const STREAMS_DIR = path.join(__dirname, '..', 'public', 'streams');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const STABLE_AFTER_MS = 10000; // running this long without exiting counts as "recovered"

// Map cameraId -> { process, viewers, startedAt, encoder, alive, stopRequested, reconnecting, retryCount, reconnectTimer, stableTimer }
const activeStreams = new Map();
const lastErrorByCamera = new Map();

function streamDirFor(cameraId) {
  return path.join(STREAMS_DIR, String(cameraId));
}

function buildArgs(camera, dir, playlistPath, encoder) {
  const maxWidth = Number(settings.getSetting('stream_max_width')) || 960;
  const scale = `scale=w='min(${maxWidth},iw)':h=-2:flags=fast_bilinear`;
  // -rtsp_transport tcp is important for many consumer-grade brands (Hikvision/Dahua/etc)
  // that drop UDP packets behind NAT/firewalls.
  //
  // Always transcode to H.264: many modern cameras (esp. Hikvision main streams)
  // default to HEVC/H.265, which no mainstream browser can decode via MSE/hls.js.
  // Remuxing with -c:v copy would silently produce a stream that fetches fine but
  // never renders a frame.
  const encoderArgs = encoder === 'qsv'
    ? ['-vf', `${scale},format=nv12`, '-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '25']
    : ['-vf', `${scale},format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-crf', '23'];

  return [
    '-rtsp_transport', 'tcp',
    // Without this, an unreachable camera (wrong/private IP, closed port,
    // dead link) hangs the RTSP connect step indefinitely — the process
    // stays "active" with no output and no error, instead of failing fast
    // so the reconnect-with-backoff logic below can kick in.
    '-timeout', '10000000', // microseconds
    '-i', camera.rtsp_url,
    ...encoderArgs,
    '-r', String(Number(settings.getSetting('stream_fps')) || 15),
    '-an',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+append_list',
    '-hls_segment_filename', path.join(dir, 'seg_%03d.ts'),
    playlistPath
  ];
}

function preferredEncoder() {
  return settings.getSetting('hwaccel_mode') === 'software' ? 'x264' : 'qsv';
}

function spawnEncoder(camera, entry, encoder) {
  const dir = streamDirFor(camera.id);
  const playlistPath = path.join(dir, 'index.m3u8');
  const args = buildArgs(camera, dir, playlistPath, encoder);

  // windowsHide: without it, Windows pops up a console window for every
  // ffmpeg process — very noticeable with many cameras + auto-reconnect
  // spawning new processes repeatedly.
  const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  entry.process = proc;
  entry.encoder = encoder;
  entry.alive = true;
  entry.reconnecting = false;
  const startedAt = Date.now();
  let fellBack = false;

  if (entry.stableTimer) clearTimeout(entry.stableTimer);
  entry.stableTimer = setTimeout(() => {
    entry.retryCount = 0;
    // A prior failure's message would otherwise stick around in the UI
    // forever, showing "error" next to a camera that has since recovered.
    lastErrorByCamera.delete(camera.id);
  }, STABLE_AFTER_MS);

  proc.on('error', (err) => {
    entry.alive = false;
    activeStreams.delete(camera.id);
    logEvent(camera.id, 'stream_error', `Gagal menjalankan ffmpeg: ${err.message}`);
  });

  proc.stderr.on('data', (chunk) => {
    // ffmpeg logs go to stderr by default; keep last error line for diagnostics
    const text = chunk.toString();
    if (/error|fail/i.test(text)) {
      lastErrorByCamera.set(camera.id, text.trim().slice(-500));
    }
  });

  proc.on('exit', (code) => {
    entry.alive = false;
    if (entry.stableTimer) clearTimeout(entry.stableTimer);
    const ranMs = Date.now() - startedAt;

    if (entry.stopRequested) {
      activeStreams.delete(camera.id);
      logEvent(camera.id, 'stream_stopped', 'Live stream dihentikan');
      return;
    }

    // QSV dying almost immediately usually means the hardware path isn't
    // usable on this host (no iGPU, missing driver, no /dev/dri in a
    // container). Fall back to the software encoder rather than leaving
    // the camera with no stream at all.
    if (encoder === 'qsv' && code !== 0 && ranMs < 4000 && !fellBack) {
      fellBack = true;
      logEvent(camera.id, 'stream_error', 'Hardware encoder (QSV) gagal, beralih ke software (libx264)');
      spawnEncoder(camera, entry, 'x264');
      return;
    }

    // Unexpected disconnect (network blip, camera reboot, RTSP timeout) —
    // retry with exponential backoff instead of leaving the camera dark
    // until someone notices and clicks "Live" again.
    entry.retryCount = (entry.retryCount || 0) + 1;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (entry.retryCount - 1));
    entry.reconnecting = true;
    logEvent(camera.id, 'stream_reconnecting', `Live stream terputus, mencoba sambung ulang dalam ${Math.round(delay / 1000)}s (percobaan ke-${entry.retryCount})`);
    entry.reconnectTimer = setTimeout(() => {
      if (!activeStreams.has(camera.id) || entry.stopRequested) return;
      // Re-fetch instead of reusing the closed-over `camera` — otherwise an
      // admin fixing a wrong password (or IP/RTSP path) via the Edit form
      // has no effect on a stream that's already mid-retry: every future
      // attempt keeps reusing the credentials it started with.
      const fresh = getCameraById(camera.id) || camera;
      spawnEncoder(fresh, entry, preferredEncoder());
    }, delay);
  });
}

function startStream(camera) {
  if (activeStreams.has(camera.id)) {
    const existing = activeStreams.get(camera.id);
    existing.viewers += 1;
    // A prior stopStream() may have set this while its SIGTERM'd process was
    // still exiting. If a new viewer starts watching before that exit event
    // fires, the exit handler must not tear this entry down out from under
    // them (it would otherwise trust the stale flag and kill a live view
    // that was just (re)started).
    existing.stopRequested = false;
    return existing;
  }

  const dir = streamDirFor(camera.id);
  fs.mkdirSync(dir, { recursive: true });

  const entry = {
    process: null,
    viewers: 1,
    startedAt: Date.now(),
    encoder: null,
    alive: false,
    stopRequested: false,
    reconnecting: false,
    retryCount: 0,
    reconnectTimer: null,
    stableTimer: null,
  };
  activeStreams.set(camera.id, entry);
  spawnEncoder(camera, entry, preferredEncoder());
  logEvent(camera.id, 'stream_started', 'Live stream dimulai');
  return entry;
}

function stopStream(cameraId) {
  const entry = activeStreams.get(cameraId);
  if (!entry) return false;
  entry.viewers -= 1;
  if (entry.viewers <= 0) {
    entry.stopRequested = true;
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }
    if (entry.stableTimer) clearTimeout(entry.stableTimer);
    if (entry.alive && entry.process) {
      entry.process.kill('SIGTERM'); // exit handler finishes cleanup + logs stream_stopped
    } else {
      activeStreams.delete(cameraId); // mid-backoff wait, no live process to kill
      logEvent(cameraId, 'stream_stopped', 'Live stream dihentikan');
    }
  }
  return true;
}

function getStatus(cameraId) {
  const entry = activeStreams.get(cameraId);
  return {
    active: entry ? entry.alive : false,
    reconnecting: entry ? !!entry.reconnecting : false,
    viewers: entry ? entry.viewers : 0,
    encoder: entry ? entry.encoder : null,
    lastError: lastErrorByCamera.get(cameraId) || null
  };
}

function stopAll() {
  for (const [id, entry] of activeStreams) {
    entry.stopRequested = true;
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
    if (entry.stableTimer) clearTimeout(entry.stableTimer);
    if (entry.process) entry.process.kill('SIGTERM');
  }
  activeStreams.clear();
}

module.exports = { startStream, stopStream, getStatus, stopAll, streamDirFor };
