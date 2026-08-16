/// ACConnx Service Worker v1.0.0
const CACHE_VERSION = 'acconnx-v1.0.0';
const STATIC_CACHE = CACHE_VERSION + '-static';
const DYNAMIC_CACHE = CACHE_VERSION + '-dynamic';
const API_CACHE = CACHE_VERSION + '-api';

// Static assets to pre-cache
const PRECACHE_ASSETS = [
  '/company-portal.html',
  '/manifest.json',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
  '/icons/apple-touch-icon.png'
];

// Install — pre-cache static assets
self.addEventListener('install', (event) => {
  console.log('[SW] Installing...');
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      console.log('[SW] Pre-caching static assets');
      return cache.addAll(PRECACHE_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Activate — clean old caches
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key.startsWith('acconnx-') && !key.startsWith(CACHE_VERSION))
          .map((key) => {
            console.log('[SW] Removing old cache:', key);
            return caches.delete(key);
          })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch — routing strategy
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // Skip chrome-extension and other non-http(s) requests
  if (!url.protocol.startsWith('http')) return;

  // API calls — Network-first with cache fallback
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirstStrategy(request, API_CACHE));
    return;
  }

  // Google Fonts — Cache-first
  if (url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com') {
    event.respondWith(cacheFirstStrategy(request, STATIC_CACHE));
    return;
  }

  // Stripe.js — Network-first (always want fresh)
  if (url.origin === 'https://js.stripe.com') {
    event.respondWith(networkFirstStrategy(request, STATIC_CACHE));
    return;
  }

  // Static assets (icons, manifest, images) — Cache-first
  if (url.pathname.startsWith('/icons/') || url.pathname === '/manifest.json') {
    event.respondWith(cacheFirstStrategy(request, STATIC_CACHE));
    return;
  }

  // HTML pages — Network-first with cache fallback
  if (request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(networkFirstStrategy(request, DYNAMIC_CACHE));
    return;
  }

  // Default — Cache-first
  event.respondWith(cacheFirstStrategy(request, DYNAMIC_CACHE));
});

// Cache-first strategy
async function cacheFirstStrategy(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    console.log('[SW] Cache-first fetch failed:', err);
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

// Network-first strategy
async function networkFirstStrategy(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    console.log('[SW] Network-first falling back to cache:', request.url);
    const cached = await caches.match(request);
    if (cached) return cached;

    // Return offline fallback for HTML
    if (request.headers.get('accept')?.includes('text/html')) {
      const fallback = await caches.match('/company-portal.html');
      if (fallback) return fallback;
    }

    return new Response(JSON.stringify({ error: 'You are offline', offline: true }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// =====================
// PUSH NOTIFICATIONS
// =====================
self.addEventListener('push', (event) => {
  console.log('[SW] Push received');

  let data = {
    title: 'ACConnx',
    body: 'You have a new notification',
    icon: '/icons/icon-192x192.png',
    badge: '/icons/icon-72x72.png',
    tag: 'acconnx-notification',
    data: { url: '/company-portal.html' }
  };

  if (event.data) {
    try {
      const payload = event.data.json();
      data = { ...data, ...payload };
    } catch (e) {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body,
    icon: data.icon || '/icons/icon-192x192.png',
    badge: data.badge || '/icons/icon-72x72.png',
    tag: data.tag || 'acconnx-notification',
    vibrate: [100, 50, 100],
    data: data.data || { url: '/company-portal.html' },
    actions: data.actions || [
      { action: 'view', title: 'View Lead' },
      { action: 'dismiss', title: 'Dismiss' }
    ],
    requireInteraction: data.requireInteraction || false
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// Notification click handler
self.addEventListener('notificationclick', (event) => {
  console.log('[SW] Notification clicked:', event.action);
  event.notification.close();

  if (event.action === 'dismiss') return;

  const url = event.notification.data?.url || '/company-portal.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Focus existing window if available
      for (const client of windowClients) {
        if (client.url.includes('company-portal') && 'focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      // Open new window
      return clients.openWindow(url);
    })
  );
});

// =====================
// BACKGROUND SYNC
// =====================
self.addEventListener('sync', (event) => {
  console.log('[SW] Background sync:', event.tag);

  if (event.tag === 'sync-lead-actions') {
    event.waitUntil(syncLeadActions());
  }
});

async function syncLeadActions() {
  try {
    // Get queued actions from IndexedDB or Cache API
    const cache = await caches.open('acconnx-sync-queue');
    const requests = await cache.keys();

    for (const request of requests) {
      try {
        const response = await fetch(request.clone());
        if (response.ok) {
          await cache.delete(request);
          console.log('[SW] Synced queued action:', request.url);
        }
      } catch (err) {
        console.log('[SW] Failed to sync action:', err);
      }
    }
  } catch (err) {
    console.error('[SW] Background sync error:', err);
  }
}
