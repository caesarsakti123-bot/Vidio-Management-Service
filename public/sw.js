// Service worker for Open VMS PWA installability.
//
// Bump this on any change to the cached shell files so old clients pick up
// the new cache instead of reusing a stale one.
const CACHE_NAME = 'ovms-shell-v1';
const SHELL_URLS = ['/', '/app.js', '/style.css', '/manifest.json'];

self.addEventListener('install', (event) => {
  // Cache each shell URL independently rather than cache.addAll(), which
  // aborts the whole install if even one request fails (e.g. a route that
  // 404s transiently) — better to install with a partial cache than not
  // install at all.
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all(SHELL_URLS.map((url) =>
        fetch(url).then((res) => (res.ok ? cache.put(url, res) : null)).catch(() => null)
      )))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Live HLS streams, the relay ingest endpoint, and all API calls are
  // dynamic/auth-sensitive and must always go straight to the network —
  // never intercepted or served from cache.
  if (request.method !== 'GET' || url.pathname.startsWith('/streams/') || url.pathname.startsWith('/api/')) {
    return;
  }

  // Network-first with cache fallback: the server already sends
  // Cache-Control: no-cache on the app shell specifically so a deploy is
  // never masked by a stale cached copy (see src/index.js). This mirrors
  // that intent — the cache here is only an offline/flaky-network safety
  // net, never a cache-first shortcut.
  event.respondWith(
    fetch(request)
      .then((response) => {
        // Only cache an actually-good response — a transient 404/500 (e.g.
        // mid-deploy restart) must never overwrite the last known-good shell
        // file, or the next *offline/flaky-network* fallback below would
        // serve that cached error page instead of real content.
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});
