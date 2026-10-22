// ==================================================================
// NVR Playback Module — Hikvision ISAPI + RTSP Replay → HLS
// Place at: src/nvr_playback.js
// ==================================================================

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { db, logEvent } = require('./db');
const { encrypt, decrypt } = require('./crypto');
const settings = require('./settings');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const STREAMS_DIR = path.join(__dirname, '..', 'public', 'streams');
const HLS_SEGMENT_SECONDS = 2;

// Active NVR playback sessions: streamId -> { process, nvrId, channel,
// startedAt, lastAccessedAt, stopRequested }
const activeSessions = new Map();

// Unlike streaming.js's SOFTWARE_CONCURRENCY_LIMIT, nothing here capped how
// many of these ffmpeg processes could run at once — any authenticated
// caller (every role can reach POST /start) repeatedly hitting it would
// spawn an unbounded number of them, exhausting server CPU/process handles.
const NVR_PLAYBACK_CONCURRENCY_LIMIT = Number(process.env.NVR_PLAYBACK_CONCURRENCY_LIMIT) || 5;

// Cleanup idle sessions every 60s (same pattern as streaming.js)
const IDLE_TIMEOUT_MS = 3 * 60 * 1000; // 3 min for playback (shorter than live)
setInterval(sweepIdleSessions, 60 * 1000).unref();

// =====================================================================
//  HTTP Digest Auth Client (RFC 2617, MD5, qop=auth)
//  Zero external dependencies — uses built-in http/https + crypto.
// =====================================================================

class DigestAuth {
  constructor(username, password) {
    this.user = username;
    this.pass = password;
    this.nc = 0;
  }

  /** Make an HTTP request with Digest auth. Returns { statusCode, headers, body }. */
  async fetch(url, { method = 'GET', body = null, timeout = 8000 } = {}) {
    // First request: no auth → expect 401 with WWW-Authenticate
    const r1 = await this._rawRequest(url, method, body, null, timeout);
    if (r1.statusCode !== 401) return r1;

    const wwwAuth = r1.headers['www-authenticate'];
    if (!wwwAuth) throw new Error('NVR returned 401 without WWW-Authenticate');

    const authHeader = this._buildDigestHeader(wwwAuth, method, url);
    return this._rawRequest(url, method, body, authHeader, timeout);
  }

  _buildDigestHeader(wwwAuth, method, fullUrl) {
    const params = {};
    for (const m of wwwAuth.matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g)) {
      params[m[1]] = m[2] ?? m[3];
    }

    this.nc++;
    const nc = this.nc.toString(16).padStart(8, '0');
    const cnonce = crypto.randomBytes(8).toString('hex');

    // Extract path from full URL
    const parsed = new URL(fullUrl);
    const uri = parsed.pathname + parsed.search;

    const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
    const ha1 = md5(`${this.user}:${params.realm}:${this.pass}`);
    const ha2 = md5(`${method}:${uri}`);
    // RFC 2617: qop-options is a quoted, comma-separated list ("auth" or
    // "auth,auth-int") — using it verbatim (e.g. hashing the literal string
    // "auth,auth-int" and emitting an unquoted multi-value qop= token) would
    // produce an invalid digest and a syntactically broken Authorization
    // header against any server that offers more than one option.
    const qopOptions = (params.qop || 'auth').split(',').map((s) => s.trim());
    const qop = qopOptions.includes('auth') ? 'auth' : qopOptions[0];
    const response = md5(`${ha1}:${params.nonce}:${nc}:${cnonce}:${qop}:${ha2}`);

    let header = `Digest username="${this.user}", realm="${params.realm}", ` +
      `nonce="${params.nonce}", uri="${uri}", response="${response}", ` +
      `qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
    if (params.opaque) header += `, opaque="${params.opaque}"`;
    return header;
  }

  _rawRequest(url, method, body, authHeader, timeout) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const mod = parsed.protocol === 'https:' ? https : http;
      const opts = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        timeout,
        headers: {},
        // Hikvision NVRs use self-signed certs
        rejectUnauthorized: false,
      };
      if (authHeader) opts.headers['Authorization'] = authHeader;
      if (body) {
        opts.headers['Content-Type'] = 'application/xml';
        opts.headers['Content-Length'] = Buffer.byteLength(body);
      }

      const req = mod.request(opts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
        // Without this, a connection reset mid-response (flaky network, NVR
        // reboot) emits 'error' on an EventEmitter with no listener — an
        // uncaught exception that crashes the entire Node process, not just
        // this one ISAPI call.
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('Request timeout')); });
      if (body) req.write(body);
      req.end();
    });
  }
}

// =====================================================================
//  NVR Source helpers (CRUD uses db directly, here just decrypt helper)
// =====================================================================

function decryptNvrSource(row) {
  if (!row) return row;
  return { ...row, username: decrypt(row.username), password: decrypt(row.password) };
}

function getNvrSourceById(id) {
  const row = db.prepare('SELECT * FROM nvr_sources WHERE id = ?').get(id);
  return decryptNvrSource(row);
}

// =====================================================================
//  ISAPI — Search recordings stored on the NVR
// =====================================================================

/**
 * Search recordings on a Hikvision NVR via ISAPI.
 * @param {object} nvr - Decrypted NVR source row
 * @param {number} channel - Channel number (1-based)
 * @param {string} startTime - ISO 8601 (e.g. 2026-09-01T00:00:00)
 * @param {string} endTime - ISO 8601 (e.g. 2026-09-01T23:59:59)
 * @returns {Array} Array of { startTime, endTime, trackId }
 */
async function searchNvrRecordings(nvr, channel, startTime, endTime) {
  const auth = new DigestAuth(nvr.username, nvr.password);
  const url = `http://${nvr.ip}:${nvr.port}/ISAPI/ContentMgmt/search`;
  const trackId = `${channel}01`; // channel 1 = 101, channel 2 = 201

  const searchId = `search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const xmlBody = `<?xml version="1.0" encoding="UTF-8"?>
<CMSearchDescription>
  <searchID>${searchId}</searchID>
  <trackIDList>
    <trackID>${trackId}</trackID>
  </trackIDList>
  <timeSpanList>
    <timeSpan>
      <startTime>${startTime}Z</startTime>
      <endTime>${endTime}Z</endTime>
    </timeSpan>
  </timeSpanList>
  <maxResults>500</maxResults>
  <searchResultPosition>0</searchResultPosition>
  <metadataList>
    <metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor>
  </metadataList>
</CMSearchDescription>`;

  const res = await auth.fetch(url, { method: 'POST', body: xmlBody, timeout: 15000 });

  if (res.statusCode !== 200) {
    throw new Error(`ISAPI search failed: HTTP ${res.statusCode}`);
  }

  return parseSearchResults(res.body);
}

/**
 * Parse Hikvision ISAPI search XML response into structured results.
 * Uses regex to avoid adding an XML parser dependency.
 */
function parseSearchResults(xml) {
  const results = [];
  // Match each <searchMatchItem>...</searchMatchItem>
  const itemRegex = /<searchMatchItem>([\s\S]*?)<\/searchMatchItem>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
      return m ? m[1].trim() : null;
    };
    const startTime = get('startTime');
    const endTime = get('endTime');
    const trackId = get('trackID');

    if (startTime && endTime) {
      results.push({
        startTime: startTime.replace('Z', ''),
        endTime: endTime.replace('Z', ''),
        trackId,
      });
    }
  }
  return results;
}

// =====================================================================
//  RTSP Replay URL builder
// =====================================================================

/**
 * Build the RTSP replay URL for a Hikvision NVR.
 * Format: [REDACTED_CONN_STRING]://user:pass@ip:554/Streaming/tracks/{channel}01
 *         ?starttime=YYYYMMDDTHHMMSSz&endtime=YYYYMMDDTHHMMSSz
 */
function buildReplayRtspUrl(nvr, channel, startTime, endTime) {
  const toHikFormat = (isoStr) => {
    // Input: "2026-09-01T08:00:00" → Output: "20260901T080000z"
    return isoStr.replace(/[-:]/g, '').replace(/\.\d+/, '') + 'z';
  };

  const trackId = `${channel}01`;
  const user = encodeURIComponent(nvr.username);
  const pass = encodeURIComponent(nvr.password);
  const port = nvr.rtsp_port || 554;

  return `rtsp://${user}:${pass}@${nvr.ip}:${port}/Streaming/tracks/${trackId}` +
    `?starttime=${toHikFormat(startTime)}&endtime=${toHikFormat(endTime)}`;
}

// =====================================================================
//  Start NVR Playback — RTSP replay → ffmpeg → HLS
// =====================================================================

/**
 * Start an NVR playback session.
 * Spawns ffmpeg to pull the RTSP replay stream and convert to HLS.
 * @returns {{ streamId, hlsUrl }} The stream ID and HLS playlist URL
 */
function startNvrPlayback(nvr, channel, startTime, endTime) {
  if (activeSessions.size >= NVR_PLAYBACK_CONCURRENCY_LIMIT) {
    const err = new Error(`Batas ${NVR_PLAYBACK_CONCURRENCY_LIMIT} sesi playback NVR bersamaan tercapai — hentikan sesi lain dulu`);
    err.code = 'NVR_PLAYBACK_LIMIT';
    throw err;
  }
  const streamId = `nvr-${nvr.id}-ch${channel}-${Date.now()}`;
  const dir = path.join(STREAMS_DIR, streamId);
  fs.mkdirSync(dir, { recursive: true });

  const playlistPath = path.join(dir, 'index.m3u8');
  const rtspUrl = buildReplayRtspUrl(nvr, channel, startTime, endTime);

  // Build ffmpeg args — similar pattern to streaming.js but for playback
  const maxWidth = Number(settings.getSetting('stream_max_width')) || 960;
  const fps = Number(settings.getSetting('stream_fps')) || 15;
  const gop = fps * HLS_SEGMENT_SECONDS;

  const args = [
    '-fflags', '+genpts+discardcorrupt',
    '-avoid_negative_ts', 'make_zero',
    '-rtsp_transport', 'tcp',
    '-timeout', '10000000',
    '-i', rtspUrl,
    '-vf', `scale=w='min(${maxWidth},iw)':h=-2:flags=fast_bilinear,format=yuv420p`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-crf', '23',
    '-g', String(gop),
    '-keyint_min', String(gop),
    '-sc_threshold', '0',
    '-r', String(fps),
    '-an',
    '-f', 'hls',
    '-hls_time', String(HLS_SEGMENT_SECONDS),
    '-hls_list_size', '0', // keep all segments (playback, not live rolling)
    '-hls_flags', 'independent_segments',
    '-hls_segment_filename', path.join(dir, 'seg_%04d.ts'),
    playlistPath,
  ];

  const proc = spawn(FFMPEG, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });

  const entry = {
    process: proc,
    nvrId: nvr.id,
    channel,
    streamId,
    dir,
    startedAt: Date.now(),
    lastAccessedAt: Date.now(),
    stopRequested: false,
  };
  activeSessions.set(streamId, entry);

  // Capture stderr for debugging — accumulate (capped) rather than replace,
  // so the diagnostically useful error line isn't discarded the moment a
  // later, less informative chunk (e.g. a trailing newline) arrives.
  let lastErr = '';
  proc.stderr.on('data', (data) => {
    lastErr = (lastErr + data.toString()).slice(-500);
  });

  proc.on('exit', (code) => {
    if (!entry.stopRequested) {
      // rtspUrl embeds the NVR's password (buildReplayRtspUrl above) and
      // ffmpeg commonly echoes the failing -i argument back in its stderr —
      // redact before this reaches the server console/logs.
      const safeErr = lastErr.replace(/(rtsp:\/\/)[^@\s/]+@/gi, '$1***:***@');
      console.error(`[nvr-playback] Stream ${streamId} exited unexpectedly (code ${code}): ${safeErr.slice(-200)}`);
    }
    activeSessions.delete(streamId);
    // Clean up HLS files after a delay (give browser time to fetch last segments)
    setTimeout(() => {
      try {
        const files = fs.readdirSync(dir);
        for (const f of files) {
          try { fs.unlinkSync(path.join(dir, f)); } catch { /* ok */ }
        }
        fs.rmdirSync(dir);
      } catch { /* already gone */ }
    }, 10000);
  });

  proc.on('error', (err) => {
    console.error(`[nvr-playback] Failed to spawn ffmpeg for ${streamId}: ${err.message}`);
    activeSessions.delete(streamId);
  });

  return {
    streamId,
    hlsUrl: `/streams/${streamId}/index.m3u8`,
  };
}

// =====================================================================
//  Stop NVR Playback
// =====================================================================

function stopNvrPlayback(streamId) {
  const entry = activeSessions.get(streamId);
  if (!entry) return false;
  entry.stopRequested = true;
  if (entry.process && entry.process.exitCode === null) {
    entry.process.kill('SIGTERM');
  } else {
    activeSessions.delete(streamId);
  }
  return true;
}

// =====================================================================
//  Touch / Sweep idle sessions (same pattern as streaming.js)
// =====================================================================

function touchSession(streamId) {
  const entry = activeSessions.get(streamId);
  if (entry) entry.lastAccessedAt = Date.now();
}

function sweepIdleSessions() {
  const now = Date.now();
  for (const [id, entry] of activeSessions) {
    if (now - entry.lastAccessedAt > IDLE_TIMEOUT_MS) {
      console.log(`[nvr-playback] Stopping idle session ${id}`);
      stopNvrPlayback(id);
    }
  }
}

// =====================================================================
//  Test NVR connection (ISAPI /System/deviceInfo)
// =====================================================================

async function testNvrConnection(nvr) {
  const auth = new DigestAuth(nvr.username, nvr.password);
  const url = `http://${nvr.ip}:${nvr.port}/ISAPI/System/deviceInfo`;
  const res = await auth.fetch(url, { timeout: 10000 });

  if (res.statusCode !== 200) {
    throw new Error(`HTTP ${res.statusCode}: ${res.body.slice(0, 200)}`);
  }

  // Parse basic device info from XML
  const get = (tag) => {
    const m = res.body.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
    return m ? m[1].trim() : null;
  };

  return {
    deviceName: get('deviceName'),
    model: get('model'),
    serialNumber: get('serialNumber'),
    firmwareVersion: get('firmwareVersion'),
    macAddress: get('macAddress'),
  };
}

// Stop all sessions on shutdown
function stopAll() {
  for (const [id] of activeSessions) {
    stopNvrPlayback(id);
  }
}

module.exports = {
  // NVR source helpers
  getNvrSourceById,
  decryptNvrSource,
  // ISAPI
  searchNvrRecordings,
  testNvrConnection,
  // Playback
  buildReplayRtspUrl,
  startNvrPlayback,
  stopNvrPlayback,
  touchSession,
  stopAll,
  // For testing
  DigestAuth,
  parseSearchResults,
};
