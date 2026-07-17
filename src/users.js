const express = require('express');
const bcrypt = require('bcryptjs');
const { db, logEvent } = require('./db');
const router = express.Router();

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
  logEvent(null, 'user_created', `User ${username} dibuat dengan role ${role}`);
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
    updates.push('role = ?');
    values.push(role);
  }
  if (!updates.length) return res.status(400).json({ error: 'Tidak ada perubahan' });

  values.push(id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  logEvent(null, 'user_updated', `User ${user.username} diperbarui`);
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  logEvent(null, 'user_deleted', `User ${user.username} dihapus`);
  res.json({ ok: true });
});

module.exports = router;