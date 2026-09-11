import { browser } from '$app/environment';
import { env } from '$env/dynamic/public';
import { redactUrl } from '$lib/utils/redirect';

/**
 * Product analytics (PostHog), twice gated: the deployment must set `PUBLIC_POSTHOG_KEY`, and the
 * visitor must have accepted (ConsentBanner). Until both hold, no script is loaded and nothing is
 * sent; `capture()` calls are simply dropped. Swap the provider by replacing `load()` and the
 * four methods — callers only know `analytics`.
 */

export type Consent = 'granted' | 'denied' | 'undecided';

const KEY = env.PUBLIC_POSTHOG_KEY;
const HOST = env.PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com';
const STORAGE_KEY = 'starterdough.analytics-consent';

type PostHog = typeof import('posthog-js').default;
type CaptureResult = import('posthog-js').CaptureResult;

/**
 * The visitor's stored decision. Exported because error tracking honours the same one: performance
 * tracing is analytics, so it only runs when this says `granted` (src/hooks.client.ts).
 */
export function storedConsent(): Consent {
	if (!browser) return 'undecided';
	const value = localStorage.getItem(STORAGE_KEY);
	return value === 'granted' || value === 'denied' ? value : 'undecided';
}

/**
 * Every event passes through here on its way out. `$current_url`, `$referrer` and their initial
 * twins carry the whole address, and Better Auth's emailed links put a password-reset token or an
 * email address in it — without this, a returning visitor who accepted the banner would ship a live
 * credential to a third party. (`before_send` is what replaced `sanitize_properties`.)
 */
function redactProperties(event: CaptureResult | null): CaptureResult | null {
	if (!event) return event;
	for (const [key, value] of Object.entries(event.properties)) {
		if (typeof value === 'string') event.properties[key] = redactUrl(value);
	}
	return event;
}

class Analytics {
	/** Whether this deployment has analytics configured at all (decides if the banner shows). */
	readonly available = Boolean(KEY);
	consent = $state<Consent>('undecided');
	#client: PostHog | null = null;
	#loading: Promise<PostHog> | null = null;
	#initialised = false;

	/** Read the stored decision and start the client if it was "granted". Call once on mount. */
	start() {
		this.consent = storedConsent();
		if (this.consent === 'granted') void this.#load();
	}

	decide(consent: Exclude<Consent, 'undecided'>) {
		this.consent = consent;
		localStorage.setItem(STORAGE_KEY, consent);
		if (consent === 'granted') void this.#load();
		else this.#teardown();
	}

	/** Forget the decision so the banner shows again (a "cookie settings" link can call this). */
	reset() {
		localStorage.removeItem(STORAGE_KEY);
		this.consent = 'undecided';
		this.#teardown();
	}

	page() {
		this.#client?.capture('$pageview');
	}

	capture(event: string, properties?: Record<string, unknown>) {
		this.#client?.capture(event, properties);
	}

	identify(id: string, traits?: Record<string, unknown>) {
		this.#client?.identify(id, traits);
	}

	/** On sign-out: detach the person so the next visitor is not merged into this one. */
	signOut() {
		this.#client?.reset();
	}

	async #load() {
		if (!browser || !KEY || this.#client) return;
		this.#loading ??= import('posthog-js').then(({ default: posthog }) => posthog);
		const posthog = await this.#loading;
		// The decision can change while the bundle loads, and a second grant must not re-init.
		if (this.consent !== 'granted' || this.#client) return;
		if (!this.#initialised) {
			posthog.init(KEY, {
				api_host: HOST,
				// Page views are sent from `afterNavigate` so client-side navigations count too.
				capture_pageview: false,
				capture_pageleave: true,
				persistence: 'localStorage+cookie',
				autocapture: false,
				before_send: redactProperties,
			});
			this.#initialised = true;
		}
		// A visitor who declined earlier is opted out in PostHog's own storage, and neither `init`
		// nor a fresh page load undoes that — without this, "decline" would be permanent.
		posthog.opt_in_capturing({ captureEventName: false });
		this.#client = posthog;
		this.page();
	}

	#teardown() {
		this.#client?.opt_out_capturing();
		this.#client = null;
	}
}

export const analytics = new Analytics();
