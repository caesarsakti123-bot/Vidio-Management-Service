const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { db, logEvent } = require('./db');
const settings = require('./settings');

const RECORDINGS_DIR = path.join(__dirname, '..', 'recordings');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || deriveFfprobePath(FFMPEG);
const SEGMENT_SECONDS = 600; // 10 minutes per file

const activeRecorders = new Map(); // cameraId -> { process, starting }

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
  const startedAt = Date.now();
  let fellBack = false;

  proc.on('error', (err) => {
    activeRecorders.delete(camera.id);
    logEvent(camera.id, 'recording_error', `Gagal menjalankan ffmpeg: ${err.message}`);
  });

  proc.on('exit', (code) => {
    const ranMs = Date.now() - startedAt;
    if (encoder === 'qsv' && code !== 0 && ranMs < 4000 && !fellBack) {
      fellBack = true;
      logEvent(camera.id, 'recording_error', 'Hardware encoder (QSV) gagal, beralih ke software (libx264) untuk rekaman');
      spawnRecorder(camera, entry, pattern, 'x264');
      return;
    }
    activeRecorders.delete(camera.id);
    logEvent(camera.id, 'recording_stopped', `Recorder exited with code ${code}`);
  });

  logEvent(camera.id, 'recording_started', `Perekaman berkelanjutan dimulai (${encoder})`);
}

async function startRecording(camera) {
  if (activeRecorders.has(camera.id)) return false;

  const entry = { process: null, starting: true };
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
  const encoder = codec === 'h264' ? 'copy' : (settings.getSetting('hwaccel_mode') === 'software' ? 'x264' : 'qsv');
  spawnRecorder(camera, entry, pattern, encoder);
  return true;
}

function stopRecording(cameraId) {
  const entry = activeRecorders.get(cameraId);
  if (!entry) return false;
  if (entry.process) {
    entry.process.kill('SIGTERM');
  } else {
    activeRecorders.delete(cameraId); // still probing codec, nothing spawned yet
  }
  return true;
}

function isRecording(cameraId) {
  return activeRecorders.has(cameraId);
}

// Scan recordings directories, register new files into DB, and delete files older than retention.
function reconcileAndCleanup() {
  const retentionDays = Number(settings.getSetting('retention_days')) || 14;
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
    if (entry.process) entry.process.kill('SIGTERM');
  }
  activeRecorders.clear();
}

module.exports = { startRecording, stopRecording, isRecording, startCleanupScheduler, stopAll, camDir };
