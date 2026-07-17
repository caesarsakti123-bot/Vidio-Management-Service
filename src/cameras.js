const express = require('express');
const crypto = require('crypto');
const onvif = require('onvif');
const { db, logEvent, getCameraById, decryptCamera } = require('./db');
const { encrypt, decrypt } = require('./crypto');
const { requireRole } = require('./auth');
const streaming = require('./streaming');
const recording = require('./recording');
const motion = require('./motion');
const relay = require('./relay');

const router = express.Router();

function generateRelayToken() {
  return crypto.randomBytes(24).toString('hex');
}

// Derives a site code from a camera name so cameras belonging to the same
// physical site (e.g. "BSS T1 B" / "BSS T1 C", "KOE BSS") land in the same
// location automatically, without the user picking one by hand every time.
function deriveSiteCode(name) {
  let code = name
    .replace(/\bBSS\b/gi, ' ')
    .replace(/[-\s]+/g, ' ')
    .trim();
  // Strip a trailing single-letter channel suffix ("T1 B" -> "T1") so
  // multiple cameras at one site group together.
  code = code.replace(/\s+[A-Za-z]$/, '');
  return code || name.trim();
}

// Finds an existing location matching the camera's derived site code, or
// creates one (at a placeholder pin). Only called when the caller didn't
// already pick a location. Reports whether the location is brand new so the
// caller can decide whether it's worth geolocating.
function resolveAutoLocation(name) {
  const siteCode = deriveSiteCode(name);
  const existing = db.prepare('SELECT id FROM locations WHERE name = ? COLLATE NOCASE').get(siteCode);
  if (existing) return { id: existing.id, isNew: false };
  const info = db.prepare('INSERT INTO locations (name, address, lat, lng, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(siteCode, '', -2.5, 118, new Date().toISOString());
  return { id: info.lastInsertRowid, isNew: true };
}

const PRIVATE_IP_RE = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

function isPublicIp(ip) {
  return typeof ip === 'string' && !PRIVATE_IP_RE.test(ip);
}

// Best-effort: place a freshly auto-created location's pin using free IP
// geolocation (city/region accuracy, not exact address). Never blocks the
// camera-creation response — runs after the fact and just logs on failure.
async function geolocateAndUpdateLocation(locationId, ip) {
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,message,lat,lon,city,regionName,country`);
    const data = await res.json();
    if (data.status !== 'success') throw new Error(data.message || 'lookup gagal');
    const address = [data.city, data.regionName, data.country].filter(Boolean).join(', ');
    db.prepare('UPDATE locations SET lat = ?, lng = ?, address = ? WHERE id = ?')
      .run(data.lat, data.lon, address, locationId);
  } catch (err) {
    console.error(`[geolocation] gagal menentukan posisi untuk IP ${ip}: ${err.message}`);
  }
}

// Pasting two adjacent spreadsheet cells (e.g. a site code and "BSS") into a
// single text field inserts a literal tab between them — normalize whatever
// arrives (form paste, CSV import, API) so stray tabs/newlines never land in
// the database.
function sanitizeName(name) {
  return name.replace(/\s+/g, ' ').trim();
}

// ---- CRUD ----

router.get('/', (req, res) => {
  const cameras = db.prepare('SELECT id, name, brand, ip, rtsp_port, onvif_port, username, rtsp_path, rtsp_url, ptz_supported, recording_enabled, motion_detection_enabled, motion_sensitivity, motion_recording_enabled, location_id, building, sort_order, is_relay, relay_token FROM cameras ORDER BY sort_order ASC, id ASC').all();
  const isViewer = req.user.role === 'viewer';
  const withStatus = cameras.map(c => {
    const rtspUrl = decrypt(c.rtsp_url);
    return {
      ...c,
      // rtsp_url embeds the camera's password — admins/operators need the
      // real thing (editing, building relay-agent commands); viewers just
      // need to know one is configured, not to see the credential.
      rtsp_url: isViewer ? (rtspUrl ? '(tersedia)' : null) : rtspUrl,
      // Needed to prefill the Edit-camera form for admins/operators; not
      // exposed to viewers (they can't edit anyway).
      username: isViewer ? undefined : c.username,
      rtsp_path: isViewer ? undefined : c.rtsp_path,
      stream: c.is_relay ? relay.getRelayStatus(c.id) : streaming.getStatus(c.id),
      recording_active: recording.isRecording(c.id),
      motion_active: motion.isMotionActive(c.id),
      motion_detection_enabled: c.motion_detection_enabled === 1,
      motion_recording_enabled: c.motion_recording_enabled === 1,
      is_relay: c.is_relay === 1,
      // The token is a bearer credential for pushing video — only admins/operators
      // (who can also see the setup instructions) get it back over the API.
      relay_token: isViewer ? null : c.relay_token,
    };
  });
  res.json(withStatus);
});

router.post('/', requireRole(['admin', 'operator']), (req, res) => {
  let { name, brand, ip, rtsp_port, onvif_port, username, password, rtsp_path, rtsp_url, ptz_supported, motion_detection_enabled, motion_sensitivity, motion_recording_enabled, location_id, building, is_relay } = req.body;
  if (!name || !ip) return res.status(400).json({ error: 'name dan ip wajib diisi' });
  name = sanitizeName(name);
  building = building ? sanitizeName(building) : null;

  const finalRtspUrl = rtsp_url || (rtsp_path
    ? `rtsp://${username ? `${encodeURIComponent(username)}:${encodeURIComponent(password || '')}@` : ''}${ip}:${rtsp_port || 554}${rtsp_path}`
    : null);

  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM cameras').get().m;
  const relayToken = is_relay ? generateRelayToken() : null;
  const autoLocation = location_id ? null : resolveAutoLocation(name);
  const finalLocationId = location_id || autoLocation.id;

  const info = db.prepare(`
    INSERT INTO cameras (name, brand, ip, rtsp_port, onvif_port, username, password, rtsp_path, rtsp_url, ptz_supported, motion_detection_enabled, motion_sensitivity, motion_recording_enabled, location_id, building, sort_order, is_relay, relay_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    brand || null,
    ip,
    rtsp_port || 554,
    onvif_port || 80,
    username || null,
    encrypt(password || null),
    rtsp_path || null,
    encrypt(finalRtspUrl),
    ptz_supported ? 1 : 0,
    motion_detection_enabled ? 1 : 0,
    Number(motion_sensitivity) || 0.04,
    motion_recording_enabled ? 1 : 0,
    finalLocationId,
    building,
    maxOrder + 1,
    is_relay ? 1 : 0,
    relayToken
  );

  const camera = getCameraById(info.lastInsertRowid);
  motion.syncCamera(camera);
  logEvent(info.lastInsertRowid, 'camera_added', `Kamera "${name}" (${brand || 'unknown'}) ditambahkan`);
  res.status(201).json({ id: info.lastInsertRowid, relay_token: relayToken });

  if (autoLocation?.isNew && isPublicIp(ip)) {
    geolocateAndUpdateLocation(autoLocation.id, ip);
  }
});

// Must be registered before /:id so "reorder" isn't matched as an id param.
router.put('/reorder', requireRole(['admin', 'operator']), (req, res) => {
  const { items } = req.body; // [{ id, sort_order }]
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items harus berupa array berisi {id, sort_order}' });
  }
  const stmt = db.prepare('UPDATE cameras SET sort_order = ? WHERE id = ?');
  const applyAll = db.transaction((rows) => {
    for (const row of rows) stmt.run(Number(row.sort_order), Number(row.id));
  });
  applyAll(items);
  res.json({ ok: true });
});

router.put('/:id', requireRole(['admin', 'operator']), (req, res) => {
  const id = Number(req.params.id);
  const cam = getCameraById(id);
  if (!cam) return res.status(404).json({ error: 'Kamera tidak ditemukan' });

  const fields = ['name', 'brand', 'ip', 'rtsp_port', 'onvif_port', 'username', 'password', 'rtsp_path', 'rtsp_url', 'ptz_supported', 'recording_enabled', 'motion_detection_enabled', 'motion_sensitivity', 'motion_recording_enabled', 'location_id', 'building', 'is_relay'];
  const updates = fields.filter(f => f in req.body);
  if (updates.length === 0) return res.status(400).json({ error: 'Tidak ada field untuk diupdate' });

  // Turning relay mode on for the first time needs a fresh token; turning it
  // back on later keeps whatever token was already issued (the agent's
  // config on the remote PC still references it).
  if (updates.includes('is_relay') && req.body.is_relay && !cam.relay_token) {
    updates.push('relay_token');
  }

  // Editing IP/credentials/path without also resending a raw rtsp_url would
  // otherwise leave the stored rtsp_url stale (still pointing at the old
  // host/credentials) — rebuild it from the merged values, same way POST
  // does when a camera is first created.
  const rtspAffecting = ['ip', 'rtsp_port', 'username', 'password', 'rtsp_path'];
  if (!('rtsp_url' in req.body) && rtspAffecting.some(f => f in req.body)) {
    const merged = {
      ip: req.body.ip ?? cam.ip,
      rtsp_port: req.body.rtsp_port ?? cam.rtsp_port,
      username: req.body.username ?? cam.username,
      password: 'password' in req.body ? req.body.password : cam.password,
      rtsp_path: req.body.rtsp_path ?? cam.rtsp_path,
    };
    // Cameras set up via ONVIF auto-detect have no rtsp_path on file (their
    // rtsp_url came back whole from the device) — fall back to the path
    // portion of the existing rtsp_url so an edited username/password still
    // gets baked into the URL that's actually used to connect, instead of
    // silently updating the columns while streaming keeps using old creds.
    let path = merged.rtsp_path;
    if (!path && cam.rtsp_url) {
      try { path = new URL(cam.rtsp_url).pathname; } catch { /* not a parseable rtsp URL, skip */ }
    }
    if (path) {
      req.body.rtsp_url = `rtsp://${merged.username ? `${encodeURIComponent(merged.username)}:${encodeURIComponent(merged.password || '')}@` : ''}${merged.ip}:${merged.rtsp_port || 554}${path}`;
      updates.push('rtsp_url');
    }
  }

  const setClause = updates.map(f => `${f} = ?`).join(', ');
  const values = updates.map((f) => {
    if (f === 'motion_detection_enabled' || f === 'motion_recording_enabled' || f === 'is_relay') {
      return req.body[f] ? 1 : 0;
    }
    if (f === 'motion_sensitivity') {
      return Number(req.body[f]) || 0.04;
    }
    if (f === 'relay_token') {
      return generateRelayToken();
    }
    if (f === 'name') {
      return sanitizeName(req.body[f]);
    }
    if (f === 'building') {
      return req.body[f] ? sanitizeName(req.body[f]) : null;
    }
    if (f === 'password' || f === 'rtsp_url') {
      return encrypt(req.body[f]);
    }
    return req.body[f];
  });
  db.prepare(`UPDATE cameras SET ${setClause} WHERE id = ?`).run(...values, id);

  const updatedCam = getCameraById(id);
  motion.syncCamera(updatedCam);
  res.json({ ok: true, relay_token: updatedCam.relay_token, is_relay: updatedCam.is_relay === 1 });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  streaming.stopStream(id);
  recording.stopRecording(id);
  motion.stopDetector(id);
  db.prepare('DELETE FROM cameras WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---- ONVIF: auto-detect stream URI + device info ----

router.post('/:id/onvif/probe', requireRole(['admin', 'operator']), async (req, res) => {
  const id = Number(req.params.id);
  const cam = getCameraById(id);
  if (!cam) return res.status(404).json({ error: 'Kamera tidak ditemukan' });
  if (cam.is_relay) return res.status(400).json({ error: 'Kamera relay tidak bisa dijangkau langsung dari server pusat — atur RTSP path manual saja' });

  let responded = false;
  const device = new onvif.Cam({
    hostname: cam.ip,
    port: cam.onvif_port || 80,
    username: cam.username || undefined,
    password: cam.password || undefined,
    timeout: 8000
  }, function (err) {
    if (responded) return;
    if (err) {
      responded = true;
      return res.status(502).json({ error: `Gagal konek ONVIF: ${err.message}` });
    }
    this.getStreamUri({ protocol: 'RTSP' }, (err2, stream) => {
      if (responded) return;
      if (err2) {
        responded = true;
        return res.status(502).json({ error: `Gagal ambil stream URI: ${err2.message}` });
      }

      const ptzSupported = !!this.services?.ptz;
      db.prepare('UPDATE cameras SET rtsp_url = ?, ptz_supported = ? WHERE id = ?')
        .run(encrypt(stream.uri), ptzSupported ? 1 : 0, id);

      const updatedCam = getCameraById(id);
      motion.syncCamera(updatedCam);
      logEvent(id, 'onvif_probe_ok', 'Berhasil mengambil stream URI via ONVIF');
      responded = true;
      res.json({
        rtsp_url: stream.uri,
        ptz_supported: ptzSupported,
        manufacturer: this.deviceInformation?.manufacturer,
        model: this.deviceInformation?.model
      });
    });
  });
});

// ---- PTZ control (only works if camera reports PTZ support) ----

router.post('/:id/ptz', requireRole(['admin', 'operator']), (req, res) => {
  const id = Number(req.params.id);
  const cam = getCameraById(id);
  if (!cam) return res.status(404).json({ error: 'Kamera tidak ditemukan' });
  if (cam.is_relay) return res.status(400).json({ error: 'PTZ tidak tersedia untuk kamera relay — server pusat tidak bisa menjangkau kamera ini langsung' });
  if (!cam.ptz_supported) return res.status(400).json({ error: 'Kamera ini tidak mendukung PTZ' });

  const { action, pan = 0, tilt = 0, zoom = 0 } = req.body; // action: 'move' | 'stop'

  let responded = false;
  const respond = (status, body) => {
    if (responded) return;
    responded = true;
    res.status(status).json(body);
  };

  const device = new onvif.Cam({
    hostname: cam.ip,
    port: cam.onvif_port || 80,
    username: cam.username || undefined,
    password: cam.password || undefined,
    timeout: 8000
  }, function (err) {
    if (err) return respond(502, { error: `Gagal konek ONVIF: ${err.message}` });

    if (action === 'stop') {
      this.stop({}, (err2) => respond(err2 ? 502 : 200, err2 ? { error: err2.message } : { ok: true }));
    } else {
      this.continuousMove({ x: pan, y: tilt, zoom }, (err2) => respond(err2 ? 502 : 200, err2 ? { error: err2.message } : { ok: true }));
    }
  });
});

// ---- Live stream start/stop (HLS via ffmpeg) ----

router.post('/:id/stream/start', requireRole(['admin', 'operator', 'viewer']), (req, res) => {
  const id = Number(req.params.id);
  const cam = getCameraById(id);
  if (!cam) return res.status(404).json({ error: 'Kamera tidak ditemukan' });
  if (cam.is_relay) {
    // Nothing to "start" centrally — the remote agent decides when to push.
    // Report whatever the current relay status already is.
    return res.json({ ok: true, playlist: `/streams/${id}/index.m3u8`, relay: relay.getRelayStatus(id) });
  }
  if (!cam.rtsp_url) return res.status(400).json({ error: 'RTSP URL belum diatur untuk kamera ini' });

  streaming.startStream(cam);
  res.json({ ok: true, playlist: `/streams/${id}/index.m3u8` });
});

router.post('/:id/stream/stop', requireRole(['admin', 'operator', 'viewer']), (req, res) => {
  const id = Number(req.params.id);
  const cam = db.prepare('SELECT is_relay FROM cameras WHERE id = ?').get(id);
  if (cam?.is_relay) return res.json({ ok: true }); // agent-controlled; nothing local to stop
  streaming.stopStream(id);
  res.json({ ok: true });
});

// ---- Recording toggle ----

router.post('/:id/recording/start', requireRole(['admin', 'operator']), async (req, res) => {
  const id = Number(req.params.id);
  const cam = getCameraById(id);
  if (!cam) return res.status(404).json({ error: 'Kamera tidak ditemukan' });
  if (cam.is_relay) return res.status(400).json({ error: 'Rekaman untuk kamera relay belum didukung dari server pusat' });
  if (!cam.rtsp_url) return res.status(400).json({ error: 'RTSP URL belum diatur untuk kamera ini' });

  const started = await recording.startRecording(cam);
  if (!started && !recording.isRecording(id)) {
    return res.status(500).json({ error: 'Gagal memulai perekaman — cek log peristiwa untuk detail' });
  }
  db.prepare('UPDATE cameras SET recording_enabled = 1 WHERE id = ?').run(id);
  res.json({ ok: true });
});

router.post('/:id/recording/stop', requireRole(['admin', 'operator']), (req, res) => {
  const id = Number(req.params.id);
  recording.stopRecording(id);
  db.prepare('UPDATE cameras SET recording_enabled = 0 WHERE id = ?').run(id);
  res.json({ ok: true });
});

module.exports = router;
