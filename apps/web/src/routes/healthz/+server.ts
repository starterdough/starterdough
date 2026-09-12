import { json } from '@sveltejs/kit';

/**
 * Liveness probe for the container HEALTHCHECK and Caddy's active health checks. Prerendered, so
 * it is a static file in every build (node, Cloudflare, static) and costs nothing per poll; it
 * answers "the server process is up", nothing about the API (that is the API's own /readyz).
 */
export const prerender = true;

export const GET = () => json({ status: 'ok' });
