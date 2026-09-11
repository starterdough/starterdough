import { OpenAPIGenerator } from '@orpc/openapi';
import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { ORPCError, onError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import {
	experimental_ZodSmartCoercionPlugin as ZodSmartCoercionPlugin,
	ZodToJsonSchemaConverter,
} from '@orpc/zod/zod4';
import { env } from '@repo/env';
import type { Hono } from 'hono';
import { addLogContext, log } from '../log';
import { createContext } from './context';
import { router } from './router';
import { version } from './version';

const rpcLog = log.with({ component: 'rpc' });

/**
 * The matched procedure (`documents.list`) on every line this request writes, the error line below
 * included: the request-level interceptor sees the error but not which procedure raised it. Runs
 * before the procedure, so a line from inside the handler carries it too. `requestId`, method and
 * path are already in the context (see `middleware/request-log.ts`).
 */
function tagProcedure(options: { path: readonly string[]; next: () => Promise<unknown> }) {
	addLogContext({ procedure: options.path.join('.') });
	return options.next();
}

/**
 * Every failed procedure passes through here. A 4xx `ORPCError` (validation, auth, not found) is
 * the procedure answering as designed — the access log already records the status, so a debug
 * line is enough; anything else is a bug or an outage and is logged in full.
 */
function logError(error: unknown) {
	if (error instanceof ORPCError && error.status < 500) {
		rpcLog.debug('procedure rejected', {
			code: error.code,
			status: error.status,
			message: error.message,
		});
		return;
	}
	rpcLog.error('procedure failed', { error });
}

/** Compact transport for our own TypeScript clients (rich types: Date, Map, Set, …). */
const rpcHandler = new RPCHandler(router, {
	interceptors: [onError(logError)],
	clientInterceptors: [tagProcedure],
});

/** Plain REST for everyone else — Python services, curl, third parties. */
const openapiHandler = new OpenAPIHandler(router, {
	interceptors: [onError(logError)],
	clientInterceptors: [tagProcedure],
	plugins: [new ZodSmartCoercionPlugin()],
});

const generator = new OpenAPIGenerator({
	schemaConverters: [new ZodToJsonSchemaConverter()],
});

export function generateSpec() {
	return generator.generate(router, {
		info: {
			title: 'Starterdough API',
			// The release version, like `/health` and `/admin/system` — never a second literal here.
			version,
			description: 'Single source of truth consumed by the web app, native shells and services.',
		},
		servers: [{ url: `${env.API_URL ?? 'http://localhost:3000'}/api/v1` }],
	});
}

/**
 * Built once per process: generating it walks every procedure and converts every Zod schema, and
 * the document only changes when the build does. `no-cache` (store it, but revalidate) rather than
 * the API's blanket `no-store`, so the ETag can actually save the transfer — this document is the
 * contract, not tenant data.
 */
let cachedSpec: Promise<{ body: string; etag: string }> | null = null;

function openapiDocument(): Promise<{ body: string; etag: string }> {
	cachedSpec ??= generateSpec().then((spec) => {
		const body = JSON.stringify(spec);
		return { body, etag: `"${Bun.hash(body).toString(16)}"` };
	});
	return cachedSpec;
}

export function mountRpc(app: Hono) {
	app.use('/rpc/*', async (c, next) => {
		const { matched, response } = await rpcHandler.handle(c.req.raw, {
			prefix: '/rpc',
			context: createContext(c.req.raw),
		});
		if (matched) return c.newResponse(response.body, response);
		await next();
	});

	app.get('/api/v1/openapi.json', async (c) => {
		const { body, etag } = await openapiDocument();
		const headers = { etag, 'cache-control': 'no-cache' };
		if (c.req.header('if-none-match') === etag) return c.body(null, 304, headers);
		return c.body(body, 200, { ...headers, 'content-type': 'application/json' });
	});

	app.use('/api/v1/*', async (c, next) => {
		const { matched, response } = await openapiHandler.handle(c.req.raw, {
			prefix: '/api/v1',
			context: createContext(c.req.raw),
		});
		if (matched) return c.newResponse(response.body, response);
		await next();
	});
}
