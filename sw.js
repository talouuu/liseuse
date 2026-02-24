// sw.js v4 — FIXED: only cache the app shell.
// DO NOT intercept CDN or HuggingFace requests.
// transformers.js (used by kokoro-js) has its own Cache API
// layer for model files. Our old SW was intercepting those
// requests and re-downloading them every time (network-first),
// which is why the model never seemed to stay cached.

const CACHE_NAME = 'liseuse-v4';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          // Also don't delete transformers.js cache buckets
          .filter(k => !k.startsWith('transformers'))
          .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // ONLY handle same-origin requests (our app files).
  // Let ALL external requests (esm.sh, cdnjs, huggingface)
  // pass through to the browser/transformers.js cache untouched.
  if (url.origin !== location.origin) return;

  // App shell: cache-first
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
