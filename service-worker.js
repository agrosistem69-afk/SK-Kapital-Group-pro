// SKKG Pro — Service Worker
// Задача: приложение открывается всегда, даже при плохой связи, и при этом сразу показывает
// новую версию после публикации.
// • Страница (index.html) — сначала сеть, без кэша браузера и хостинга; нет сети — сохранённая копия.
// • Библиотеки, оформление, шрифты, иконки (всё своё, из папки vendor) — сохраняются на устройстве
//   при установке и отдаются сразу. Ссылки на них содержат ?v=версия, поэтому новая версия
//   скачивается заново, а старая удаляется.
// • version.json и всё чужое (база Supabase и т.п.) не трогаем.
// При каждой публикации меняйте версию: CACHE_NAME здесь, APP_VERSION и ?v= в index.html,
// version.json. Автотест проверяет, что они совпадают.

const VERSION = '38';
const CACHE_NAME = 'workcontrol-cache-v' + VERSION;
const CORE = [
    'vendor/app.css',
    'vendor/fontawesome/css/all.min.css',
    'vendor/inter/inter.css',
    'vendor/supabase.js',
    'vendor/html2canvas.min.js',
    'vendor/jspdf.umd.min.js',
    'vendor/jszip.min.js',
].map((u) => u + '?v=' + VERSION).concat([
    'vendor/fontawesome/webfonts/fa-solid-900.woff2',
    'vendor/fontawesome/webfonts/fa-regular-400.woff2',
    'manifest.json',
    'icons/icon-192.png',
    'icons/icon-512.png',
]);

// Свежая копия с сервера: метка в адресе обходит кэш хостинга, no-store — кэш браузера.
function fresh(url) {
    const u = new URL(url, self.location.href);
    u.searchParams.set('_', Date.now());
    return fetch(u.href, { cache: 'no-store', credentials: 'same-origin' });
}

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        // Файлы ставим по одному: если какой-то не скачался, остальные всё равно сохранятся.
        await Promise.all(CORE.map((u) => fetch(u, { cache: 'no-store' }).then((r) => r.ok && cache.put(u, r)).catch(() => {})));
        const page = await fresh('./index.html').catch(() => null);
        if (page && page.ok) await cache.put('./index.html', page);
        await self.skipWaiting();
    })());
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
    const url = new URL(request.url);
    if (url.origin !== self.location.origin || request.method !== 'GET') return;
    if (url.pathname.endsWith('/version.json')) return;

    // Страница приложения: сначала сеть. Если связи нет или сервер долго молчит — сохранённая копия.
    if (request.mode === 'navigate' || request.destination === 'document') {
        event.respondWith((async () => {
            const cache = await caches.open(CACHE_NAME);
            const net = fresh(request.url).then((r) => {
                if (r.ok) cache.put('./index.html', r.clone());
                return r;
            });
            const cached = await cache.match('./index.html');
            if (!cached) return net.catch(() => new Response('Нет связи с сайтом. Проверьте интернет и обновите страницу.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
            // Ждём сеть до 6 секунд, потом показываем сохранённую версию (новая подтянется при следующем открытии).
            const slow = new Promise((resolve) => setTimeout(() => resolve(cached), 6000));
            return Promise.race([net.catch(() => cached), slow]);
        })());
        return;
    }

    // Свои файлы: сначала сохранённые на устройстве, иначе сеть (и сохраняем на будущее).
    event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(request);
        if (cached) return cached;
        const r = await fetch(request);
        if (r.ok && (url.pathname.includes('/vendor/') || url.pathname.includes('/icons/'))) cache.put(request, r.clone());
        return r;
    })());
});
