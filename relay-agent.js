#!/usr/bin/env node
/**
 * Open VMS — Relay Agent
 *
 * Run this on a PC that sits on the SAME local network as a camera the
 * central VMS server can't reach directly (private IP, no port-forward,
 * no VPN). It pulls the camera's RTSP feed locally (where it's reachable),
 * transcodes to H.264 (browsers can't decode H.265), and pushes the
 * resulting HLS segments out to the central server over an outbound HTTPS/
 * HTTP connection — the direction almost every firewall/NAT allows, unlike
 * exposing an inbound port on the camera's side.
 *
 * Requirements on this PC: Node.js 18+ and ffmpeg installed.
 *
 * Usage:
 *   node relay-agent.js --server=https://vms.example.com --token=<relay_token> --rtsp="rtsp://admin:pass@192.168.1.50:554/Streaming/Channels/101"
 *
 * Get the exact command (with your camera's token already filled in) from
 * the VMS app: check "🔌 Kamera ini di jaringan privat" when adding the
 * camera, or click "Info Agen" on an existing relay camera's tile.
 *
 * Optional flags:
 *   --ffmpeg=/path/to/ffmpeg   (default: "ffmpeg" from PATH, or FFMPEG_PATH env var)
 *   --width=960                (max output width, matches server-side live view)
 *   --fps=15                   (output frame rate)
 *
 * --server / --token / --rtsp can also be set via env vars (RELAY_SERVER,
 * RELAY_TOKEN, RELAY_RTSP_URL) if your shell/service manager mangles the
 * '%'/'@'/':' characters in an rtsp:// URL passed as a CLI argument.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    const m = raw.match(/^--([^=]+)=(.*)$/);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
// CLI flags win; env vars are a fallback for setups where quoting a
// rtsp://user:pass@host URL on the command line is awkward (systemd unit
// files, Windows Task Scheduler, some shells mangling '%'/'@' in args).
const SERVER = (args.server || process.env.RELAY_SERVER || '').replace(/\/+$/, '');
const TOKEN = args.token || process.env.RELAY_TOKEN;
const RTSP_URL = args.rtsp || process.env.RELAY_RTSP_URL;
const FFMPEG = args.ffmpeg || process.env.FFMPEG_PATH || 'ffmpeg';
const MAX_WIDTH = Number(args.width) || 960;
const TARGET_FPS = Number(args.fps) || 15;

if (!SERVER || !TOKEN || !RTSP_URL) {
  console.error('Wajib diisi: --server=... --token=... --rtsp="..."');
  console.error('Contoh: node relay-agent.js --server=http://192.168.1.5:4000 --token=abcd1234 --rtsp="rtsp://admin:pass@192.168.1.50:554/Streaming/Channels/101"');
  process.exit(1);
}

const WORK_DIR = path.join(os.tmpdir(), 'vms-relay-agent', TOKEN.slice(0, 12));
fs.mkdirSync(WORK_DIR, { recursive: true });

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;
let retryCount = 0;
let stopRequested = false;
// QSV is a host-level hardware capability — once it's proven unusable on
// this PC it will fail identically on every future reconnect, so remember
// that instead of burning ~4s retrying it each cycle.
let qsvKnownUnavailable = false;

function log(...msg) {
  console.log(`[${new Date().toISOString()}]`, ...msg);
}

const HLS_SEGMENT_SECONDS = 2;

function buildFfmpegArgs(encoder) {
  const scale = `scale=w='min(${MAX_WIDTH},iw)':h=-2:flags=fast_bilinear`;
  // See the matching comment in streaming.js's buildArgs — without pinning
  // the GOP to the HLS segment length, the encoder's default keyframe
  // interval (far longer than 2s) makes the first segment take many
  // seconds to close and every segment after it an inconsistent length.
  const gop = TARGET_FPS * HLS_SEGMENT_SECONDS;
  const encoderArgs = encoder === 'qsv'
    ? ['-vf', `${scale},format=nv12`, '-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '25', '-g', String(gop), '-bf', '0']
    : ['-vf', `${scale},format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-crf', '23', '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0'];

  return [
    // See the matching comment in streaming.js — tolerate a glitchy WAN
    // camera link instead of the pipeline stalling or dying on it.
    '-fflags', '+genpts+discardcorrupt',
    '-avoid_negative_ts', 'make_zero',
    '-rtsp_transport', 'tcp',
    '-timeout', '10000000',
    '-i', RTSP_URL,
    ...encoderArgs,
    '-r', String(TARGET_FPS),
    '-an',
    '-f', 'hls',
    '-hls_time', String(HLS_SEGMENT_SECONDS),
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+append_list+independent_segments',
    '-hls_segment_filename', path.join(WORK_DIR, 'seg_%03d.ts'),
    path.join(WORK_DIR, 'index.m3u8'),
  ];
}

async function pushFile(name) {
  const filePath = path.join(WORK_DIR, name);
  let data;
  try {
    data = fs.readFileSync(filePath);
  } catch {
    return; // file rotated away between detection and read; skip this tick
  }
  const url = `${SERVER}/api/relay/${TOKEN}/segment?name=${encodeURIComponent(name)}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: data,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log(`Gagal push ${name}: HTTP ${res.status} ${body}`);
    }
  } catch (err) {
    log(`Gagal push ${name}: ${err.message}`);
  }
}

// Poll the local HLS output dir and push anything new/changed. Simple and
// dependency-free; segments land every ~2s so 1s granularity is plenty.
const knownMtimes = new Map();
let watching = false;
function startWatcher() {
  if (watching) return;
  watching = true;
  setInterval(async () => {
    let entries;
    try {
      entries = fs.readdirSync(WORK_DIR);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!/^(index\.m3u8|seg_\d+\.ts)$/.test(name)) continue;
      const full = path.join(WORK_DIR, name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      const prev = knownMtimes.get(name);
      if (prev === stat.mtimeMs) continue;
      knownMtimes.set(name, stat.mtimeMs);
      await pushFile(name);
    }
  }, 1000);
}

function spawnFfmpeg(encoder) {
  const proc = spawn(FFMPEG, buildFfmpegArgs(encoder), { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  const startedAt = Date.now();
  let fellBack = false;
  let lastStderr = '';

  log(`ffmpeg dimulai (encoder=${encoder}) untuk ${RTSP_URL}`);

  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    if (/error|fail/i.test(text)) lastStderr = text.trim().slice(-300);
  });

  proc.on('error', (err) => {
    log(`Gagal menjalankan ffmpeg: ${err.message}. Pastikan ffmpeg terinstal dan --ffmpeg mengarah ke lokasi yang benar.`);
    scheduleReconnect();
  });

  proc.on('exit', (code) => {
    if (stopRequested) return;
    const ranMs = Date.now() - startedAt;
    if (encoder === 'qsv' && code !== 0 && ranMs < 4000 && !fellBack) {
      fellBack = true;
      qsvKnownUnavailable = true;
      log('Hardware encoder (QSV) gagal, beralih ke software (libx264)...');
      spawnFfmpeg('x264');
      return;
    }
    log(`ffmpeg berhenti (code=${code}). ${lastStderr}`);
    scheduleReconnect();
  });

  if (!watching) startWatcher();
}

function scheduleReconnect() {
  retryCount += 1;
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (retryCount - 1));
  log(`Mencoba sambung ulang dalam ${Math.round(delay / 1000)}s (percobaan ke-${retryCount})...`);
  setTimeout(() => {
    if (!stopRequested) spawnFfmpeg(qsvKnownUnavailable ? 'x264' : 'qsv');
  }, delay);
}

process.on('SIGINT', () => {
  log('Berhenti...');
  stopRequested = true;
  process.exit(0);
});

log(`Relay agent berjalan. Target server: ${SERVER}`);
log(`Folder kerja lokal: ${WORK_DIR}`);
spawnFfmpeg('qsv');
