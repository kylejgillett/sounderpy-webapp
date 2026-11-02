// Makes the installed app feel at home with no connection. Pages always come from the network, so
// nobody gets stuck on an old version; with no connection they get offline.html. Build files have
// their contents in their names, so a saved copy is always right. Plots and the API are never touched.
const CACHE = "sounderpy-v1";
const MAX_ENTRIES = 80;
const PRECACHE = ["/offline.html", "/icons/icon-192.png"];
const REFRESHED = ["/data/", "/icons/", "/sounderpy-logo.png", "/favicon.png", "/500_heights.gif"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

async function save(request, response) {
  if (!response.ok) return;
  const cache = await caches.open(CACHE);
  await cache.put(request, response);
  const keys = await cache.keys();
  const extra = keys.filter((key) => !PRECACHE.includes(new URL(key.url).pathname)).slice(0, Math.max(0, keys.length - MAX_ENTRIES));
  await Promise.all(extra.map((key) => cache.delete(key)));
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/offline.html")));
  } else if (url.pathname.startsWith("/_astro/")) {
    event.respondWith(caches.match(request).then((saved) => saved ?? fetch(request).then((response) => {
      event.waitUntil(save(request, response.clone()));
      return response;
    })));
  } else if (REFRESHED.some((path) => url.pathname.startsWith(path))) {
    // Show the saved copy straight away and refresh it for next time.
    const fresh = fetch(request);
    event.waitUntil(fresh.then((response) => save(request, response.clone())).catch(() => {}));
    event.respondWith(caches.match(request).then((saved) => saved ?? fresh));
  }
});
