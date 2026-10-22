const nodemailer = require('nodemailer');
const settings = require('./settings');

// Camera name/IP are free-text fields an operator controls (cameras.js does
// no format validation on either) but end up interpolated straight into an
// HTML email body below — without this, a camera named e.g.
// `<a href="//evil">click</a>` would render as a live link/markup in
// whatever mail client the notification lands in.
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function isConfigured() {
  return settings.getSetting('smtp_enabled') === 'true'
    && !!settings.getSetting('smtp_host')
    && !!settings.getSetting('smtp_user')
    && !!settings.getSetting('smtp_pass')
    && !!settings.getSetting('notify_email_to');
}

// Built fresh per send (not cached) so a config change from the Pengaturan
// page takes effect on the very next email, no restart needed.
function buildTransporter() {
  const port = Number(settings.getSetting('smtp_port')) || 587;
  // Port 465 is implicit TLS — the socket is TLS from the first byte.
  // Everything else (587, the common Office 365/Gmail STARTTLS port; 25)
  // connects plain and upgrades via STARTTLS instead. Hardcoding `secure:
  // false` regardless of port made every provider on 465 fail the
  // handshake outright, with the failure never surfacing beyond a
  // console.error from sendMail()'s catch.
  const secure = port === 465;
  return nodemailer.createTransport({
    host: settings.getSetting('smtp_host'),
    port,
    secure,
    requireTLS: !secure,
    auth: { user: settings.getSetting('smtp_user'), pass: settings.getSetting('smtp_pass') },
  });
}

// Never throws — a notification failure (bad SMTP creds, network blip) must
// not take down whatever triggered it (the health-check loop).
async function sendMail(subject, html) {
  if (!isConfigured()) {
    console.log(`[notifications] SMTP belum dikonfigurasi/nonaktif, lewati: "${subject}"`);
    return false;
  }
  try {
    await buildTransporter().sendMail({
      from: settings.getSetting('smtp_user'),
      to: settings.getSetting('notify_email_to'),
      subject: `[${settings.getSetting('app_name') || 'Open VMS'}] ${subject}`,
      html,
    });
    return true;
  } catch (err) {
    console.error(`[notifications] Gagal kirim email "${subject}": ${err.message}`);
    return false;
  }
}

// Unlike sendMail(), this surfaces the real error message to the caller —
// used by the "Test kirim email" button in Pengaturan, where a vague
// swallowed failure would be useless for debugging SMTP settings.
async function sendTestEmail() {
  if (!isConfigured()) {
    throw new Error('Lengkapi dulu semua field SMTP dan simpan pengaturannya sebelum test.');
  }
  await buildTransporter().sendMail({
    from: settings.getSetting('smtp_user'),
    to: settings.getSetting('notify_email_to'),
    subject: `[${settings.getSetting('app_name') || 'Open VMS'}] Test notifikasi email`,
    html: `<p>Ini email test dari halaman Pengaturan. Kalau kamu menerima ini, konfigurasi SMTP sudah benar.</p>
           <p>Dikirim pada ${new Date().toLocaleString('id-ID')}.</p>`,
  });
}

function sendCameraOfflineAlert(camera) {
  return sendMail(
    `Kamera offline: ${camera.name}`,
    `<p>Kamera <b>${escapeHtml(camera.name)}</b> (IP: ${escapeHtml(camera.ip)}) tidak bisa dijangkau sejak ${new Date().toLocaleString('id-ID')}.</p>
     <p>Cek koneksi jaringan, status perangkat, atau kredensial kamera ini.</p>`
  );
}

function sendCameraRecoveredAlert(camera) {
  return sendMail(
    `Kamera kembali online: ${camera.name}`,
    `<p>Kamera <b>${escapeHtml(camera.name)}</b> (IP: ${escapeHtml(camera.ip)}) sudah bisa dijangkau lagi per ${new Date().toLocaleString('id-ID')}.</p>`
  );
}

module.exports = { isConfigured, sendMail, sendTestEmail, sendCameraOfflineAlert, sendCameraRecoveredAlert };
