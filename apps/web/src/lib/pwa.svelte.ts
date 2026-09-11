import { browser, dev } from '$app/environment';

/** True inside the Tauri desktop/mobile shells (static build served from the app bundle). */
export const isTauri = browser && '__TAURI_INTERNALS__' in window;

/**
 * Progressive-web-app plumbing: registers the service worker (src/service-worker.ts — offline
 * shell + cached assets) and captures the browser's install prompt so the UI can offer
 * "Install app" at a sensible moment instead of the browser's mini-infobar.
 */
class Pwa {
	#prompt = $state<BeforeInstallPromptEvent | null>(null);
	/** True when the browser is willing to install the app right now. */
	readonly canInstall = $derived(this.#prompt !== null);
	installed = $state(false);
	/** A newer build has been activated by the service worker; a reload picks it up. */
	updateAvailable = $state(false);

	/** Call once on mount (root layout). */
	start() {
		if (!browser) return;
		this.installed = matchMedia('(display-mode: standalone)').matches;
		window.addEventListener('beforeinstallprompt', (event) => {
			event.preventDefault();
			this.#prompt = event as BeforeInstallPromptEvent;
		});
		window.addEventListener('appinstalled', () => {
			this.#prompt = null;
			this.installed = true;
		});
		void this.#register();
	}

	/**
	 * Drop every cache this origin holds. Called on sign-out: the current worker caches only the
	 * public build (src/service-worker.ts), but a cache written by an older build may still hold
	 * an authenticated page, and on a shared machine the next person must not be able to read it.
	 * The offline shell is precached again by the next install, or per file on first use.
	 */
	async clearCaches() {
		if (!browser || !('caches' in window)) return;
		try {
			const keys = await caches.keys();
			await Promise.all(keys.map((key) => caches.delete(key)));
		} catch (error) {
			console.warn('Clearing caches failed', error);
		}
	}

	async install() {
		const prompt = this.#prompt;
		if (!prompt) return;
		await prompt.prompt();
		const { outcome } = await prompt.userChoice;
		if (outcome === 'accepted') this.#prompt = null;
	}

	/** Production browsers only: no caching games in dev, and the Tauri shells ship their own files. */
	async #register() {
		if (dev || isTauri || !('serviceWorker' in navigator)) return;
		try {
			const registration = await navigator.serviceWorker.register('/service-worker.js');
			registration.addEventListener('updatefound', () => {
				const worker = registration.installing;
				worker?.addEventListener('statechange', () => {
					if (worker.state === 'activated' && navigator.serviceWorker.controller) {
						this.updateAvailable = true;
					}
				});
			});
		} catch (error) {
			console.warn('Service worker registration failed', error);
		}
	}
}

export const pwa = new Pwa();
