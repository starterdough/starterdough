import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/**
 * `/` is a doorway, not a page. The marketing site (apps/site) is the public landing, so a second
 * one here only ever offered the same two buttons again: visitors arriving from "Open the app", or
 * typing the bare domain, had to choose a door twice. `(app)/app/+layout.ts` already knows which
 * one they wanted — the workspace with a session, `/login?next=/app` without — so send them there
 * and let the one guard decide. Universal, so the static (Tauri) build redirects on the client the
 * same way the server-rendered targets answer with a 307.
 */
export const load: PageLoad = () => redirect(307, '/app');
