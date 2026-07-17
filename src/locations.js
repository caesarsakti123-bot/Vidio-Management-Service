const express = require('express');
const { db, logEvent } = require('./db');
const { requireRole } = require('./auth');
const router = express.Router();

// Pasting adjacent spreadsheet cells into a single text field can insert a
// literal tab between them — normalize whatever arrives into a clean name.
function sanitizeName(name) {
  return name.replace(/\s+/g, ' ').trim();
}

router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT l.*, (SELECT COUNT(*) FROM cameras c WHERE c.location_id = l.id) AS camera_count
    FROM locations l
    ORDER BY l.name
  `).all();
  res.json(rows);
});

router.post('/', requireRole(['admin', 'operator']), (req, res) => {
  const { name, address, lat, lng } = req.body;
  if (!name || lat === undefined || lng === undefined || lat === '' || lng === '') {
    return res.status(400).json({ error: 'name, lat, dan lng wajib diisi' });
  }
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (Number.isNaN(latNum) || Number.isNaN(lngNum)) {
    return res.status(400).json({ error: 'lat/lng harus berupa angka' });
  }

  const info = db.prepare('INSERT INTO locations (name, address, lat, lng) VALUES (?, ?, ?, ?)')
    .run(sanitizeName(name), address || null, latNum, lngNum);
  logEvent(null, 'location_added', `Lokasi "${name}" ditambahkan`);
  res.status(201).json({ id: info.lastInsertRowid });
});

router.put('/:id', requireRole(['admin', 'operator']), (req, res) => {
  const id = Number(req.params.id);
  const loc = db.prepare('SELECT * FROM locations WHERE id = ?').get(id);
  if (!loc) return res.status(404).json({ error: 'Lokasi tidak ditemukan' });

  const { name, address, lat, lng } = req.body;
  const latNum = lat !== undefined && lat !== '' ? Number(lat) : loc.lat;
  const lngNum = lng !== undefined && lng !== '' ? Number(lng) : loc.lng;
  if (Number.isNaN(latNum) || Number.isNaN(lngNum)) {
    return res.status(400).json({ error: 'lat/lng harus berupa angka' });
  }

  db.prepare('UPDATE locations SET name = ?, address = ?, lat = ?, lng = ? WHERE id = ?')
    .run(name ? sanitizeName(name) : loc.name, address !== undefined ? address : loc.address, latNum, lngNum, id);
  logEvent(null, 'location_updated', `Lokasi "${loc.name}" diperbarui`);
  res.json({ ok: true });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const loc = db.prepare('SELECT * FROM locations WHERE id = ?').get(id);
  if (!loc) return res.status(404).json({ error: 'Lokasi tidak ditemukan' });

  db.prepare('UPDATE cameras SET location_id = NULL WHERE location_id = ?').run(id);
  db.prepare('DELETE FROM locations WHERE id = ?').run(id);
  logEvent(null, 'location_deleted', `Lokasi "${loc.name}" dihapus`);
  res.json({ ok: true });
});

module.exports = router;
