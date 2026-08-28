const state = {
  token: localStorage.getItem('vms_token') || null,
  user: JSON.parse(localStorage.getItem('vms_user') || '{}'),
  cameras: [],
  players: new Map(), // cameraId -> Hls instance
  pagedOutVideos: new Map(), // cameraId -> detached <video> node kept alive (network paused) while its tile is off the current layout page
  pagedOutStopTimers: new Map(), // cameraId -> setTimeout handle; fires the actual server-side stream/stop once a paged-out camera has stayed off-page longer than PAGE_OUT_STOP_DELAY_MS
  pollTimer: null,
  layout: localStorage.getItem('vms_layout') || 'auto',
  layoutPage: 0,
  spotlightMainId: null,
  alertPollTimer: null,
  locations: [],
  locationFilter: null,
  buildingFilter: null, // { locationId, building } | null
  treeExpanded: new Set(),
  statusFilter: null, // null | 'active' | 'inactive'
  capabilityFilter: null, // null | 'ptz' | 'motion' | 'recording' | 'relay'
  favoriteFilter: false,
  cameraSearch: '',
  deviceSearch: '',
  devicePage: 0,
  devicePageSize: 50,
  healthTrendDays: 7,
  bulkSelectMode: false,
  bulkSelectedIds: new Set(),
  eventsChartDays: 14,
  activityDays: 7,
  activityUserFilter: '',
  systemHealthTimer: null,
  systemStatusTimer: null,
  currentRecording: null, // { id, filename, cameraLabel } for whatever's open in the player modal
};

const $ = (sel) => document.querySelector(sel);
const api = async (path, opts = {}) => {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
};

// ---- Theme (light/dark) ----
// The actual flip on page load happens in an inline <script> in index.html
// (runs before first paint, avoids a flash of the wrong theme) — this just
// wires the toggle button and keeps its icon/label in sync afterwards.

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('vms_theme', theme);
  const btn = $('#theme-toggle-btn');
  if (btn) {
    btn.querySelector('.theme-icon-sun')?.classList.toggle('hidden', theme === 'light');
    btn.querySelector('.theme-icon-moon')?.classList.toggle('hidden', theme !== 'light');
    btn.title = theme === 'light' ? 'Ganti ke mode gelap' : 'Ganti ke mode terang';
  }
}

$('#theme-toggle-btn')?.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  applyTheme(current === 'light' ? 'dark' : 'light');
});

applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');

// ---- Toast notifications (replaces alert()) ----

const TOAST_ICON = {
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg>',
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></svg>',
};

function showToast(message, type = 'error', duration = 5000) {
  const container = $('#toast-container');
  if (!container) { console.error(message); return; }
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${TOAST_ICON[type] || TOAST_ICON.info}</span>
    <span class="toast-message"></span>
    <button type="button" class="toast-close" aria-label="Tutup"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
  `;
  // Textual content set via .textContent (not the innerHTML template above)
  // so server/error strings can never be interpreted as markup.
  toast.querySelector('.toast-message').textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  let dismissTimer = setTimeout(() => dismiss(), duration);
  function dismiss() {
    clearTimeout(dismissTimer);
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 200);
  }
  toast.querySelector('.toast-close').addEventListener('click', dismiss);
}

// ---- Confirm modal (replaces confirm()) ----

function showConfirm(message, { title = 'Konfirmasi', danger = true, confirmLabel = 'Ya, lanjutkan', cancelLabel = 'Batal' } = {}) {
  return new Promise((resolve) => {
    const modal = $('#confirm-modal');
    $('#confirm-modal-title').textContent = title;
    $('#confirm-modal-message').textContent = message;
    const confirmBtn = $('#confirm-modal-confirm-btn');
    const cancelBtn = $('#confirm-modal-cancel-btn');
    confirmBtn.textContent = confirmLabel;
    confirmBtn.className = danger ? 'btn danger' : 'btn';
    cancelBtn.textContent = cancelLabel;
    modal.classList.remove('hidden');

    function settle(result) {
      modal.classList.add('hidden');
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onOverlayClick);
      document.removeEventListener('keydown', onKeydown);
      resolve(result);
    }
    function onConfirm() { settle(true); }
    function onCancel() { settle(false); }
    function onOverlayClick(e) { if (e.target === modal) settle(false); }
    function onKeydown(e) { if (e.key === 'Escape') settle(false); }

    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKeydown);
  });
}

// ---- Relay agent command (replaces prompt()) ----

function showRelayCommand(cameraName, command) {
  $('#relay-command-intro').textContent = `Perintah agen untuk "${cameraName}" — jalankan ini di PC pada jaringan lokal kamera:`;
  $('#relay-command-value').textContent = command;
  $('#relay-command-modal').classList.remove('hidden');
}
$('#relay-command-close-btn')?.addEventListener('click', () => $('#relay-command-modal').classList.add('hidden'));
$('#relay-command-modal')?.addEventListener('click', (e) => { if (e.target.id === 'relay-command-modal') $('#relay-command-modal').classList.add('hidden'); });
$('#relay-command-copy-btn')?.addEventListener('click', () => {
  navigator.clipboard?.writeText($('#relay-command-value').textContent);
  const btn = $('#relay-command-copy-btn');
  const original = btn.textContent;
  btn.textContent = 'Tersalin!';
  setTimeout(() => { btn.textContent = original; }, 1500);
});

// ---- Auth ----

$('#login-btn').addEventListener('click', async () => {
  const username = $('#login-username').value.trim();
  const password = $('#login-password').value;
  $('#login-error').textContent = '';
  try {
    const data = await api('/auth/login', { method: 'POST', body: { username, password } });
    state.token = data.token;
    state.user = data.user;
    localStorage.setItem('vms_token', data.token);
    localStorage.setItem('vms_user', JSON.stringify(data.user));
    enterApp();
  } catch (e) {
    $('#login-error').textContent = e.message;
  }
});

function enterApp() {
  $('#login-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  state.user = JSON.parse(localStorage.getItem('vms_user') || '{}');
  $('#whoami').textContent = state.user.username ? `Masuk sebagai ${state.user.username} (${state.user.role})` : '';
  renderNavForRole();
  loadLocations();
  loadCameras();
  loadRecordings();
  loadEvents();
  loadDashboard();
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(loadCameras, 15000);
  refreshAlertBadge();
  if (state.alertPollTimer) clearInterval(state.alertPollTimer);
  state.alertPollTimer = setInterval(refreshAlertBadge, 20000);
  loadSystemStatus();
  if (state.systemStatusTimer) clearInterval(state.systemStatusTimer);
  state.systemStatusTimer = setInterval(loadSystemStatus, 15000);
  resetIdleLogoutTimer();
}

function logout() {
  // Best-effort audit entry — logout should still proceed locally even if
  // this request fails (token expired, network down, etc.).
  if (state.token) {
    fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${state.token}` } }).catch(() => {});
  }
  stopIdleLogoutTimer();
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
  if (state.alertPollTimer) clearInterval(state.alertPollTimer);
  state.alertPollTimer = null;
  if (state.systemHealthTimer) clearInterval(state.systemHealthTimer);
  state.systemHealthTimer = null;
  if (state.systemStatusTimer) clearInterval(state.systemStatusTimer);
  state.systemStatusTimer = null;
  setThrottleBanner(false);
  clearAllPagedOutStopTimers();
  for (const id of state.players.keys()) stopPlayer(id);
  state.token = null;
  state.user = {};
  state.cameras = [];
  localStorage.removeItem('vms_token');
  localStorage.removeItem('vms_user');
  $('#login-username').value = '';
  $('#login-password').value = '';
  $('#login-error').textContent = '';
  $('#app').classList.add('hidden');
  $('#login-screen').classList.remove('hidden');
}

$('#logout-btn').addEventListener('click', logout);

// ---- Idle auto-logout ----
// A live-view wall is meant to be left open unattended showing video (see
// the reconnect-forever comments elsewhere in this file) — but an
// unattended *logged-in* session is this app's biggest single exposure
// (camera credentials, RTSP URLs, user management, settings all sit behind
// just this one token). Log out automatically after this long with zero
// user interaction, same as any banking/admin-panel session timeout.
// Admins can reach user management/settings/credentials, so they get a
// tighter window; operators/viewers are mostly just watching the live-view
// wall, so a short timeout would log out exactly the people meant to be
// able to leave it open.
const IDLE_LOGOUT_MS_BY_ROLE = {
  admin: 10 * 60 * 1000,
  operator: 60 * 60 * 1000,
  viewer: 60 * 60 * 1000,
};
const IDLE_LOGOUT_MS_DEFAULT = IDLE_LOGOUT_MS_BY_ROLE.operator;
let idleLogoutTimer = null;

function resetIdleLogoutTimer() {
  if (!state.token) return;
  clearTimeout(idleLogoutTimer);
  const ms = IDLE_LOGOUT_MS_BY_ROLE[state.user.role] ?? IDLE_LOGOUT_MS_DEFAULT;
  idleLogoutTimer = setTimeout(() => {
    logout();
    showToast(`Sesi berakhir karena tidak ada aktivitas selama ${Math.round(ms / 60000)} menit.`, 'info');
  }, ms);
}
function stopIdleLogoutTimer() {
  clearTimeout(idleLogoutTimer);
  idleLogoutTimer = null;
}
// capture: true so this still counts as activity even if some inner handler
// calls stopPropagation() on its way up — a scroll/click inside a modal
// should reset the timer just as much as one on the sidebar.
['mousedown', 'mousemove', 'keydown', 'wheel', 'scroll', 'touchstart'].forEach((evt) => {
  document.addEventListener(evt, resetIdleLogoutTimer, { passive: true, capture: true });
});

// ---- "Pengaturan" footer menu (Ganti Password / SOP / Tentang Aplikasi) ----
// Collapsed behind one toggle instead of three permanently-stacked buttons —
// they're occasional actions, not something worth taking sidebar space for
// on every screen.

function closeFooterSettingsMenu() {
  $('#footer-settings-btn')?.classList.remove('open');
  $('#footer-settings-menu')?.classList.add('hidden');
}
$('#footer-settings-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('#footer-settings-menu');
  if (!menu) return;
  const opening = menu.classList.contains('hidden');
  if (opening) {
    $('#footer-settings-btn').classList.add('open');
    menu.classList.remove('hidden');
  } else {
    closeFooterSettingsMenu();
  }
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#footer-settings-menu') && !e.target.closest('#footer-settings-btn')) closeFooterSettingsMenu();
});

// ---- Ganti Password (self-service, semua peran) ----

$('#change-password-btn')?.addEventListener('click', () => {
  closeFooterSettingsMenu();
  closeDrawer(); // no-op on desktop; on mobile, leaving the drawer open behind this modal looked like two screens stacked on top of each other
  $('#cp-current-password').value = '';
  $('#cp-new-password').value = '';
  $('#cp-confirm-password').value = '';
  const msg = $('#cp-form-msg');
  msg.textContent = '';
  msg.className = 'form-msg';
  $('#change-password-modal').classList.remove('hidden');
});
$('#cp-cancel-btn')?.addEventListener('click', () => $('#change-password-modal').classList.add('hidden'));

$('#cp-save-btn')?.addEventListener('click', async () => {
  const msg = $('#cp-form-msg');
  msg.textContent = '';
  msg.className = 'form-msg';

  const current = $('#cp-current-password').value;
  const next = $('#cp-new-password').value;
  const confirm = $('#cp-confirm-password').value;
  if (!current || !next) {
    msg.textContent = 'Password saat ini dan password baru wajib diisi.';
    msg.classList.add('error');
    return;
  }
  if (next.length < 8) {
    msg.textContent = 'Password baru minimal 8 karakter.';
    msg.classList.add('error');
    return;
  }
  if (next !== confirm) {
    msg.textContent = 'Konfirmasi password baru tidak cocok.';
    msg.classList.add('error');
    return;
  }

  try {
    await api('/auth/change-password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
    msg.textContent = 'Password berhasil diubah.';
    msg.classList.add('ok');
    setTimeout(() => $('#change-password-modal').classList.add('hidden'), 900);
  } catch (e) {
    msg.textContent = e.message;
    msg.classList.add('error');
  }
});

function renderNavForRole() {
  $('#add-camera-btn').style.display = state.user.role === 'viewer' ? 'none' : 'inline-block';
  $('#bulk-select-toggle-btn').style.display = state.user.role === 'viewer' ? 'none' : 'inline-flex';
  document.querySelectorAll('.nav-item[data-view="users"], .nav-item[data-view="activity"]').forEach((item) => {
    item.style.display = state.user.role === 'admin' ? 'block' : 'none';
  });
  // "Perangkat" used to be its own nav item, hidden entirely from viewers
  // (serial numbers/firmware/password strength are admin+operator info).
  // It's now the default sub-tab inside the merged "Perangkat" nav item
  // (see index.html #map-sub-tabs) — same access restriction, just applied
  // to the sub-tab button instead of a whole nav item. A viewer who was
  // sitting on it (or whose session defaults there) gets bounced to
  // "Daftar Lokasi", which — like the map itself — stays open to every role.
  const isViewer = state.user.role === 'viewer';
  const devicesSubTab = $('.sub-tab[data-subtab="devices"]');
  if (devicesSubTab) devicesSubTab.style.display = isViewer ? 'none' : '';
  if (isViewer && mapSubTab === 'devices') activateMapSubTab('list');
  // Same story for "Kesehatan Server" — used to be its own admin-only nav
  // item, now the last sub-tab inside "Device & Server" (see
  // index.html #devsrv-sub-tabs). Non-admins sitting on it get bounced to
  // "Rekaman" (the default), same reasoning as the devices bounce above.
  const isAdmin = state.user.role === 'admin';
  const systemSubTab = $('.sub-tab[data-subtab="system"]');
  if (systemSubTab) systemSubTab.style.display = isAdmin ? '' : 'none';
  if (!isAdmin && devsrvSubTab === 'system') activateDevSrvSubTab('recordings');
  // "Pengaturan Sistem" moved from the main nav into the footer's
  // "Pengaturan" menu (see index.html) — it isn't a .nav-item anymore, so
  // it needs its own visibility toggle here instead of riding the selector
  // above.
  const settingsLink = $('#settings-page-link');
  if (settingsLink) settingsLink.style.display = state.user.role === 'admin' ? 'inline-flex' : 'none';
}

// ---- Branding (app name / logo) ----

function applyBranding(data) {
  if (!data) return;
  const name = data.app_name || 'Open VMS';
  const nameEls = [$('#sidebar-app-name'), $('#login-app-name')];
  nameEls.forEach((el) => { if (el) el.textContent = name; });
  document.title = `${name} — Unified Video Management`;

  if (data.logo_path) {
    const imgHtml = `<img src="${escapeHtml(data.logo_path)}" alt="${escapeHtml(name)}" />`;
    const sidebarMark = $('#sidebar-brand-mark');
    const loginLogo = $('#login-logo');
    if (sidebarMark) sidebarMark.innerHTML = imgHtml;
    if (loginLogo) loginLogo.innerHTML = imgHtml;
  }
}

async function loadBranding() {
  try {
    const res = await fetch('/api/branding');
    applyBranding(await res.json());
  } catch (e) { console.error(e); }
}
loadBranding();

let usersCache = [];

async function loadUsers() {
  try {
    usersCache = await api('/users');
    // A user added/removed here must show up in the Activity tab's user
    // filter next time it's opened — without this, activityUsersPopulated
    // staying true (it's only ever set, never cleared) means
    // populateActivityUserFilter() keeps skipping the refresh forever,
    // even though usersCache itself is current.
    activityUsersPopulated = false;
    const tbody = $('#users-table');
    if (!tbody) return;
    tbody.innerHTML = usersCache.map((user) => `
      <tr>
        <td>${escapeHtml(user.username)}</td>
        <td><span class="role-badge ${escapeHtml(user.role)}">${escapeHtml(user.role)}</span></td>
        <td>${new Date(user.created_at).toLocaleString('id-ID')}</td>
        <td class="row-actions">
          <button data-user-action="edit" data-id="${user.id}">Edit</button>
          ${user.id !== state.user.id ? `<button class="danger" data-user-action="delete" data-id="${user.id}">Hapus</button>` : ''}
        </td>
      </tr>
    `).join('') || '<tr><td colspan="4" style="color:var(--text-dim)">Belum ada user</td></tr>';

    tbody.querySelectorAll('[data-user-action]').forEach((btn) => {
      btn.addEventListener('click', () => handleUserAction(btn.dataset.userAction, Number(btn.dataset.id)));
    });
  } catch (e) {
    console.error(e);
  }
}

// ---- Aktivitas Pengguna (audit trail: who did what) ----

let activityUsersPopulated = false;

async function populateActivityUserFilter() {
  if (activityUsersPopulated && usersCache.length) return;
  try {
    if (!usersCache.length) usersCache = await api('/users');
    const select = $('#activity-user-filter');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">Semua User</option>' + usersCache
      .map((u) => `<option value="${u.id}">${escapeHtml(u.username)}</option>`)
      .join('');
    select.value = current;
    activityUsersPopulated = true;
  } catch (e) { console.error(e); }
}

async function loadUserActivity(days) {
  state.activityDays = days;
  document.querySelectorAll('#activity-range-picker .chip').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.days) === days);
  });
  await populateActivityUserFilter();
  try {
    const qs = new URLSearchParams({ days });
    if (state.activityUserFilter) qs.set('user_id', state.activityUserFilter);
    const data = await api(`/users/activity?${qs.toString()}`);
    renderActivityTable(data.rows || []);
  } catch (e) {
    console.error(e);
  }
}

// SQLite's CURRENT_TIMESTAMP (used for events.created_at) stores a
// space-separated UTC string with no zone suffix ("2026-08-10 07:00:00").
// `new Date(...)` on that exact shape is read as local time by the browser
// instead of UTC, so an admin in WIB would see every activity-log entry
// timestamped 7 hours later than it actually happened — force it into a
// spec-compliant UTC string first, same fix already applied to the events
// chart's day labels (see eventsChartDayLabel below).
function parseServerDate(str) {
  return new Date(`${str}`.replace(' ', 'T') + 'Z');
}

function renderActivityTable(rows) {
  const tbody = $('#activity-tbody');
  if (!tbody) return;
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="color:var(--text-dim)">Belum ada aktivitas untuk filter ini.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((r) => {
    const meta = EVENT_META[r.type] || { label: r.type, tone: 'neutral' };
    const actorHtml = r.actor_username
      ? `<span class="activity-user-name">${escapeHtml(r.actor_username)}</span>`
      : `<span class="activity-system-actor">tidak dikenal</span>`;
    return `
      <tr>
        <td>${parseServerDate(r.created_at).toLocaleString('id-ID')}</td>
        <td class="activity-user-cell">${actorHtml}</td>
        <td><span class="tone-badge tone-${meta.tone}">${escapeHtml(meta.label)}</span></td>
        <td>${escapeHtml(r.message || '')}</td>
      </tr>
    `;
  }).join('');
}

$('#activity-range-picker')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  loadUserActivity(Number(btn.dataset.days));
});

$('#activity-user-filter')?.addEventListener('change', (e) => {
  state.activityUserFilter = e.target.value;
  loadUserActivity(state.activityDays);
});

let editingUserId = null;

function openUserModal(user) {
  editingUserId = user ? user.id : null;
  $('#user-modal-title').textContent = user ? `Edit user: ${user.username}` : 'Tambah user';
  $('#user-username').value = user ? user.username : '';
  $('#user-username').disabled = !!user;
  $('#user-password').value = '';
  $('#user-password-label').textContent = user ? 'Password baru (kosongkan jika tidak diubah)' : 'Password';
  $('#user-role').value = user ? user.role : 'viewer';
  $('#user-form-msg').textContent = '';
  $('#user-form-msg').className = 'form-msg';
  $('#user-modal').classList.remove('hidden');
}

function closeUserModal() {
  $('#user-modal').classList.add('hidden');
  editingUserId = null;
}

async function handleUserAction(action, id) {
  const user = usersCache.find((u) => u.id === id);
  if (!user) return;
  if (action === 'edit') {
    openUserModal(user);
  } else if (action === 'delete') {
    if (!(await showConfirm(`Hapus user "${user.username}"?`, { title: 'Hapus User' }))) return;
    try {
      await api(`/users/${id}`, { method: 'DELETE' });
      await loadUsers();
    } catch (e) {
      showToast(e.message);
    }
  }
}

$('#add-user-btn')?.addEventListener('click', () => openUserModal(null));
$('#user-cancel-btn').addEventListener('click', closeUserModal);

$('#user-save-btn').addEventListener('click', async () => {
  const msg = $('#user-form-msg');
  msg.className = 'form-msg';
  msg.textContent = '';
  const username = $('#user-username').value.trim();
  const password = $('#user-password').value;
  const role = $('#user-role').value;

  try {
    if (editingUserId) {
      const body = { role };
      if (password) body.password = password;
      await api(`/users/${editingUserId}`, { method: 'PUT', body });
    } else {
      if (!username || !password) throw new Error('Username dan password wajib diisi');
      await api('/users', { method: 'POST', body: { username, password, role } });
    }
    msg.textContent = 'User tersimpan';
    msg.classList.add('ok');
    setTimeout(() => {
      closeUserModal();
      loadUsers();
    }, 500);
  } catch (e) {
    msg.textContent = e.message;
    msg.classList.add('error');
  }
});

if (state.token) enterApp();

// ---- Navigation ----

const ALL_VIEWS = ['dashboard', 'live', 'map', 'devsrv', 'users', 'activity', 'settings', 'sop'];

function showView(viewName) {
  ALL_VIEWS.forEach((v) => {
    $(`#view-${v}`)?.classList.toggle('hidden', v !== viewName);
  });
  $('#nav-live-location')?.classList.toggle('hidden', viewName !== 'live');
  closeLocationDropdown(); // irrelevant/stale once we've left (or re-entered) Live view
  closeDrawer(); // no-op on desktop; on mobile the sidebar is an off-canvas drawer
}

// Only poll server CPU/RAM while the "Kesehatan Server" sub-tab is actually
// visible. Called both when leaving the "Device & Server" nav item entirely
// and when switching sub-tabs within it (see activateDevSrvSubTab) — the
// nav-item click handler alone can't cover the latter, since sub-tab clicks
// don't go through it.
function stopSystemHealthPolling() {
  if (state.systemHealthTimer) { clearInterval(state.systemHealthTimer); state.systemHealthTimer = null; }
}

document.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((i) => i.classList.remove('active'));
    item.classList.add('active');
    showView(item.dataset.view);
    if (item.dataset.view === 'dashboard') loadDashboard();
    if (item.dataset.view === 'users') loadUsers();
    if (item.dataset.view === 'activity') loadUserActivity(state.activityDays || 7);
    // "Perangkat" (devices) is now the default sub-tab inside this same nav
    // item (see #map-sub-tabs) — closeDeviceDetail() resets any drill-down
    // left open from a previous visit, same as the old dedicated nav item
    // used to on every click, so re-entering always lands on the list.
    if (item.dataset.view === 'map') { closeDeviceDetail(); showMapView(); }
    stopSystemHealthPolling();
    // "Rekaman", "Log peristiwa", "Kesehatan Kamera" and "Kesehatan Server"
    // are now sub-tabs inside this one nav item (see #devsrv-sub-tabs) —
    // showDevSrvView() re-activates whichever one was last active, which
    // restarts the CPU/RAM poll above if that happens to be "system".
    if (item.dataset.view === 'devsrv') showDevSrvView();
  });
});

// "SOP Aplikasi" lives in the sidebar footer (next to Keluar), not the main
// nav list, since it's reference material rather than a working area — but
// it still swaps into the same single main content pane as every other view.
$('#sop-link')?.addEventListener('click', () => {
  closeFooterSettingsMenu();
  document.querySelectorAll('.nav-item').forEach((i) => i.classList.remove('active'));
  showView('sop');
});

// "Pengaturan Sistem" used to be its own top-level nav item; it now lives
// in the footer's "Pengaturan" menu instead (admin-only, same as before —
// see renderNavForRole), but still drives the same #view-settings pane and
// needs the same loadSettingsPage() call the old nav-item click used to make.
$('#settings-page-link')?.addEventListener('click', () => {
  closeFooterSettingsMenu();
  document.querySelectorAll('.nav-item').forEach((i) => i.classList.remove('active'));
  showView('settings');
  loadSettingsPage();
});

// ---- "Tentang Aplikasi" modal ----
// Mirrors the sidebar branding (logo/name already loaded by loadBranding())
// instead of re-fetching it, so this can't ever show a different name/logo
// than the rest of the UI.
function renderAboutGrid(data) {
  const rows = [
    ['Versi', data.app_version || '-'],
    ...(data.git ? [['Build', `${data.git.commit} · ${new Date(data.git.date).toLocaleDateString('id-ID')}`]] : []),
    ['Node.js', data.node_version || '-'],
    ['Platform', data.platform || '-'],
    ['Waktu Aktif', formatDuration((data.uptime_seconds || 0) * 1000)],
    ['Jumlah Kamera', String(data.camera_count ?? '-')],
    ['Jumlah Lokasi', String(data.location_count ?? '-')],
    ['Ukuran Database', data.db_size_bytes != null ? formatBytes(data.db_size_bytes) : '-'],
  ];
  return rows.map(([label, value]) => `
    <div class="about-row">
      <span class="about-label">${escapeHtml(label)}</span>
      <span class="about-value">${escapeHtml(value)}</span>
    </div>
  `).join('');
}

$('#about-link')?.addEventListener('click', async () => {
  closeFooterSettingsMenu();
  const logoHtml = $('#sidebar-brand-mark')?.innerHTML;
  if (logoHtml) $('#about-logo').innerHTML = logoHtml;
  $('#about-app-name').textContent = $('#sidebar-app-name')?.textContent || 'Open VMS';
  $('#about-version').textContent = '';
  $('#about-grid').innerHTML = '<div class="about-loading">Memuat…</div>';
  $('#about-modal').classList.remove('hidden');
  try {
    const data = await api('/about');
    $('#about-version').textContent = `v${data.app_version || '0.0.0'}`;
    $('#about-grid').innerHTML = renderAboutGrid(data);
  } catch (e) {
    $('#about-grid').innerHTML = '<div class="about-loading">Gagal memuat info aplikasi.</div>';
    console.error(e);
  }
});
$('#about-close-btn')?.addEventListener('click', () => $('#about-modal').classList.add('hidden'));
$('#about-modal')?.addEventListener('click', (e) => { if (e.target.id === 'about-modal') $('#about-modal').classList.add('hidden'); });
$('#about-sop-btn')?.addEventListener('click', () => {
  $('#about-modal').classList.add('hidden');
  document.querySelectorAll('.nav-item').forEach((i) => i.classList.remove('active'));
  showView('sop');
});

// ---- Mobile off-canvas drawer ----
// On phones the sidebar (built above as a normal vertical nav) is tucked
// off-screen via CSS and slid in on demand, rather than duplicating the nav
// markup in a second mobile-only menu.

function openDrawer() {
  $('#sidebar')?.classList.add('drawer-open');
  $('#drawer-backdrop')?.classList.add('visible');
}
function closeDrawer() {
  $('#sidebar')?.classList.remove('drawer-open');
  $('#drawer-backdrop')?.classList.remove('visible');
}
$('#drawer-backdrop')?.addEventListener('click', closeDrawer);
$('#drawer-close-btn')?.addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
window.addEventListener('resize', () => { if (window.innerWidth > 860) closeDrawer(); });

// Every page header gets its own hamburger button (rather than one global
// bar) so it sits inline with that page's title, matching the single-row
// "☰ Title    [action]" pattern instead of stacking a separate bar above it.
document.querySelectorAll('.main-header').forEach((header) => {
  const h2 = header.querySelector('h2');
  if (!h2) return;
  const titleWrap = document.createElement('div');
  titleWrap.className = 'main-header-title';
  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'mobile-menu-btn';
  menuBtn.setAttribute('aria-label', 'Buka menu');
  menuBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>';
  menuBtn.addEventListener('click', openDrawer);
  header.insertBefore(titleWrap, h2);
  titleWrap.appendChild(menuBtn);
  titleWrap.appendChild(h2);
});

// ---- Camera grid ----

async function loadCameras() {
  try {
    state.cameras = await api('/cameras');
    renderStatusFilters();
    renderLocationTree();
    renderGrid();
    if (focusCameraId && !$('#focus-modal').classList.contains('hidden')) {
      const cam = state.cameras.find((c) => c.id === focusCameraId);
      if (cam) renderFocusModal(cam);
    }
    // "Perangkat" is now the "devices" sub-tab inside #view-map (see
    // #map-sub-tabs) rather than its own top-level view — check both that
    // the merged view is open and that tab is the active one.
    if (!$('#view-map')?.classList.contains('hidden') && mapSubTab === 'devices') renderDeviceTable();
  } catch (e) {
    console.error(e);
  }
}

// Surfaces the server-side CPU auto-throttle (see system_health.js /
// streaming.js) to every logged-in role, not just admins on the "Kesehatan
// Server" tab — an operator watching the live view grid is exactly who
// needs to know new streams are being held back and why, without having to
// go find the health page.
let throttleBannerShown = false;
function setThrottleBanner(show, cpuPercent) {
  const el = $('#cpu-throttle-banner');
  if (!el) return;
  if (show === throttleBannerShown) {
    if (show) el.textContent = `CPU server sedang tinggi (${cpuPercent}%) sejak beberapa saat lalu — live view baru ditahan sementara sampai beban turun. Kamera yang sudah menyala tidak dimatikan.`;
    return;
  }
  throttleBannerShown = show;
  el.classList.toggle('hidden', !show);
  if (show) {
    el.textContent = `CPU server sedang tinggi (${cpuPercent}%) sejak beberapa saat lalu — live view baru ditahan sementara sampai beban turun. Kamera yang sudah menyala tidak dimatikan.`;
  }
}

async function loadSystemStatus() {
  try {
    const status = await api('/system-status');
    setThrottleBanner(!!status.throttled, status.cpu_percent);
  } catch (e) {
    // Non-critical — just skip this tick, next poll will retry.
  }
}

async function reorderCameras(draggedId, targetId) {
  if (draggedId === targetId) return;
  const fromIdx = state.cameras.findIndex((c) => c.id === draggedId);
  const toIdx = state.cameras.findIndex((c) => c.id === targetId);
  if (fromIdx === -1 || toIdx === -1) return;

  // Move within the full camera list (not just the visible/filtered subset)
  // so ordering stays consistent across filters and pages, then renumber
  // sequentially. Renumbering (rather than reusing old sort_order values)
  // also self-heals cameras that still share the same default sort_order.
  const reordered = [...state.cameras];
  const [moved] = reordered.splice(fromIdx, 1);
  const newToIdx = reordered.findIndex((c) => c.id === targetId);
  reordered.splice(newToIdx, 0, moved);
  reordered.forEach((c, i) => { c.sort_order = i; });
  state.cameras = reordered;
  renderGrid();

  try {
    await api('/cameras/reorder', {
      method: 'PUT',
      body: { items: reordered.map((c) => ({ id: c.id, sort_order: c.sort_order })) },
    });
  } catch (e) {
    console.error('Gagal menyimpan urutan kamera:', e.message);
    await loadCameras();
  }
}

// Fixed-slot layouts show a set number of tiles per "page" and pad any
// remaining slots with placeholders, like a real VMS layout preset.
// 'auto' keeps the original responsive wrap (no empty filler tiles, grid
// just reflows to fit however many cameras are on the page) but still
// needs a page cap — without one, every camera in the DB would get its
// own hls.js instance + <video> element at once when viewed/started
// together, which is the main driver of ballooning browser tab memory.
// pageSize (not slots) drives that cap for auto so the empty-tile-padding
// branch below (which keys off `slots`) stays off for it.
const AUTO_LAYOUT_PAGE_SIZE = 12;
const LAYOUTS = {
  auto: { slots: null, pageSize: AUTO_LAYOUT_PAGE_SIZE },
  '1x1': { slots: 1 },
  '2x2': { slots: 4 },
  '3x3': { slots: 9 },
  '4x4': { slots: 16 },
  spotlight: { slots: 6 },
};

// The server tracks *why* a stream isn't playing (wrong RTSP credentials,
// unreachable IP, a corrupt/incompatible codec, waiting on a concurrency
// slot — see lastError in streaming.js) but nothing ever showed it: a dead
// tile just said "Menyambung ulang..." forever with no way to tell "this
// will recover on its own" from "this camera is misconfigured and will
// retry forever for nothing" without pulling server logs. Surfacing it
// here means whoever's looking at the grid can tell at a glance. Only
// shown once reconnecting has actually kicked in — a stream's first
// connection attempt hasn't failed yet, so there's nothing to report before
// then. Truncated (ffmpeg stderr excerpts can run to hundreds of chars);
// full text still available via the title attribute (hover) for whoever
// needs it.
// status.state (from streaming.js's getStatus()) collapses the three
// situations that used to all show as one generic "Reconnecting" into
// something an operator can act on differently:
//  - 'queued'     — waiting on a server-side resource (encoder slot or CPU
//                    throttle), not a camera problem. Nothing to do; it'll
//                    start on its own.
//  - 'connecting' — a normal, still-fresh RTSP reconnect attempt.
//  - 'failing'    — the same reconnect loop, but past FAILING_RETRY_THRESHOLD
//                    attempts server-side — worth a look (bad credentials,
//                    unreachable camera, wrong codec).
function streamPlaceholderInfo(status, rtspUrl) {
  if (!rtspUrl) return { text: 'RTSP belum diatur — lakukan ONVIF probe', title: '', isError: false };
  if (status.state === 'queued') {
    const text = status.queuedReason === 'cpu_throttle' ? 'Menunggu CPU server turun...' : 'Mengantre slot encoder...';
    return { text, title: status.lastError || '', isError: false };
  }
  if (status.state === 'failing') {
    if (status.lastError) {
      const oneLine = status.lastError.replace(/\s+/g, ' ').trim();
      const short = oneLine.length > 90 ? `${oneLine.slice(0, 90)}…` : oneLine;
      return { text: `Gagal konek (percobaan ke-${status.retryCount}): ${short}`, title: oneLine, isError: true };
    }
    return { text: `Gagal konek berulang (percobaan ke-${status.retryCount})`, title: '', isError: true };
  }
  if (status.state === 'connecting') {
    return { text: 'Menyambung ulang...', title: '', isError: false };
  }
  return { text: 'Klik "Live" untuk mulai menonton', title: '', isError: false };
}

// Shared status-pill styling/label for the grid tile and focus modal, keyed
// off the same status.state — see streamPlaceholderInfo above.
function liveStatusPillInfo(status) {
  switch (status.state) {
    case 'live': return { cls: 'live-on', label: 'Live' };
    case 'queued': return { cls: 'reconnecting', label: 'Mengantre' };
    case 'connecting': return { cls: 'reconnecting', label: 'Menyambung...' };
    case 'failing': return { cls: 'failing', label: `Gagal (${status.retryCount}x)` };
    default: return { cls: '', label: 'Live' };
  }
}

function buildCameraTile(cam, isSpotlightMain, isSpotlightSidebar, enableDrag) {
  const tile = document.createElement('div');
  const canEdit = state.user.role !== 'viewer';
  const bulkMode = state.bulkSelectMode && canEdit;
  const isSelected = state.bulkSelectedIds.has(cam.id);
  tile.className = 'tile' + (isSpotlightMain ? ' spotlight-main' : '') + (bulkMode ? ' bulk-selectable' : '') + (isSelected ? ' bulk-selected' : '');
  tile.dataset.camId = cam.id;

  // Selection mode takes over drag-reorder and the "click tile to focus"
  // gesture — trying to support both on the same click would mean guessing
  // intent, so bulk mode wins outright while it's active.
  if (enableDrag && canEdit && !bulkMode) {
    tile.draggable = true;
    tile.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(cam.id));
      tile.classList.add('dragging');
    });
    tile.addEventListener('dragend', () => tile.classList.remove('dragging'));
    tile.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      tile.classList.add('drag-over');
    });
    tile.addEventListener('dragleave', () => tile.classList.remove('drag-over'));
    tile.addEventListener('drop', (e) => {
      e.preventDefault();
      tile.classList.remove('drag-over');
      const draggedId = Number(e.dataTransfer.getData('text/plain'));
      reorderCameras(draggedId, cam.id);
    });
  }

  const camLocation = state.locations.find((l) => l.id === cam.location_id);
  const hasMenuItems = tileActionMenuItems(cam).length > 0;
  const subPlaceholder = streamPlaceholderInfo(cam.stream_sub, cam.rtsp_url);
  const subPill = liveStatusPillInfo(cam.stream_sub);

  tile.innerHTML = `
    <div class="tile-video">
      ${bulkMode ? `<div class="bulk-select-checkbox ${isSelected ? 'checked' : ''}"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></div>` : ''}
      <video id="video-${cam.id}" muted playsinline></video>
      <div class="placeholder ${cam.stream_sub.active ? 'hidden' : ''}${subPlaceholder.isError ? ' placeholder-error' : ''}" id="placeholder-${cam.id}" title="${escapeHtml(subPlaceholder.title)}">${escapeHtml(subPlaceholder.text)}</div>
      <div class="status-badge">
        <span class="status-pill ${subPill.cls}"><span class="status-dot live"></span>${subPill.label}</span>
        <span class="status-pill ${cam.recording_active ? 'rec-on' : ''}"><span class="status-dot rec"></span>Rec</span>
        <span class="status-pill ${cam.motion_active ? 'motion-on' : ''}"><span class="status-dot motion"></span>Motion</span>
      </div>
      ${enableDrag && canEdit ? `<div class="drag-handle" title="Seret untuk atur urutan"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg></div>` : ''}
      ${isSpotlightSidebar ? `
      <button class="promote-btn" data-action="promote" data-id="${cam.id}" title="Jadikan kamera utama">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
      </button>` : ''}
    </div>
    <div class="tile-info">
      <div class="tile-info-text">
        <div class="name">${escapeHtml(cam.name)} ${cam.is_relay ? '<span class="relay-badge" title="Video dikirim via agen relay, bukan konek langsung">📡 Relay</span>' : ''}</div>
        <div class="brand">${escapeHtml(cam.brand || 'Tidak diketahui')} · ${escapeHtml(cam.ip)}</div>
        ${cam.location_id ? `<div class="location-tag">📍 ${escapeHtml(camLocation?.name || 'Lokasi tidak dikenal')}</div>` : ''}
        ${camLocation?.address ? `<div class="location-address">${escapeHtml(camLocation.address)}</div>` : ''}
        <div class="meta">Motion: ${cam.motion_detection_enabled ? 'ON' : 'OFF'} · Sensitivitas: ${cam.motion_sensitivity || 0.04}</div>
      </div>
      <div class="tile-actions">
        <button class="favorite-btn ${cam.is_favorite ? 'active' : ''}" data-action="favorite" data-id="${cam.id}" title="${cam.is_favorite ? 'Hapus dari favorit' : 'Tandai favorit'}" aria-label="Favorit">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="${cam.is_favorite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
        </button>
        ${hasMenuItems ? `
        <button class="tile-menu-btn" data-menu-toggle="${cam.id}" title="Menu aksi" aria-label="Menu aksi">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
        </button>` : ''}
      </div>
    </div>
    ${cam.ptz_supported ? `
    <div class="ptz-grid">
      <span></span><button data-ptz="up" data-id="${cam.id}">▲</button><span></span>
      <button data-ptz="left" data-id="${cam.id}">◀</button>
      <button data-ptz="stop" data-id="${cam.id}">■</button>
      <button data-ptz="right" data-id="${cam.id}">▶</button>
      <span></span><button data-ptz="down" data-id="${cam.id}">▼</button><span></span>
    </div>` : ''}
  `;

  tile.querySelector('.tile-video').addEventListener('click', (e) => {
    if (e.target.closest('button, .drag-handle')) return;
    if (bulkMode) {
      toggleBulkSelection(cam.id);
      return;
    }
    openFocusView(cam.id);
  });

  return tile;
}

function buildEmptyTile(isSpotlightMain) {
  const el = document.createElement('div');
  el.className = 'tile tile-empty' + (isSpotlightMain ? ' spotlight-main' : '');
  el.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 10l4.55-2.28A1 1 0 0 1 21 8.62v6.76a1 1 0 0 1-1.45.9L15 14"/><rect x="3" y="6" width="12" height="12" rx="2"/></svg>
    <span>Slot kosong</span>
  `;
  return el;
}

// ---- Bulk select (edit lokasi/motion detection untuk banyak kamera sekaligus) ----
// Deliberately reuses renderGrid() for every selection-state change instead
// of hand-patching the DOM — renderGrid() already knows how to preserve live
// <video>/hls.js players across a rebuild (see the comment inside it), so
// toggling selection doesn't interrupt anything already playing.

function toggleBulkSelection(camId) {
  if (state.bulkSelectedIds.has(camId)) state.bulkSelectedIds.delete(camId);
  else state.bulkSelectedIds.add(camId);
  const tile = document.querySelector(`.tile[data-cam-id="${camId}"]`);
  if (tile) {
    const selected = state.bulkSelectedIds.has(camId);
    tile.classList.toggle('bulk-selected', selected);
    tile.querySelector('.bulk-select-checkbox')?.classList.toggle('checked', selected);
  }
  updateBulkActionBar();
}

function updateBulkActionBar() {
  const count = state.bulkSelectedIds.size;
  const countEl = $('#bulk-selected-count');
  if (countEl) countEl.textContent = `${count} kamera dipilih`;
  const editBtn = $('#bulk-edit-open-btn');
  if (editBtn) editBtn.disabled = count === 0;
}

function enterBulkSelectMode() {
  state.bulkSelectMode = true;
  state.bulkSelectedIds.clear();
  $('#bulk-action-bar')?.classList.remove('hidden');
  $('#bulk-select-toggle-btn')?.classList.add('active');
  updateBulkActionBar();
  renderGrid();
}

function exitBulkSelectMode() {
  state.bulkSelectMode = false;
  state.bulkSelectedIds.clear();
  $('#bulk-action-bar')?.classList.add('hidden');
  $('#bulk-select-toggle-btn')?.classList.remove('active');
  renderGrid();
}

$('#bulk-select-toggle-btn')?.addEventListener('click', () => {
  if (state.bulkSelectMode) exitBulkSelectMode();
  else enterBulkSelectMode();
});

$('#bulk-select-cancel-btn')?.addEventListener('click', exitBulkSelectMode);

// "Visible" = whatever's actually rendered under the current filter/search/
// layout page right now, not every camera in the whole system — matches
// what the operator can see on screen while deciding to select it all.
$('#bulk-select-all-visible-btn')?.addEventListener('click', () => {
  document.querySelectorAll('#camera-grid .tile[data-cam-id]').forEach((tile) => {
    state.bulkSelectedIds.add(Number(tile.dataset.camId));
  });
  renderGrid();
  updateBulkActionBar();
});

function openBulkEditModal() {
  if (state.bulkSelectedIds.size === 0) return;
  $('#bulk-edit-count').textContent = state.bulkSelectedIds.size;

  // Always opens blank — this *sets* a value across many cameras that likely
  // already differ from each other, it doesn't reflect any one of their
  // current settings.
  $('#bulk-edit-location-toggle').checked = false;
  $('#bulk-edit-location-fields').classList.add('hidden');
  $('#bulk-edit-location').value = '';
  $('#bulk-edit-building').value = '';
  $('#bulk-edit-motion-toggle').checked = false;
  $('#bulk-edit-motion-fields').classList.add('hidden');
  $('#bulk-edit-motion-enabled').checked = false;
  $('#bulk-edit-motion-recording').checked = false;
  $('#bulk-edit-motion-sensitivity').value = 0.04;
  const msg = $('#bulk-edit-msg');
  msg.textContent = '';
  msg.className = 'form-msg';

  const select = $('#bulk-edit-location');
  select.innerHTML = '<option value="">Tidak ditentukan</option>' +
    state.locations.map((l) => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('');

  $('#bulk-edit-modal').classList.remove('hidden');
}

function closeBulkEditModal() {
  $('#bulk-edit-modal').classList.add('hidden');
}

$('#bulk-edit-open-btn')?.addEventListener('click', openBulkEditModal);
$('#bulk-edit-cancel-btn')?.addEventListener('click', closeBulkEditModal);
$('#bulk-edit-location-toggle')?.addEventListener('change', (e) => {
  $('#bulk-edit-location-fields').classList.toggle('hidden', !e.target.checked);
});
$('#bulk-edit-motion-toggle')?.addEventListener('change', (e) => {
  $('#bulk-edit-motion-fields').classList.toggle('hidden', !e.target.checked);
});

$('#bulk-edit-save-btn')?.addEventListener('click', async () => {
  const msg = $('#bulk-edit-msg');
  msg.textContent = '';
  msg.className = 'form-msg';

  const wantLocation = $('#bulk-edit-location-toggle').checked;
  const wantMotion = $('#bulk-edit-motion-toggle').checked;
  if (!wantLocation && !wantMotion) {
    msg.textContent = 'Centang minimal satu bagian yang mau diubah.';
    msg.classList.add('error');
    return;
  }

  const body = { ids: [...state.bulkSelectedIds] };
  if (wantLocation) {
    body.location_id = $('#bulk-edit-location').value ? Number($('#bulk-edit-location').value) : null;
    body.building = $('#bulk-edit-building').value.trim() || null;
  }
  if (wantMotion) {
    body.motion_detection_enabled = $('#bulk-edit-motion-enabled').checked;
    body.motion_recording_enabled = $('#bulk-edit-motion-recording').checked;
    body.motion_sensitivity = Number($('#bulk-edit-motion-sensitivity').value) || 0.04;
  }

  try {
    const res = await api('/cameras/bulk', { method: 'PUT', body });
    msg.textContent = `Berhasil memperbarui ${res.updated} kamera.`;
    msg.classList.add('ok');
    setTimeout(() => {
      closeBulkEditModal();
      exitBulkSelectMode();
      loadCameras();
    }, 700);
  } catch (e) {
    msg.textContent = e.message;
    msg.classList.add('error');
  }
});

// ---- Per-tile "..." action menu ----
// A single shared popup (appended to <body>, not the tile) is reused for
// every tile — a menu nested inside .tile would get clipped by the tile's
// own `overflow: hidden` (needed to round the video's square corners), and
// grid tiles rebuild from scratch on every 15s poll anyway.

function tileActionMenuItems(cam) {
  const canEdit = state.user.role !== 'viewer';
  const items = cam.is_relay
    ? [
        canEdit && { action: 'edit', label: 'Edit' },
        canEdit && { action: 'relay-info', label: 'Info Agen' },
        state.user.role === 'admin' && { action: 'delete', label: 'Hapus', danger: true },
      ]
    : [
        { action: 'stream', label: cam.stream_sub.active ? 'Stop live' : 'Live' },
        { action: 'record', label: cam.recording_active ? 'Stop rekam' : 'Rekam' },
        { action: 'probe', label: 'Probe ONVIF' },
        canEdit && { action: 'edit', label: 'Edit' },
        state.user.role !== 'viewer' && { action: 'motion', label: cam.motion_detection_enabled ? 'Matikan Motion' : 'Hidupkan Motion' },
        state.user.role === 'admin' && { action: 'delete', label: 'Hapus', danger: true },
      ];
  return items.filter(Boolean);
}

function hideTileActionMenu() {
  const menu = $('#tile-action-menu');
  if (menu) {
    menu.classList.add('hidden');
    delete menu.dataset.openFor;
  }
}

function toggleTileActionMenu(btn, camId) {
  const menu = $('#tile-action-menu');
  if (!menu) return;
  const wasOpenForThis = !menu.classList.contains('hidden') && menu.dataset.openFor === String(camId);
  hideTileActionMenu();
  if (wasOpenForThis) return; // clicking the same "..." again just closes it

  const cam = state.cameras.find((c) => c.id === camId);
  if (!cam) return;
  menu.innerHTML = tileActionMenuItems(cam)
    .map((m) => `<button data-action="${m.action}" data-id="${cam.id}"${m.danger ? ' class="danger"' : ''}>${m.label}</button>`)
    .join('');
  menu.dataset.openFor = String(camId);
  menu.classList.remove('hidden');

  // Measure after the content is in and visible so we can keep the menu on
  // screen — with dense grid layouts (video-wall style, many columns of
  // small tiles) a naive bottom-right anchor regularly pushes it past the
  // viewport edge for tiles in the last row or the leftmost column.
  const rect = btn.getBoundingClientRect();
  const menuWidth = menu.offsetWidth;
  const menuHeight = menu.offsetHeight;
  const openUpward = window.innerHeight - rect.bottom < menuHeight + 12 && rect.top > menuHeight + 12;
  const right = Math.max(8, Math.min(window.innerWidth - rect.right, window.innerWidth - menuWidth - 8));

  menu.style.left = 'auto';
  menu.style.right = `${right}px`;
  menu.style.top = openUpward ? `${Math.max(8, rect.top - 6 - menuHeight)}px` : `${rect.bottom + 6}px`;
}

// Delegated on the container itself (not its buttons) so it survives the
// innerHTML rebuild every time the menu is (re)opened for a different tile.
$('#tile-action-menu')?.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  hideTileActionMenu();
  handleTileAction(btn.dataset.action, Number(btn.dataset.id));
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#tile-action-menu') && !e.target.closest('[data-menu-toggle]')) hideTileActionMenu();
});
window.addEventListener('scroll', hideTileActionMenu, true);
window.addEventListener('resize', hideTileActionMenu);

function updateLayoutPager(page, totalPages, remainingAfterThisPage) {
  const pager = $('#layout-pager');
  if (!pager) return;
  if (!totalPages || totalPages <= 1) {
    pager.classList.add('hidden');
    return;
  }
  pager.classList.remove('hidden');
  const label = `Halaman ${page + 1}/${totalPages}`;
  $('#layout-page-label').textContent = remainingAfterThisPage > 0
    ? `${label} · ${remainingAfterThisPage} kamera lagi →`
    : label;
  $('#layout-prev').disabled = page === 0;
  $('#layout-next').disabled = page >= totalPages - 1;
}

function renderGrid() {
  const grid = $('#camera-grid');
  const playingIds = [...state.players.keys()];
  hideTileActionMenu(); // tiles/buttons below are about to be torn down and rebuilt

  // The grid gets rebuilt from scratch below on every call — after
  // starting/stopping any single stream, on the 15s status poll, on layout
  // or filter changes, on reorder — which would otherwise destroy the
  // <video> element a running hls.js player is attached to. That forced
  // every already-playing tile to fully reinitialize (new manifest fetch,
  // fresh buffer) any time it happened, which looks exactly like the
  // stream reconnecting even though the ffmpeg process behind it never
  // stopped (e.g. clicking "Live" on one camera made every other
  // already-stable tile flicker/reconnect too). Detach and hang onto the
  // live <video> nodes before the rebuild, then splice them back into
  // their tile's fresh placeholder afterwards instead of recreating
  // playback. This only works because the detach (grid.innerHTML = '')
  // and the re-insertion both happen synchronously within this same
  // function, with no `await`/timeout between them for the browser to
  // treat the node as gone.
  // A player can also be alive but currently off-DOM — paginated off the
  // layout page on a previous renderGrid() call (see the pagedOutVideos
  // handling below) — so it needs to be found there too, not just in the
  // live document.
  const liveVideoNodes = new Map();
  const idsResumingFromPagedOut = new Set();
  for (const id of playingIds) {
    const pagedOutEl = state.pagedOutVideos.get(id);
    const el = document.getElementById(`video-${id}`) || pagedOutEl;
    if (el) liveVideoNodes.set(id, el);
    if (pagedOutEl) idsResumingFromPagedOut.add(id);
    state.pagedOutVideos.delete(id); // re-added below if still off-page after this render
  }

  grid.innerHTML = '';
  grid.className = `grid layout-${state.layout}`;

  document.querySelectorAll('#layout-picker .layout-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.layout === state.layout);
  });

  if (state.cameras.length === 0) {
    grid.innerHTML = '<div class="empty-state">Belum ada kamera. Klik "Tambah kamera" untuk memulai.</div>';
    for (const id of playingIds) {
      const hls = state.players.get(id);
      if (hls) hls.destroy();
    }
    state.players.clear();
    state.pagedOutVideos.clear();
    clearAllPagedOutStopTimers();
    updateLayoutPager(0, 0);
    return;
  }

  const filteredCameras = getVisibleCameras();
  if (filteredCameras.length === 0) {
    const emptyMsg = state.cameraSearch.trim()
      ? `Tidak ada kamera yang cocok dengan pencarian "${escapeHtml(state.cameraSearch.trim())}".`
      : 'Tidak ada kamera di lokasi ini.';
    grid.innerHTML = `<div class="empty-state">${emptyMsg}</div>`;
    for (const id of playingIds) {
      const hls = state.players.get(id);
      if (hls) hls.destroy();
    }
    state.players.clear();
    state.pagedOutVideos.clear();
    clearAllPagedOutStopTimers();
    updateLayoutPager(0, 0);
    return;
  }

  const layoutDef = LAYOUTS[state.layout] || LAYOUTS.auto;
  const slotCount = layoutDef.slots;
  const pageSize = layoutDef.pageSize || slotCount;
  let camerasToShow = filteredCameras;

  if (pageSize) {
    const totalPages = Math.max(1, Math.ceil(filteredCameras.length / pageSize));
    if (state.layoutPage >= totalPages) state.layoutPage = totalPages - 1;
    if (state.layoutPage < 0) state.layoutPage = 0;
    const start = state.layoutPage * pageSize;
    camerasToShow = filteredCameras.slice(start, start + pageSize);
    updateLayoutPager(state.layoutPage, totalPages, filteredCameras.length - (start + camerasToShow.length));
  } else {
    updateLayoutPager(0, 0);
  }

  if (state.layout === 'spotlight') {
    const mainCam = camerasToShow.find((c) => c.id === state.spotlightMainId) || camerasToShow[0];
    const others = camerasToShow.filter((c) => c !== mainCam);

    grid.appendChild(mainCam ? buildCameraTile(mainCam, true, false, false) : buildEmptyTile(true));
    const sidebar = document.createElement('div');
    sidebar.className = 'spotlight-sidebar';
    for (let i = 0; i < slotCount - 1; i++) {
      sidebar.appendChild(others[i] ? buildCameraTile(others[i], false, true, false) : buildEmptyTile(false));
    }
    grid.appendChild(sidebar);
  } else {
    camerasToShow.forEach((cam) => grid.appendChild(buildCameraTile(cam, false, false, true)));
    if (slotCount) {
      for (let i = camerasToShow.length; i < slotCount; i++) {
        grid.appendChild(buildEmptyTile(false));
      }
    }
  }

  grid.querySelectorAll('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => handleTileAction(btn.dataset.action, Number(btn.dataset.id)));
  });
  grid.querySelectorAll('[data-ptz]').forEach((btn) => {
    const move = () => sendPtz(Number(btn.dataset.id), btn.dataset.ptz);
    btn.addEventListener('mousedown', move);
    btn.addEventListener('mouseup', () => sendPtz(Number(btn.dataset.id), 'stop'));
    btn.addEventListener('mouseleave', () => sendPtz(Number(btn.dataset.id), 'stop'));
  });
  grid.querySelectorAll('[data-menu-toggle]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleTileActionMenu(btn, Number(btn.dataset.menuToggle));
    });
  });

  // Restore playback for cameras whose stream is still active — reusing the
  // preserved live <video> node (no reconnect, no re-buffer) where one
  // exists, and only falling back to a fresh startPlayer() for tiles that
  // genuinely have no player running yet: streams active server-side but
  // never started from this browser tab (e.g. still running from before a
  // page reload, or started by another operator), so their tile shows live
  // video instead of sitting blank even though the status badge says active.
  // Focus view deliberately pauses every grid player to hand its own stream
  // the full 6-connections-per-host budget (see pauseGridPlayersForFocus) —
  // the 15s poll calls renderGrid() unconditionally regardless of whether
  // focus view is open, so without this check it would undo that pause on
  // the very next poll, starving the focus stream again a few seconds in.
  // closeFocusView() calls renderGrid() itself once the modal is hidden, so
  // background tiles still resume promptly, just not while focus view is up.
  const focusViewOpen = !$('#focus-modal')?.classList.contains('hidden');

  const activeIds = new Set(playingIds);
  for (const cam of camerasToShow) {
    if (cam.stream_sub.active) activeIds.add(cam.id);
  }
  // "Nyalakan Halaman Ini" fires stream/start for a whole page of cameras,
  // staggered server-side, but only calls loadCameras() once at the very
  // end — so every one of them goes from "no player" to "needs startPlayer()"
  // in this same renderGrid() pass. Calling startPlayer() for all of them
  // synchronously opens that many hls.js manifest fetches in the same tick,
  // which blows straight through the browser's 6-connections-per-host cap
  // (see the focus-view comment above): most of the requests just sit
  // queued by the browser itself, long enough to trip hls.js's own load
  // timeout before they're even sent — so the whole page can fail to load
  // at once even though the server is serving every one of them fine.
  // Staggering the *client-side* startPlayer() calls too (not just the
  // server-side start requests) keeps the number of concurrent manifest
  // fetches low enough that each one actually gets a connection.
  let newPlayerStartCount = 0;
  const GRID_PLAYER_START_STAGGER_MS = 200;
  for (const id of activeIds) {
    const cam = state.cameras.find((c) => c.id === id);
    if (!cam || !cam.stream_sub.active) {
      const hls = state.players.get(id);
      if (hls) hls.destroy();
      state.players.delete(id);
      state.pagedOutVideos.delete(id);
      cancelPagedOutStop(id);
      continue;
    }

    const placeholderVideo = document.getElementById(`video-${id}`);
    const liveVideo = liveVideoNodes.get(id);

    if (!placeholderVideo) {
      // Camera is still live but its tile isn't on the current layout page
      // (paginated away) — keep the player alive instead of destroying it,
      // so flipping back to this page resumes instantly instead of
      // reconnecting from scratch, but stop its network activity while
      // unseen so it doesn't keep competing for the 6-connections-per-host
      // budget or wasting bandwidth on a stream nobody's looking at.
      // schedulePagedOutStop backstops this: if it's still off-page after
      // PAGE_OUT_STOP_DELAY_MS, the server-side ffmpeg process gets stopped
      // too, not just the client-side load.
      if (liveVideo && state.players.has(id)) {
        state.players.get(id).stopLoad();
        state.pagedOutVideos.set(id, liveVideo);
        schedulePagedOutStop(id);
      }
      continue;
    }

    // Tile is visible again — cancel any pending paged-out stop before it
    // fires (it would otherwise race the code below and stop a stream the
    // user is now looking at).
    cancelPagedOutStop(id);

    if (liveVideo && state.players.has(id)) {
      placeholderVideo.replaceWith(liveVideo);
      document.getElementById(`placeholder-${id}`)?.classList.add('hidden');
      // Only resume loading if this tile was actually paused for pagination —
      // calling startLoad() on a player that was never stopped (e.g. an
      // ordinary same-page 15s poll) would restart it from the live edge
      // and cause a visible hiccup for playback that was never interrupted.
      if (idsResumingFromPagedOut.has(id)) state.players.get(id).startLoad();
    } else if (!focusViewOpen) {
      const playlistUrl = `/streams/${id}/sub/index.m3u8`;
      const delay = newPlayerStartCount * GRID_PLAYER_START_STAGGER_MS;
      newPlayerStartCount += 1;
      setTimeout(() => {
        // Re-check on fire, not just at schedule time — renderGrid() may have
        // run again in the meantime (poll tick, layout change, camera
        // stopped) and already started/removed this tile's player.
        if ($(`#video-${id}`) && !state.players.has(id)) startPlayer(id, playlistUrl);
      }, delay);
    }
  }
}

$('#layout-picker')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.layout-btn');
  if (!btn) return;
  state.layout = btn.dataset.layout;
  state.layoutPage = 0;
  localStorage.setItem('vms_layout', state.layout);
  renderGrid();
});

$('#layout-prev')?.addEventListener('click', () => {
  state.layoutPage = Math.max(0, state.layoutPage - 1);
  renderGrid();
});

$('#layout-next')?.addEventListener('click', () => {
  state.layoutPage += 1;
  renderGrid();
});

async function handleTileAction(action, id) {
  if (action === 'promote') {
    state.spotlightMainId = id;
    renderGrid();
    return;
  }

  const cam = state.cameras.find((c) => c.id === id);

  if (action === 'edit') {
    openCameraModal(cam);
    return;
  }

  if (action === 'relay-info') {
    if (!cam.relay_token) {
      showToast('Token relay tidak tersedia (perlu role admin/operator untuk melihatnya).');
      return;
    }
    if (!cam.rtsp_url) {
      showToast(`Kamera "${cam.name}" belum punya RTSP path. Edit kamera ini dan isi RTSP path manual dulu (Probe ONVIF tidak tersedia untuk kamera relay).`);
      return;
    }
    const cmd = `node relay-agent.js --server=${window.location.origin} --token=${cam.relay_token} --rtsp="${cam.rtsp_url}"`;
    showRelayCommand(cam.name, cmd);
    return;
  }

  try {
    if (action === 'favorite') {
      await api(`/cameras/${id}/favorite`, { method: cam.is_favorite ? 'DELETE' : 'POST' });
    } else if (action === 'stream') {
      // Grid tiles use the 'sub' (lightweight) profile — much cheaper for
      // ffmpeg to decode+scale+re-encode than main, so more tiles can be
      // live at once. Falls back to main-stream quality server-side for any
      // camera that hasn't configured a sub stream path.
      if (cam.stream_sub.active) {
        await api(`/cameras/${id}/stream/stop`, { method: 'POST', body: { profile: 'sub' } });
        stopPlayer(id);
      } else {
        const res = await api(`/cameras/${id}/stream/start`, { method: 'POST', body: { profile: 'sub' } });
        startPlayer(id, res.playlist);
      }
    } else if (action === 'record') {
      await api(`/cameras/${id}/recording/${cam.recording_active ? 'stop' : 'start'}`, { method: 'POST' });
    } else if (action === 'probe') {
      $(`#placeholder-${id}`).textContent = 'Menghubungi kamera via ONVIF...';
      const info = await api(`/cameras/${id}/onvif/probe`, { method: 'POST' });
      $(`#placeholder-${id}`).textContent = `Terhubung: ${info.manufacturer || ''} ${info.model || ''}`.trim();
    } else if (action === 'delete') {
      if (!(await showConfirm(`Hapus kamera "${cam.name}"?`, { title: 'Hapus Kamera' }))) return;
      await api(`/cameras/${id}`, { method: 'DELETE' });
    } else if (action === 'motion') {
      await api(`/cameras/${id}`, {
        method: 'PUT',
        body: {
          motion_detection_enabled: !cam.motion_detection_enabled,
          motion_sensitivity: cam.motion_sensitivity || 0.04,
          motion_recording_enabled: cam.motion_recording_enabled,
        },
      });
    }
    await loadCameras();
  } catch (e) {
    showToast(e.message);
  }
}

async function sendPtz(id, direction) {
  const map = {
    up: { pan: 0, tilt: 0.5 },
    down: { pan: 0, tilt: -0.5 },
    left: { pan: -0.5, tilt: 0 },
    right: { pan: 0.5, tilt: 0 },
    stop: null,
  };
  try {
    if (direction === 'stop') {
      await api(`/cameras/${id}/ptz`, { method: 'POST', body: { action: 'stop' } });
    } else {
      await api(`/cameras/${id}/ptz`, { method: 'POST', body: { action: 'move', ...map[direction] } });
    }
  } catch (e) {
    console.error(e);
  }
}

// A fatal hls.js error doesn't always mean the stream is actually dead — a
// single dropped segment or a decode hiccup is fatal-flagged too, and hls.js
// has cheap in-place recovery for exactly those (recoverMediaError,
// startLoad) that avoid tearing down the player and re-fetching the whole
// manifest. Only escalate to the caller's hard-restart path if the same
// error class keeps recurring, which means recovery isn't actually working.
function createHlsErrorHandler(hls, onGiveUp) {
  let mediaErrorCount = 0;
  let networkErrorCount = 0;
  return (_evt, data) => {
    if (!data.fatal) return;
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaErrorCount < 3) {
      mediaErrorCount += 1;
      hls.recoverMediaError();
      return;
    }
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkErrorCount < 3) {
      networkErrorCount += 1;
      hls.startLoad();
      return;
    }
    onGiveUp();
  };
}

// hls.js's own defaults for a manifest that 404s (e.g. a stream/start just
// fired but ffmpeg hasn't written its first HLS segment yet — routine for a
// WAN/public-IP camera whose RTSP handshake takes longer than a LAN one)
// retry *internally* with a backoff that can silently run for the better
// part of a minute before it ever raises a fatal error. Nothing in this app
// ever sees that — the tile just sits black with no placeholder update and
// no call to our own onFatalError retry loop (see startPlayer), so it only
// ever recovered by accident, whenever some unrelated action (a poll tick,
// clicking "Hentikan Semua") happened to call loadCameras() and rebuild the
// player from scratch. Capping the manifest retry budget here makes hls.js
// surface that failure quickly and on a predictable timeline, so our own
// retry (which now refetches fresh status before retrying — see
// startPlayer's comment) is what actually recovers it, consistently, not
// coincidence.
// liveSyncDurationCount/liveMaxLatencyDurationCount are in units of segments
// (server writes 2s segments — see HLS_SEGMENT_SECONDS in streaming.js), not
// seconds. Defaults (3 / not set) keep playback right on the live edge,
// which stutters on any minor delivery jitter (network hiccup, a slightly
// late segment write) since there's no cushion to absorb it. Trading a
// little more latency (~8s target, ~12s before a hard catch-up seek) for
// noticeably smoother playback — 12s max still stays inside the server's
// own 6-segment/12s retention window (hls_list_size), so a catch-up seek
// never lands on a segment that's already rolled off and 404s.
const HLS_CONFIG = {
  manifestLoadPolicy: {
    default: {
      maxTimeToFirstByteMs: 8000,
      maxLoadTimeMs: 10000,
      timeoutRetry: { maxNumRetry: 1, retryDelayMs: 1000, maxRetryDelayMs: 1000 },
      errorRetry: { maxNumRetry: 2, retryDelayMs: 1000, maxRetryDelayMs: 2000 },
    },
  },
  liveSyncDurationCount: 4,
  liveMaxLatencyDurationCount: 6,
};

// Independent of whatever HLS_CONFIG's manifestLoadPolicy actually ends up
// doing — hls.js's exact retry-policy config shape has drifted across
// versions, and a policy object it doesn't recognize is silently ignored
// rather than erroring, so there's no reliable way to *prove* it's in effect
// from here. This is the real backstop: if the manifest hasn't parsed within
// this window, something is stuck (browser 6-connections-per-host queueing,
// a slow WAN camera, hls.js's own retry running long) and force a retry
// ourselves rather than leaving the tile black forever with nothing in the
// console to explain why.
const HLS_STALL_TIMEOUT_MS = 10000;

// Shared by grid tiles (startPlayer) and the focus view modal — a single
// code path for attaching hls.js (or native HLS on Safari/iOS) to a
// <video>, so the two can't silently drift apart in how they set up or
// recover playback. Owns destroying itself on a fatal error before
// notifying the caller, so callers never need to re-destroy.
function attachHlsPlayer(video, playlistUrl, onFatalError) {
  if (Hls.isSupported()) {
    const hls = new Hls(HLS_CONFIG);
    hls.loadSource(playlistUrl);
    hls.attachMedia(video);
    let gaveUp = false;
    const giveUp = () => {
      if (gaveUp) return;
      gaveUp = true;
      clearTimeout(stallTimer);
      hls.destroy();
      onFatalError();
    };
    const stallTimer = setTimeout(giveUp, HLS_STALL_TIMEOUT_MS);
    hls.once(Hls.Events.MANIFEST_PARSED, () => clearTimeout(stallTimer));
    hls.on(Hls.Events.ERROR, createHlsErrorHandler(hls, giveUp));
    video.play().catch(() => {});
    return hls;
  }
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = playlistUrl;
    video.play().catch(() => {});
  }
  return null;
}

function startPlayer(id, playlistUrl) {
  const video = $(`#video-${id}`);
  if (!video) return;
  stopPlayer(id); // avoid orphaned hls.js instances piling up across re-renders
  $(`#placeholder-${id}`)?.classList.add('hidden');
  const hls = attachHlsPlayer(video, playlistUrl, () => {
    state.players.delete(id);
    const placeholder = $(`#placeholder-${id}`);
    if (!placeholder) return;
    placeholder.textContent = 'Gagal memuat video, mencoba lagi...';
    placeholder.classList.remove('hidden');
    setTimeout(async () => {
      if (!$(`#video-${id}`)) return; // tile no longer on screen (paginated away, filtered out, camera deleted)
      // Gating retry on state.cameras alone trusted a snapshot that can be
      // up to 15s stale (state.pollTimer) or older — a WAN/public-IP camera
      // routinely takes longer than that to finish its RTSP handshake and
      // write its first HLS segment, so the stream would already be genuinely
      // live server-side while this stayed stuck on the pre-start "not
      // active" snapshot and never retried. Refetch first so the decision is
      // based on current reality, not whatever the last poll happened to
      // catch. loadCameras() -> renderGrid() already starts a player for any
      // visible tile whose stream is now active and has none, so the
      // explicit startPlayer() below is just a fallback for whatever edge
      // case that pass didn't already cover (e.g. focus view was open then).
      await loadCameras();
      const cam = state.cameras.find((c) => c.id === id);
      if (cam?.stream_sub?.active && $(`#video-${id}`) && !state.players.has(id)) startPlayer(id, playlistUrl);
    }, 3000);
  });
  if (hls) state.players.set(id, hls);
}

function stopPlayer(id) {
  const hls = state.players.get(id);
  if (hls) {
    hls.destroy();
    state.players.delete(id);
  }
  state.pagedOutVideos.delete(id);
}

// A camera paged off the current layout page keeps its ffmpeg process (and
// hls.js player, parked via pagedOutVideos) alive so flipping back is
// instant — but left alone indefinitely that's exactly the unbounded
// server-side memory/CPU the pagination cap was meant to fix. Give it a
// short grace window instead of stopping it the instant it's paged out:
// long enough that fast back-and-forth page flipping still gets the
// instant-resume behavior (no reconnect, no flicker), short enough that a
// camera nobody's actually looking at gets shut down within seconds, not
// the 5-minute server-side idle-timeout's worth of wasted resources.
const PAGE_OUT_STOP_DELAY_MS = 8000;

function schedulePagedOutStop(id) {
  if (state.pagedOutStopTimers.has(id)) return; // already counting down
  const timer = setTimeout(() => {
    state.pagedOutStopTimers.delete(id);
    stopPagedOutStream(id);
  }, PAGE_OUT_STOP_DELAY_MS);
  state.pagedOutStopTimers.set(id, timer);
}

function cancelPagedOutStop(id) {
  const timer = state.pagedOutStopTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    state.pagedOutStopTimers.delete(id);
  }
}

function clearAllPagedOutStopTimers() {
  for (const timer of state.pagedOutStopTimers.values()) clearTimeout(timer);
  state.pagedOutStopTimers.clear();
}

async function stopPagedOutStream(id) {
  // Still paged-out when the timer actually fires? (Could have been paged
  // back into view and stopPlayer()'d — which clears pagedOutVideos — in
  // the gap between scheduling and firing.) Skip if not, so this never
  // stops a stream the user is back to watching.
  if (!state.pagedOutVideos.has(id)) return;
  try {
    await api(`/cameras/${id}/stream/stop`, { method: 'POST', body: { profile: 'sub' } });
  } catch (e) {
    console.error(`Gagal menghentikan live kamera #${id} (paginasi idle):`, e.message);
  }
  stopPlayer(id);
  await loadCameras();
}

// ---- Focus view (click a camera tile to enlarge it) ----

let focusHls = null;
let focusCameraId = null;
let gridResumeTimer = null;

// Browsers cap concurrent connections per host at 6 (HTTP/1.1) — with dozens
// of grid tiles all polling their own HLS playlist/segments in the
// background, a freshly-opened focus view's manifest request can end up
// queued behind them indefinitely and never actually load, even though the
// exact same stream plays fine once a slot frees up. Pausing every grid
// player while focus view is open hands the focus stream the whole
// connection budget; renderGrid() naturally restarts whichever ones are
// still cam.stream.active once it closes (same recovery path the 15s poll
// already uses).
function pauseGridPlayersForFocus() {
  for (const id of [...state.players.keys()]) stopPlayer(id);
}

// hls.js's destroy()/detachMedia() on a <video> tears down its MediaSource
// asynchronously in the browser's own media pipeline, not purely
// synchronously in JS — re-attaching a brand new Hls() to the *same* video
// element right away (close, then immediately reopen) can race that teardown
// and silently never reach a playable state, with no error surfaced. A
// cloned, never-attached element sidesteps the race entirely instead of
// needing to guess a safe delay.
function resetFocusVideoElement() {
  const oldVideo = $('#focus-video');
  const freshVideo = oldVideo.cloneNode(false);
  oldVideo.replaceWith(freshVideo);
  return freshVideo;
}

function openFocusView(cameraId) {
  const cam = state.cameras.find((c) => c.id === cameraId);
  if (!cam) return;
  // Force a genuinely fresh player on every explicit open — renderFocusModal's
  // own guard (`!focusHls && !video.currentSrc`) only prevents *redundant*
  // setup on the 15s poll-triggered re-renders of an already-playing camera;
  // it can't tell "still the same camera, don't interrupt it" apart from
  // "leftover player from a previous camera/failed attempt", so a stuck or
  // stale player from before would otherwise block any new attempt forever.
  if (focusHls) {
    focusHls.destroy();
    focusHls = null;
  }
  resetFocusVideoElement();
  // Cancel a pending resume from a just-closed previous focus view — without
  // this, closing camera A then immediately opening camera B would let A's
  // delayed renderGrid() fire *after* B's pause, restarting the exact
  // connection churn (start → immediately abort → stale-manifest 404s) this
  // whole scheme exists to avoid.
  if (gridResumeTimer) {
    clearTimeout(gridResumeTimer);
    gridResumeTimer = null;
  }
  pauseGridPlayersForFocus();
  focusCameraId = cameraId;
  $('#focus-modal').classList.remove('hidden');
  renderFocusModal(cam);

  // Grid tiles only ever run the lightweight 'sub' profile — focus view is
  // often the first time this camera's full-quality 'main' stream is needed
  // at all, and nothing else starts it automatically. Without this, opening
  // focus view just showed a black tile with a "Live" button sitting right
  // there doing nothing until the user noticed and clicked it themselves.
  // Relay cameras have nothing to start centrally (the remote agent decides
  // when to push), and an unconfigured camera has no RTSP URL to start.
  if (!cam.is_relay && cam.rtsp_url && !cam.stream.active) {
    api(`/cameras/${cameraId}/stream/start`, { method: 'POST' })
      .then(() => loadCameras())
      .then(() => {
        // User may have closed this modal or opened a different camera
        // while the start request was in flight — don't clobber whatever
        // they're looking at now with a stale render of the old one.
        if (focusCameraId !== cameraId || $('#focus-modal').classList.contains('hidden')) return;
        const freshCam = state.cameras.find((c) => c.id === cameraId);
        if (freshCam) renderFocusModal(freshCam);
      })
      .catch((e) => console.error(`Gagal menyalakan live utama untuk kamera #${cameraId}:`, e.message));
  }
}

function closeFocusView() {
  if (focusHls) {
    focusHls.destroy();
    focusHls = null;
  }
  resetFocusVideoElement();
  $('#focus-modal').classList.add('hidden');
  focusCameraId = null;
  // Debounced, not immediate — closing and immediately reopening a (maybe
  // different) camera is a common flow, and resuming every background tile
  // right away just to tear them all down again a moment later is exactly
  // the start/abort churn that leaves segments 404ing. If focus view is
  // still closed 2s later, it's a real "back to browsing the grid" moment.
  gridResumeTimer = setTimeout(() => {
    gridResumeTimer = null;
    if ($('#focus-modal')?.classList.contains('hidden')) renderGrid();
  }, 2000);
}

function renderFocusModal(cam) {
  const camLocation = state.locations.find((l) => l.id === cam.location_id);
  $('#focus-title').textContent = cam.name;
  $('#focus-subtitle').textContent = `${cam.brand || 'Tidak diketahui'} · ${cam.ip}` + (camLocation?.address ? ` · ${camLocation.address}` : '');

  const focusPill = liveStatusPillInfo(cam.stream);
  $('#focus-status-live').className = 'status-pill' + (focusPill.cls ? ` ${focusPill.cls}` : '');
  $('#focus-status-live').lastChild.textContent = focusPill.label;
  $('#focus-status-rec').className = 'status-pill' + (cam.recording_active ? ' rec-on' : '');
  $('#focus-status-motion').className = 'status-pill' + (cam.motion_active ? ' motion-on' : '');

  $('#focus-stream-btn').textContent = cam.stream.active ? 'Stop live' : 'Live';
  $('#focus-record-btn').textContent = cam.recording_active ? 'Stop rekam' : 'Rekam';
  $('#focus-motion-btn').textContent = cam.motion_detection_enabled ? 'Matikan Motion' : 'Hidupkan Motion';
  $('#focus-motion-btn').style.display = state.user.role === 'viewer' ? 'none' : '';
  $('#focus-ptz').classList.toggle('hidden', !cam.ptz_supported);

  const video = $('#focus-video');
  const placeholder = $('#focus-placeholder');
  if (cam.stream.active) {
    placeholder.classList.add('hidden');
    if (!focusHls && !video.currentSrc) {
      focusHls = attachHlsPlayer(video, `/streams/${cam.id}/index.m3u8`, () => {
        focusHls = null;
        // hls.js's destroy() (called just before this fires) does not
        // reliably clear video.currentSrc back to empty in every browser —
        // it can keep reporting the dead blob: URL indefinitely. The retry
        // below's `!video.currentSrc` guard (in the next renderFocusModal
        // call) then stays permanently false after the very first failure,
        // so attachHlsPlayer() never runs again and the tile sits stuck
        // silently (placeholder hidden, no video) no matter how many
        // retries fire. resetFocusVideoElement() (used by openFocusView/
        // closeFocusView already) replaces the element outright, which is
        // the one thing that's actually proven to leave currentSrc empty.
        resetFocusVideoElement();
        if (focusCameraId !== cam.id || $('#focus-modal').classList.contains('hidden')) return;
        placeholder.textContent = 'Gagal memuat video, mencoba lagi...';
        placeholder.classList.remove('hidden');
        setTimeout(async () => {
          if (focusCameraId !== cam.id || $('#focus-modal').classList.contains('hidden')) return;
          // Same reasoning as startPlayer()'s retry (see its comment): don't
          // decide off a state.cameras snapshot that can be stale by up to
          // 15s — a slow-to-connect WAN camera can genuinely go live in that
          // window and this would otherwise sit stuck on the old snapshot.
          await loadCameras();
          if (focusCameraId !== cam.id || $('#focus-modal').classList.contains('hidden')) return;
          const latestCam = state.cameras.find((c) => c.id === cam.id);
          if (latestCam) renderFocusModal(latestCam);
        }, 3000);
      });
    }
  } else {
    if (focusHls) {
      focusHls.destroy();
      focusHls = null;
    }
    video.removeAttribute('src');
    video.load();
    placeholder.classList.remove('hidden');
    const mainPlaceholder = streamPlaceholderInfo(cam.stream, cam.rtsp_url);
    placeholder.textContent = mainPlaceholder.text;
    placeholder.title = mainPlaceholder.title;
    placeholder.classList.toggle('placeholder-error', mainPlaceholder.isError);
  }
}

async function handleFocusAction(action) {
  const cam = state.cameras.find((c) => c.id === focusCameraId);
  if (!cam) return;
  try {
    if (action === 'stream') {
      await api(`/cameras/${cam.id}/stream/${cam.stream.active ? 'stop' : 'start'}`, { method: 'POST' });
    } else if (action === 'record') {
      await api(`/cameras/${cam.id}/recording/${cam.recording_active ? 'stop' : 'start'}`, { method: 'POST' });
    } else if (action === 'probe') {
      $('#focus-placeholder').classList.remove('hidden');
      $('#focus-placeholder').textContent = 'Menghubungi kamera via ONVIF...';
      await api(`/cameras/${cam.id}/onvif/probe`, { method: 'POST' });
    } else if (action === 'motion') {
      await api(`/cameras/${cam.id}`, {
        method: 'PUT',
        body: {
          motion_detection_enabled: !cam.motion_detection_enabled,
          motion_sensitivity: cam.motion_sensitivity || 0.04,
          motion_recording_enabled: cam.motion_recording_enabled,
        },
      });
    }
    await loadCameras();
    const updatedCam = state.cameras.find((c) => c.id === focusCameraId);
    if (updatedCam && !$('#focus-modal').classList.contains('hidden')) renderFocusModal(updatedCam);
  } catch (e) {
    showToast(e.message);
  }
}

$('#focus-close-btn')?.addEventListener('click', closeFocusView);
$('#focus-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'focus-modal') closeFocusView();
});
$('#focus-stream-btn')?.addEventListener('click', () => handleFocusAction('stream'));
$('#focus-record-btn')?.addEventListener('click', () => handleFocusAction('record'));
$('#focus-probe-btn')?.addEventListener('click', () => handleFocusAction('probe'));
$('#focus-motion-btn')?.addEventListener('click', () => handleFocusAction('motion'));
$('#focus-ptz')?.querySelectorAll('[data-focus-ptz]').forEach((btn) => {
  const move = () => focusCameraId && sendPtz(focusCameraId, btn.dataset.focusPtz);
  btn.addEventListener('mousedown', move);
  btn.addEventListener('mouseup', () => focusCameraId && sendPtz(focusCameraId, 'stop'));
  btn.addEventListener('mouseleave', () => focusCameraId && sendPtz(focusCameraId, 'stop'));
});

// ---- Start all / stop all live streams ----

// Firing stream/start for every camera back-to-back opens dozens/hundreds
// of new outbound RTSP TCP connections and ffmpeg processes within
// milliseconds of each other — enough of a CPU/network burst that already
// -connected cameras can transiently miss their own connect deadline and
// briefly reconnect too (reproduced directly: even a single new stream
// starting can knock an already-stable one into a few seconds of
// reconnecting). Spacing the starts out lets each connection actually
// establish before the next one piles on.
const STREAM_START_ALL_STAGGER_MS = 400;
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Used to target every camera in the DB — with 200 cameras that's exactly
// the ffmpeg spawn burst that overwhelmed Windows's process-creation
// subsystem (see SOFTWARE_CONCURRENCY_LIMIT in streaming.js: "spawn
// UNKNOWN" errno -4094, zero ffmpeg processes actually running). Scoping
// "Nyalakan Halaman Ini" to just the current layout page instead keeps it
// useful as a one-click way to light up what you're actually looking at,
// without ever asking the server to spawn more streams at once than fit on
// screen. Mirrors the exact slice renderGrid() shows — same
// getVisibleCameras() filter, same layout/page math — so "what's on
// screen" and "what this button turns on" never disagree.
function getCurrentPageCameras() {
  const filteredCameras = getVisibleCameras();
  const layoutDef = LAYOUTS[state.layout] || LAYOUTS.auto;
  const pageSize = layoutDef.pageSize || layoutDef.slots;
  if (!pageSize) return filteredCameras;
  const totalPages = Math.max(1, Math.ceil(filteredCameras.length / pageSize));
  const page = Math.min(Math.max(state.layoutPage, 0), totalPages - 1);
  const start = page * pageSize;
  return filteredCameras.slice(start, start + pageSize);
}

$('#stream-start-all-btn')?.addEventListener('click', async () => {
  const btn = $('#stream-start-all-btn');
  // Always targets the grid's 'sub' profile — sub streams cost far less to
  // encode than main, so more of the current page can actually go live at
  // once.
  const targets = getCurrentPageCameras().filter((c) => c.rtsp_url && !c.stream_sub.active);
  if (targets.length === 0) return;
  const estSeconds = Math.round((targets.length - 1) * STREAM_START_ALL_STAGGER_MS / 1000);
  const confirmed = await showConfirm(
    `Nyalakan ${targets.length} live view sekaligus di halaman ini? Prosesnya bertahap (~${estSeconds} detik total) agar server tidak kelebihan beban; kamera yang tidak kebagian slot encoder akan mengantre otomatis.`,
    { title: 'Nyalakan Halaman Ini', danger: false, confirmLabel: 'Ya, nyalakan' }
  );
  if (!confirmed) return;
  btn.disabled = true;
  try {
    for (let i = 0; i < targets.length; i++) {
      const cam = targets[i];
      try {
        await api(`/cameras/${cam.id}/stream/start`, { method: 'POST', body: { profile: 'sub' } });
      } catch (e) {
        console.error(`Gagal menyalakan live "${cam.name}":`, e.message);
      }
      if (i < targets.length - 1) await sleep(STREAM_START_ALL_STAGGER_MS);
    }
    await loadCameras();
  } finally {
    btn.disabled = false;
  }
});

$('#stream-stop-all-btn')?.addEventListener('click', async () => {
  const btn = $('#stream-stop-all-btn');
  // Must also catch cameras that are 'reconnecting'/queued (waiting on a
  // software encoder slot, entry.alive still false) — filtering on .active
  // alone left every queued camera out of the stop loop entirely, so a mass
  // "Nyalakan Semua" left hundreds of cameras perpetually fighting over the
  // 5 software slots even after clicking "Hentikan Semua", since they were
  // never actually told to stop.
  const targets = state.cameras.filter((c) => c.stream_sub.active || c.stream_sub.reconnecting || c.stream_sub.queued);
  if (targets.length === 0) return;
  btn.disabled = true;
  try {
    for (const cam of targets) {
      try {
        await api(`/cameras/${cam.id}/stream/stop`, { method: 'POST', body: { profile: 'sub' } });
        stopPlayer(cam.id);
      } catch (e) {
        console.error(`Gagal menghentikan live "${cam.name}":`, e.message);
      }
    }
    await loadCameras();
  } finally {
    btn.disabled = false;
  }
});

// ---- Add/Edit camera modal ----

let editingCameraId = null;
let editingCameraWasRelay = false;

function resetCameraModal() {
  $('#cam-is-relay').checked = false;
  $('#cam-relay-token-box').classList.add('hidden');
  $('#cam-relay-token-value').textContent = '';
  $('#cam-building').value = '';
}

function openCameraModal(cam) {
  resetCameraModal();
  editingCameraId = cam ? cam.id : null;
  editingCameraWasRelay = !!cam?.is_relay;
  $('#camera-modal-title').textContent = cam ? `Edit kamera: ${cam.name}` : 'Tambah kamera';
  $('#cam-save-btn').textContent = cam ? 'Simpan perubahan' : 'Simpan kamera';
  $('#cam-name').value = cam?.name || '';
  $('#cam-brand').value = cam?.brand || '';
  $('#cam-ip').value = cam?.ip || '';
  $('#cam-onvif-port').value = cam?.onvif_port || 80;
  $('#cam-rtsp-port').value = cam?.rtsp_port || 554;
  $('#cam-username').value = cam?.username || '';
  $('#cam-password').value = '';
  $('#cam-password').placeholder = cam ? 'Kosongkan kalau tidak diubah' : '';
  $('#cam-rtsp-path').value = cam?.rtsp_path || '';
  $('#cam-rtsp-path-sub').value = cam?.rtsp_path_sub || '';
  $('#cam-motion-enabled').checked = !!cam?.motion_detection_enabled;
  $('#cam-motion-recording').checked = !!cam?.motion_recording_enabled;
  $('#cam-motion-sensitivity').value = cam?.motion_sensitivity || 0.04;
  $('#cam-location').value = cam?.location_id || '';
  $('#cam-building').value = cam?.building || '';
  $('#cam-is-relay').checked = !!cam?.is_relay;
  $('#cam-form-msg').textContent = '';
  $('#cam-form-msg').className = 'form-msg';
  $('#camera-modal').classList.remove('hidden');
}

function buildRelayAgentCommand(token) {
  const ip = $('#cam-ip').value.trim();
  const port = $('#cam-rtsp-port').value || 554;
  const user = $('#cam-username').value.trim();
  const pass = $('#cam-password').value;
  const path = $('#cam-rtsp-path').value.trim() || '/Streaming/Channels/101';
  const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass || '')}@` : '';
  const rtspUrl = `rtsp://${auth}${ip}:${port}${path}`;
  return `node relay-agent.js --server=${window.location.origin} --token=${token} --rtsp="${rtspUrl}"`;
}

$('#add-camera-btn').addEventListener('click', () => openCameraModal(null));
$('#cam-cancel-btn').addEventListener('click', () => $('#camera-modal').classList.add('hidden'));

$('#cam-relay-copy-btn')?.addEventListener('click', () => {
  navigator.clipboard?.writeText($('#cam-relay-token-value').textContent);
  const btn = $('#cam-relay-copy-btn');
  const original = btn.textContent;
  btn.textContent = 'Tersalin!';
  setTimeout(() => { btn.textContent = original; }, 1500);
});

$('#cam-save-btn').addEventListener('click', async () => {
  const msg = $('#cam-form-msg');
  msg.className = 'form-msg';
  msg.textContent = '';
  try {
    const isEdit = editingCameraId !== null;
    const isRelay = $('#cam-is-relay').checked;
    const body = {
      name: $('#cam-name').value.trim(),
      brand: $('#cam-brand').value.trim(),
      ip: $('#cam-ip').value.trim(),
      onvif_port: Number($('#cam-onvif-port').value) || 80,
      rtsp_port: Number($('#cam-rtsp-port').value) || 554,
      username: $('#cam-username').value.trim(),
      rtsp_path: $('#cam-rtsp-path').value.trim(),
      rtsp_path_sub: $('#cam-rtsp-path-sub').value.trim(),
      motion_detection_enabled: $('#cam-motion-enabled').checked,
      motion_sensitivity: Number($('#cam-motion-sensitivity').value) || 0.04,
      motion_recording_enabled: $('#cam-motion-recording').checked,
      location_id: $('#cam-location').value ? Number($('#cam-location').value) : null,
      building: $('#cam-building').value.trim(),
      is_relay: isRelay,
    };
    // Blank password while editing means "leave it as-is" (we never show
    // the real one back in the form); adding a camera always sends it,
    // even empty, same as before.
    const passwordInput = $('#cam-password').value;
    if (!isEdit || passwordInput) body.password = passwordInput;
    if (!body.name || !body.ip) throw new Error('Nama dan alamat IP wajib diisi');

    const result = isEdit
      ? await api(`/cameras/${editingCameraId}`, { method: 'PUT', body })
      : await api('/cameras', { method: 'POST', body });
    msg.textContent = 'Kamera tersimpan';
    msg.classList.add('ok');

    // Only pop up the ready-to-run agent command when relay mode was just
    // turned on — re-showing it on every unrelated edit would be noise
    // ("Info Agen" on the tile covers viewing it again later).
    const justBecameRelay = isRelay && result.relay_token && (!isEdit || !editingCameraWasRelay);
    if (justBecameRelay) {
      await loadCameras();
      // Build the command from the saved camera's real rtsp_url (not the
      // form fields) — if editing and the password was left blank to keep
      // the existing one, the form field itself would be empty and produce
      // a command with a blank password.
      const savedCam = state.cameras.find((c) => c.id === (editingCameraId || result.id));
      $('#cam-relay-token-value').textContent = savedCam?.rtsp_url
        ? `node relay-agent.js --server=${window.location.origin} --token=${result.relay_token} --rtsp="${savedCam.rtsp_url}"`
        : buildRelayAgentCommand(result.relay_token);
      $('#cam-relay-token-box').classList.remove('hidden');
      // Leave the modal open so the user can copy the agent command; they
      // close it manually via "Batal" once done.
      return;
    }

    setTimeout(() => {
      $('#camera-modal').classList.add('hidden');
      ['cam-name', 'cam-brand', 'cam-ip', 'cam-username', 'cam-password', 'cam-rtsp-path', 'cam-rtsp-path-sub', 'cam-motion-sensitivity', 'cam-building'].forEach((id) => ($(`#${id}`).value = ''));
      $('#cam-motion-enabled').checked = false;
      $('#cam-motion-recording').checked = false;
      $('#cam-location').value = '';
      editingCameraId = null;
      resetCameraModal();
      loadCameras();
    }, 600);
  } catch (e) {
    msg.textContent = e.message;
    msg.classList.add('error');
  }
});

// ---- Import cameras from CSV ----

function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  if (rows.length === 0) return [];

  const header = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1)
    .filter((r) => r.some((v) => v.trim() !== ''))
    .map((r) => {
      const obj = {};
      header.forEach((h, idx) => { obj[h] = (r[idx] || '').trim(); });
      return obj;
    });
}

let importRows = [];

$('#import-csv-btn')?.addEventListener('click', () => {
  importRows = [];
  $('#import-file-input').value = '';
  $('#import-file-input').disabled = false;
  $('#import-preview').classList.add('hidden');
  $('#import-results').classList.add('hidden');
  $('#import-form-msg').textContent = '';
  $('#import-form-msg').className = 'form-msg';
  $('#import-start-btn').disabled = true;
  $('#import-modal').classList.remove('hidden');
});

$('#import-cancel-btn')?.addEventListener('click', () => $('#import-modal').classList.add('hidden'));

$('#import-template-link')?.addEventListener('click', (e) => {
  e.preventDefault();
  const csv = 'name,brand,ip,rtsp_port,onvif_port,username,password,rtsp_path,location\n'
    + 'Kamera Depan,Hikvision,192.168.1.101,554,80,admin,password123,/Streaming/Channels/101,Lokasi 1\n'
    + 'Kamera Belakang,Dahua,192.168.1.102,554,80,admin,password123,,Lokasi 1\n';
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'contoh-import-kamera.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

$('#import-file-input')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  const startBtn = $('#import-start-btn');
  const preview = $('#import-preview');
  const msg = $('#import-form-msg');
  msg.textContent = '';
  msg.className = 'form-msg';
  $('#import-results').classList.add('hidden');

  if (!file) {
    importRows = [];
    startBtn.disabled = true;
    preview.classList.add('hidden');
    return;
  }

  try {
    const text = await file.text();
    const rows = parseCsv(text);
    const valid = rows.filter((r) => r.name && r.ip);
    const invalidCount = rows.length - valid.length;
    importRows = valid;

    if (importRows.length === 0) {
      preview.classList.add('hidden');
      startBtn.disabled = true;
      msg.textContent = 'Tidak ada baris valid (name & ip wajib diisi) di file ini';
      msg.classList.add('error');
      return;
    }

    const previewRows = importRows.slice(0, 8);
    preview.innerHTML = `
      <table>
        <thead><tr><th>Name</th><th>IP</th><th>Brand</th><th>Location</th></tr></thead>
        <tbody>
          ${previewRows.map((r) => `<tr><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.ip)}</td><td>${escapeHtml(r.brand || '-')}</td><td>${escapeHtml(r.location || '-')}</td></tr>`).join('')}
        </tbody>
      </table>
      ${importRows.length > previewRows.length ? `<div style="margin-top:8px;color:var(--text-faint)">...dan ${importRows.length - previewRows.length} baris lainnya</div>` : ''}
    `;
    preview.classList.remove('hidden');
    startBtn.disabled = false;
    msg.textContent = `${importRows.length} baris siap diimpor${invalidCount ? ` (${invalidCount} baris dilewati karena name/ip kosong)` : ''}`;
    msg.classList.add('ok');
  } catch (err) {
    msg.textContent = `Gagal membaca file: ${err.message}`;
    msg.classList.add('error');
    startBtn.disabled = true;
  }
});

$('#import-start-btn')?.addEventListener('click', async () => {
  const startBtn = $('#import-start-btn');
  const resultsEl = $('#import-results');
  const msg = $('#import-form-msg');
  startBtn.disabled = true;
  $('#import-file-input').disabled = true;
  resultsEl.classList.remove('hidden');
  msg.textContent = '';
  msg.className = 'form-msg';

  let ok = 0;
  const failures = [];
  resultsEl.innerHTML = `<div class="import-progress-bar"><div class="import-progress-fill" id="import-progress-fill" style="width:0%"></div></div><div id="import-progress-label">Mengimpor 0/${importRows.length}...</div>`;

  for (let i = 0; i < importRows.length; i++) {
    const row = importRows[i];
    const loc = row.location ? state.locations.find((l) => l.name.toLowerCase() === row.location.toLowerCase()) : null;
    const body = {
      name: row.name,
      brand: row.brand || '',
      ip: row.ip,
      onvif_port: Number(row.onvif_port) || 80,
      rtsp_port: Number(row.rtsp_port) || 554,
      username: row.username || '',
      password: row.password || '',
      rtsp_path: row.rtsp_path || '',
      location_id: loc ? loc.id : null,
    };
    try {
      await api('/cameras', { method: 'POST', body });
      ok++;
    } catch (err) {
      failures.push({ row: i + 2, name: row.name, error: err.message });
    }
    const pct = Math.round(((i + 1) / importRows.length) * 100);
    $('#import-progress-fill').style.width = `${pct}%`;
    $('#import-progress-label').textContent = `Mengimpor ${i + 1}/${importRows.length}...`;
  }

  resultsEl.innerHTML = `
    <div class="import-summary">
      <span class="ok-count">${ok} berhasil</span>
      ${failures.length ? `<span class="fail-count">${failures.length} gagal</span>` : ''}
    </div>
    ${failures.length ? `
      <table>
        <thead><tr><th>Baris</th><th>Nama</th><th>Error</th></tr></thead>
        <tbody>${failures.map((f) => `<tr class="import-row-error"><td>${f.row}</td><td>${escapeHtml(f.name)}</td><td>${escapeHtml(f.error)}</td></tr>`).join('')}</tbody>
      </table>
    ` : ''}
  `;

  $('#import-file-input').disabled = false;
  await loadCameras();
  await loadLocations();
});

// ---- Locations & map ----

let leafletMap = null;
let mapMarkers = new Map(); // locationId -> marker
let editingLocationId = null;

const naturalSort = new Intl.Collator('id', { numeric: true, sensitivity: 'base' });
function sortLocationsNaturally(locations) {
  return [...locations].sort((a, b) => naturalSort.compare(a.name, b.name));
}

async function loadLocations() {
  try {
    state.locations = sortLocationsNaturally(await api('/locations'));
    renderLocationDropdown();
    renderLocationTree();
    renderLocationsTable();
    if (leafletMap) renderMapMarkers();
  } catch (e) {
    console.error(e);
  }
}

function renderLocationsTable() {
  const tbody = $('#locations-table');
  if (!tbody) return;
  const canEdit = state.user.role !== 'viewer';

  tbody.innerHTML = state.locations.map((loc) => `
    <tr>
      <td>${canEdit
        ? `<span class="location-name-inline" data-id="${loc.id}" title="Klik untuk ganti nama">${escapeHtml(loc.name)}</span>`
        : escapeHtml(loc.name)}</td>
      <td>${escapeHtml(loc.address || '-')}</td>
      <td>${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}</td>
      <td>${loc.camera_count ?? 0}</td>
      <td class="row-actions">
        <button data-loc-action="view" data-id="${loc.id}">Lihat kamera</button>
        ${canEdit ? `<button data-loc-action="edit" data-id="${loc.id}">Edit</button>` : ''}
        ${state.user.role === 'admin' ? `<button class="danger" data-loc-action="delete" data-id="${loc.id}">Hapus</button>` : ''}
      </td>
    </tr>
  `).join('') || '<tr><td colspan="5" style="color:var(--text-dim)">Belum ada lokasi</td></tr>';

  tbody.querySelectorAll('[data-loc-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const loc = state.locations.find((l) => l.id === Number(btn.dataset.id));
      if (!loc) return;
      const action = btn.dataset.locAction;
      if (action === 'view') goToLocationCameras(loc.id);
      else if (action === 'edit') openLocationModal(loc);
      else if (action === 'delete') deleteLocation(loc);
    });
  });

  tbody.querySelectorAll('.location-name-inline').forEach((span) => {
    span.addEventListener('click', () => startInlineLocationRename(span));
  });
}

function startInlineLocationRename(span) {
  const locId = Number(span.dataset.id);
  const loc = state.locations.find((l) => l.id === locId);
  if (!loc) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.value = loc.name;
  input.className = 'location-name-edit-input';
  span.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;

  const commit = async () => {
    if (settled) return;
    settled = true;
    const newName = input.value.trim();
    if (!newName || newName === loc.name) {
      renderLocationsTable();
      return;
    }
    try {
      await api(`/locations/${locId}`, { method: 'PUT', body: { name: newName } });
      await loadLocations();
    } catch (e) {
      showToast(e.message);
      renderLocationsTable();
    }
  };

  const cancel = () => {
    if (settled) return;
    settled = true;
    renderLocationsTable();
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });
}

function renderLocationDropdown() {
  const select = $('#cam-location');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">Tidak ditentukan</option>' +
    state.locations.map((l) => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('');
  select.value = current;
}

function renderLeaf(cam) {
  return `
    <div class="tree-leaf" data-tree-cam="${cam.id}">
      <span class="tree-cam-dot ${cam.stream?.active ? 'live' : ''}"></span>${escapeHtml(cam.name)}
    </div>
  `;
}

// Line icons matching the rest of the app's sidebar/button icon language —
// stroke="currentColor" so each one inherits whatever color its row already
// has (muted by default, accent when active) instead of a fixed emoji tint.
const ICON_CAMERA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 10l4.55-2.28A1 1 0 0 1 21 8.62v6.76a1 1 0 0 1-1.45.9L15 14"/><rect x="3" y="6" width="12" height="12" rx="2"/></svg>';
const ICON_FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>';
const ICON_BUILDING = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="1"/><path d="M9 8h.01M14 8h.01M9 12h.01M14 12h.01M9 16h.01M14 16h.01"/></svg>';
const ICON_CHEVRON_RIGHT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';

function closeLocationDropdown() {
  $('#location-dropdown-btn')?.classList.remove('open');
  $('#location-tree-panel')?.classList.add('hidden');
}
function toggleLocationDropdown() {
  const btn = $('#location-dropdown-btn');
  const panel = $('#location-tree-panel');
  if (!btn || !panel) return;
  const opening = panel.classList.contains('hidden');
  if (!opening) { closeLocationDropdown(); return; }

  btn.classList.add('open');
  panel.classList.remove('hidden');
  // Positioned via JS instead of CSS anchoring to the button: the button
  // lives inside the sidebar, which on mobile is a transformed (slide-in)
  // element and therefore becomes the containing block for anything
  // absolutely/fixed-positioned inside it — its own overflow-y:auto would
  // then clip the panel. Computing fixed coordinates from the button's own
  // viewport rect sidesteps that entirely, same as the tile "..." menu.
  const rect = btn.getBoundingClientRect();
  const panelWidth = panel.offsetWidth;
  const panelHeight = panel.offsetHeight;
  const openUpward = window.innerHeight - rect.bottom < panelHeight + 12 && rect.top > panelHeight + 12;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - panelWidth - 8));
  panel.style.left = `${left}px`;
  panel.style.top = openUpward ? `${Math.max(8, rect.top - 6 - panelHeight)}px` : `${rect.bottom + 6}px`;
}
$('#location-dropdown-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleLocationDropdown();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#location-tree-panel') && !e.target.closest('#location-dropdown-btn')) closeLocationDropdown();
});
window.addEventListener('scroll', closeLocationDropdown, true);
window.addEventListener('resize', closeLocationDropdown);

function updateLocationDropdownLabel() {
  const label = $('#location-dropdown-label');
  if (!label) return;
  if (!state.locationFilter) {
    label.textContent = `Semua Kamera (${state.cameras.length})`;
    return;
  }
  const loc = state.locations.find((l) => l.id === state.locationFilter);
  label.textContent = state.buildingFilter
    ? `${loc?.name || 'Lokasi'} • ${state.buildingFilter.building}`
    : (loc?.name || 'Lokasi');
}

function renderLocationTree() {
  const wrap = $('#location-tree');
  if (!wrap) return;
  updateLocationDropdownLabel();

  const rows = [`
    <div class="tree-row tree-root ${!state.locationFilter ? 'active' : ''}" data-tree-loc="">
      <span class="tree-toggle-spacer"></span>
      <span class="tree-icon">${ICON_CAMERA}</span>
      <span class="tree-label">Semua Kamera</span>
      <span class="tree-count">${state.cameras.length}</span>
    </div>
  `];

  for (const loc of state.locations) {
    const camsInLoc = state.cameras.filter((c) => c.location_id === loc.id);
    const locKey = `loc-${loc.id}`;
    const expanded = state.treeExpanded.has(locKey);
    const locActive = state.locationFilter === loc.id && !state.buildingFilter;

    // Cameras with a "Gedung" set branch into their own sub-folder; cameras
    // without one stay as direct leaves under the location, same as before.
    const buildingNames = [...new Set(camsInLoc.filter((c) => c.building).map((c) => c.building))].sort();
    const noBuilding = camsInLoc.filter((c) => !c.building);

    rows.push(`
      <div class="tree-row ${locActive ? 'active' : ''}" data-tree-loc="${loc.id}">
        <button class="tree-toggle ${expanded ? 'expanded' : ''}" data-tree-toggle="${locKey}" title="${expanded ? 'Lipat' : 'Buka'}">${ICON_CHEVRON_RIGHT}</button>
        <span class="tree-icon">${ICON_FOLDER}</span>
        <span class="tree-label">${escapeHtml(loc.name)}</span>
        <span class="tree-count">${camsInLoc.length}</span>
      </div>
      <div class="tree-children ${expanded ? '' : 'hidden'}">
        ${buildingNames.map((bldg) => {
          const bldgKey = `bldg-${loc.id}-${bldg}`;
          const bldgExpanded = state.treeExpanded.has(bldgKey);
          const bldgCams = camsInLoc.filter((c) => c.building === bldg);
          const bldgActive = state.buildingFilter && state.buildingFilter.locationId === loc.id && state.buildingFilter.building === bldg;
          return `
            <div class="tree-row tree-row-bldg ${bldgActive ? 'active' : ''}" data-tree-bldg-loc="${loc.id}" data-tree-bldg-name="${escapeHtml(bldg)}">
              <button class="tree-toggle ${bldgExpanded ? 'expanded' : ''}" data-tree-toggle="${bldgKey}" title="${bldgExpanded ? 'Lipat' : 'Buka'}">${ICON_CHEVRON_RIGHT}</button>
              <span class="tree-icon">${ICON_BUILDING}</span>
              <span class="tree-label">${escapeHtml(bldg)}</span>
              <span class="tree-count">${bldgCams.length}</span>
            </div>
            <div class="tree-children tree-children-2 ${bldgExpanded ? '' : 'hidden'}">
              ${bldgCams.map(renderLeaf).join('')}
            </div>
          `;
        }).join('')}
        ${noBuilding.map(renderLeaf).join('')}
        ${camsInLoc.length === 0 ? '<div class="tree-empty">Tidak ada kamera</div>' : ''}
      </div>
    `);
  }

  wrap.innerHTML = rows.join('');

  wrap.querySelectorAll('[data-tree-toggle]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = btn.dataset.treeToggle;
      if (state.treeExpanded.has(key)) state.treeExpanded.delete(key);
      else state.treeExpanded.add(key);
      renderLocationTree();
    });
  });
  wrap.querySelectorAll('[data-tree-loc]').forEach((row) => {
    row.addEventListener('click', () => {
      state.locationFilter = row.dataset.treeLoc ? Number(row.dataset.treeLoc) : null;
      state.buildingFilter = null;
      state.layoutPage = 0;
      renderLocationTree();
      renderGrid();
      closeLocationDropdown();
    });
  });
  wrap.querySelectorAll('[data-tree-bldg-loc]').forEach((row) => {
    row.addEventListener('click', () => {
      const locationId = Number(row.dataset.treeBldgLoc);
      state.locationFilter = locationId;
      state.buildingFilter = { locationId, building: row.dataset.treeBldgName };
      state.layoutPage = 0;
      renderLocationTree();
      renderGrid();
      closeLocationDropdown();
    });
  });
  wrap.querySelectorAll('[data-tree-cam]').forEach((leaf) => {
    leaf.addEventListener('click', (e) => {
      e.stopPropagation();
      const cam = state.cameras.find((c) => c.id === Number(leaf.dataset.treeCam));
      if (!cam) return;
      state.locationFilter = cam.location_id;
      state.buildingFilter = cam.building ? { locationId: cam.location_id, building: cam.building } : null;
      renderLocationTree();
      renderGrid();
      closeLocationDropdown();
      openFocusView(cam.id);
    });
  });
}

const CAPABILITY_PREDICATES = {
  ptz: (c) => !!c.ptz_supported,
  motion: (c) => !!c.motion_detection_enabled,
  recording: (c) => !!c.recording_enabled,
  relay: (c) => !!c.is_relay,
};

function renderStatusFilters() {
  const select = $('#status-filter-select');
  if (select) {
    const activeCount = state.cameras.filter((c) => c.stream?.active).length;
    const inactiveCount = state.cameras.length - activeCount;
    select.options[0].textContent = `Semua Status (${state.cameras.length})`;
    select.options[1].textContent = `Aktif (${activeCount})`;
    select.options[2].textContent = `Tidak Aktif (${inactiveCount})`;
    select.value = state.statusFilter || '';
  }

  const capSelect = $('#capability-filter-select');
  if (capSelect) {
    const labels = {
      ptz: 'Mendukung PTZ',
      motion: 'Motion Detection Aktif',
      recording: 'Rekaman Berkelanjutan Aktif',
      relay: 'Kamera Relay',
    };
    capSelect.options[0].textContent = `Semua Fungsi (${state.cameras.length})`;
    Array.from(capSelect.options).slice(1).forEach((opt) => {
      const count = state.cameras.filter(CAPABILITY_PREDICATES[opt.value]).length;
      opt.textContent = `${labels[opt.value]} (${count})`;
    });
    capSelect.value = state.capabilityFilter || '';
  }

  const favBtn = $('#favorite-filter-btn');
  if (favBtn) {
    const favCount = state.cameras.filter((c) => c.is_favorite).length;
    $('#favorite-filter-label').textContent = `Favorit (${favCount})`;
    favBtn.classList.toggle('active', state.favoriteFilter);
  }
}

$('#status-filter-select')?.addEventListener('change', (e) => {
  state.statusFilter = e.target.value || null;
  state.layoutPage = 0;
  renderGrid();
});

$('#capability-filter-select')?.addEventListener('change', (e) => {
  state.capabilityFilter = e.target.value || null;
  state.layoutPage = 0;
  renderGrid();
});

$('#favorite-filter-btn')?.addEventListener('click', () => {
  state.favoriteFilter = !state.favoriteFilter;
  state.layoutPage = 0;
  renderStatusFilters();
  renderGrid();
});

function getVisibleCameras() {
  let list = state.cameras;
  if (state.locationFilter) {
    list = list.filter((c) => c.location_id === state.locationFilter);
  }
  if (state.buildingFilter) {
    list = list.filter((c) => c.location_id === state.buildingFilter.locationId && c.building === state.buildingFilter.building);
  }
  if (state.statusFilter === 'active') {
    list = list.filter((c) => c.stream?.active);
  } else if (state.statusFilter === 'inactive') {
    list = list.filter((c) => !c.stream?.active);
  }
  if (state.capabilityFilter && CAPABILITY_PREDICATES[state.capabilityFilter]) {
    list = list.filter(CAPABILITY_PREDICATES[state.capabilityFilter]);
  }
  if (state.favoriteFilter) {
    list = list.filter((c) => c.is_favorite);
  }
  const q = state.cameraSearch.trim().toLowerCase();
  if (q) {
    list = list.filter((c) => {
      const loc = state.locations.find((l) => l.id === c.location_id);
      const haystack = [c.name, c.ip, c.brand, loc?.name].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }
  return list;
}

$('#camera-search-input')?.addEventListener('input', (e) => {
  state.cameraSearch = e.target.value;
  state.layoutPage = 0;
  $('#camera-search-clear')?.classList.toggle('hidden', !state.cameraSearch);
  renderGrid();
});

$('#camera-search-clear')?.addEventListener('click', () => {
  state.cameraSearch = '';
  $('#camera-search-input').value = '';
  $('#camera-search-clear').classList.add('hidden');
  state.layoutPage = 0;
  renderGrid();
});

// ---- Device table (Perangkat) — HikCentral-style camera inventory list ----

const PASSWORD_STRENGTH_LABEL = { strong: 'Kuat', medium: 'Sedang', weak: 'Lemah' };

function getFilteredDevices() {
  const q = state.deviceSearch.trim().toLowerCase();
  if (!q) return state.cameras;
  return state.cameras.filter((c) => {
    const haystack = [c.name, c.ip, c.serial_number, c.brand].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(q);
  });
}

function renderDeviceTable() {
  const tbody = $('#devices-table');
  if (!tbody) return;

  const filtered = getFilteredDevices();
  const pageSize = state.devicePageSize;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  if (state.devicePage > totalPages - 1) state.devicePage = totalPages - 1;
  if (state.devicePage < 0) state.devicePage = 0;
  const pageItems = filtered.slice(state.devicePage * pageSize, state.devicePage * pageSize + pageSize);

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="color:var(--text-dim)">Tidak ada perangkat ditemukan.</td></tr>';
  } else {
    tbody.innerHTML = pageItems.map((cam) => {
      const canEdit = state.user.role !== 'viewer';
      const canDelete = state.user.role === 'admin';
      const online = cam.network_status === 'online';
      return `
        <tr>
          <td><a href="#" class="device-name-link" data-device-action="detail" data-id="${cam.id}">${escapeHtml(cam.name)}</a></td>
          <td>${escapeHtml(cam.ip)}</td>
          <td>${escapeHtml(cam.serial_number || '-')}</td>
          <td>${escapeHtml(cam.firmware_version || '-')}</td>
          <td>${cam.channel_count || 1}</td>
          <td><span class="net-badge ${online ? 'online' : 'offline'}"><span class="net-badge-dot"></span>${online ? 'Online' : 'Offline'}</span></td>
          <td><span class="pw-strength-badge ${cam.password_strength || 'weak'}">${PASSWORD_STRENGTH_LABEL[cam.password_strength] || 'Lemah'}</span></td>
          <td class="row-actions">
            ${canEdit ? `<button data-device-action="edit" data-id="${cam.id}">Edit</button>` : ''}
            ${canEdit && !cam.is_relay ? `<button data-device-action="probe" data-id="${cam.id}">Probe ONVIF</button>` : ''}
            ${canDelete ? `<button data-device-action="delete" data-id="${cam.id}" class="danger">Hapus</button>` : ''}
          </td>
        </tr>
      `;
    }).join('');
  }

  tbody.querySelectorAll('[data-device-action]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      handleDeviceAction(el.dataset.deviceAction, Number(el.dataset.id));
    });
  });

  $('#devices-total-label').textContent = `Total: ${filtered.length}`;
  $('#devices-page-input').value = state.devicePage + 1;
  $('#devices-page-total').textContent = `/ ${totalPages}`;
}

async function handleDeviceAction(action, id) {
  const cam = state.cameras.find((c) => c.id === id);
  if (!cam) return;
  if (action === 'detail') {
    openDeviceDetail(cam);
    return;
  }
  if (action === 'edit') {
    openCameraModal(cam);
    return;
  }
  try {
    if (action === 'probe') {
      await api(`/cameras/${id}/onvif/probe`, { method: 'POST' });
      showToast(`Probe ONVIF "${cam.name}" berhasil.`);
      await loadCameras();
    } else if (action === 'delete') {
      if (!(await showConfirm(`Hapus kamera "${cam.name}"?`, { title: 'Hapus Kamera' }))) return;
      await api(`/cameras/${id}`, { method: 'DELETE' });
      await loadCameras();
    }
  } catch (e) {
    showToast(e.message);
  }
}

$('#device-add-btn')?.addEventListener('click', () => openCameraModal(null));

// Probe every non-relay device sequentially (each ONVIF round-trip already
// takes seconds on its own — no extra artificial delay needed between them,
// unlike stream-start-all's ffmpeg spawns which return almost instantly and
// need pacing to avoid a burst).
$('#device-probe-all-btn')?.addEventListener('click', async () => {
  const btn = $('#device-probe-all-btn');
  const targets = state.cameras.filter((c) => !c.is_relay);
  if (targets.length === 0) return;
  btn.disabled = true;
  const originalHtml = btn.innerHTML;
  let ok = 0;
  let failed = 0;
  try {
    for (let i = 0; i < targets.length; i++) {
      btn.textContent = `Probing ${i + 1}/${targets.length}...`;
      try {
        await api(`/cameras/${targets[i].id}/onvif/probe`, { method: 'POST' });
        ok += 1;
      } catch (e) {
        failed += 1;
        console.error(`Gagal probe "${targets[i].name}":`, e.message);
      }
    }
    await loadCameras();
    showToast(`Probe selesai: ${ok} berhasil, ${failed} gagal.`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
});

// ---- Device detail page (Informasi Dasar — basic connection info only;
// motion/location/relay settings still live in the full openCameraModal,
// reached via the "Edit" row action) ----

let deviceDetailId = null;

// Mirrors src/cameras.js's passwordStrength() exactly — duplicated
// intentionally so the strength meter updates live as the admin types,
// without a round-trip per keystroke.
function computePasswordStrength(password) {
  if (!password) return null;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(password)).length;
  if (password.length >= 10 && classes >= 3) return 'strong';
  if (password.length >= 8 && classes >= 2) return 'medium';
  return 'weak';
}

function updatePasswordMeter() {
  const strength = computePasswordStrength($('#dd-password').value);
  const bar = $('#dd-password-bar');
  const label = $('#dd-password-label');
  bar.className = `password-strength-bar${strength ? ` ${strength}` : ''}`;
  label.className = `password-strength-label${strength ? ` ${strength}` : ''}`;
  label.textContent = strength ? PASSWORD_STRENGTH_LABEL[strength] : '';
}

function openDeviceDetail(cam) {
  deviceDetailId = cam.id;
  $('#device-detail-title').textContent = cam.name;
  $('#device-detail-open-link').href = `http://${cam.ip}`;
  $('#dd-ip').value = cam.ip || '';
  $('#dd-rtsp-port').value = cam.rtsp_port || 554;
  $('#dd-onvif-port').value = cam.onvif_port || 80;
  $('#dd-name').value = cam.name || '';
  $('#dd-username').value = cam.username || '';
  $('#dd-password').value = '';
  updatePasswordMeter();
  $('#dd-form-msg').textContent = '';
  $('#dd-form-msg').className = 'form-msg';
  $('#devices-list-view').classList.add('hidden');
  $('#devices-detail-view').classList.remove('hidden');
}

function closeDeviceDetail() {
  deviceDetailId = null;
  $('#devices-detail-view').classList.add('hidden');
  $('#devices-list-view').classList.remove('hidden');
}

$('#dd-password')?.addEventListener('input', updatePasswordMeter);
$('#device-detail-back-btn')?.addEventListener('click', closeDeviceDetail);
$('#dd-cancel-btn')?.addEventListener('click', closeDeviceDetail);

$('#dd-save-btn')?.addEventListener('click', async () => {
  const msg = $('#dd-form-msg');
  msg.className = 'form-msg';
  msg.textContent = '';
  try {
    const name = $('#dd-name').value.trim();
    const ip = $('#dd-ip').value.trim();
    if (!name || !ip) throw new Error('Nama dan alamat IP wajib diisi');
    const body = {
      name,
      ip,
      rtsp_port: Number($('#dd-rtsp-port').value) || 554,
      onvif_port: Number($('#dd-onvif-port').value) || 80,
      username: $('#dd-username').value.trim(),
    };
    const passwordInput = $('#dd-password').value;
    if (passwordInput) body.password = passwordInput;

    await api(`/cameras/${deviceDetailId}`, { method: 'PUT', body });
    msg.textContent = 'Tersimpan';
    msg.classList.add('ok');
    await loadCameras();
    setTimeout(closeDeviceDetail, 700);
  } catch (e) {
    msg.textContent = e.message;
    msg.classList.add('error');
  }
});

$('#device-search-input')?.addEventListener('input', (e) => {
  state.deviceSearch = e.target.value;
  state.devicePage = 0;
  $('#device-search-clear')?.classList.toggle('hidden', !state.deviceSearch);
  renderDeviceTable();
});

$('#device-search-clear')?.addEventListener('click', () => {
  state.deviceSearch = '';
  $('#device-search-input').value = '';
  $('#device-search-clear').classList.add('hidden');
  state.devicePage = 0;
  renderDeviceTable();
});

$('#devices-page-size')?.addEventListener('change', (e) => {
  state.devicePageSize = Number(e.target.value) || 50;
  state.devicePage = 0;
  renderDeviceTable();
});

function goToDevicePage() {
  const requested = Number($('#devices-page-input').value) || 1;
  state.devicePage = Math.max(0, requested - 1);
  renderDeviceTable();
}
$('#devices-page-go-btn')?.addEventListener('click', goToDevicePage);
$('#devices-page-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') goToDevicePage();
});

// Shared by every sub-tab strip in the app (Peta Lokasi, Rekaman,
// Pengaturan): swaps the `.active` class among a strip's buttons and
// shows/hides one panel per tab, deriving each panel's id from the
// button's own data attribute instead of a separately hand-kept tab list —
// three near-identical copies of this loop had already drifted slightly
// before this existed. `onSwitch` is where each caller's own side effects
// (lazy-loading a table, initializing Leaflet, ...) still live; this helper
// only owns the generic active/hidden toggling. Returns the activate
// function so a caller can also trigger it programmatically (see
// showMapView, which needs to restore whichever sub-tab was last active).
function wireTabStrip(containerSelector, { dataAttr = 'subtab', panelId, onSwitch } = {}) {
  const buttons = [...document.querySelectorAll(`${containerSelector} .sub-tab`)];
  function activate(tab) {
    buttons.forEach((btn) => {
      const isActive = btn.dataset[dataAttr] === tab;
      btn.classList.toggle('active', isActive);
      $(`#${panelId(btn.dataset[dataAttr])}`)?.classList.toggle('hidden', !isActive);
    });
    onSwitch?.(tab);
  }
  buttons.forEach((btn) => btn.addEventListener('click', () => activate(btn.dataset[dataAttr])));
  return activate;
}

// "Daftar Perangkat" is the default landing sub-tab (see index.html — its
// button starts with the 'active' class) since device management is the
// more frequently-used of the two merged sections. Viewers get bounced off
// it in renderNavForRole() (they can't see the sub-tab button at all).
let mapSubTab = 'devices';

// Header title + which action buttons show is per-tab: device management
// (Probe Semua / Tambah kamera) doesn't make sense while looking at
// locations, and Tambah Lokasi doesn't make sense while looking at devices
// — same header element, just repurposed instead of three separate ones.
const MAP_SUBTAB_META = {
  devices: { title: 'Perangkat', showDeviceActions: true },
  list: { title: 'Peta Lokasi', showDeviceActions: false },
  map: { title: 'Peta Lokasi', showDeviceActions: false },
};

const activateMapSubTab = wireTabStrip('#map-sub-tabs', {
  panelId: (tab) => `map-subview-${tab}`,
  onSwitch: (tab) => {
    mapSubTab = tab;
    const meta = MAP_SUBTAB_META[tab] || MAP_SUBTAB_META.list;
    const titleEl = $('#devices-map-title');
    if (titleEl) titleEl.textContent = meta.title;
    $('#device-probe-all-btn')?.classList.toggle('hidden', !meta.showDeviceActions);
    $('#device-add-btn')?.classList.toggle('hidden', !meta.showDeviceActions);
    $('#add-location-btn')?.classList.toggle('hidden', meta.showDeviceActions);
    if (tab === 'devices') {
      closeDeviceDetail(); // land on the list, not wherever a previous visit drilled into
      renderDeviceTable();
    } else if (tab === 'list') {
      renderLocationsTable();
    } else {
      initMapIfNeeded();
      // Leaflet computes tile layout from its container's size — while the
      // map div sits under a hidden tab its size is 0, so the view must be
      // refreshed once it's actually visible or tiles render misaligned/blank.
      setTimeout(() => leafletMap?.invalidateSize(), 50);
      renderMapMarkers();
    }
  },
});

function showMapView() {
  // Re-activates whichever sub-tab (devices/list/map) was last active
  // instead of always resetting to the default — the map (and its tile
  // requests) only initializes lazily once the user actually clicks the
  // "Peta" tab.
  activateMapSubTab(mapSubTab);
}

// "Device & Server" bundles four previously-separate top-level nav items
// (Rekaman, Log Peristiwa, Kesehatan Kamera, Kesehatan Server) into one,
// the same sub-tab pattern used for "Perangkat" above. "Rekaman" is the
// default landing sub-tab (first in reading order); each sub-tab's own
// data only gets (re)loaded once it's actually the one being switched to.
let devsrvSubTab = 'recordings';

const activateDevSrvSubTab = wireTabStrip('#devsrv-sub-tabs', {
  panelId: (tab) => `devsrv-subview-${tab}`,
  onSwitch: (tab) => {
    devsrvSubTab = tab;
    stopSystemHealthPolling(); // only the 'system' branch below restarts it
    if (tab === 'recordings') loadRecordings();
    else if (tab === 'events') loadEvents();
    else if (tab === 'health') loadHealthTrends(state.healthTrendDays || 7);
    else if (tab === 'system') {
      loadSystemHealth();
      state.systemHealthTimer = setInterval(loadSystemHealth, 3000);
    }
  },
});

function showDevSrvView() {
  activateDevSrvSubTab(devsrvSubTab);
}

function initMapIfNeeded() {
  if (!leafletMap && typeof L !== 'undefined') {
    leafletMap = L.map('location-map').setView([-2.5, 118], 5);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
      maxZoom: 19,
      subdomains: 'abcd',
    }).addTo(leafletMap);
    leafletMap.on('click', (e) => openLocationModal(null, e.latlng));
  }
}

// success/warn/error/neutral by how many of a location's cameras are
// currently live — same tone system as everywhere else in the app, so a
// glance at the map already tells you which site needs attention before
// opening its popup.
function locationStatusTone(camsHere) {
  if (camsHere.length === 0) return 'neutral';
  const onlineCount = camsHere.filter((c) => c.stream?.active).length;
  if (onlineCount === 0) return 'error';
  if (onlineCount === camsHere.length) return 'success';
  return 'warn';
}

function buildLocationMarkerIcon(tone) {
  return L.divIcon({
    className: 'map-marker-icon',
    html: `<span class="map-marker-dot tone-${tone}"></span>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    popupAnchor: [0, -9],
  });
}

function renderMapMarkers() {
  if (!leafletMap) return;
  for (const marker of mapMarkers.values()) leafletMap.removeLayer(marker);
  mapMarkers.clear();

  const canEdit = state.user.role !== 'viewer';
  const bounds = [];
  for (const loc of state.locations) {
    const camsHere = state.cameras.filter((c) => c.location_id === loc.id);
    const camCount = camsHere.length;
    const onlineCount = camsHere.filter((c) => c.stream?.active).length;
    const tone = locationStatusTone(camsHere);
    const marker = L.marker([loc.lat, loc.lng], { draggable: canEdit, icon: buildLocationMarkerIcon(tone) }).addTo(leafletMap);
    if (canEdit) {
      marker.on('dragend', async () => {
        const { lat, lng } = marker.getLatLng();
        const prevLat = loc.lat;
        const prevLng = loc.lng;
        try {
          await api(`/locations/${loc.id}`, { method: 'PUT', body: { lat, lng } });
          loc.lat = lat;
          loc.lng = lng;
          const confirmPopup = L.popup({ closeButton: false, autoClose: true })
            .setLatLng([lat, lng])
            .setContent('<div style="font-size:12px;font-weight:600;">✓ Posisi lokasi tersimpan</div>')
            .openOn(leafletMap);
          setTimeout(() => leafletMap.closePopup(confirmPopup), 1400);
        } catch (err) {
          marker.setLatLng([prevLat, prevLng]);
          showToast(`Gagal menyimpan posisi baru: ${err.message}`);
        }
      });
    }
    const popupEl = document.createElement('div');
    popupEl.innerHTML = `
      <div class="map-popup-title">${escapeHtml(loc.name)}</div>
      ${loc.address ? `<div class="map-popup-address">${escapeHtml(loc.address)}</div>` : ''}
      <div class="map-popup-count"><span class="tone-badge tone-${tone}">${onlineCount}/${camCount} online</span></div>
      ${camCount > 0 ? `
        <div class="map-popup-cameras">
          ${camsHere.map((c) => `
            <div class="map-popup-cam-row" data-cam-id="${c.id}">
              <span class="status-dot ${c.stream?.active ? 'online' : ''}"></span>
              <span class="map-popup-cam-name">${escapeHtml(c.name)}</span>
            </div>
          `).join('')}
        </div>
      ` : '<div class="map-popup-empty">Belum ada kamera di lokasi ini</div>'}
      <div class="map-popup-actions">
        <button class="primary" data-map-action="view">Lihat semua di Live view</button>
        <button data-map-action="edit">Edit</button>
        ${state.user.role === 'admin' ? `<button class="danger" data-map-action="delete">Hapus</button>` : ''}
      </div>
    `;
    popupEl.querySelectorAll('.map-popup-cam-row').forEach((row) => {
      row.addEventListener('click', () => openFocusView(Number(row.dataset.camId)));
    });
    popupEl.querySelector('[data-map-action="view"]').addEventListener('click', () => goToLocationCameras(loc.id));
    popupEl.querySelector('[data-map-action="edit"]').addEventListener('click', () => openLocationModal(loc));
    popupEl.querySelector('[data-map-action="delete"]')?.addEventListener('click', () => deleteLocation(loc));
    marker.bindPopup(popupEl);
    mapMarkers.set(loc.id, marker);
    bounds.push([loc.lat, loc.lng]);
  }
  if (bounds.length > 0) {
    leafletMap.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 });
  }
}

function goToLocationCameras(locationId) {
  state.locationFilter = locationId;
  state.layoutPage = 0;
  state.treeExpanded.add(locationId);
  document.querySelector('.nav-item[data-view="live"]')?.click();
  renderLocationTree();
  renderGrid();
}

function openLocationModal(loc, latlng) {
  editingLocationId = loc ? loc.id : null;
  $('#location-modal-title').textContent = loc ? `Edit lokasi: ${loc.name}` : 'Tambah lokasi';
  $('#loc-name').value = loc ? loc.name : '';
  $('#loc-address').value = loc ? (loc.address || '') : '';
  $('#loc-lat').value = loc ? loc.lat : (latlng ? latlng.lat.toFixed(6) : '');
  $('#loc-lng').value = loc ? loc.lng : (latlng ? latlng.lng.toFixed(6) : '');
  $('#location-form-msg').textContent = '';
  $('#location-form-msg').className = 'form-msg';
  $('#location-modal').classList.remove('hidden');
}

function closeLocationModal() {
  $('#location-modal').classList.add('hidden');
  editingLocationId = null;
}

let locationModalSource = null;

$('#add-location-btn')?.addEventListener('click', () => {
  locationModalSource = null;
  openLocationModal(null);
});
$('#cam-add-location-btn')?.addEventListener('click', () => {
  // No map click context here, so seed a default point (Indonesia-ish
  // center) — the user can drag the pin to the right spot later from
  // Peta Lokasi. What matters right now is not blocking the camera form.
  locationModalSource = 'camera-form';
  openLocationModal(null, { lat: -2.5, lng: 118 });
});
$('#location-cancel-btn')?.addEventListener('click', () => {
  locationModalSource = null;
  closeLocationModal();
});

$('#location-save-btn')?.addEventListener('click', async () => {
  const msg = $('#location-form-msg');
  msg.className = 'form-msg';
  msg.textContent = '';
  try {
    const body = {
      name: $('#loc-name').value.trim(),
      address: $('#loc-address').value.trim(),
      lat: $('#loc-lat').value,
      lng: $('#loc-lng').value,
    };
    if (!body.name || body.lat === '' || body.lng === '') throw new Error('Nama, latitude, dan longitude wajib diisi');

    let savedId = editingLocationId;
    if (editingLocationId) {
      await api(`/locations/${editingLocationId}`, { method: 'PUT', body });
    } else {
      const created = await api('/locations', { method: 'POST', body });
      savedId = created.id;
    }
    msg.textContent = 'Lokasi tersimpan';
    msg.classList.add('ok');
    const cameFromCameraForm = locationModalSource === 'camera-form';
    setTimeout(async () => {
      closeLocationModal();
      await loadLocations();
      if (cameFromCameraForm && savedId) $('#cam-location').value = savedId;
      locationModalSource = null;
    }, 500);
  } catch (e) {
    msg.textContent = e.message;
    msg.classList.add('error');
  }
});

async function deleteLocation(loc) {
  if (!(await showConfirm(`Hapus lokasi "${loc.name}"? Kamera yang terhubung tidak akan terhapus, hanya lepas dari lokasi ini.`, { title: 'Hapus Lokasi' }))) return;
  try {
    await api(`/locations/${loc.id}`, { method: 'DELETE' });
    await loadLocations();
  } catch (e) {
    showToast(e.message);
  }
}

async function loadRecordings() {
  try {
    const [rows, stats] = await Promise.all([api('/recordings'), api('/recordings/stats')]);

    const statsEl = $('#recordings-stats');
    if (statsEl) {
      const recordingNow = state.cameras.filter((c) => c.recording_active).length;
      const tiles = [
        { tone: 'neutral', value: stats.count, label: 'Total file rekaman' },
        { tone: 'info', value: formatBytes(stats.total_bytes), label: 'Total penyimpanan' },
        { tone: 'error', value: recordingNow, label: 'Kamera sedang merekam' },
        { tone: 'warn', value: `${stats.retention_days} hari`, label: 'Retensi otomatis' },
      ];
      statsEl.innerHTML = tiles.map((t) => `
        <div class="stat-tile">
          <div class="stat-icon tone-${t.tone}">${TONE_ICON[t.tone] || TONE_ICON.neutral}</div>
          <div class="stat-body">
            <div class="stat-value">${t.value}</div>
            <div class="stat-label">${t.label}</div>
          </div>
        </div>
      `).join('');
      animateStatTiles(statsEl);
    }

    const tbody = $('#recordings-table');
    if (!tbody) return;
    tbody.innerHTML = rows.map((r) => {
      const cam = state.cameras.find((c) => c.id === r.camera_id);
      const camLabel = cam ? cam.name : `Kamera #${r.camera_id}`;
      return `
        <tr>
          <td>${escapeHtml(camLabel)}</td>
          <td>${escapeHtml(r.filename)}</td>
          <td>${new Date(r.started_at).toLocaleString('id-ID')}</td>
          <td>${formatBytes(r.size_bytes)}</td>
          <td class="row-actions">
            <button data-recording-action="play" data-id="${r.id}" data-filename="${escapeHtml(r.filename)}" data-camera="${escapeHtml(camLabel)}">Putar</button>
            <button data-recording-action="download" data-id="${r.id}" data-filename="${escapeHtml(r.filename)}">Unduh</button>
          </td>
        </tr>
      `;
    }).join('') || '<tr><td colspan="5" style="color:var(--text-dim)">Belum ada rekaman</td></tr>';

    tbody.querySelectorAll('[data-recording-action="download"]').forEach((btn) => {
      btn.addEventListener('click', () => downloadRecording(Number(btn.dataset.id), btn.dataset.filename));
    });
    tbody.querySelectorAll('[data-recording-action="play"]').forEach((btn) => {
      btn.addEventListener('click', () => openPlayer(Number(btn.dataset.id), btn.dataset.filename, btn.dataset.camera));
    });
  } catch (e) {
    console.error(e);
  }
}

const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// ---- 3D hover tilt (camera tiles & stat tiles) ----
// Cursor position within the card maps to a small rotateX/rotateY, released
// back to flat on mouseleave — a cheap depth cue that was the other half of
// "light mode feels flat" (the color/gradient tweaks above only address the
// palette, not the interaction). Delegated on `document` instead of binding
// per-element: .tile/.stat-tile grids are re-rendered via innerHTML swaps
// constantly (renderGrid, loadDashboard, ...), so per-element listeners
// would mean re-binding every render or leaking onto discarded nodes.
(() => {
  const TILT_SELECTOR = '.tile, .stat-tile';
  let tiltEl = null;
  let tiltFrame = null;

  function resetTilt(el) {
    if (el) el.style.transform = '';
  }

  document.addEventListener('mousemove', (e) => {
    if (prefersReducedMotion()) return;
    const el = e.target.closest(TILT_SELECTOR);
    if (el !== tiltEl) {
      resetTilt(tiltEl);
      tiltEl = el;
    }
    if (!el) return;

    const clientX = e.clientX;
    const clientY = e.clientY;
    if (tiltFrame) return; // an update is already queued for this frame
    tiltFrame = requestAnimationFrame(() => {
      tiltFrame = null;
      const rect = el.getBoundingClientRect();
      const px = (clientX - rect.left) / rect.width;
      const py = (clientY - rect.top) / rect.height;
      // Camera tiles are the bigger visual anchor and read fine with a more
      // dramatic tilt; stat tiles are smaller/text-heavy, so a subtler
      // angle keeps their numbers legible instead of swimming around.
      const isTile = el.classList.contains('tile');
      const max = isTile ? 7 : 4;
      const rotateY = (px - 0.5) * max * 2;
      const rotateX = (0.5 - py) * max * 2;
      const scale = isTile ? 1.02 : 1.012;
      el.style.transform = `perspective(900px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale(${scale}) translateY(-4px)`;
    });
  }, { passive: true });

  // mouseleave doesn't bubble, but binding it directly on `document` still
  // fires once when the pointer exits the whole viewport — the one case the
  // closest()-swap logic above can't catch on its own.
  document.addEventListener('mouseleave', () => { resetTilt(tiltEl); tiltEl = null; });
})();

// Animates a stat-tile's leading number counting up from 0 to whatever value
// is already in the element (set normally beforehand, HTML markup included —
// e.g. `19.8 MB`, `80.1%`, `0<span class="stat-sub">/199</span>`). Only the
// numeric run is touched; everything before/after it (units, suffix markup)
// is preserved verbatim so this works across every stat-grid without each
// caller needing its own formatting logic.
function animateStatValue(el) {
  if (!el || prefersReducedMotion()) return;
  const targetHtml = el.innerHTML;
  const match = targetHtml.match(/\d+(\.\d+)?/);
  if (!match) return;
  const target = parseFloat(match[0]);
  const decimals = match[1] ? match[1].length - 1 : 0;
  const prefix = targetHtml.slice(0, match.index);
  const suffix = targetHtml.slice(match.index + match[0].length);
  const duration = 650;
  const start = performance.now();
  function tick(now) {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = target * eased;
    el.innerHTML = prefix + (decimals ? current.toFixed(decimals) : String(Math.round(current))) + suffix;
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function animateStatTiles(container) {
  container?.querySelectorAll('.stat-value').forEach(animateStatValue);
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

async function downloadRecording(id, filename) {
  try {
    const res = await fetch(`/api/recordings/${id}/download`, {
      headers: state.token ? { Authorization: `Bearer ${state.token}` } : {},
    });
    if (!res.ok) throw new Error('Gagal mengunduh rekaman');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'recording.mp4';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    showToast(e.message);
  }
}

// Tracks the pending loadedmetadata listener from the last openPlayer() call
// so it can be torn down instead of leaking onto the shared #player-video
// element — without this, closing the modal (or opening a different
// recording) before the listener fires left it attached, and it would still
// fire later and seek whatever video happens to be loaded next to a wrong,
// unrelated offset.
let playerSeekListener = null;

function openPlayer(id, filename, cameraLabel, seekTo = 0) {
  const video = $('#player-video');
  if (playerSeekListener) {
    video.removeEventListener('loadedmetadata', playerSeekListener);
    playerSeekListener = null;
  }
  $('#player-title').textContent = filename;
  $('#player-subtitle').textContent = cameraLabel || '';
  video.src = `/api/recordings/${id}/stream?token=${encodeURIComponent(state.token)}`;
  $('#player-download-link').href = `/api/recordings/${id}/download?token=${encodeURIComponent(state.token)}`;
  $('#player-download-link').setAttribute('download', filename || 'recording.mp4');
  $('#player-bookmark-note').value = '';
  state.currentRecording = { id, filename, cameraLabel };
  if (seekTo > 0) {
    // currentTime can't be set until the browser knows the video's
    // duration/seekable range — do it once loadedmetadata fires instead of
    // racing the still-loading <video>.
    playerSeekListener = () => { video.currentTime = seekTo; playerSeekListener = null; };
    video.addEventListener('loadedmetadata', playerSeekListener, { once: true });
  }
  $('#player-modal').classList.remove('hidden');
  video.play().catch(() => {});
}

function closePlayer() {
  const video = $('#player-video');
  if (playerSeekListener) {
    video.removeEventListener('loadedmetadata', playerSeekListener);
    playerSeekListener = null;
  }
  video.pause();
  video.removeAttribute('src');
  video.load();
  state.currentRecording = null;
  $('#player-modal').classList.add('hidden');
}

$('#player-close-btn')?.addEventListener('click', closePlayer);
$('#player-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'player-modal') closePlayer();
});

// ---- Bookmarks ----

$('#player-bookmark-btn')?.addEventListener('click', async () => {
  const recording = state.currentRecording;
  const video = $('#player-video');
  const note = $('#player-bookmark-note').value.trim();
  if (!recording) return;
  if (!note) { showToast('Isi catatan bookmark dulu'); return; }
  try {
    await api('/bookmarks', {
      method: 'POST',
      body: { recording_id: recording.id, offset_seconds: video.currentTime, note },
    });
    $('#player-bookmark-note').value = '';
    showToast('Bookmark ditambahkan', 'success');
    if (!$('#recordings-subview-bookmarks').classList.contains('hidden')) loadBookmarks();
  } catch (e) {
    showToast(e.message);
  }
});

async function loadBookmarks() {
  try {
    const rows = await api('/bookmarks');
    const tbody = $('#bookmarks-table');
    if (!tbody) return;
    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="color:var(--text-dim)">Belum ada bookmark.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((b) => {
      const cam = state.cameras.find((c) => c.id === b.camera_id);
      const camLabel = cam ? cam.name : `Kamera #${b.camera_id}`;
      return `
        <tr>
          <td>${escapeHtml(camLabel)}</td>
          <td>${parseServerDate(b.occurred_at).toLocaleString('id-ID')}</td>
          <td>${escapeHtml(b.note)}</td>
          <td>${escapeHtml(b.created_by_username || 'tidak dikenal')}</td>
          <td class="row-actions">
            <button data-bookmark-action="play" data-id="${b.id}">Putar</button>
            ${(state.user.role === 'admin' || b.created_by === state.user.id) ? `<button class="danger" data-bookmark-action="delete" data-id="${b.id}">Hapus</button>` : ''}
          </td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('[data-bookmark-action="play"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const b = rows.find((r) => r.id === Number(btn.dataset.id));
        if (!b) return;
        const cam = state.cameras.find((c) => c.id === b.camera_id);
        openPlayer(b.recording_id, b.filename, cam ? cam.name : `Kamera #${b.camera_id}`, b.offset_seconds);
      });
    });
    tbody.querySelectorAll('[data-bookmark-action="delete"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!(await showConfirm('Hapus bookmark ini?', { title: 'Hapus Bookmark' }))) return;
        try {
          await api(`/bookmarks/${btn.dataset.id}`, { method: 'DELETE' });
          loadBookmarks();
        } catch (e) {
          showToast(e.message);
        }
      });
    });
  } catch (e) {
    console.error(e);
  }
}

wireTabStrip('#recordings-sub-tabs', {
  panelId: (tab) => `recordings-subview-${tab}`,
  onSwitch: (tab) => { if (tab === 'bookmarks') loadBookmarks(); },
});

// ---- Dashboard ----

async function loadDashboard() {
  try {
    const [cameras, rawLocations, events, recStats] = await Promise.all([
      api('/cameras'),
      api('/locations'),
      api('/events'),
      api('/recordings/stats'),
    ]);
    const locations = sortLocationsNaturally(rawLocations);
    state.cameras = cameras;
    state.locations = locations;
    renderDashboard(cameras, locations, events, recStats);
    loadEventsChart(state.eventsChartDays);
  } catch (e) {
    console.error(e);
  }
}

function renderDashboard(cameras, locations, events, recStats) {
  const total = cameras.length;
  const online = cameras.filter((c) => c.stream.active).length;
  const recording = cameras.filter((c) => c.recording_active).length;
  const motionActive = cameras.filter((c) => c.motion_active).length;

  const statsEl = $('#dashboard-stats');
  if (statsEl) {
    const tiles = [
      { tone: 'info', value: total, label: 'Total kamera' },
      { tone: 'success', value: `${online}<span class="stat-sub">/${total}</span>`, label: 'Live aktif sekarang' },
      { tone: 'error', value: recording, label: 'Sedang merekam' },
      { tone: 'warn', value: motionActive, label: 'Motion aktif' },
      { tone: 'user', value: locations.length, label: 'Lokasi terdaftar' },
      { tone: 'neutral', value: formatBytes(recStats.total_bytes), label: `Penyimpanan rekaman (${recStats.count} file)` },
    ];
    statsEl.innerHTML = tiles.map((t) => `
      <div class="stat-tile">
        <div class="stat-icon tone-${t.tone}">${TONE_ICON[t.tone] || TONE_ICON.neutral}</div>
        <div class="stat-body">
          <div class="stat-value">${t.value}</div>
          <div class="stat-label">${t.label}</div>
        </div>
      </div>
    `).join('');
    animateStatTiles(statsEl);
  }

  const locEl = $('#dashboard-locations');
  if (locEl) {
    if (locations.length === 0) {
      locEl.innerHTML = '<div class="empty-state">Belum ada lokasi. Tambahkan di menu Peta Lokasi.</div>';
    } else {
      // Column order per request: kamera aktif/off, lokasi kamera, jumlah
      // kamera per lokasi, lalu "kesehatan" — there's no real battery
      // telemetry anywhere in this app (these are IP/RTSP cameras, not
      // battery-powered devices), so that last column reuses the same
      // online-ratio already computed here, just framed as a health score
      // instead of a bare online count.
      const rows = locations.map((loc) => {
        const camsHere = cameras.filter((c) => c.location_id === loc.id);
        const onlineHere = camsHere.filter((c) => c.stream.active).length;
        const offlineHere = camsHere.length - onlineHere;
        const pct = camsHere.length ? Math.round((onlineHere / camsHere.length) * 100) : 0;
        const healthTone = pct >= 80 ? 'good' : pct >= 40 ? 'warn' : 'bad';
        return `
          <div class="location-status-row" data-loc-id="${loc.id}">
            <div class="location-status-counts">
              <span class="location-count-pill online"><span class="dot"></span>${onlineHere} aktif</span>
              <span class="location-count-pill offline"><span class="dot"></span>${offlineHere} off</span>
            </div>
            <div class="location-status-name">${escapeHtml(loc.name)}</div>
            <div class="location-status-count-text">${camsHere.length} kamera di ${escapeHtml(loc.name)}</div>
            <div class="location-status-health">
              <div class="location-status-bar"><div class="location-status-fill tone-${healthTone}" style="width:${pct}%"></div></div>
              <span class="location-status-pct tone-${healthTone}">${pct}%</span>
            </div>
          </div>
        `;
      }).join('');
      locEl.innerHTML = `
        <div class="location-status-header">
          <span>Aktif/Off</span>
          <span>Lokasi</span>
          <span>Jumlah Kamera</span>
          <span>Kesehatan</span>
        </div>
        ${rows}
      `;
      locEl.querySelectorAll('[data-loc-id]').forEach((row) => {
        row.addEventListener('click', () => goToLocationCameras(Number(row.dataset.locId)));
      });
    }
  }

  const evEl = $('#dashboard-events');
  if (evEl) {
    const recent = events.slice(0, 6);
    if (recent.length === 0) {
      evEl.innerHTML = '<div class="empty-state">Belum ada aktivitas.</div>';
    } else {
      evEl.innerHTML = recent.map((r) => {
        const meta = EVENT_META[r.type] || { label: r.type, tone: 'neutral' };
        return `
          <div class="event-item tone-${meta.tone}">
            <div class="event-icon">${TONE_ICON[meta.tone] || TONE_ICON.neutral}</div>
            <div class="event-body">
              <div class="event-top">
                <span class="event-title">${escapeHtml(meta.label)}</span>
                <span class="event-time">${new Date(r.created_at).toLocaleString('id-ID')}</span>
              </div>
            </div>
          </div>
        `;
      }).join('');
    }
  }
}

// ---- Kesehatan Kamera (uptime trends) ----
// Reachability (TCP-probe based, independent of whether anyone has the live
// view open) is tracked server-side in the events table as camera_offline/
// camera_online transitions; /api/health-trends turns that into per-camera
// uptime% and downtime intervals for a chosen window instead of raw events.

function formatDuration(ms) {
  if (!ms || ms < 60000) return '< 1 menit';
  const totalMin = Math.round(ms / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const min = totalMin % 60;
  const parts = [];
  if (days) parts.push(`${days}h`);
  if (hours) parts.push(`${hours}j`);
  if (min && !days) parts.push(`${min}m`); // skip minutes once we're into multi-day downtime — not actionable precision
  return parts.join(' ') || '< 1 menit';
}

// Matches the app's existing status semantics (live=green healthy, warn=amber
// degraded, rec=red critical) rather than a generic sequential ramp — uptime
// here is a state judgment (fine / watch / bad), not a plain magnitude.
function uptimeTone(pct) {
  if (pct >= 99) return 'success';
  if (pct >= 95) return 'warn';
  return 'error';
}

function renderHealthTimeline(intervals, windowStart, windowEnd) {
  const totalMs = Math.max(1, windowEnd - windowStart);
  const segs = intervals.map((iv) => {
    const left = ((Math.max(iv.start, windowStart) - windowStart) / totalMs) * 100;
    const width = ((Math.min(iv.end, windowEnd) - Math.max(iv.start, windowStart)) / totalMs) * 100;
    return `<div class="health-timeline-seg" style="left:${left}%;width:${Math.max(width, 0.4)}%"></div>`;
  }).join('');
  return `<div class="health-timeline">${segs}</div>`;
}

async function loadHealthTrends(days) {
  state.healthTrendDays = days;
  document.querySelectorAll('#health-range-picker .chip').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.days) === days);
  });
  const tbody = $('#health-trends-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Memuat data kesehatan kamera...</td></tr>';
  try {
    const data = await api(`/health-trends/trends?days=${days}`);
    renderHealthTrends(data);
  } catch (e) {
    console.error(e);
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="empty-state">Gagal memuat: ${escapeHtml(e.message)}</td></tr>`;
  }
}

function renderHealthTrends(data) {
  const { cameras, window_start, window_end } = data;
  const locMap = new Map(state.locations.map((l) => [l.id, l.name]));

  const statsEl = $('#health-stats');
  if (statsEl) {
    const avgUptime = cameras.length ? cameras.reduce((s, c) => s + c.uptime_pct, 0) / cameras.length : 100;
    const currentlyOffline = cameras.filter((c) => c.currently_offline).length;
    const totalOfflineEvents = cameras.reduce((s, c) => s + c.offline_count, 0);
    const worst = cameras.length ? [...cameras].sort((a, b) => a.uptime_pct - b.uptime_pct)[0] : null;

    const tiles = [
      { tone: uptimeTone(avgUptime), value: `${avgUptime.toFixed(1)}%`, label: 'Rata-rata uptime' },
      { tone: currentlyOffline > 0 ? 'error' : 'success', value: currentlyOffline, label: 'Kamera offline sekarang' },
      { tone: totalOfflineEvents > 0 ? 'warn' : 'success', value: totalOfflineEvents, label: 'Total kejadian offline' },
      { tone: 'neutral', value: worst ? `${worst.uptime_pct.toFixed(1)}%` : '-', label: worst ? `Uptime terendah — ${worst.name}` : 'Uptime terendah' },
    ];
    statsEl.innerHTML = tiles.map((t) => `
      <div class="stat-tile">
        <div class="stat-icon tone-${t.tone}">${TONE_ICON[t.tone] || TONE_ICON.neutral}</div>
        <div class="stat-body">
          <div class="stat-value">${t.value}</div>
          <div class="stat-label">${escapeHtml(String(t.label))}</div>
        </div>
      </div>
    `).join('');
    animateStatTiles(statsEl);
  }

  const tbody = $('#health-trends-tbody');
  if (!tbody) return;
  if (cameras.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Belum ada kamera.</td></tr>';
    return;
  }
  // Worst first — the whole point of this view is spotting what needs
  // attention, not an alphabetical camera list (Live view already has one).
  const sorted = [...cameras].sort((a, b) => a.uptime_pct - b.uptime_pct);
  tbody.innerHTML = sorted.map((c) => {
    const locName = c.location_id ? (locMap.get(c.location_id) || '-') : '-';
    const tone = uptimeTone(c.uptime_pct);
    return `
      <tr>
        <td>${escapeHtml(c.name)}${c.is_relay ? ' <span class="relay-badge" title="Kamera relay">📡</span>' : ''}</td>
        <td>${escapeHtml(locName)}</td>
        <td><span class="health-status-badge ${c.currently_offline ? 'offline' : 'online'}"><span class="status-dot"></span>${c.currently_offline ? 'Offline' : 'Online'}</span></td>
        <td><span class="health-uptime-pill tone-${tone}">${c.uptime_pct.toFixed(1)}%</span></td>
        <td>${formatDuration(c.downtime_ms)}</td>
        <td>${c.offline_count}</td>
        <td>${renderHealthTimeline(c.intervals, window_start, window_end)}</td>
      </tr>
    `;
  }).join('');
}

document.querySelectorAll('#health-range-picker .chip').forEach((btn) => {
  btn.addEventListener('click', () => loadHealthTrends(Number(btn.dataset.days)));
});

// ---- "Kesehatan Server" (CPU/RAM) ----
// Opposite direction from uptimeTone: here higher % is worse (busier CPU,
// fuller RAM), not better.
function usageTone(pct) {
  if (pct >= 90) return 'error';
  if (pct >= 75) return 'warn';
  return 'success';
}

async function loadSystemHealth() {
  try {
    const data = await api('/system-health');
    renderSystemHealth(data);
  } catch (e) {
    console.error(e);
  }
}

function renderSystemHealth(data) {
  const { cpu, memory, process: proc, system } = data;

  const statsEl = $('#sys-stats');
  if (statsEl) {
    const tiles = [
      { tone: usageTone(cpu.percent), value: `${cpu.percent}%`, label: `CPU (${cpu.core_count} core)` },
      { tone: usageTone(memory.percent), value: `${memory.percent}%`, label: 'RAM terpakai' },
      { tone: 'neutral', value: formatDuration(system.uptime_seconds * 1000), label: 'Waktu aktif server' },
      { tone: 'neutral', value: cpu.load_average[0] ? cpu.load_average[0].toFixed(2) : '-', label: 'Load average (1 menit)' },
    ];
    statsEl.innerHTML = tiles.map((t) => `
      <div class="stat-tile">
        <div class="stat-icon tone-${t.tone}">${TONE_ICON[t.tone] || TONE_ICON.neutral}</div>
        <div class="stat-body">
          <div class="stat-value">${t.value}</div>
          <div class="stat-label">${escapeHtml(String(t.label))}</div>
        </div>
      </div>
    `).join('');
    animateStatTiles(statsEl);
  }

  const cpuFill = $('#sys-cpu-fill');
  if (cpuFill) { cpuFill.style.width = `${cpu.percent}%`; cpuFill.className = `sys-meter-fill tone-${usageTone(cpu.percent)}`; }
  const cpuValue = $('#sys-cpu-value');
  if (cpuValue) cpuValue.textContent = `${cpu.percent}%`;

  const coreGrid = $('#sys-core-grid');
  if (coreGrid) {
    coreGrid.innerHTML = cpu.cores.map((pct, i) => `
      <div class="sys-core-row" title="Core ${i}: ${pct}%">
        <span class="sys-core-label">${i}</span>
        <div class="sys-core-bar"><div class="sys-core-fill tone-${usageTone(pct)}" style="width:${pct}%"></div></div>
      </div>
    `).join('');
  }

  const memFill = $('#sys-mem-fill');
  if (memFill) { memFill.style.width = `${memory.percent}%`; memFill.className = `sys-meter-fill tone-${usageTone(memory.percent)}`; }
  const memValue = $('#sys-mem-value');
  if (memValue) memValue.textContent = `${memory.percent}%`;

  const memDetail = $('#sys-mem-detail');
  if (memDetail) {
    memDetail.textContent = `${formatBytes(memory.used_bytes)} terpakai dari ${formatBytes(memory.total_bytes)} (${formatBytes(memory.free_bytes)} bebas)`;
  }

  const infoGrid = $('#sys-info-grid');
  if (infoGrid) {
    const rows = [
      ['Hostname', system.hostname || '-'],
      ['Platform', system.platform || '-'],
      ['Memori Proses (RSS)', formatBytes(proc.rss_bytes)],
      ['Waktu Aktif Proses', formatDuration(proc.uptime_seconds * 1000)],
    ];
    infoGrid.innerHTML = rows.map(([label, value]) => `
      <div class="about-row">
        <span class="about-label">${escapeHtml(label)}</span>
        <span class="about-value">${escapeHtml(value)}</span>
      </div>
    `).join('');
  }

  const sampledEl = $('#sys-sampled-at');
  if (sampledEl) sampledEl.textContent = `Diperbarui ${new Date(data.sampled_at).toLocaleTimeString('id-ID')}`;
}

const EVENT_META = {
  camera_added: { label: 'Kamera ditambahkan', tone: 'info', group: 'camera' },
  camera_updated: { label: 'Kamera diperbarui', tone: 'info', group: 'camera' },
  camera_deleted: { label: 'Kamera dihapus', tone: 'error', group: 'camera' },
  onvif_probe_ok: { label: 'ONVIF probe berhasil', tone: 'success', group: 'camera' },
  stream_started: { label: 'Live stream dimulai', tone: 'success', group: 'stream' },
  stream_stopped: { label: 'Live stream dihentikan', tone: 'neutral', group: 'stream' },
  stream_error: { label: 'Live stream error', tone: 'error', group: 'stream' },
  stream_reconnecting: { label: 'Live stream menyambung ulang', tone: 'warn', group: 'stream' },
  stream_idle_timeout: { label: 'Live stream dihentikan otomatis (idle)', tone: 'warn', group: 'stream' },
  recording_started: { label: 'Rekaman dimulai', tone: 'success', group: 'recording' },
  recording_resumed: { label: 'Rekaman dilanjutkan otomatis setelah restart', tone: 'info', group: 'recording' },
  recording_stopped: { label: 'Rekaman dihentikan', tone: 'neutral', group: 'recording' },
  recording_reconnecting: { label: 'Rekaman menyambung ulang', tone: 'warn', group: 'recording' },
  recording_purged: { label: 'Rekaman lama dihapus', tone: 'neutral', group: 'recording' },
  recording_error: { label: 'Rekaman error', tone: 'error', group: 'recording' },
  motion_detected: { label: 'Gerakan terdeteksi', tone: 'warn', group: 'motion' },
  motion_recording_started: { label: 'Rekaman motion dimulai', tone: 'warn', group: 'motion' },
  motion_detector_started: { label: 'Motion detection aktif', tone: 'info', group: 'motion' },
  motion_detector_stopped: { label: 'Motion detection nonaktif', tone: 'neutral', group: 'motion' },
  motion_detector_reconnecting: { label: 'Motion detector menyambung ulang', tone: 'warn', group: 'motion' },
  motion_detector_error: { label: 'Motion detector error', tone: 'error', group: 'motion' },
  user_created: { label: 'User dibuat', tone: 'user', group: 'user' },
  user_updated: { label: 'User diperbarui', tone: 'user', group: 'user' },
  user_password_changed: { label: 'Password diubah sendiri', tone: 'user', group: 'user' },
  user_deleted: { label: 'User dihapus', tone: 'user', group: 'user' },
  user_login: { label: 'Login', tone: 'success', group: 'user' },
  user_login_failed: { label: 'Login gagal', tone: 'error', group: 'user' },
  user_logout: { label: 'Logout', tone: 'neutral', group: 'user' },
  location_added: { label: 'Lokasi ditambahkan', tone: 'info', group: 'location' },
  location_updated: { label: 'Lokasi diperbarui', tone: 'info', group: 'location' },
  location_deleted: { label: 'Lokasi dihapus', tone: 'neutral', group: 'location' },
  camera_offline: { label: 'Kamera offline', tone: 'error', group: 'camera' },
  camera_online: { label: 'Kamera kembali online', tone: 'success', group: 'camera' },
  settings_updated: { label: 'Pengaturan diperbarui', tone: 'info', group: 'other' },
  cameras_bulk_updated: { label: 'Kamera diperbarui massal', tone: 'info', group: 'camera' },
  bookmark_added: { label: 'Bookmark ditambahkan', tone: 'success', group: 'recording' },
  bookmark_deleted: { label: 'Bookmark dihapus', tone: 'neutral', group: 'recording' },
};

const TONE_ICON = {
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></svg>',
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg>',
  neutral: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
};

// ---- Dashboard: "Volume Kejadian per Hari" stacked bar chart ----
// Stacked by the same tone EVENT_META already assigns each event type (the
// dashboard's own event-log coloring), not a separately invented palette —
// bottom-anchored in a fixed order so the same tone always lands in the
// same visual band day to day (color follows the entity, never its rank).
const EVENTS_CHART_TONE_ORDER = ['error', 'warn', 'info', 'success', 'user', 'neutral'];
const EVENTS_CHART_TONE_LABEL = { error: 'Error/Gangguan', warn: 'Peringatan', info: 'Informasi', success: 'Berhasil', user: 'User', neutral: 'Netral' };
const EVENTS_CHART_TONE_VAR = { error: '--rec', warn: '--warn', info: '--accent', success: '--live', user: '--accent-2', neutral: '--text-faint' };

function eventsChartNiceMax(value) {
  if (value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = 10 ** exp;
  const frac = value / base;
  const niceFrac = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return niceFrac * base;
}

function eventsChartDayLabel(dayStr) {
  // Explicit UTC read + UTC format: dayStr is a plain UTC calendar date from
  // the backend (see /api/events/summary) with no time component — letting
  // this fall through to the browser's local timezone could shift it to the
  // adjacent day depending on where the browser is.
  return new Date(`${dayStr}T00:00:00Z`).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', timeZone: 'UTC' });
}

async function loadEventsChart(days) {
  state.eventsChartDays = days;
  document.querySelectorAll('#events-chart-range-picker .chip').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.days) === days);
  });
  const el = $('#events-chart');
  if (el) el.innerHTML = '<div class="empty-state">Memuat...</div>';
  try {
    const data = await api(`/events/summary?days=${days}`);
    renderEventsChart(data);
  } catch (e) {
    console.error(e);
    if (el) el.innerHTML = `<div class="empty-state">Gagal memuat: ${escapeHtml(e.message)}</div>`;
  }
}

function renderEventsChart(data) {
  const container = $('#events-chart');
  if (!container) return;
  const { days, rows } = data;

  // Zero-fill every day in the window — GROUP BY only returns rows for days
  // that actually had events, and a gap in the x-axis would otherwise read
  // as missing data rather than "nothing happened."
  const dayKeys = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    dayKeys.push(d.toISOString().slice(0, 10));
  }
  const byDay = new Map(dayKeys.map((k) => [k, { total: 0, byTone: {}, byType: {} }]));
  for (const r of rows) {
    const bucket = byDay.get(r.day);
    if (!bucket) continue; // e.g. a day exactly on the boundary edge — skip rather than misdraw
    const tone = (EVENT_META[r.type] && EVENT_META[r.type].tone) || 'neutral';
    bucket.byTone[tone] = (bucket.byTone[tone] || 0) + r.count;
    bucket.byType[r.type] = (bucket.byType[r.type] || 0) + r.count;
    bucket.total += r.count;
  }

  const buckets = dayKeys.map((k) => byDay.get(k));
  const maxTotal = Math.max(0, ...buckets.map((b) => b.total));
  if (maxTotal === 0) {
    container.innerHTML = '<div class="empty-state">Belum ada kejadian pada rentang waktu ini.</div>';
    return;
  }
  const niceMax = eventsChartNiceMax(maxTotal * 1.05);
  const presentTones = EVENTS_CHART_TONE_ORDER.filter((t) => buckets.some((b) => b.byTone[t] > 0));

  const plotHeight = 190;
  const plotTop = 12;
  const leftMargin = 42;
  const slotWidth = days > 20 ? 26 : days > 10 ? 32 : 40;
  const barWidth = Math.min(28, slotWidth - 10);
  const svgWidth = leftMargin + days * slotWidth + 8;
  const svgHeight = plotTop + plotHeight + 34; // + x-axis label row

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const y = plotTop + plotHeight * (1 - f);
    const value = Math.round(niceMax * f);
    return `<line x1="${leftMargin}" y1="${y}" x2="${svgWidth - 4}" y2="${y}" class="events-chart-grid" />
            <text x="${leftMargin - 8}" y="${y + 3}" class="events-chart-axis-label" text-anchor="end">${value}</text>`;
  }).join('');

  // Show every Nth x-axis label so they don't collide once there are more
  // than ~12 bars on screen.
  const labelStride = days > 20 ? 3 : days > 10 ? 2 : 1;

  const bars = dayKeys.map((day, i) => {
    const bucket = byDay.get(day);
    const x = leftMargin + i * slotWidth + (slotWidth - barWidth) / 2;
    let yCursor = plotTop + plotHeight;
    const segments = EVENTS_CHART_TONE_ORDER.map((tone) => {
      const count = bucket.byTone[tone] || 0;
      if (count <= 0) return '';
      const h = (count / niceMax) * plotHeight;
      const y = yCursor - h;
      yCursor -= h;
      const drawH = Math.max(0, h - (presentTones.length > 1 ? 2 : 0));
      return `<rect x="${x}" y="${y}" width="${barWidth}" height="${drawH}" rx="2" fill="var(${EVENTS_CHART_TONE_VAR[tone]})" />`;
    }).join('');
    const showLabel = i % labelStride === 0 || i === dayKeys.length - 1;
    const labelX = x + barWidth / 2;
    return `
      <g class="events-chart-bar-group" data-day="${day}" tabindex="0">
        <rect x="${x - (slotWidth - barWidth) / 2}" y="${plotTop}" width="${slotWidth}" height="${plotHeight}" fill="transparent" />
        ${segments}
        ${showLabel ? `<text x="${labelX}" y="${plotTop + plotHeight + 18}" class="events-chart-axis-label" text-anchor="middle">${eventsChartDayLabel(day)}</text>` : ''}
      </g>
    `;
  }).join('');

  const legend = presentTones.map((tone) => `
    <div class="events-chart-legend-item">
      <span class="events-chart-legend-dot" style="background:var(${EVENTS_CHART_TONE_VAR[tone]})"></span>
      ${EVENTS_CHART_TONE_LABEL[tone]}
    </div>
  `).join('');

  container.innerHTML = `
    <div class="events-chart-wrap">
      <svg viewBox="0 0 ${svgWidth} ${svgHeight}" class="events-chart-svg" preserveAspectRatio="xMinYMid meet">
        ${gridLines}
        ${bars}
      </svg>
    </div>
    <div class="events-chart-legend">${legend}</div>
    <div class="events-chart-tooltip hidden" id="events-chart-tooltip"></div>
  `;

  const tooltip = $('#events-chart-tooltip');
  container.querySelectorAll('.events-chart-bar-group').forEach((g) => {
    const bucket = byDay.get(g.dataset.day);
    const showTooltip = (clientX, clientY) => {
      const breakdown = EVENTS_CHART_TONE_ORDER
        .filter((t) => bucket.byTone[t] > 0)
        .map((t) => `<div class="events-chart-tooltip-row"><span class="events-chart-legend-dot" style="background:var(${EVENTS_CHART_TONE_VAR[t]})"></span>${EVENTS_CHART_TONE_LABEL[t]}<span class="events-chart-tooltip-count">${bucket.byTone[t]}</span></div>`)
        .join('');
      tooltip.innerHTML = `<div class="events-chart-tooltip-date">${eventsChartDayLabel(g.dataset.day)} — ${bucket.total} kejadian</div>${breakdown || '<div class="events-chart-tooltip-row">Tidak ada kejadian</div>'}`;
      tooltip.classList.remove('hidden');
      const wrapRect = container.getBoundingClientRect();
      tooltip.style.left = `${clientX - wrapRect.left + 12}px`;
      tooltip.style.top = `${clientY - wrapRect.top - 8}px`;
    };
    g.addEventListener('mouseenter', (e) => showTooltip(e.clientX, e.clientY));
    g.addEventListener('mousemove', (e) => showTooltip(e.clientX, e.clientY));
    g.addEventListener('mouseleave', () => tooltip.classList.add('hidden'));
    g.addEventListener('focus', () => {
      const r = g.querySelector('rect').getBoundingClientRect();
      showTooltip(r.left, r.top);
    });
    g.addEventListener('blur', () => tooltip.classList.add('hidden'));
  });
}

document.querySelectorAll('#events-chart-range-picker .chip').forEach((btn) => {
  btn.addEventListener('click', () => loadEventsChart(Number(btn.dataset.days)));
});

let eventsCache = [];
let eventsFilter = 'all';

async function loadEvents() {
  try {
    eventsCache = await api('/events');
    renderEvents();
  } catch (e) { console.error(e); }
}

function renderEvents() {
  const list = $('#events-table');
  if (!list) return;
  const filtered = eventsCache.filter((r) => {
    const meta = EVENT_META[r.type];
    if (eventsFilter === 'all') return true;
    if (eventsFilter === 'error') return (meta?.tone || 'neutral') === 'error';
    return (meta?.group || 'other') === eventsFilter;
  });

  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty-state">Belum ada peristiwa untuk filter ini.</div>';
    return;
  }

  list.innerHTML = filtered.map((r) => {
    const meta = EVENT_META[r.type] || { label: r.type, tone: 'neutral' };
    const cam = state.cameras.find((c) => c.id === r.camera_id);
    const camLabel = cam ? cam.name : (r.camera_id ? `Kamera #${r.camera_id}` : 'Sistem');
    return `
      <div class="event-item tone-${meta.tone}">
        <div class="event-icon">${TONE_ICON[meta.tone] || TONE_ICON.neutral}</div>
        <div class="event-body">
          <div class="event-top">
            <span class="event-title">${escapeHtml(meta.label)}</span>
            <span class="event-time">${new Date(r.created_at).toLocaleString('id-ID')}</span>
          </div>
          ${r.message ? `<div class="event-message">${escapeHtml(r.message)}</div>` : ''}
          <div class="event-cam">${escapeHtml(camLabel)}</div>
        </div>
      </div>
    `;
  }).join('');
}

$('#event-filters')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  eventsFilter = btn.dataset.filter;
  document.querySelectorAll('#event-filters .chip').forEach((c) => c.classList.toggle('active', c === btn));
  renderEvents();
});

// ---- Pengaturan (Settings) ----

wireTabStrip('#settings-sub-tabs', {
  dataAttr: 'settingsTab',
  panelId: (tab) => `settings-tab-${tab}`,
});

async function loadSettingsPage() {
  try {
    const s = await api('/settings');
    $('#settings-app-name').value = s.app_name || '';
    $('#settings-smtp-enabled').checked = s.smtp_enabled === 'true';
    $('#settings-smtp-host').value = s.smtp_host || '';
    $('#settings-smtp-port').value = s.smtp_port || '';
    $('#settings-smtp-user').value = s.smtp_user || '';
    $('#settings-smtp-pass').value = '';
    $('#settings-smtp-pass').placeholder = s.smtp_pass_set ? 'Sudah diatur — kosongkan kalau tidak diubah' : 'Kosongkan kalau tidak diubah';
    $('#settings-notify-to').value = s.notify_email_to || '';
    $('#settings-retention').value = s.retention_days || 14;
    $('#settings-stream-width').value = s.stream_max_width || 960;
    $('#settings-stream-fps').value = s.stream_fps || 15;
    $('#settings-hwaccel').value = s.hwaccel_mode || 'auto';
    $('#settings-health-interval').value = s.health_check_interval_min || 5;
    $('#settings-offline-threshold').value = s.offline_threshold_checks || 2;

    const preview = $('#settings-logo-preview');
    if (s.logo_path) {
      preview.src = s.logo_path;
      preview.classList.remove('hidden');
    } else {
      preview.classList.add('hidden');
    }
  } catch (e) {
    console.error(e);
  }
}

// Each section saves independently — PUT /settings only touches whatever
// keys are in the body, so saving SMTP never re-sends (and can't clobber)
// branding/recording/performance/health-check fields. Deliberately does NOT
// reload the whole settings form afterward either: doing so would overwrite
// any not-yet-saved text the admin has typed into a *different* section's
// inputs while they were on this page.
async function saveSettingsSection(msgSelector, body, afterSave) {
  const msg = $(msgSelector);
  msg.textContent = '';
  msg.className = 'form-msg';
  try {
    await api('/settings', { method: 'PUT', body });
    msg.textContent = 'Tersimpan.';
    msg.classList.add('ok');
    if (afterSave) afterSave();
  } catch (e) {
    msg.textContent = e.message;
    msg.classList.add('error');
  }
}

$('#settings-save-branding-btn')?.addEventListener('click', () => saveSettingsSection('#settings-branding-msg', {
  app_name: $('#settings-app-name').value.trim() || 'Open VMS',
}, loadBranding));

$('#settings-save-email-btn')?.addEventListener('click', () => saveSettingsSection('#settings-email-msg', {
  smtp_enabled: $('#settings-smtp-enabled').checked ? 'true' : 'false',
  smtp_host: $('#settings-smtp-host').value.trim(),
  smtp_port: $('#settings-smtp-port').value.trim(),
  smtp_user: $('#settings-smtp-user').value.trim(),
  smtp_pass: $('#settings-smtp-pass').value, // blank = server keeps existing
  notify_email_to: $('#settings-notify-to').value.trim(),
}, () => {
  // Don't leave a just-typed password sitting in the field once it's saved.
  $('#settings-smtp-pass').value = '';
  $('#settings-smtp-pass').placeholder = 'Sudah diatur — kosongkan kalau tidak diubah';
}));

$('#settings-save-recording-btn')?.addEventListener('click', () => saveSettingsSection('#settings-recording-msg', {
  retention_days: $('#settings-retention').value.trim(),
}));

$('#settings-save-performance-btn')?.addEventListener('click', () => saveSettingsSection('#settings-performance-msg', {
  stream_max_width: $('#settings-stream-width').value.trim(),
  stream_fps: $('#settings-stream-fps').value.trim(),
  hwaccel_mode: $('#settings-hwaccel').value,
}));

$('#settings-save-healthcheck-btn')?.addEventListener('click', () => saveSettingsSection('#settings-healthcheck-msg', {
  health_check_interval_min: $('#settings-health-interval').value.trim(),
  offline_threshold_checks: $('#settings-offline-threshold').value.trim(),
}));

$('#settings-test-email-btn')?.addEventListener('click', async () => {
  const msg = $('#settings-email-msg');
  msg.textContent = 'Mengirim...';
  msg.className = 'form-msg';
  try {
    await api('/settings/test-email', { method: 'POST' });
    msg.textContent = 'Email test berhasil dikirim — cek inbox tujuan.';
    msg.classList.add('ok');
  } catch (e) {
    msg.textContent = e.message;
    msg.classList.add('error');
  }
});

$('#settings-logo-file')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  const filenameEl = $('#settings-logo-filename');
  if (!file) {
    if (filenameEl) filenameEl.textContent = 'Belum ada file dipilih';
    return;
  }
  if (filenameEl) filenameEl.textContent = file.name;
  const msg = $('#settings-logo-msg');
  msg.textContent = 'Mengupload...';
  msg.className = 'form-msg';
  try {
    const formData = new FormData();
    formData.append('logo', file);
    const res = await fetch('/api/settings/logo', {
      method: 'POST',
      headers: state.token ? { Authorization: `Bearer ${state.token}` } : {},
      body: formData,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);

    const preview = $('#settings-logo-preview');
    preview.src = data.logo_path;
    preview.classList.remove('hidden');
    msg.textContent = 'Logo tersimpan.';
    msg.classList.add('ok');
    await loadBranding();
  } catch (err) {
    msg.textContent = err.message;
    msg.classList.add('error');
  } finally {
    e.target.value = '';
  }
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- Alert / notification center ----

let alertPanelOpen = false;
const ALERT_TONE_COLOR = { error: 'var(--rec)', success: 'var(--live)', warn: '#f59e0b', info: 'var(--accent)', neutral: 'var(--text-faint)' };

async function refreshAlertBadge() {
  try {
    const { count } = await api('/alerts/count');
    const badge = $('#alert-bell-badge');
    if (!badge) return;
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  } catch (e) { console.error(e); }
}

async function loadAlertPanel() {
  const list = $('#alert-panel-list');
  list.innerHTML = '<div class="alert-panel-empty">Memuat...</div>';
  try {
    const alerts = await api('/alerts');
    if (alerts.length === 0) {
      list.innerHTML = '<div class="alert-panel-empty">Tidak ada notifikasi.</div>';
      return;
    }
    list.innerHTML = alerts.map((a) => {
      const meta = EVENT_META[a.type] || { label: a.type, tone: 'neutral' };
      const cam = state.cameras.find((c) => c.id === a.camera_id);
      return `
        <div class="alert-item ${a.acknowledged ? '' : 'unread'}" data-alert-id="${a.id}" data-alert-cam="${a.camera_id || ''}">
          <span class="alert-item-dot" style="background:${ALERT_TONE_COLOR[meta.tone] || ALERT_TONE_COLOR.neutral}"></span>
          <div class="alert-item-body">
            <div class="alert-item-title">${escapeHtml(meta.label)}${cam ? ` — ${escapeHtml(cam.name)}` : ''}</div>
            ${a.message ? `<div class="alert-item-msg">${escapeHtml(a.message)}</div>` : ''}
            <div class="alert-item-time">${new Date(a.created_at).toLocaleString('id-ID')}</div>
          </div>
        </div>
      `;
    }).join('');

    list.querySelectorAll('[data-alert-id]').forEach((item) => {
      item.addEventListener('click', async () => {
        const id = Number(item.dataset.alertId);
        const camId = item.dataset.alertCam ? Number(item.dataset.alertCam) : null;
        try { await api(`/alerts/${id}/ack`, { method: 'POST' }); } catch (e) { console.error(e); }
        item.classList.remove('unread');
        refreshAlertBadge();
        if (camId) {
          closeAlertPanel();
          document.querySelector('.nav-item[data-view="live"]')?.click();
          setTimeout(() => {
            const cam = state.cameras.find((c) => c.id === camId);
            if (cam) openFocusView(camId);
          }, 400);
        }
      });
    });
  } catch (e) {
    list.innerHTML = '<div class="alert-panel-empty">Gagal memuat notifikasi.</div>';
  }
}

function openAlertPanel() {
  alertPanelOpen = true;
  // On mobile the bell lives inside the off-canvas drawer — leaving the
  // drawer open underneath would put the fixed-position, z-indexed alert
  // panel visually on top of the (unpositioned) nav items in the same
  // sidebar column, making the whole nav menu invisible/unreachable while
  // notifications are shown. No-op on desktop where there's no drawer.
  closeDrawer();
  $('#alert-panel').classList.remove('hidden');
  loadAlertPanel();
}
function closeAlertPanel() {
  alertPanelOpen = false;
  $('#alert-panel')?.classList.add('hidden');
}

$('#alert-bell-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (alertPanelOpen) closeAlertPanel();
  else openAlertPanel();
});
document.addEventListener('click', (e) => {
  if (alertPanelOpen && !e.target.closest('#alert-panel') && !e.target.closest('#alert-bell-btn')) closeAlertPanel();
});
$('#alert-ack-all-btn')?.addEventListener('click', async (e) => {
  e.stopPropagation();
  try {
    await api('/alerts/ack-all', { method: 'POST' });
    await loadAlertPanel();
    await refreshAlertBadge();
  } catch (err) {
    showToast(err.message);
  }
});
