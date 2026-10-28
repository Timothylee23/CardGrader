// sw.js - service worker: makes the app work offline.
//
// A service worker is a small script the browser runs in the background,
// between the page and the network. It can answer requests from a cache.
//
// Strategy:
//   - On install: download the app shell + opencv.js into the cache.
//   - Page loads (navigations): try the network first so updates show up,
//     fall back to the cached page when offline.
//   - Everything else (JS, CSS, icons, opencv.js): cache first, network if missing.
//
// Bump CACHE_NAME when you want to force every phone to re-download everything.

const CACHE_NAME = "cardgrader-v1";

const CORE_FILES = [
  "./",
  "./index.html",
  "./manifest.json",
  "./opencv.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(CORE_FILES);
      // Vite gives the JS/CSS bundles random-looking names (index-a1b2c3.js),
      // so read them out of index.html and cache those too.
      const html = await (await fetch("./index.html")).text();
      const assets = [...html.matchAll(/(?:src|href)="(\.?\/?assets\/[^"]+)"/g)].map((m) => m[1]);
      await cache.addAll(assets);
      await self.skipWaiting(); // activate right away
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Delete caches from older versions.
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)));
      await self.clients.claim(); // take control of open pages
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    // Network first for the page itself.
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          const cache = await caches.open(CACHE_NAME);
          cache.put("./index.html", response.clone());
          return response;
        } catch {
          return (await caches.match("./index.html", { ignoreVary: true })) ?? Response.error();
        }
      })(),
    );
    return;
  }

  // Cache first for everything else.
  event.respondWith(
    (async () => {
      // ignoreVary: servers often send "Vary: Origin", which would make the
      // cache refuse to match Vite's crossorigin <script> tags when offline.
      const cached = await caches.match(request, { ignoreVary: true });
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, response.clone());
      }
      return response;
    })(),
  );
});
