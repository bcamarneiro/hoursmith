const CACHE_NAME = 'hoursmith-shell-v3';
// Stable, fixed-name shell assets only. The JS/CSS bundles are content-hashed
// (`main.<hash>.js`, etc.) and change every build, so they are NOT precached
// here — listing them would 404 and, because `addAll` is atomic, abort the
// whole install (the prior `./bundle.js` / `./bundle.css` entries never existed
// in production, so the SW never installed). Hashed assets are cached at runtime
// by the fetch handler below.
const APP_SHELL = [
	'./',
	'./index.html',
	'./manifest.webmanifest',
	'./favicon.svg',
	'./pwa-icon.svg',
	'./pwa-icon-maskable.svg',
];

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches.open(CACHE_NAME).then((cache) =>
			// Resilient precache: a single missing asset must not abort the install
			// (unlike `addAll`, which rejects the whole batch on any failure).
			Promise.allSettled(APP_SHELL.map((url) => cache.add(url))),
		),
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
