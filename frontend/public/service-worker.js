const CACHE_NAME = 'hoursmith-shell-v5';
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

	// Never cache API traffic. The hosted proxy is same-origin
	// (`/api/proxy/...`), so cache-first would persist Jira worklog data and
	// identity to disk (privacy leak) and replay frozen first responses
	// (stale data — edits/new/deleted worklogs never appear). Always go to the
	// network and never `cache.put` these. (ADA-450)
	if (requestUrl.pathname.startsWith('/api/')) {
		event.respondWith(fetch(event.request));
		return;
	}

	if (event.request.mode === 'navigate') {
		// Stale-while-revalidate for the app shell: serve the cached
		// index.html instantly so the app loads without waiting for the
		// network, then fetch a fresh copy in the background to update the
		// cache for the *next* navigation. The versioned CACHE_NAME ensures
		// a new SW build invalidates the old shell and its hashed chunk
		// references in one activation.
		event.respondWith(
			caches.open(CACHE_NAME).then(async (cache) => {
				const cachedResponse =
					(await cache.match('./index.html')) || (await cache.match('./'));

				// Background revalidation — don't block the response on it.
				const networkPromise = fetch(event.request)
					.then((networkResponse) => {
						if (networkResponse && networkResponse.status === 200) {
							cache.put('./index.html', networkResponse.clone());
						}
						return networkResponse;
					})
					.catch(() => undefined);

				// Wait for the background update so the SW doesn't get
				// terminated before the cache is written.
				event.waitUntil(networkPromise);

				// Fall back to the network result before giving up. The promise
				// above has already resolved by the time we get here; discarding
				// it meant a missing shell cache (evicted under storage
				// pressure, a partial precache on install, or site data cleared
				// while the SW stayed registered) turned every navigation into a
				// network error — the app unreachable while fully online.
				return cachedResponse || (await networkPromise) || Response.error();
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
