// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		interface Error {
			message: string;
			/** Reference id attached by `handleError` (also sent to Sentry when configured). */
			id?: string;
		}
		// interface Locals {}
		interface PageData {
			/** Feature flags of the active organization; seeded by the `(app)` layout load. */
			flags?: Record<string, boolean>;
		}
		// interface PageState {}
		// interface Platform {}
	}

	interface ImportMetaEnv {
		/** Build target injected by vite.config.ts (`ADAPTER=node|cloudflare|static`). */
		readonly ADAPTER: 'node' | 'cloudflare' | 'static';
	}

	/** Chromium's install prompt (not in lib.dom). */
	interface BeforeInstallPromptEvent extends Event {
		prompt(): Promise<void>;
		readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
	}
}

export {};
