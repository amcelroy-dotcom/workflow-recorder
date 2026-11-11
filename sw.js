/* WorkFlow Recorder service worker.
 * 1. Keeps the app working offline (the app's own files are cached here; the
 *    speech model is cached separately by the engine).
 * 2. Receives recordings shared from other apps (Pixel Recorder: Share >
 *    Audio file > WorkFlow Recorder).
 * 3. Adds the two security headers that let the speech engine use several
 *    processor cores at once (cross-origin isolation). */
const VERSION = 'wf-recorder-2';
const SHELL = [
  './', './index.html', './app.js', './storage.js', './audio.js', './engine.js', './styles.css',
  './recorder-worklet.js', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
  './vendor/engine-worker.js'
];

self.addEventListener('install', (event) => {
  // Cache each file on its own, so one missing file doesn't stop the app from installing.
  event.waitUntil(caches.open(VERSION)
    .then((c) => Promise.all(SHELL.map((f) => c.add(f).catch(() => null))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isolate(response) {
  if (!response || response.status === 0 || response.type === 'opaque') return response;
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// A file shared in from another app is kept here until the page picks it up.
function keepSharedFile(file) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('workflow-recorder', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      ['pcm', 'audio', 'kv'].forEach((n) => { if (!d.objectStoreNames.contains(n)) d.createObjectStore(n); });
      if (!d.objectStoreNames.contains('sessions')) d.createObjectStore('sessions', { keyPath: 'id' });
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const t = req.result.transaction('kv', 'readwrite');
      t.objectStore('kv').put({ file, at: Date.now() }, 'shared');
      t.oncomplete = () => { req.result.close(); resolve(); };
      t.onerror = () => reject(t.error);
    };
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.origin === self.location.origin && url.pathname.endsWith('/share-target')) {
    event.respondWith((async () => {
      try {
        const form = await req.formData();
        const file = form.getAll('audio').find((f) => f && typeof f === 'object' && f.size);
        if (file) await keepSharedFile(file);
      } catch (e) { /* the page will say nothing came through */ }
      return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
    })());
    return;
  }
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // model downloads and fonts go straight to the network
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
    // Big engine files never change for a version: once cached, don't fetch them again.
    if (cached && url.pathname.includes('/vendor/')) return isolate(cached);
    // Everything else: answer from the cache right away, and refresh it in the background.
    const network = fetch(req).then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    const res = cached || (await network);
    if (!res) return new Response('Offline, and this file isn\u2019t saved yet.', { status: 503 });
    return isolate(res);
  })());
});
