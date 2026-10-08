import { type ApiClient, createApiClient, type FetchLike } from '@repo/api-client';
import { PUBLIC_API_URL, PUBLIC_DEMO_MODE, PUBLIC_WEB_URL } from '$app/env/public';
import { isTauri } from './pwa.svelte';
import { tokenStore, usesBearerAuth } from './token-store';

/**
 * Browser-facing API origin. Must be absolute. For single-origin deployments
 * (Caddy path routing behind Tailscale) point it at the same host as the app.
 */
export const API_URL = PUBLIC_API_URL || 'http://localhost:3000';

/**
 * Origin of the deployed web app, for round trips that leave a shell: an emailed link, the address
 * an outside page sends the browser back to (a shell offers no OAuth sign-in, see
 * `SOCIAL_SIGN_IN_AVAILABLE`). Inside the Tauri shells `location.origin` is `tauri://localhost` or
 * `http://tauri.localhost`, which nothing outside the webview can resolve, so those builds need
 * `PUBLIC_WEB_URL` to name the real deployment. Empty everywhere else: the app is already there.
 */
const WEB_URL = (PUBLIC_WEB_URL || '').replace(/\/+$/, '');

/**
 * The static (bearer) build running inside a Tauri shell, on `tauri://localhost` or
 * `http://tauri.localhost`. Three sign-in steps and impersonation cannot finish there, so the flags
 * below turn them off. Only there: the same static build served from a static host runs on the web
 * app's own origin, where all of them behave as they do in the web build, and an account that only
 * has a provider or a passkey must still be able to sign in. Fixed for the page's lifetime; `false`
 * during SSR, which only the web build does.
 */
const inShell = usesBearerAuth && isTauri;

/**
 * False only inside a shell built without `PUBLIC_WEB_URL` (`dev:desktop`, `preview:desktop`; a
 * release build refuses to start without it). There `returnUrl()` can only answer with the shell's
 * own origin, and an outside page cannot send the system browser back to that, so the flows that
 * need a way back are disabled instead of handing out an unroutable URL. A static host serves the
 * page from the web app's own origin, which works as a return address without `PUBLIC_WEB_URL`,
 * the same as in the web build.
 */
export const RETURN_URLS_AVAILABLE = !inShell || WEB_URL !== '';

/**
 * False inside a shell. Social sign-in ends with the API setting a session cookie in whichever
 * browser made the round trip, and the shell hands the provider's page to the *system* browser
 * (`apps/native/src-tauri/src/lib.rs`), so at best the user is signed in to the web app over there
 * while the shell, which only reads a bearer token, stays on its sign-in page. A return address
 * (`PUBLIC_WEB_URL`) does not change that. The buttons stay hidden until the shells get a deep-link
 * return (apps/native/README.md).
 */
export const SOCIAL_SIGN_IN_AVAILABLE = !inShell;

/**
 * False inside a shell. The API registers passkeys for `WEB_URL`'s hostname (the relying-party
 * ID), and WebAuthn refuses with a SecurityError on any page whose own hostname is not that one or
 * a subdomain of it, before the API is even asked, so a shell can neither sign in with a passkey
 * nor add one. Listing, renaming and removing passkeys are plain API calls and keep working there.
 */
export const PASSKEYS_AVAILABLE = !inShell;

/**
 * False inside a shell. Between the password and the code, Better Auth keeps the half-finished
 * sign-in in a `SameSite=Lax` cookie, and a browser engine drops a cookie like that when a
 * cross-site `fetch` sets it. A shell's page is never on the API's site, so the code check would
 * fail with "invalid two factor cookie": the code page explains instead of taking a code it cannot
 * check. Lift this once the API hands that cookie to bearer clients the way the `bearer` plugin
 * hands over the session token.
 */
export const TWO_FACTOR_SIGN_IN_AVAILABLE = !inShell;

/**
 * False inside a shell. Impersonating swaps the shell's bearer token for the target user's session
 * and parks the admin's own session in an `admin_session` cookie, which is dropped for the same
 * cross-site reason as the two-factor one. "Stop impersonating" then finds no admin session to go
 * back to, and the admin would be stuck as the other user. Admins impersonate from the web app.
 */
export const IMPERSONATION_AVAILABLE = !inShell;

/**
 * Public demo deployment (`PUBLIC_DEMO_MODE`): the shell shows a banner, every page is `noindex`,
 * and the controls whose procedures the API refuses in demo mode are disabled.
 */
export const DEMO_MODE = PUBLIC_DEMO_MODE === 'true';

/**
 * Absolute URL of one of this app's own pages, for anything that leaves the device: a provider's
 * return address, a link in an email. Never build one from `location.origin` directly: inside a
 * shell that is `tauri://localhost` or `http://tauri.localhost`, which the recipient's browser
 * cannot open. A release shell build always has `PUBLIC_WEB_URL`; `build:desktop` refuses to run
 * without it. Browser only.
 */
export function returnUrl(path: string): string {
	return `${(usesBearerAuth && WEB_URL) || location.origin}${path}`;
}

/** Shared client for components and client-side code. */
export const api: ApiClient = createApiClient({
	baseUrl: API_URL,
	getToken: () => tokenStore.get(),
});

/**
 * Per-request client for `load` functions. Passing SvelteKit's `fetch` lets SSR
 * forward the browser's cookies (see hooks.server.ts) and dedupe requests.
 */
export function apiFor(fetch: FetchLike): ApiClient {
	return createApiClient({ baseUrl: API_URL, fetch, getToken: () => tokenStore.get() });
}
