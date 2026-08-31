const express = require('express');
const bcrypt = require('bcryptjs');
const { db, logEvent } = require('./db');
const router = express.Router();

function countOtherAdmins(excludeId) {
  return db.prepare('SELECT COUNT(*) AS n FROM users WHERE role = ? AND id != ?').get('admin', excludeId).n;
}

router.get('/', (req, res) => {
  const users = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id').all();
  res.json(users);
});

router.post('/', (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password || !role) return res.status(400).json({ error: 'username, password, role wajib diisi' });
  if (!['admin', 'operator', 'viewer'].includes(role)) return res.status(400).json({ error: 'role tidak valid' });

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(400).json({ error: 'Username sudah digunakan' });

  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, hash, role);
  logEvent(null, 'user_created', `User ${username} dibuat dengan role ${role}`, req.user);
  res.status(201).json({ id: info.lastInsertRowid });
});

router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const { password, role } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });
  const updates = [];
  const values = [];

  if (password) {
    updates.push('password_hash = ?');
    values.push(bcrypt.hashSync(password, 10));
  }
  if (role) {
    if (!['admin', 'operator', 'viewer'].includes(role)) return res.status(400).json({ error: 'role tidak valid' });
    if (user.role === 'admin' && role !== 'admin' && countOtherAdmins(id) === 0) {
      return res.status(400).json({ error: 'Tidak bisa menurunkan role admin terakhir' });
    }
    updates.push('role = ?');
    values.push(role);
  }
  if (!updates.length) return res.status(400).json({ error: 'Tidak ada perubahan' });

  values.push(id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  logEvent(null, 'user_updated', `User ${user.username} diperbarui`, req.user);
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT username, role FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });
  if (user.role === 'admin' && countOtherAdmins(id) === 0) {
    return res.status(400).json({ error: 'Tidak bisa menghapus admin terakhir' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  logEvent(null, 'user_deleted', `User ${user.username} dihapus`, req.user);
  res.json({ ok: true });
});

// Audit trail of who-did-what: only actor-attributed events (deliberate user
// actions — CRUD, settings, login) plus failed-login attempts, which have no
// actor since the credentials never resolved to a real session. Deliberately
// excludes the high-volume system events already covered by "Log peristiwa"
// (stream reconnects, health checks, motion triggers) so the signal here
// stays readable.
router.get('/activity', (req, res) => {
  const userId = req.query.user_id ? Number(req.query.user_id) : null;
  const conditions = [`(actor_id IS NOT NULL OR type = 'user_login_failed')`];
  const params = [];

  // Custom from/to range (sent as "YYYY-MM-DD HH:MM:SS" UTC, same shape as
  // created_at) takes priority over the quick "last N days" chips — the
  // frontend only sends one or the other, never both.
  const from = req.query.from ? String(req.query.from) : '';
  const to = req.query.to ? String(req.query.to) : '';
  if (from || to) {
    if (from) { conditions.push('created_at >= ?'); params.push(from); }
    if (to) { conditions.push('created_at <= ?'); params.push(to); }
  } else {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
    conditions.push(`created_at >= datetime('now', ?)`);
    params.push(`-${days} days`);
  }

  if (userId) {
    conditions.push('actor_id = ?');
    params.push(userId);
  }
  const rows = db.prepare(`
    SELECT id, type, message, actor_id, actor_username, created_at
    FROM events
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at DESC
    LIMIT 300
  `).all(...params);
  res.json({ rows });
});

module.exports = router;