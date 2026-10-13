import { describe, expect, it } from 'bun:test';
import type { ErrorEvent } from '@sentry/node';
import {
	errorReportingEnabled,
	flushErrorReporting,
	reportError,
	scrubEvent,
	startErrorReporting,
} from './error-reporting';

/**
 * Runs `script` in a child process with `SENTRY_DSN` pointing at a local server, and returns what
 * the child printed and every body the server received. The SDK is global and once per process,
 * and `bun test` runs every file in one process, so starting it here would leave a live client
 * behind for the files that run after this one. Spawning is slow on a loaded machine, hence the
 * generous timeouts below. A child expected to exit non-zero prints nothing worth parsing.
 */
async function inChild(script: string, env: Record<string, string> = {}, exitCode = 0) {
	const bodies: string[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const bytes = new Uint8Array(await request.arrayBuffer());
			// The SDK gzips an envelope past 32 KiB.
			const gzipped = request.headers.get('content-encoding') === 'gzip';
			bodies.push(new TextDecoder().decode(gzipped ? Bun.gunzipSync(bytes) : bytes));
			return Response.json({});
		},
	});
	try {
		const child = Bun.spawn([process.execPath, '--eval', script], {
			cwd: import.meta.dir,
			env: {
				PATH: process.env.PATH ?? '',
				SKIP_ENV_VALIDATION: '1',
				SENTRY_DSN: `http://public@127.0.0.1:${server.port}/1`,
				...env,
			},
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (code !== exitCode) throw new Error(`the child exited ${code}: ${stderr}`);
		const printed: Record<string, unknown> = exitCode === 0 ? JSON.parse(stdout) : {};
		return { printed, sent: bodies.join('\n') };
	} finally {
		server.stop(true);
	}
}

/** Starts reporting the way `index.ts` does, runs `body`, flushes and prints `result`. */
const childScript = (body: string) => `
	const { trace } = await import('@opentelemetry/api');
	const { flushErrorReporting, reportError, startErrorReporting } = await import('./error-reporting.ts');
	// The global provider is a proxy that never changes; registering one swaps its delegate.
	const tracerProvider = () => trace.getTracerProvider().getDelegate();
	const providerBefore = tracerProvider();
	const started = await startErrorReporting({
		dsn: process.env.SENTRY_DSN,
		environment: 'test',
		release: '1.1.0',
		serverName: 'starterdough-api',
	});
	const result = { started };
	${body}
	result.flushed = await flushErrorReporting(5_000);
	result.sameTracerProvider = tracerProvider() === providerBefore;
	console.log(JSON.stringify(result));
	process.exit(0);
`;

describe('error reporting', () => {
	it('is a no-op without a DSN', async () => {
		const started = await startErrorReporting({
			dsn: undefined,
			environment: 'test',
			release: '0.0.0',
			serverName: 'starterdough-api',
		});
		expect(started).toBe(false);
		expect(errorReportingEnabled()).toBe(false);
		reportError(new Error('dropped'), { requestId: 'req-0' });
		expect(await flushErrorReporting(100)).toBe(true);
	});

	it('sends a captured error with its fields, and leaves tracing to OpenTelemetry', async () => {
		const { printed, sent } = await inChild(
			childScript(`
				reportError(new Error('boom in a procedure'), { requestId: 'req-1', procedure: 'notes.create' });
			`),
			// The root .env hands this process the web's sample rate too; the API must not trace.
			{ SENTRY_TRACES_SAMPLE_RATE: '1' },
		);
		expect(printed).toEqual({ started: true, flushed: true, sameTracerProvider: true });
		expect(sent).toContain('boom in a procedure');
		expect(sent).toContain('"requestId":"req-1"');
		expect(sent).toContain('"procedure":"notes.create"');
		expect(sent).toContain('"environment":"test"');
		expect(sent).toContain('"release":"1.1.0"');
		expect(sent).toContain('"server_name":"starterdough-api"');
		expect(sent).not.toContain('"type":"transaction"');
		const integrations = JSON.parse(/"integrations":(\[[^\]]*\])/.exec(sent)?.[1] ?? 'null');
		expect(integrations).toContain('LinkedErrors');
		for (const excluded of ['OnUncaughtException', 'Http', 'NodeFetch', 'Console']) {
			expect(integrations).not.toContain(excluded);
		}
		expect(integrations.join()).not.toContain('LocalVariables');
	}, 30_000);

	it('withholds a failed statement and its bound values, and keeps what Postgres said', async () => {
		// The secret is made in the child at run time: the SDK sends source lines around each frame,
		// so a literal in a source file would reach the envelope whatever the scrub does.
		const { printed, sent } = await inChild(
			childScript(`
				const { DrizzleQueryError } = await import('drizzle-orm/errors');
				result.secret = 'tok_' + crypto.randomUUID();
				reportError(
					new DrizzleQueryError('select * from "session" where "token" = $1', [result.secret], new Error('relation "session" does not exist')),
					{ requestId: 'req-2' },
				);
			`),
		);
		expect(printed.started).toBe(true);
		expect(printed.flushed).toBe(true);
		expect(typeof printed.secret).toBe('string');
		expect(sent).toContain('req-2');
		expect(sent).not.toContain(printed.secret as string);
		expect(sent).not.toContain('from \\"session\\" where');
		expect(sent).toContain('statement and parameters withheld');
		expect(sent).toContain('does not exist');
	}, 30_000);

	it('sends a fatal error before the process exits', async () => {
		// Sentry's own process handlers are left out, so `lifecycle.ts` is the only path a crash
		// outside any request takes to Sentry, and its exit must wait for the report to go out.
		const { sent } = await inChild(
			`
				const { startErrorReporting } = await import('./error-reporting.ts');
				const { installProcessHandlers } = await import('./lifecycle.ts');
				await startErrorReporting({
					dsn: process.env.SENTRY_DSN,
					environment: 'test',
					release: '1.1.0',
					serverName: 'starterdough-api',
				});
				installProcessHandlers(() => {});
				// A server keeps the event loop alive, so only the fatal path can end this process.
				setInterval(() => {}, 1_000);
				setTimeout(() => {
					throw new Error('crashed outside any request');
				}, 0);
			`,
			{},
			1,
		);
		expect(sent).toContain('crashed outside any request');
		expect(sent).toContain('"fatal":"uncaught exception"');
	}, 30_000);

	it('strips the query string from a request URL the SDK attached', () => {
		const event = scrubEvent({
			type: undefined,
			request: {
				url: 'https://api.example.com/api/auth/verify-email?token=t',
				query_string: 'token=t',
			},
		} as ErrorEvent);
		expect(event.request?.url).toBe('https://api.example.com/api/auth/verify-email');
		expect(event.request?.query_string).toBeUndefined();
	});
});
