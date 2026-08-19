const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const onvif = require('onvif');
const { db, logEvent, getCameraById, decryptCamera } = require('./db');
const { encrypt, decrypt } = require('./crypto');
const { requireRole } = require('./auth');
const streaming = require('./streaming');
const recording = require('./recording');
const motion = require('./motion');
const relay = require('./relay');
const healthcheck = require('./healthcheck');

const router = express.Router();

function generateRelayToken() {
  return crypto.randomBytes(24).toString('hex');
}

// `Number(x) || 0.04` would silently replace an explicit 0 (max sensitivity)
// with the default, since 0 is falsy — only fall back when the value is
// genuinely missing or non-numeric.
function normalizeMotionSensitivity(value) {
  const n = Number(value);
  return value === undefined || value === null || value === '' || !Number.isFinite(n) ? 0.04 : n;
}

// Rough heuristic for the "Password strength" column (device inventory
// hygiene indicator, not a real password policy) — never returns or logs the
// password itself, only a weak/medium/strong classification.
function passwordStrength(password) {
  if (!password) return 'weak';
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(password)).length;
  if (password.length >= 10 && classes >= 3) return 'strong';
  if (password.length >= 8 && classes >= 2) return 'medium';
  return 'weak';
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

// foreign_keys is ON (db.js) so an insert/update against a location_id that
// no longer exists now throws a raw SqliteError instead of silently storing
// a dangling reference — check first and return a real 400 instead of
// letting that surface as an opaque 500 (e.g. an admin submits a camera
// form with a location that someone else just deleted from a stale
// dropdown).
function locationExists(id) {
  return !!db.prepare('SELECT 1 FROM locations WHERE id = ?').get(id);
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
  const cameras = db.prepare('SELECT id, name, brand, ip, rtsp_port, onvif_port, username, password, rtsp_path, rtsp_url, rtsp_path_sub, rtsp_url_sub, ptz_supported, recording_enabled, motion_detection_enabled, motion_sensitivity, motion_recording_enabled, location_id, building, sort_order, is_relay, relay_token, serial_number, firmware_version, channel_count FROM cameras ORDER BY sort_order ASC, id ASC').all();
  const isViewer = req.user.role === 'viewer';
  const withStatus = cameras.map(c => {
    const rtspUrl = decrypt(c.rtsp_url);
    const rtspUrlSub = decrypt(c.rtsp_url_sub);
    // password itself never leaves this function for any role — only the
    // derived strength label does (see passwordStrength() above).
    const { password, ...rest } = c;
    return {
      ...rest,
      // rtsp_url embeds the camera's password — admins/operators need the
      // real thing (editing, building relay-agent commands); viewers just
      // need to know one is configured, not to see the credential.
      rtsp_url: isViewer ? (rtspUrl ? '(tersedia)' : null) : rtspUrl,
      rtsp_url_sub: isViewer ? (rtspUrlSub ? '(tersedia)' : null) : rtspUrlSub,
      // Needed to prefill the Edit-camera form for admins/operators; not
      // exposed to viewers (they can't edit anyway).
      username: isViewer ? undefined : c.username,
      rtsp_path: isViewer ? undefined : c.rtsp_path,
      rtsp_path_sub: isViewer ? undefined : c.rtsp_path_sub,
      // 'stream' stays the main-profile status (focus/fullscreen view,
      // unchanged shape from before sub streams existed); 'stream_sub' is
      // the Live View grid's own lightweight-profile status — relay cameras
      // have no separate sub feed (the remote agent pushes one stream), so
      // they just mirror the same relay status for both.
      stream: c.is_relay ? relay.getRelayStatus(c.id) : streaming.getStatus(c.id, 'main'),
      stream_sub: c.is_relay ? relay.getRelayStatus(c.id) : streaming.getStatus(c.id, 'sub'),
      recording_active: recording.isRecording(c.id),
      motion_active: motion.isMotionActive(c.id),
      motion_detection_enabled: c.motion_detection_enabled === 1,
      motion_recording_enabled: c.motion_recording_enabled === 1,
      is_relay: c.is_relay === 1,
      // The token is a bearer credential for pushing video — only admins/operators
      // (who can also see the setup instructions) get it back over the API.
      relay_token: isViewer ? null : c.relay_token,
      network_status: healthcheck.isOnline(c.id) ? 'online' : 'offline',
      password_strength: passwordStrength(decrypt(password)),
    };
  });
  res.json(withStatus);
});

router.post('/', requireRole(['admin', 'operator']), (req, res) => {
  let { name, brand, ip, rtsp_port, onvif_port, username, password, rtsp_path, rtsp_url, rtsp_path_sub, rtsp_url_sub, ptz_supported, motion_detection_enabled, motion_sensitivity, motion_recording_enabled, location_id, building, is_relay } = req.body;
  // Sanitize before checking presence — a whitespace-only name (" ") is
  // truthy and would otherwise sail past `!name`, then come out of
  // sanitizeName() as '' and get stored as a nameless camera (and, via
  // resolveAutoLocation('') below, a nameless auto-created location too).
  name = name ? sanitizeName(name) : '';
  if (!name || !ip) return res.status(400).json({ error: 'name dan ip wajib diisi' });
  if (location_id && !locationExists(location_id)) return res.status(400).json({ error: 'Lokasi tidak ditemukan' });
  building = building ? sanitizeName(building) : null;

  const finalRtspUrl = rtsp_url || (rtsp_path
    ? `rtsp://${username ? `${encodeURIComponent(username)}:${encodeURIComponent(password || '')}@` : ''}${ip}:${rtsp_port || 554}${rtsp_path}`
    : null);
  // Sub stream is entirely optional — no rtsp_path_sub/rtsp_url_sub means
  // this camera just keeps using the main stream for the Live View grid,
  // same behavior as before sub streams existed.
  const finalRtspUrlSub = rtsp_url_sub || (rtsp_path_sub
    ? `rtsp://${username ? `${encodeURIComponent(username)}:${encodeURIComponent(password || '')}@` : ''}${ip}:${rtsp_port || 554}${rtsp_path_sub}`
    : null);

  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM cameras').get().m;
  const relayToken = is_relay ? generateRelayToken() : null;
  const autoLocation = location_id ? null : resolveAutoLocation(name);
  const finalLocationId = location_id || autoLocation.id;

  const info = db.prepare(`
    INSERT INTO cameras (name, brand, ip, rtsp_port, onvif_port, username, password, rtsp_path, rtsp_url, rtsp_path_sub, rtsp_url_sub, ptz_supported, motion_detection_enabled, motion_sensitivity, motion_recording_enabled, location_id, building, sort_order, is_relay, relay_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    rtsp_path_sub || null,
    encrypt(finalRtspUrlSub),
    ptz_supported ? 1 : 0,
    motion_detection_enabled ? 1 : 0,
    normalizeMotionSensitivity(motion_sensitivity),
    motion_recording_enabled ? 1 : 0,
    finalLocationId,
    building,
    maxOrder + 1,
    is_relay ? 1 : 0,
    relayToken
  );

  const camera = getCameraById(info.lastInsertRowid);
  motion.syncCamera(camera);
  logEvent(info.lastInsertRowid, 'camera_added', `Kamera "${name}" (${brand || 'unknown'}) ditambahkan`, req.user);
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
  const validRows = items.filter((row) => Number.isInteger(Number(row.id)) && Number.isInteger(Number(row.sort_order)));
  if (validRows.length === 0) {
    return res.status(400).json({ error: 'items tidak valid' });
  }
  const stmt = db.prepare('UPDATE cameras SET sort_order = ? WHERE id = ?');
  const applyAll = db.transaction((rows) => {
    for (const row of rows) stmt.run(Number(row.sort_order), Number(row.id));
  });
  applyAll(validRows);
  res.json({ ok: true, applied: validRows.length, skipped: items.length - validRows.length });
});

// Must be registered before /:id, same reason as /reorder above.
//
// Scoped deliberately to fields that make sense applied identically across
// many cameras at once (grouping + motion behavior) — connection details
// (IP, RTSP, credentials) are camera-specific and stay on the single-camera
// edit form; rebuilding rtsp_url/relay tokens per camera the way PUT /:id
// does wouldn't even mean anything applied to 50 different cameras at once.
router.put('/bulk', requireRole(['admin', 'operator']), (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids harus berupa array kamera yang tidak kosong' });
  }
  const numericIds = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n)))];
  if (numericIds.length === 0) return res.status(400).json({ error: 'ids tidak valid' });

  const fields = ['location_id', 'building', 'motion_detection_enabled', 'motion_sensitivity', 'motion_recording_enabled'];
  const updates = fields.filter((f) => f in req.body);
  if (updates.length === 0) return res.status(400).json({ error: 'Tidak ada field untuk diupdate' });

  if (updates.includes('building')) {
    req.body.building = req.body.building ? sanitizeName(req.body.building) : null;
  }
  if (updates.includes('location_id') && req.body.location_id && !locationExists(req.body.location_id)) {
    return res.status(400).json({ error: 'Lokasi tidak ditemukan' });
  }

  const setClause = updates.map((f) => `${f} = ?`).join(', ');
  const values = updates.map((f) => {
    if (f === 'motion_detection_enabled' || f === 'motion_recording_enabled') {
      // better-sqlite3 can't bind a JS boolean — see the matching note on
      // PUT /:id below.
      return req.body[f] ? 1 : 0;
    }
    if (f === 'motion_sensitivity') {
      return normalizeMotionSensitivity(req.body[f]);
    }
    return req.body[f];
  });

  const stmt = db.prepare(`UPDATE cameras SET ${setClause} WHERE id = ?`);
  const applyAll = db.transaction((camIds) => {
    let count = 0;
    for (const camId of camIds) {
      const info = stmt.run(...values, camId);
      if (info.changes > 0) count += 1;
    }
    return count;
  });
  const updatedCount = applyAll(numericIds);

  // Motion detector child processes need to be (re)started/stopped per
  // camera after the DB write, same as PUT /:id does for a single camera —
  // the settings column changing alone doesn't touch the running ffmpeg
  // process.
  const motionFieldsChanged = updates.includes('motion_detection_enabled') || updates.includes('motion_sensitivity') || updates.includes('motion_recording_enabled');
  if (motionFieldsChanged) {
    for (const camId of numericIds) {
      const cam = getCameraById(camId);
      if (cam) motion.syncCamera(cam);
    }
  }

  logEvent(null, 'cameras_bulk_updated', `${updatedCount} kamera diperbarui sekaligus (${updates.join(', ')})`, req.user);
  res.json({ ok: true, updated: updatedCount });
});

router.put('/:id', requireRole(['admin', 'operator']), (req, res) => {
  const id = Number(req.params.id);
  const cam = getCameraById(id);
  if (!cam) return res.status(404).json({ error: 'Kamera tidak ditemukan' });

  const fields = ['name', 'brand', 'ip', 'rtsp_port', 'onvif_port', 'username', 'password', 'rtsp_path', 'rtsp_url', 'rtsp_path_sub', 'rtsp_url_sub', 'ptz_supported', 'recording_enabled', 'motion_detection_enabled', 'motion_sensitivity', 'motion_recording_enabled', 'location_id', 'building', 'is_relay'];
  const updates = fields.filter(f => f in req.body);
  if (updates.length === 0) return res.status(400).json({ error: 'Tidak ada field untuk diupdate' });

  // Sanitize before checking presence — a whitespace-only name (" ") is
  // truthy, so without this a rename to " " would sail through and get
  // stored as an empty string (sanitizeName trims it to '').
  if (updates.includes('name')) {
    req.body.name = sanitizeName(req.body.name || '');
    if (!req.body.name) return res.status(400).json({ error: 'name tidak boleh kosong' });
  }
  if (updates.includes('location_id') && req.body.location_id && !locationExists(req.body.location_id)) {
    return res.status(400).json({ error: 'Lokasi tidak ditemukan' });
  }

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
      // .search must come along with .pathname — some cameras (notably many
      // Hikvision/Dahua ONVIF responses) put required parameters in the
      // query string (e.g. "?transportmode=unicast"); dropping it here would
      // silently rebuild a URL the camera no longer accepts.
      try {
        const u = new URL(cam.rtsp_url);
        path = u.pathname + u.search;
      } catch { /* not a parseable rtsp URL, skip */ }
    }
    if (path) {
      req.body.rtsp_url = `rtsp://${merged.username ? `${encodeURIComponent(merged.username)}:${encodeURIComponent(merged.password || '')}@` : ''}${merged.ip}:${merged.rtsp_port || 554}${path}`;
      updates.push('rtsp_url');
    }
  }

  // Same rebuild, mirrored for the sub stream — only when there's actually a
  // sub path on file (existing or newly-sent) to rebuild against. A camera
  // with no sub stream configured just has nothing to rebuild here.
  const rtspSubAffecting = ['ip', 'rtsp_port', 'username', 'password', 'rtsp_path_sub'];
  if (!('rtsp_url_sub' in req.body) && rtspSubAffecting.some(f => f in req.body)) {
    const mergedSub = {
      ip: req.body.ip ?? cam.ip,
      rtsp_port: req.body.rtsp_port ?? cam.rtsp_port,
      username: req.body.username ?? cam.username,
      password: 'password' in req.body ? req.body.password : cam.password,
      rtsp_path_sub: req.body.rtsp_path_sub ?? cam.rtsp_path_sub,
    };
    let pathSub = mergedSub.rtsp_path_sub;
    if (!pathSub && cam.rtsp_url_sub) {
      try {
        const u = new URL(cam.rtsp_url_sub);
        pathSub = u.pathname + u.search;
      } catch { /* not a parseable rtsp URL, skip */ }
    }
    if (pathSub) {
      req.body.rtsp_url_sub = `rtsp://${mergedSub.username ? `${encodeURIComponent(mergedSub.username)}:${encodeURIComponent(mergedSub.password || '')}@` : ''}${mergedSub.ip}:${mergedSub.rtsp_port || 554}${pathSub}`;
      updates.push('rtsp_url_sub');
    } else if ('rtsp_path_sub' in req.body && !req.body.rtsp_path_sub) {
      // Explicitly cleared the sub path with no existing sub URL to fall
      // back on — clear rtsp_url_sub too instead of leaving it stale.
      req.body.rtsp_url_sub = null;
      updates.push('rtsp_url_sub');
    }
  }

  const setClause = updates.map(f => `${f} = ?`).join(', ');
  const values = updates.map((f) => {
    if (f === 'motion_detection_enabled' || f === 'motion_recording_enabled' || f === 'is_relay' || f === 'ptz_supported' || f === 'recording_enabled') {
      // better-sqlite3 can't bind a JS boolean — without this coercion,
      // PUT {"ptz_supported": true} (the obvious way to send it, matching
      // how every other boolean field here is sent) throws and 500s instead
      // of storing 1/0.
      return req.body[f] ? 1 : 0;
    }
    if (f === 'motion_sensitivity') {
      return normalizeMotionSensitivity(req.body[f]);
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
    if (f === 'password' || f === 'rtsp_url' || f === 'rtsp_url_sub') {
      return encrypt(req.body[f]);
    }
    return req.body[f];
  });
  db.prepare(`UPDATE cameras SET ${setClause} WHERE id = ?`).run(...values, id);

  const updatedCam = getCameraById(id);
  motion.syncCamera(updatedCam);
  logEvent(id, 'camera_updated', `Kamera "${updatedCam.name}" diperbarui (${updates.join(', ')})`, req.user);
  res.json({ ok: true, relay_token: updatedCam.relay_token, is_relay: updatedCam.is_relay === 1 });
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  const cam = db.prepare('SELECT name FROM cameras WHERE id = ?').get(id);
  motion.stopDetector(id);
  // Force-stop and wait for both ffmpeg processes to actually exit before
  // touching their directories below — a bare SIGTERM (the old stopStream())
  // returns immediately, so the rmSync calls used to race the still-exiting
  // process for its open file handles (EBUSY/EPERM on Windows), leaving the
  // directory orphaned since the camera row is gone by the time anyone would
  // revisit it. Also, unlike stopStream(), this stops the stream outright
  // regardless of how many viewers currently have it open — correct here
  // since the camera itself is being deleted.
  await Promise.all([
    streaming.stopStreamAndWait(id),
    recording.stopRecordingAndWait(id),
  ]);
  // The `recordings` row cleanup is handled by ON DELETE CASCADE (now that
  // foreign_keys is enabled, db.js), but that only removes database rows —
  // the actual video files on disk have to be removed here explicitly, or
  // they'd sit orphaned forever (never revisited by reconcileAndCleanup,
  // which only walks directories for cameras still present in the table).
  try {
    fs.rmSync(recording.camDir(id), { recursive: true, force: true });
  } catch (err) {
    console.error(`[cameras] gagal menghapus folder rekaman kamera ${id}: ${err.message}`);
  }
  try {
    fs.rmSync(streaming.streamDirFor(id), { recursive: true, force: true });
  } catch (err) {
    console.error(`[cameras] gagal menghapus folder live stream kamera ${id}: ${err.message}`);
  }
  db.prepare('DELETE FROM cameras WHERE id = ?').run(id);
  logEvent(id, 'camera_deleted', `Kamera "${cam ? cam.name : `#${id}`}" dihapus`, req.user);
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
    // getProfiles/getVideoSources run automatically as part of connect()
    // above (populating this.profiles), but GetDeviceInformation does not —
    // it has to be called explicitly to get serialNumber/firmwareVersion.
    // Some cheaper cameras don't support it at all; ignore that failure and
    // keep going with whatever the RTSP-URI probe below still finds.
    this.getDeviceInformation(() => {
      this.getStreamUri({ protocol: 'RTSP' }, (err2, stream) => {
        if (responded) return;
        if (err2) {
          responded = true;
          return res.status(502).json({ error: `Gagal ambil stream URI: ${err2.message}` });
        }

        const ptzSupported = !!this.services?.ptz;
        // Fall back to whatever was already stored when a field isn't
        // reported (some cameras omit fields from GetDeviceInformation).
        const serialNumber = this.deviceInformation?.serialNumber || cam.serial_number || null;
        const firmwareVersion = this.deviceInformation?.firmwareVersion || cam.firmware_version || null;
        const channelCount = this.profiles?.length || cam.channel_count || 1;
        db.prepare('UPDATE cameras SET rtsp_url = ?, ptz_supported = ?, serial_number = ?, firmware_version = ?, channel_count = ? WHERE id = ?')
          .run(encrypt(stream.uri), ptzSupported ? 1 : 0, serialNumber, firmwareVersion, channelCount, id);

        const updatedCam = getCameraById(id);
        motion.syncCamera(updatedCam);
        logEvent(id, 'onvif_probe_ok', 'Berhasil mengambil stream URI via ONVIF', req.user);
        responded = true;
        res.json({
          rtsp_url: stream.uri,
          ptz_supported: ptzSupported,
          manufacturer: this.deviceInformation?.manufacturer,
          model: this.deviceInformation?.model,
          serial_number: serialNumber,
          firmware_version: firmwareVersion,
          channel_count: channelCount
        });
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
  // 'sub' = Live View grid tile (lightweight, camera's own low-res feed);
  // 'main' = focus/fullscreen view + recording (full quality). Anything
  // unrecognized falls back to 'main', same as before profiles existed.
  const profile = req.body?.profile === 'sub' ? 'sub' : 'main';
  const playlist = profile === 'sub' ? `/streams/${id}/sub/index.m3u8` : `/streams/${id}/index.m3u8`;
  if (cam.is_relay) {
    // Nothing to "start" centrally — the remote agent decides when to push.
    // Report whatever the current relay status already is.
    return res.json({ ok: true, playlist, relay: relay.getRelayStatus(id) });
  }
  // A camera with no sub stream configured just streams 'main' quality into
  // the grid too (streaming.js's rtspUrlFor already falls back to
  // rtsp_url when rtsp_url_sub is unset) — only a totally unconfigured
  // camera (no rtsp_url at all) is actually blocked here.
  if (!cam.rtsp_url) return res.status(400).json({ error: 'RTSP URL belum diatur untuk kamera ini' });

  streaming.startStream(cam, profile);
  res.json({ ok: true, playlist });
});

router.post('/:id/stream/stop', requireRole(['admin', 'operator', 'viewer']), (req, res) => {
  const id = Number(req.params.id);
  const cam = db.prepare('SELECT is_relay FROM cameras WHERE id = ?').get(id);
  if (cam?.is_relay) return res.json({ ok: true }); // agent-controlled; nothing local to stop
  const profile = req.body?.profile === 'sub' ? 'sub' : 'main';
  streaming.stopStream(id, profile);
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
