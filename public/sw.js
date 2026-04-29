const CACHE_NAME = 'cafemenu-admin-v1';
const STATIC_ASSETS = [
  '/admin',
  '/admin.html',
  '/manifest.json',
  'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap'
];

// Kurulum — statik dosyaları cache'e al
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS).catch(() => {});
    })
  );
  self.skipWaiting();
});

// Aktivasyon — eski cache'leri temizle
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — Network first, cache fallback
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API isteklerini her zaman network'ten al, cache'leme
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ error: 'İnternet bağlantısı yok' }), {
          headers: { 'Content-Type': 'application/json' },
          status: 503
        })
      )
    );
    return;
  }

  // Statik dosyalar — network first, sonra cache
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Başarılı yanıtı cache'e de yaz
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// Push bildirim desteği (ileride kullanmak için)
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  self.registration.showNotification(data.title || 'CafeMenu', {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-72.png',
    data: data.url || '/admin'
  });
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data || '/admin')
  );
});
