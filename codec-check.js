// Diagnostic-only script: probes every non-relay camera's main RTSP stream
// with ffprobe to see whether its source codec is H.264 (eligible for cheap
// "copy"/remux mode) or something else (must be re-encoded, expensive).
// Read-only — does not touch the database or start any stream. Safe to
// delete after running.
//
// Usage (from /var/www/vms):
//   node codec-check.js
const { spawnSync } = require('child_process');
const { db, decryptCamera } = require('./src/db');

const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const TIMEOUT_MS = 6000;

function probeCodec(rtspUrl) {
  const args = [
    '-v', 'error',
    '-rtsp_transport', 'tcp',
    '-stimeout', '5000000', // try the older flag first
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name',
    '-of', 'csv=p=0',
    rtspUrl,
  ];
  let result = spawnSync(FFPROBE, args, { encoding: 'utf8', timeout: TIMEOUT_MS });
  let out = (result.stdout || '').trim().toLowerCase();
  if (!out) {
    // retry with -timeout instead of -stimeout in case this ffprobe build
    // doesn't support -stimeout (same flip-flop as streaming.js handles)
    const args2 = args.map((a) => (a === '-stimeout' ? '-timeout' : a));
    result = spawnSync(FFPROBE, args2, { encoding: 'utf8', timeout: TIMEOUT_MS });
    out = (result.stdout || '').trim().toLowerCase();
  }
  return out || (result.error ? `error: ${result.error.message}` : 'no response');
}

const rows = db.prepare('SELECT id, name, is_relay FROM cameras ORDER BY id ASC').all();
console.log(`Total kamera di database: ${rows.length}\n`);

let h264 = 0, other = 0, unreachable = 0, relay = 0, noUrl = 0;
const otherList = [];

for (const row of rows) {
  if (row.is_relay) {
    relay += 1;
    console.log(`[${row.id}] ${row.name}: (relay, dilewati)`);
    continue;
  }
  const cam = decryptCamera(db.prepare('SELECT * FROM cameras WHERE id = ?').get(row.id));
  if (!cam.rtsp_url) {
    noUrl += 1;
    console.log(`[${row.id}] ${row.name}: (belum ada rtsp_url, dilewati)`);
    continue;
  }
  const codec = probeCodec(cam.rtsp_url);
  if (codec === 'h264') {
    h264 += 1;
    console.log(`[${row.id}] ${row.name}: h264 (bisa copy/remux)`);
  } else if (codec.startsWith('error') || codec === 'no response') {
    unreachable += 1;
    console.log(`[${row.id}] ${row.name}: TIDAK TERJANGKAU (${codec})`);
  } else {
    other += 1;
    otherList.push(`${row.id} ${row.name} (${codec})`);
    console.log(`[${row.id}] ${row.name}: ${codec} (harus re-encode)`);
  }
}

console.log('\n=== RINGKASAN ===');
console.log(`H.264 (bisa mode copy, murah)   : ${h264}`);
console.log(`Codec lain (harus re-encode)     : ${other}`);
console.log(`Tidak terjangkau saat probe      : ${unreachable}`);
console.log(`Relay (dilewati)                 : ${relay}`);
console.log(`Belum ada RTSP URL (dilewati)    : ${noUrl}`);
if (otherList.length) {
  console.log('\nDaftar codec lain:');
  otherList.forEach((l) => console.log(`  - ${l}`));
}
