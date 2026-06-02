const CACHE_NAME = 'hoursmith-shell-v2';
const APP_SHELL = [
	'./',
	'./index.html',
	'./bundle.js',
	'./bundle.css',
	'./manifest.webmanifest',
	'./favicon.svg',
	'./pwa-icon.svg',
	'./pwa-icon-maskable.svg',
];

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)),
	);
	self.skipWaiting();
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(
					keys
						.filter((key) => key !== CACHE_NAME)
						.map((key) => caches.delete(key)),
				),
			)
			.then(() => self.clients.claim()),
	);
});

self.addEventListener('fetch', (event) => {
	if (event.request.method !== 'GET') return;

	const requestUrl = new URL(event.request.url);
	if (requestUrl.origin !== self.location.origin) return;

	if (event.request.mode === 'navigate') {
		event.respondWith(
			fetch(event.request).catch(async () => {
				const cachedResponse =
					(await caches.match('./index.html')) || (await caches.match('./'));
				return cachedResponse || Response.error();
			}),
		);
		return;
	}

	event.respondWith(
		caches.match(event.request).then((cachedResponse) => {
			if (cachedResponse) return cachedResponse;

			return fetch(event.request)
				.then((networkResponse) => {
					if (!networkResponse || networkResponse.status !== 200) {
						return networkResponse;
					}

					const responseClone = networkResponse.clone();
					void caches
						.open(CACHE_NAME)
						.then((cache) => cache.put(event.request, responseClone));
					return networkResponse;
				})
				.catch(() =>
					caches
						.match('./index.html')
						.then((fallback) => fallback || Response.error()),
				);
		}),
	);
});
