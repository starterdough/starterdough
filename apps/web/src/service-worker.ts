/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
import { build, files, prerendered, version } from '$service-worker';

/**
 * Offline shell. Precaches the immutable build (`build`), the static folder (`files`) and the
 * prerendered public pages (`/offline` among them) and serves exactly those from the cache.
 *
 * Nothing else is ever written to a cache. A navigation to `/app` or `/admin` returns the
 * signed-in user's HTML, and on a single-origin deployment `/api/*` and `/uploads/:org/:doc` are
 * same-origin GETs as well — a cached copy would hand the next person at the machine another
 * user's page, or a session credential out of DevTools. A navigation that fails offline is
 * answered with `/offline`; everything else reaches the network untouched. A new deploy (new
 * `version`) replaces the cache on activation, and signing out clears it ($lib/pwa.svelte.ts).
 */
const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE = `starterdough-${version}`;
/** The only paths this worker may cache — the build manifest, which also bounds its size. */
const ASSETS = new Set([...build, ...files, ...prerendered]);
const OFFLINE = '/offline';

sw.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE);
			// One request per file rather than `addAll`: a single 404 or dropped connection would
			// otherwise leave the whole offline shell uninstalled. A path that failed here is
			// fetched (and cached) on first use by `asset()` below.
			const results = await Promise.allSettled([...ASSETS].map((asset) => cache.add(asset)));
			const failed = results.filter((result) => result.status === 'rejected').length;
			if (failed > 0) console.warn(`Service worker: ${failed}/${ASSETS.size} files not precached`);
			await sw.skipWaiting();
		})(),
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys()) {
				if (key !== CACHE) await caches.delete(key);
			}
			await sw.clients.claim();
		})(),
	);
});

sw.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.method !== 'GET') return;
	const url = new URL(request.url);
	if (url.origin !== sw.location.origin) return;

	if (ASSETS.has(url.pathname)) {
		event.respondWith(asset(url.pathname, request));
		return;
	}

	// Not in the manifest: private, dynamic, or another origin's business. Straight to the
	// network, with no cache read and no cache write; only a failed navigation is answered.
	if (request.mode === 'navigate') event.respondWith(navigation(request));
});

/** Precached build output and static files: cache first, network only to repair a gap. */
async function asset(pathname: string, request: Request) {
	const cache = await caches.open(CACHE);
	const cached = await cache.match(pathname);
	if (cached) return cached;
	const response = await fetch(request);
	if (response.ok) void cache.put(pathname, response.clone());
	return response;
}

async function navigation(request: Request) {
	try {
		return await fetch(request);
	} catch (error) {
		const cache = await caches.open(CACHE);
		const offline = await cache.match(OFFLINE);
		if (offline) return offline;
		throw error;
	}
}
