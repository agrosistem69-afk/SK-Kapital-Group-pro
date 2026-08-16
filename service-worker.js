// WorkControl Pro — Service Worker
// Стратегия: "сеть в приоритете" (network-first) для HTML, чтобы пользователь
// всегда получал самую свежую версию сайта после обновления, и при этом
// оставалась базовая офлайн-доступность на случай пропажи связи.
// При каждом обновлении файлов сайта меняйте CACHE_NAME (например, v2, v3...),
// чтобы у пользователей автоматически подтянулась новая версия.

const CACHE_NAME = 'workcontrol-cache-v1';
const PRECACHE_URLS = [
    './',
    './index.html',
    './manifest.json',
    './icons/icon-192.png',
    './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(PRECACHE_URLS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const { request } = event;

    // Запросы к Supabase и другим внешним сервисам (API, CDN) не трогаем —
    // пусть браузер обрабатывает их как обычно, без кэширования.
    if (new URL(request.url).origin !== self.location.origin) return;
    if (request.method !== 'GET') return;

    // HTML-страницы — всегда сначала пробуем сеть, чтобы не показывать устаревшую версию.
    if (request.mode === 'navigate' || request.destination === 'document') {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
                    return response;
                })
                .catch(() => caches.match(request).then((cached) => cached || caches.match('./index.html')))
        );
        return;
    }

    // Статические файлы (иконки, манифест и т.д.) — сначала кэш, для скорости и офлайна,
    // а в фоне подтягиваем свежую версию на будущее.
    event.respondWith(
        caches.match(request).then((cached) => {
            const networkFetch = fetch(request).then((response) => {
                const copy = response.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
                return response;
            }).catch(() => cached);
            return cached || networkFetch;
        })
    );
});
