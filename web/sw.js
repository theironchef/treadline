// Offline shell: serve cached files immediately and refresh them in the
// background. When a refresh turns up a changed file, a new version has been
// deployed: fetch the whole shell again, then tell open pages so they can
// offer a reload. Bump VERSION when the file list changes.
const VERSION = 'treadline-v4';
const FILES = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'js/app.js',
  'js/club.js',
  'js/format.js',
  'js/gps.js',
  'js/links.js',
  'js/model.js',
  'js/run.js',
  'js/sensor.js',
  'js/store.js',
  'js/version.js',
];

// no-cache: revalidate with the server instead of trusting the HTTP cache,
// where GitHub Pages lets a copy sit for 10 minutes.
const fresh = (f) => new Request(f, { cache: 'no-cache' });

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES.map(fresh))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      // Copied now: once `cached` goes to the page its body is used up and it
      // can't be cloned any more.
      const previous = cached?.clone();
      const update = fetch(e.request, { cache: 'no-cache' })
        .then(async (res) => {
          if (res.ok) {
            const changed = previous && (await differs(previous, res.clone()));
            await cache.put(e.request, res.clone());
            if (changed) await refreshAll();
          }
          return res;
        })
        .catch(() => cached);
      if (cached) e.waitUntil(update);
      return cached ?? update;
    }),
  );
});

// The page asks for a full check when it comes back to the foreground (an
// installed app is usually resumed rather than restarted, so nothing else
// would reach the server) and when you tap Check for updates.
self.addEventListener('message', (e) => {
  if (e.data?.type === 'check') e.waitUntil(check(e.source));
});

async function check(page) {
  const cache = await caches.open(VERSION);
  for (const f of FILES) {
    const [old, res] = await Promise.all([cache.match(f), fetch(fresh(f)).catch(() => null)]);
    if (!res?.ok) return page?.postMessage({ type: 'check-failed' });
    if (!old || (await differs(old, res))) return refreshAll();
  }
  page?.postMessage({ type: 'up-to-date' });
}

let refreshing = null;

// addAll is all or nothing, so a reload never mixes old files with new.
function refreshAll() {
  refreshing ??= caches
    .open(VERSION)
    .then((c) => c.addAll(FILES.map(fresh)))
    .then(() => self.clients.matchAll({ type: 'window' }))
    .then((pages) => pages.forEach((p) => p.postMessage({ type: 'update-ready' })))
    .catch(() => {})
    .finally(() => (refreshing = null));
  return refreshing;
}

async function differs(a, b) {
  const [x, y] = await Promise.all([a.arrayBuffer(), b.arrayBuffer()]);
  if (x.byteLength !== y.byteLength) return true;
  const u = new Uint8Array(x);
  const v = new Uint8Array(y);
  return u.some((byte, i) => byte !== v[i]);
}
