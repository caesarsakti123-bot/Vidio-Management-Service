const crypto = require('crypto');

// Camera passwords and RTSP URLs (which embed the same password) are the
// most sensitive data this app stores — used to be plaintext in SQLite.
// AES-256-GCM: random IV per value, auth tag prevents tampering.
const ALGO = 'aes-256-gcm';
const PREFIX = 'enc:v1:';

function getKey() {
  const hex = process.env.CAMERA_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('CAMERA_ENCRYPTION_KEY tidak diatur atau tidak valid (harus 64 karakter hex / 32 byte) di .env');
  }
  return Buffer.from(hex, 'hex');
}

function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return PREFIX + [iv, authTag, ciphertext].map((b) => b.toString('base64')).join(':');
}

function decrypt(value) {
  if (value === null || value === undefined || value === '') return value;
  if (!value.startsWith(PREFIX)) return value; // not encrypted (legacy row, or plain value)
  // Missing/invalid CAMERA_ENCRYPTION_KEY is a fatal config error, same as
  // encrypt() — let it throw uncaught, outside the try/catch below, so a
  // genuinely broken setup still fails loudly and immediately instead of
  // being muted into the same "corrupted value" handling as the much more
  // local problem that catch exists for.
  const key = getKey();
  try {
    const [ivB64, tagB64, dataB64] = value.slice(PREFIX.length).split(':');
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
    return plaintext.toString('utf8');
  } catch (err) {
    // A malformed/truncated ciphertext for this one value (a corrupted row,
    // or a legacy plaintext value that happens to start with the same
    // "enc:v1:" prefix and gets misparsed as encrypted) used to throw
    // straight out of here uncaught. Every caller already treats an empty
    // credential field as "not configured", so failing closed to '' here is
    // safe — and still loud via the log line — instead of crashing whatever
    // request triggered it (some call this before their first `await`,
    // turning the throw into a request Express never responds to at all).
    console.error(`[crypto] Gagal dekripsi nilai (data rusak): ${err.message}`);
    return '';
  }
}

module.exports = { encrypt, decrypt };
