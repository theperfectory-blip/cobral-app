// Cobral service worker — web only (never registered inside Capacitor, see index.html).
// Strategy: same-origin GET only; network-first for navigations and .html/.js (so an app update
// is picked up immediately when online, with a cache fallback offline); cache-first for everything
// else (icons, fonts, etc. if ever added). Versioned cache name so activate() can drop stale caches.
const CACHE_NAME = 'cobral-web-v6';
const PRECACHE = ['./', 'index.html', 'cloud/config.js', 'cloud/cobral-cloud.js'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
      .catch(err => console.log('SW precache error:', err))
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isNetworkFirst(req, url) {
  return req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('.js');
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return; // never intercept writes
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch cross-origin (Firestore/Auth/gstatic)

  if (isNetworkFirst(req, url)) {
    e.respondWith(
      fetch(req).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
        }
        return res;
      }).catch(() => caches.match(req).then(cached => cached || caches.match('./')))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
        }
        return res;
      });
    }).catch(() => caches.match('./'))
  );
});
