const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { logEvent, getCameraById } = require('./db');
const settings = require('./settings');
const systemHealth = require('./system_health');

const STREAMS_DIR = path.join(__dirname, '..', 'public', 'streams');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

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

// stopStream() is refcounted on `viewers`, which relies on the frontend
// always pairing every stream/start with a stream/stop — a crashed tab,
// killed browser process, or lost network right as the stop request goes
// out never decrements it, so the ffmpeg process (and its memory) runs
// forever with a phantom viewer nobody will ever release. lastAccessedAt
// (touched by every real HLS playlist/segment request, wired up in
// index.js's /streams middleware) is ground truth for "is anyone actually
// watching" independent of that refcount — if nothing has fetched a
// segment in this long, sweepIdleStreams() below force-stops it regardless
// of what `viewers` claims.
// 5 minutes (not seconds) deliberately: renderGrid()'s pagination
// deliberately leaves a paginated-off tile's stream running server-side
// with stopLoad() called client-side (see public/app.js) so flipping back
// resumes instantly — too short a timeout would kill that camera out from
// under a user who's just looking at a different page for a bit, forcing
// a manual re-start click. 5 minutes is generous enough not to punish
// normal page-flipping while still reclaiming a tab that's actually gone.
const IDLE_TIMEOUT_MS = Number(process.env.STREAM_IDLE_TIMEOUT_MS) || 5 * 60 * 1000;
const IDLE_SWEEP_INTERVAL_MS = 60 * 1000;

// Keyed by `${cameraId}:${profile}` — 'main' (full quality, focus/fullscreen
// view + recording) and 'sub' (camera's own lower-res feed, Live View grid)
// run as fully independent ffmpeg processes/entries so starting one never
// affects the other. Value: { process, viewers, startedAt, lastAccessedAt,
// encoder, alive, stopRequested, reconnecting, retryCount, reconnectTimer,
// stableTimer }
const activeStreams = new Map();
const lastErrorByCamera = new Map();

function streamKey(cameraId, profile) {
  return `${cameraId}:${profile}`;
}
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

// Software (libx264) has no hardware session ceiling like QSV does, but it
// still runs on real CPU cores that are just as finite — the "no such
// session ceiling" reasoning above only means ffmpeg won't refuse to start
// a 115th software encode, not that the box can actually run 115 of them.
// On a 1-vCPU host, "Nyalakan Semua" (Start All) firing stream/start for
// ~199 cameras drove load average past 100 and starved the Node process
// itself of CPU (health checks, the API, even PM2's own polling), which is
// what made the whole dashboard "lemot" rather than just the video feeds.
// Cap concurrent software encodes the same way QSV is capped: once the
// limit is hit, additional stream requests queue instead of spawning
// immediately, and get picked up as soon as a running stream's slot frees.
// Scales with actual core count so the same code doesn't need retuning
// per-deployment; override with SOFTWARE_CONCURRENCY_LIMIT if the
// empirical sweet spot for a given host differs.
// Capped at 10 regardless of core count: on a 14-core Windows dev box,
// cpus*3 (42) let "Nyalakan Semua" across 200 cameras — many with bad
// credentials/unreachable IPs/codec errors that fail and reconnect every
// few seconds forever — burst far more concurrent spawn() calls than
// Windows' process-creation subsystem tolerates, surfacing as
// `Error: spawn UNKNOWN` (errno -4094) and zero ffmpeg processes actually
// running. The limit's job is bounding concurrent spawn attempts, not
// concurrent CPU-seconds, so a flat ceiling matters more than raw core
// count once core count gets large; low-core hosts are still protected by
// the *2 floor below.
const SOFTWARE_CONCURRENCY_LIMIT = Number(process.env.SOFTWARE_CONCURRENCY_LIMIT) || Math.max(2, Math.min(os.cpus().length * 3, 10));
let activeSoftwareCount = 0;
// FIFO of { camera, entry } waiting for a software encode slot to free up.
const softwareQueue = [];

function drainSoftwareQueue() {
  // Also holds the queue while systemHealth reports a sustained-CPU
  // throttle — same reasoning as the concurrency cap itself, just triggered
  // by measured load instead of a fixed process count. Nothing already
  // running gets killed; this only stops *new* software encodes from
  // starting until CPU recovers. Re-checked on this same periodic timer (see
  // softwareQueueDrainTimer below) so queued cameras resume promptly once
  // throttle lifts, not just whenever some other stream happens to exit.
  while (softwareQueue.length > 0 && activeSoftwareCount < SOFTWARE_CONCURRENCY_LIMIT && !systemHealth.isThrottled()) {
    const { camera, entry, profile } = softwareQueue.shift();
    if (entry.stopRequested || !activeStreams.has(streamKey(camera.id, profile))) continue;
    // Re-fetch: credentials/settings may have changed while this camera sat
    // in queue, same reasoning as the reconnect-timer re-fetch below.
    const fresh = getCameraById(camera.id) || camera;
    spawnEncoder(fresh, entry, 'x264', profile);
  }
}
// systemHealth's throttle flag can flip from true to false with no stream
// ever exiting (e.g. some unrelated process on the box that was hogging CPU
// finishes) — without a periodic nudge, cameras already parked in
// softwareQueue would sit there until the next unrelated slot-release event
// happened to occur, however long that took. Cheap no-op when the queue is
// empty or still throttled/full.
setInterval(drainSoftwareQueue, 5000).unref();

// profile 'main' keeps the original, pre-sub-stream directory layout
// (public/streams/<id>/) so existing playlist URLs/bookmarks/clients don't
// break. 'sub' gets its own nested folder so the two profiles' HLS segments
// never collide.
function streamDirFor(cameraId, profile = 'main') {
  return profile === 'sub'
    ? path.join(STREAMS_DIR, String(cameraId), 'sub')
    : path.join(STREAMS_DIR, String(cameraId));
}

// -hls_flags delete_segments only prunes segments *this* ffmpeg process
// wrote, as its own rolling window advances — it has no idea a previous
// process ever wrote into the same directory. Every stop/reconnect (viewer
// closes and reopens, a dropped RTSP link, QSV falling back to x264, a
// server restart) starts a brand new process whose segment counter begins
// over, so without this, every past process this camera ever had leaves
// its last few segments behind forever, unreferenced by the current
// index.m3u8 and never cleaned up until the camera itself is deleted. Only
// .ts/.m3u8 are touched — nothing else is ever written into this directory.
function clearStreamDir(dir) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (_err) {
    return; // doesn't exist yet — nothing to clear
  }
  for (const f of files) {
    if (f.endsWith('.ts') || f.endsWith('.m3u8')) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (_err) { /* already gone, fine */ }
    }
  }
}

const HLS_SEGMENT_SECONDS = 2;

function buildArgs(camera, dir, playlistPath, encoder, rtspUrl) {
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
  let encoderArgs;
  if (encoder === 'copy') {
    // No filtering/scaling is possible without decoding, so resolution, fps
    // and keyframe interval are all whatever the camera itself is already
    // producing — the HLS muxer just cuts each segment on the nearest
    // source keyframe instead of a forced ~2s boundary. stream_max_width/
    // stream_fps settings don't apply in this mode.
    encoderArgs = ['-c:v', 'copy'];
  } else if (encoder === 'qsv') {
    encoderArgs = ['-vf', `${scale},format=nv12`, '-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '25', '-g', String(gop), '-bf', '0'];
  } else {
    encoderArgs = ['-vf', `${scale},format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-crf', '23', '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0'];
  }

  const args = [
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
    '-i', rtspUrl,
    ...encoderArgs,
    // -r forces a framerate conversion, which (like -vf) requires decoding —
    // invalid alongside -c:v copy, so the camera's native fps is kept as-is.
    ...(encoder === 'copy' ? [] : ['-r', String(fps)]),
    '-an',
    '-f', 'hls',
    '-hls_time', String(HLS_SEGMENT_SECONDS),
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+append_list+independent_segments',
    '-hls_segment_filename', path.join(dir, 'seg_%03d.ts'),
    playlistPath
  ];
  return args;
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

// Re-encoding every live view (resize + libx264/QSV) burns CPU/GPU even when
// the camera is already sending H.264 that a browser could play as-is — on a
// host with only a handful of encode slots (see QSV/SOFTWARE_CONCURRENCY_LIMIT
// above), that's the difference between 3 cameras live and all of them live.
// When the source is confirmed H.264, skip encoding entirely and just remux
// into HLS (-c:v copy): near-zero CPU cost, so it doesn't compete for either
// concurrency slot at all (see spawnEncoder). Cameras already sending H.265
// or anything else still go through the normal QSV/x264 path.
const videoCodecByCamera = new Map(); // `${cameraId}:${profile}` -> { rtspUrl, codec: 'h264' | 'other' }
const codecProbeInFlight = new Set();

function probeVideoCodec(rtspUrl) {
  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-rtsp_transport', 'tcp',
      RTSP_TIMEOUT_FLAG, '5000000',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'csv=p=0',
      rtspUrl,
    ];
    let out = '';
    let proc;
    try {
      proc = spawn(FFPROBE, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch (_err) {
      resolve('');
      return;
    }
    proc.stdout.on('data', (chunk) => { out += chunk; });
    proc.on('close', () => resolve(out.trim().toLowerCase()));
    proc.on('error', () => resolve(''));
  });
}

// Fire-and-forget: caches the result for the *next* start/reconnect attempt
// rather than blocking the current one on an extra RTSP round-trip. A single
// in-flight probe per camera+profile, since reconnect attempts can pile up
// quickly (2s base backoff) and each one would otherwise kick off its own
// ffprobe.
function ensureCodecProbed(camera, profile, rtspUrl) {
  const key = streamKey(camera.id, profile);
  if (codecProbeInFlight.has(key)) return;
  codecProbeInFlight.add(key);
  probeVideoCodec(rtspUrl)
    .then((codecName) => {
      videoCodecByCamera.set(key, {
        rtspUrl,
        codec: codecName === 'h264' ? 'h264' : 'other',
      });
    })
    .finally(() => codecProbeInFlight.delete(key));
}

function preferredEncoder(camera, profile, rtspUrl) {
  const cached = camera && videoCodecByCamera.get(streamKey(camera.id, profile));
  if (cached && cached.rtspUrl === rtspUrl) {
    if (cached.codec === 'h264') return 'copy';
  } else if (camera) {
    ensureCodecProbed(camera, profile, rtspUrl);
  }
  if (settings.getSetting('hwaccel_mode') === 'software' || qsvKnownUnavailable) return 'x264';
  if (activeQsvCount >= QSV_CONCURRENCY_LIMIT) return 'x264';
  return 'qsv';
}

// Sub stream falls back to the main stream's URL when no sub URL is
// configured — same behavior as before this feature existed for any camera
// that hasn't set one up.
function rtspUrlFor(camera, profile) {
  return profile === 'sub' ? (camera.rtsp_url_sub || camera.rtsp_url) : camera.rtsp_url;
}

function spawnEncoder(camera, entry, encoder, profile = 'main') {
  const key = streamKey(camera.id, profile);
  const rtspUrl = rtspUrlFor(camera, profile);
  // Software slot check happens before anything else spawns/allocates —
  // if the box is already at SOFTWARE_CONCURRENCY_LIMIT, park this camera
  // in the queue instead of starting a 115th ffmpeg process. It gets
  // re-dispatched through this same function once a slot frees (see
  // drainSoftwareQueue), so everything below this point can assume the
  // slot is actually available.
  const cpuThrottled = encoder === 'x264' && systemHealth.isThrottled();
  if (encoder === 'x264' && (cpuThrottled || activeSoftwareCount >= SOFTWARE_CONCURRENCY_LIMIT)) {
    entry.alive = false;
    entry.reconnecting = true;
    if (!entry.queued) {
      entry.queued = true;
      lastErrorByCamera.set(key, cpuThrottled
        ? 'CPU server tinggi berkelanjutan — live view baru ditahan sementara sampai beban turun'
        : `Menunggu slot software encoder tersedia (${SOFTWARE_CONCURRENCY_LIMIT} sedang dipakai)`);
      logEvent(camera.id, 'stream_reconnecting', cpuThrottled
        ? `Live stream (${profile}) ditahan — CPU server tinggi berkelanjutan`
        : `Live stream (${profile}) mengantre — batas ${SOFTWARE_CONCURRENCY_LIMIT} software encoder bersamaan sedang penuh`);
    }
    softwareQueue.push({ camera, entry, profile });
    return;
  }
  entry.queued = false;

  const dir = streamDirFor(camera.id, profile);
  const playlistPath = path.join(dir, 'index.m3u8');
  const args = buildArgs(camera, dir, playlistPath, encoder, rtspUrl);

  clearStreamDir(dir);

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

  // Claim a concurrency slot for the lifetime of this specific process;
  // released exactly once no matter which way this particular process ends
  // (crash, clean exit, fallback, stop) so the count never leaks or double-frees.
  let usingQsvSlot = false;
  let usingSoftwareSlot = false;
  // 'copy' claims neither slot — a remux-only process costs negligible CPU,
  // so it shouldn't compete with (or count against) the QSV/software caps
  // that exist specifically to protect the box from encode overload.
  if (encoder === 'qsv') {
    activeQsvCount += 1;
    usingQsvSlot = true;
  } else if (encoder === 'x264') {
    activeSoftwareCount += 1;
    usingSoftwareSlot = true;
  }
  function releaseQsvSlot() {
    if (usingQsvSlot) {
      activeQsvCount = Math.max(0, activeQsvCount - 1);
      usingQsvSlot = false;
    }
  }
  function releaseSoftwareSlot() {
    if (usingSoftwareSlot) {
      activeSoftwareCount = Math.max(0, activeSoftwareCount - 1);
      usingSoftwareSlot = false;
      // Someone else may have been waiting on exactly this slot.
      drainSoftwareQueue();
    }
  }

  if (entry.stableTimer) clearTimeout(entry.stableTimer);
  entry.stableTimer = setTimeout(() => {
    entry.retryCount = 0;
    // A prior failure's message would otherwise stick around in the UI
    // forever, showing "error" next to a camera that has since recovered.
    lastErrorByCamera.delete(key);
  }, STABLE_AFTER_MS);

  proc.on('error', (err) => {
    releaseQsvSlot();
    releaseSoftwareSlot();
    entry.alive = false;
    activeStreams.delete(key);
    logEvent(camera.id, 'stream_error', `Gagal menjalankan ffmpeg (${profile}): ${err.message}`);
  });

  proc.stderr.on('data', (chunk) => {
    // ffmpeg logs go to stderr by default; keep last error line for diagnostics
    const text = chunk.toString();
    if (/error|fail/i.test(text)) {
      lastErrorByCamera.set(key, text.trim().slice(-500));
    }
  });

  proc.on('exit', (code) => {
    releaseQsvSlot();
    releaseSoftwareSlot();
    entry.alive = false;
    if (entry.stableTimer) clearTimeout(entry.stableTimer);
    const ranMs = Date.now() - startedAt;

    if (entry.stopRequested) {
      activeStreams.delete(key);
      logEvent(camera.id, 'stream_stopped', `Live stream (${profile}) dihentikan`);
      return;
    }

    // QSV dying almost immediately usually means the hardware path isn't
    // usable on this host (no iGPU, missing driver, no /dev/dri in a
    // container). Fall back to the software encoder rather than leaving
    // the camera with no stream at all.
    if (encoder === 'qsv' && code !== 0 && ranMs < 4000 && !fellBack) {
      fellBack = true;
      qsvKnownUnavailable = true;
      logEvent(camera.id, 'stream_error', `Hardware encoder (QSV) gagal (${profile}), beralih ke software (libx264)`);
      spawnEncoder(camera, entry, 'x264', profile);
      return;
    }

    // A remux-only ("copy") attempt dying almost immediately usually means
    // the cached codec read was stale or wrong (camera profile/firmware
    // changed since it was probed, or ffprobe misread a non-H.264 stream) —
    // forget that cached codec so the next start re-probes instead of
    // looping on a copy attempt that can never succeed, and fall back to a
    // normal encode for this attempt so the camera isn't left dark.
    if (encoder === 'copy' && code !== 0 && ranMs < 4000 && !fellBack) {
      fellBack = true;
      videoCodecByCamera.delete(key);
      logEvent(camera.id, 'stream_error', `Mode copy (tanpa re-encode) gagal (${profile}), beralih ke re-encode`);
      const fallbackEncoder = (settings.getSetting('hwaccel_mode') === 'software' || qsvKnownUnavailable || activeQsvCount >= QSV_CONCURRENCY_LIMIT) ? 'x264' : 'qsv';
      spawnEncoder(camera, entry, fallbackEncoder, profile);
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
      logEvent(camera.id, 'stream_reconnecting', `Live stream (${profile}) terputus, mencoba sambung ulang dalam ${Math.round(delay / 1000)}s (percobaan ke-${entry.retryCount})`);
    }
    entry.reconnectTimer = setTimeout(() => {
      if (!activeStreams.has(key) || entry.stopRequested) return;
      // Re-fetch instead of reusing the closed-over `camera` — otherwise an
      // admin fixing a wrong password (or IP/RTSP path) via the Edit form
      // has no effect on a stream that's already mid-retry: every future
      // attempt keeps reusing the credentials it started with.
      const fresh = getCameraById(camera.id) || camera;
      const freshUrl = rtspUrlFor(fresh, profile);
      spawnEncoder(fresh, entry, preferredEncoder(fresh, profile, freshUrl), profile);
    }, delay);
  });
}

function startStream(camera, profile = 'main') {
  const key = streamKey(camera.id, profile);
  if (activeStreams.has(key)) {
    const existing = activeStreams.get(key);
    existing.viewers += 1;
    // A prior stopStream() may have set this while its SIGTERM'd process was
    // still exiting. If a new viewer starts watching before that exit event
    // fires, the exit handler must not tear this entry down out from under
    // them (it would otherwise trust the stale flag and kill a live view
    // that was just (re)started).
    existing.stopRequested = false;
    return existing;
  }

  const dir = streamDirFor(camera.id, profile);
  fs.mkdirSync(dir, { recursive: true });

  const entry = {
    process: null,
    viewers: 1,
    startedAt: Date.now(),
    lastAccessedAt: Date.now(),
    encoder: null,
    alive: false,
    stopRequested: false,
    reconnecting: false,
    retryCount: 0,
    reconnectTimer: null,
    stableTimer: null,
  };
  activeStreams.set(key, entry);
  const rtspUrl = rtspUrlFor(camera, profile);
  spawnEncoder(camera, entry, preferredEncoder(camera, profile, rtspUrl), profile);
  logEvent(camera.id, 'stream_started', `Live stream (${profile}) dimulai`);
  return entry;
}

function stopStream(cameraId, profile = 'main') {
  const key = streamKey(cameraId, profile);
  const entry = activeStreams.get(key);
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
      activeStreams.delete(key); // mid-backoff wait, no live process to kill
      logEvent(cameraId, 'stream_stopped', `Live stream (${profile}) dihentikan`);
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
// retry. When profile is omitted, stops both profiles — the delete route
// wants everything for this camera gone, not just one stream.
function stopStreamAndWait(cameraId, profile) {
  if (!profile) {
    return Promise.all([
      stopStreamAndWait(cameraId, 'main'),
      stopStreamAndWait(cameraId, 'sub'),
    ]);
  }
  const key = streamKey(cameraId, profile);
  const entry = activeStreams.get(key);
  if (!entry) return Promise.resolve();
  entry.stopRequested = true;
  if (entry.reconnectTimer) {
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
  }
  if (entry.stableTimer) clearTimeout(entry.stableTimer);
  if (!entry.alive || !entry.process) {
    activeStreams.delete(key); // not running (mid-backoff wait or already stopped)
    logEvent(cameraId, 'stream_stopped', `Live stream (${profile}) dihentikan`);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    entry.process.once('exit', () => resolve());
    entry.process.kill('SIGTERM');
  });
}

// Reports the 'main' profile by default so existing callers (dashboard grid
// status, before sub streams existed) keep seeing the same shape as before.
// Pass profile explicitly to check the other one.
function getStatus(cameraId, profile = 'main') {
  const key = streamKey(cameraId, profile);
  const entry = activeStreams.get(key);
  return {
    active: entry ? entry.alive : false,
    reconnecting: entry ? !!entry.reconnecting : false,
    queued: entry ? !!entry.queued : false,
    viewers: entry ? entry.viewers : 0,
    encoder: entry ? entry.encoder : null,
    lastError: lastErrorByCamera.get(key) || null
  };
}

function stopAll() {
  for (const [key, entry] of activeStreams) {
    entry.stopRequested = true;
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
    if (entry.stableTimer) clearTimeout(entry.stableTimer);
    if (entry.process) entry.process.kill('SIGTERM');
  }
  activeStreams.clear();
}

// Called from index.js on every /streams/<id>/(sub/)?... request — i.e. once
// per real HLS playlist or segment fetch. Silently no-ops for keys with no
// active entry (stale/expired URLs, streams already stopped).
function touchStream(cameraId, profile) {
  const entry = activeStreams.get(streamKey(cameraId, profile));
  if (entry) entry.lastAccessedAt = Date.now();
}

function sweepIdleStreams() {
  const now = Date.now();
  for (const [key, entry] of activeStreams) {
    if (entry.stopRequested) continue;
    if (now - (entry.lastAccessedAt || entry.startedAt) < IDLE_TIMEOUT_MS) continue;
    const [cameraIdStr, profile] = key.split(':');
    const cameraId = Number(cameraIdStr);
    entry.stopRequested = true;
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }
    if (entry.stableTimer) clearTimeout(entry.stableTimer);
    if (entry.alive && entry.process) {
      entry.process.kill('SIGTERM'); // exit handler finishes cleanup (sees stopRequested, logs stream_stopped)
    } else {
      activeStreams.delete(key); // mid-backoff wait, no live process to kill
    }
    logEvent(cameraId, 'stream_idle_timeout', `Live stream (${profile}) dihentikan otomatis — tidak ada aktivitas selama ${Math.round(IDLE_TIMEOUT_MS / 60000)} menit (kemungkinan tab browser ditutup tanpa berhenti dengan benar)`);
  }
}
setInterval(sweepIdleStreams, IDLE_SWEEP_INTERVAL_MS).unref();

module.exports = { startStream, stopStream, stopStreamAndWait, getStatus, stopAll, streamDirFor, touchStream };
