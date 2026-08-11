const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { logEvent, getCameraById } = require('./db');
const settings = require('./settings');

const STREAMS_DIR = path.join(__dirname, '..', 'public', 'streams');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

// The RTSP client-side socket timeout flag has flip-flopped across ffmpeg
// releases and hardcoding either name breaks the *other* line:
//   - ffmpeg <= ~5.x (e.g. 4.4.2, the Ubuntu 20.04/22.04 apt package):
//     '-stimeout' (microseconds) is the client timeout. '-timeout' means
//     something different (RTSP *listen_timeout*, server mode) — passing it
//     here makes ffmpeg silently try to open a listening socket instead of
//     connecting, so every single camera fails ("Unable to open RTSP for
//     listening" / "Cannot assign requested address"), and since that
//     message contains neither "error" nor "fail" it also slips past the
//     lastErrorByCamera capture below.
//   - Newer ffmpeg builds (e.g. 8.x) removed '-stimeout' entirely — passing
//     it is a hard "Unrecognized option" parse failure instead, and
//     '-timeout' is the correct (and only) client timeout there.
// Rather than hardcode one and break whichever environment doesn't match
// (this bit us going both directions already — see git history on this
// line), ask the ffmpeg binary actually installed what it supports and
// cache the answer once at startup.
function detectTimeoutFlag() {
  try {
    const result = spawnSync(FFMPEG, ['-hide_banner', '-h', 'demuxer=rtsp'], { encoding: 'utf8' });
    const helpText = `${result.stdout || ''}${result.stderr || ''}`;
    if (/^\s*-stimeout\b/m.test(helpText)) return '-stimeout';
  } catch (_err) {
    // fall through to default below
  }
  return '-timeout';
}
const RTSP_TIMEOUT_FLAG = detectTimeoutFlag();

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const STABLE_AFTER_MS = 10000; // running this long without exiting counts as "recovered"

// Map cameraId -> { process, viewers, startedAt, encoder, alive, stopRequested, reconnecting, retryCount, reconnectTimer, stableTimer }
const activeStreams = new Map();
const lastErrorByCamera = new Map();
// QSV is a host-level hardware capability, not a per-camera one: once it's
// proven unusable on this machine (no iGPU/driver), it will fail for every
// camera and every future reconnect the same way. Remembering that avoids
// wasting ~4s on a doomed QSV attempt each time a stream reconnects.
let qsvKnownUnavailable = false;

// Consumer/embedded iGPUs cap how many concurrent hardware encode sessions
// they'll actually serve — on this host, empirically, streams stayed rock
// solid up to ~5 concurrent QSV sessions, then every session beyond that
// started flapping in and out (and could knock already-stable sessions
// into reconnecting too, since the driver doesn't fail newer sessions
// gracefully — it destabilizes whichever ones lose the contention). With
// 199 cameras in this deployment, operators starting more than a handful
// of live views at once is the normal case, not an edge case. Capping how
// many streams are allowed to actually claim a QSV slot — and routing
// everything past the cap straight to software libx264, which has no such
// session ceiling and just costs CPU — keeps every stream stable instead
// of the whole hardware-accelerated set cascading into reconnect loops
// once the real ceiling is hit.
const QSV_CONCURRENCY_LIMIT = Number(process.env.QSV_CONCURRENCY_LIMIT) || 3;
let activeQsvCount = 0;

function streamDirFor(cameraId) {
  return path.join(STREAMS_DIR, String(cameraId));
}

const HLS_SEGMENT_SECONDS = 2;

function buildArgs(camera, dir, playlistPath, encoder) {
  const maxWidth = Number(settings.getSetting('stream_max_width')) || 960;
  const fps = Number(settings.getSetting('stream_fps')) || 15;
  const scale = `scale=w='min(${maxWidth},iw)':h=-2:flags=fast_bilinear`;
  // Force a keyframe every HLS_SEGMENT_SECONDS worth of output frames. The
  // HLS muxer can only cut a new segment on a keyframe — without pinning
  // the GOP to match -hls_time, the encoder falls back to its own default
  // keyframe interval (250 frames — ~16s at 15fps), so the *first* segment
  // can take upwards of ten seconds to close before it's even fetchable
  // (the "live image takes forever to appear" symptom), and every segment
  // after it comes out a wildly different length than the ~2s the player
  // expects, which is what made playback stall/rebuffer constantly.
  const gop = fps * HLS_SEGMENT_SECONDS;
  // -tune zerolatency (x264) / -bf 0 (qsv) drop B-frames — besides cutting
  // encode latency, B-frames reorder output relative to decode order, which
  // adds one more way segment boundaries can end up misaligned with GOPs.
  const encoderArgs = encoder === 'qsv'
    ? ['-vf', `${scale},format=nv12`, '-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '25', '-g', String(gop), '-bf', '0']
    : ['-vf', `${scale},format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-crf', '23', '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0'];

  return [
    // Tolerate the packet loss/corruption a real WAN-facing camera link
    // produces instead of the whole pipeline stalling or dying on it:
    // genpts patches up missing/broken timestamps, discardcorrupt drops a
    // damaged frame instead of propagating the corruption, and
    // make_zero keeps a timestamp hiccup from confusing the HLS segmenter.
    '-fflags', '+genpts+discardcorrupt',
    '-avoid_negative_ts', 'make_zero',
    '-rtsp_transport', 'tcp',
    // Without this, an unreachable camera (wrong/private IP, closed port,
    // dead link) hangs the RTSP connect step indefinitely — the process
    // stays "active" with no output and no error, instead of failing fast
    // so the reconnect-with-backoff logic below can kick in.
    //
    // See RTSP_TIMEOUT_FLAG above: whether this is '-stimeout' or '-timeout'
    // depends on which ffmpeg is actually installed on this machine, detected
    // at startup rather than hardcoded, since the two ffmpeg lines we deploy
    // to (Ubuntu 4.4.2 vs newer 8.x builds) disagree on which name is even
    // valid, let alone what it means.
    RTSP_TIMEOUT_FLAG, '10000000', // microseconds
    '-i', camera.rtsp_url,
    ...encoderArgs,
    '-r', String(fps),
    '-an',
    '-f', 'hls',
    '-hls_time', String(HLS_SEGMENT_SECONDS),
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+append_list+independent_segments',
    '-hls_segment_filename', path.join(dir, 'seg_%03d.ts'),
    playlistPath
  ];
}

// Retrying forever is the correct behavior for a live-monitoring wall left
// open unattended (the whole point is it reconnects on its own once the
// camera/network recovers, no matter how long that takes) — but logging
// every single attempt for a camera that's been down for days is what
// flooded the events table before (13k+ rows from one dead camera). Log the
// first several attempts in full, then taper off so the event log stays
// readable while the retry loop itself never gives up.
function shouldLogRetry(retryCount) {
  if (retryCount <= 5) return true;
  if (retryCount <= 20) return retryCount % 5 === 0;
  return retryCount % 20 === 0;
}

// When something disrupts several cameras at once (a burst of new streams
// starting, a network blip on a shared link), plain exponential backoff has
// them all retry in lockstep — every camera's timer fires at the same
// instant, they all pile new TCP connects onto the network at once again,
// and if that's what caused the disruption in the first place it just
// repeats the same collision every cycle. +/-20% random jitter spreads
// those retries out so they stop reinforcing each other.
function withJitter(delayMs) {
  return Math.round(delayMs * (0.8 + Math.random() * 0.4));
}

function preferredEncoder() {
  if (settings.getSetting('hwaccel_mode') === 'software' || qsvKnownUnavailable) return 'x264';
  if (activeQsvCount >= QSV_CONCURRENCY_LIMIT) return 'x264';
  return 'qsv';
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

  // Claim a QSV concurrency slot for the lifetime of this specific process;
  // released exactly once no matter which way this particular process ends
  // (crash, clean exit, fallback, stop) so the count never leaks or double-frees.
  let usingQsvSlot = false;
  if (encoder === 'qsv') {
    activeQsvCount += 1;
    usingQsvSlot = true;
  }
  function releaseQsvSlot() {
    if (usingQsvSlot) {
      activeQsvCount = Math.max(0, activeQsvCount - 1);
      usingQsvSlot = false;
    }
  }

  if (entry.stableTimer) clearTimeout(entry.stableTimer);
  entry.stableTimer = setTimeout(() => {
    entry.retryCount = 0;
    // A prior failure's message would otherwise stick around in the UI
    // forever, showing "error" next to a camera that has since recovered.
    lastErrorByCamera.delete(camera.id);
  }, STABLE_AFTER_MS);

  proc.on('error', (err) => {
    releaseQsvSlot();
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
    releaseQsvSlot();
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
      qsvKnownUnavailable = true;
      logEvent(camera.id, 'stream_error', 'Hardware encoder (QSV) gagal, beralih ke software (libx264)');
      spawnEncoder(camera, entry, 'x264');
      return;
    }

    // Unexpected disconnect (network blip, camera reboot, RTSP timeout) —
    // retry with exponential backoff instead of leaving the camera dark
    // until someone notices and clicks "Live" again. Keep retrying no
    // matter how many attempts it's been: a monitoring wall left open is
    // supposed to reconnect on its own whenever the camera comes back, not
    // get stuck showing "Offline" until someone manually restarts it.
    entry.retryCount = (entry.retryCount || 0) + 1;

    const delay = withJitter(Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (entry.retryCount - 1)));
    entry.reconnecting = true;
    if (shouldLogRetry(entry.retryCount)) {
      logEvent(camera.id, 'stream_reconnecting', `Live stream terputus, mencoba sambung ulang dalam ${Math.round(delay / 1000)}s (percobaan ke-${entry.retryCount})`);
    }
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

// Force-stops the stream and resolves only once the ffmpeg process has
// actually exited, unlike stopStream() (viewer-count based, fires SIGTERM
// without waiting). DELETE /api/cameras/:id needs this: rm'ing the segment
// directory right after a bare SIGTERM races the still-exiting process for
// its open file handles (throws EBUSY/EPERM on Windows), leaving the
// directory orphaned since the camera row is gone by the time anyone would
// retry.
function stopStreamAndWait(cameraId) {
  const entry = activeStreams.get(cameraId);
  if (!entry) return Promise.resolve();
  entry.stopRequested = true;
  if (entry.reconnectTimer) {
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
  }
  if (entry.stableTimer) clearTimeout(entry.stableTimer);
  if (!entry.alive || !entry.process) {
    activeStreams.delete(cameraId); // not running (mid-backoff wait or already stopped)
    logEvent(cameraId, 'stream_stopped', 'Live stream dihentikan');
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    entry.process.once('exit', () => resolve());
    entry.process.kill('SIGTERM');
  });
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

module.exports = { startStream, stopStream, stopStreamAndWait, getStatus, stopAll, streamDirFor };
