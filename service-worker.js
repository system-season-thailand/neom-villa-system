// Neom Villa staff console — service worker
// Cache-first app shell + stale-while-revalidate for third-party CDN assets.
// Bump CACHE_VERSION whenever precached files change so clients pick up the update.
const CACHE_VERSION = 'neom-villa-v2';
const APP_CACHE = `${CACHE_VERSION}-app`;
const CDN_CACHE = `${CACHE_VERSION}-cdn`;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/base.css',
  './css/layout.css',
  './css/components.css',
  './css/invoice.css',
  './css/prices.css',
  './css/availability.css',
  './js/app.js',
  './js/config/supabase.js',
  './js/services/invoiceService.js',
  './js/services/priceService.js',
  './js/services/availabilityService.js',
  './js/state/store.js',
  './js/utils/dateUtils.js',
  './js/utils/validators.js',
  './js/utils/format.js',
  './js/utils/dbErrors.js',
  './js/utils/arabicReshaper.js',
  './js/utils/arabicData.js',
  './js/utils/amiriFont.js',
  './js/utils/pdfGenerator.js',
  './js/components/toast.js',
  './js/components/modal.js',
  './js/components/invoiceTab.js',
  './js/components/pricesTab.js',
  './js/components/availabilityTab.js',
  './assets/icons/favicon.svg',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png'
];

const CDN_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith('neom-villa-') && key !== APP_CACHE && key !== CDN_CACHE)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache Supabase API/storage calls — data must always be fresh.
  if (url.hostname.endsWith('supabase.co')) return;

  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(request, CDN_CACHE));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request, APP_CACHE));
  }
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const fallback = await cache.match('./index.html');
    if (fallback) return fallback;
    throw err;
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkFetch = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached || networkFetch;
}
