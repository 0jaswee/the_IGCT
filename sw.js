const CACHE = 'igct-shell-v1';
const SHELL = [
  './', './index.html', './join.html', './login.html', './club.html', './doodle.html',
  './styles.css', './club-games.css', './app.js', './drawing.js', './firebase-config.js',
  './pwa.js', './manifest.webmanifest', './icon-192.png', './icon-512.png'
].map(path => new URL(path, self.registration.scope).href);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith('igct-shell-') && key !== CACHE).map(key => caches.delete(key))
  )).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  url.search = '';
  if (!SHELL.includes(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(event.request);
      if (response.ok && !event.request.url.includes('?')) await cache.put(url.href, response.clone());
      return response;
    } catch {
      return (await cache.match(url.href)) || Response.error();
    }
  })());
});
