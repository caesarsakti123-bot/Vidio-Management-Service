const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { db, logEvent } = require('./db');

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

function login(req, res) {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    // No actor to attach (the credentials never resolved to a real user) —
    // the attempted username lives in the message instead, still useful for
    // spotting brute-force attempts in the activity log.
    logEvent(null, 'user_login_failed', `Percobaan login gagal untuk username "${username || ''}"`);
    return res.status(401).json({ error: 'Username atau password salah' });
  }
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, SECRET, { expiresIn: '12h' });
  logEvent(null, 'user_login', `User "${user.username}" login`, { id: user.id, username: user.username });
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
}

function logout(req, res) {
  logEvent(null, 'user_logout', `User "${req.user.username}" logout`, req.user);
  res.json({ ok: true });
}

// Self-service password change — deliberately its own endpoint rather than
// reusing PUT /api/users/:id (which is admin-only, see index.js) so every
// role can change their *own* password without needing admin rights, while
// still never letting the request body specify which user's password to
// change (req.user.id from the verified JWT is the only source of that,
// closing off the obvious IDOR of passing someone else's id).
function changeOwnPassword(req, res) {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Password saat ini dan password baru wajib diisi' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'Password baru minimal 8 karakter' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });
  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(401).json({ error: 'Password saat ini salah' });
  }
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
  logEvent(null, 'user_password_changed', `User "${user.username}" mengubah password sendiri`, req.user);
  res.json({ ok: true });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  // Native <video>/<a> elements can't set an Authorization header, so allow
  // the same JWT via ?token= as a fallback for streaming/downloading media.
  // The header path still takes priority for normal fetch()-based API calls.
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query.token || null);
  if (!token) return res.status(401).json({ error: 'Token tidak ditemukan' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token tidak valid atau kedaluwarsa' });
  }
}

function requireRole(roles) {
  const allowedRoles = Array.isArray(roles) ? roles : [roles];
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Akses ditolak' });
    }
    next();
  };
}

module.exports = { login, logout, changeOwnPassword, requireAuth, requireRole };
