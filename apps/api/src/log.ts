import { AsyncLocalStorage } from 'node:async_hooks';
import { isSpanContextValid, trace } from '@opentelemetry/api';
import { logFormat, logLevel } from '@repo/env';

/**
 * The API's logger. Dependency-free on purpose: two output formats and four levels are all this
 * codebase needs, and a library would only add a second configuration surface.
 *
 *   json    one object per line — `{ time, level, msg, ...fields }` — for `docker logs`, Loki,
 *           Datadog and friends. `Error` values become `{ name, message, stack }`. When a trace is
 *           active (see `otel.ts`) every line carries `traceId`/`spanId`, so a log line can be
 *           found from a span and vice versa.
 *   pretty  `HH:MM:SS level message key=value …` for a developer's terminal; coloured on a TTY.
 *
 * `debug`/`info` go to stdout, `warn`/`error` to stderr, which is what process managers and
 * container runtimes expect. Use `log.with({ component: 'jobs' })` for a bound logger instead of
 * prefixing messages. Structured fields (`{ jobId }`) beat interpolation (`job ${id}`): they are
 * what a log query filters on. Inside a request every line also carries that request's fields
 * (`requestId`, method, path — see `withLogContext`), so nothing has to thread them by hand.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'json' | 'pretty';
export type LogFields = Record<string, unknown>;

export interface Logger {
	debug(message: string, fields?: LogFields): void;
	info(message: string, fields?: LogFields): void;
	warn(message: string, fields?: LogFields): void;
	error(message: string, fields?: LogFields): void;
	/** A logger that adds `fields` to every line it writes. */
	with(fields: LogFields): Logger;
}

export type LogSink = (stream: 'stdout' | 'stderr', line: string) => void;

export interface LoggerOptions {
	/** Defaults to `logFormat()` from the environment. */
	format?: LogFormat;
	/** Lines below this level are dropped. Defaults to `logLevel()` from the environment. */
	level?: LogLevel;
	/** Where lines go. Defaults to stdout/stderr; tests pass a collector. */
	sink?: LogSink;
	/** ANSI colours in pretty output. Defaults to "stdout is a TTY and NO_COLOR is unset". */
	color?: boolean;
	/** Clock, injectable for tests. */
	now?: () => Date;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const defaultSink: LogSink = (stream, line) => {
	try {
		(stream === 'stdout' ? process.stdout : process.stderr).write(`${line}\n`);
	} catch {
		// A closed pipe (`… | head`, a collector that went away) must not take the process down from
		// inside a log call — there is nowhere left to report it anyway.
	}
};

/**
 * Fields shared by every line written while handling one request. `middleware/request-log.ts` opens
 * the scope; anything running inside it — an oRPC interceptor, a service call, a job enqueued from a
 * procedure — gets `requestId` on its lines without being handed a logger.
 */
const requestContext = new AsyncLocalStorage<LogFields>();

/** Run `fn` with `fields` on every log line it writes, awaits included. */
export function withLogContext<T>(fields: LogFields, fn: () => T): T {
	return requestContext.run({ ...fields }, fn);
}

/** Add to the current scope's fields (the matched procedure, say). A no-op outside a request. */
export function addLogContext(fields: LogFields): void {
	const store = requestContext.getStore();
	if (store) Object.assign(store, fields);
}

/** The current request's fields, or `undefined` outside a request. Read-only: mutate via `addLogContext`. */
export function logContext(): Readonly<LogFields> | undefined {
	return requestContext.getStore();
}

/**
 * Field names never written to the log, whatever carries them.
 *
 * `query`/`params`/`sql` are on the list because of Drizzle: it wraps every driver failure in a
 * `DrizzleQueryError` whose own properties are the statement and every bound value, so one failing
 * session lookup used to log `select … where token = $1` next to the token itself. The rest are the
 * credentials that could plausibly ride along on an error or a context object.
 */
const REDACTED_FIELDS = new Set([
	'authorization',
	'cookie',
	'params',
	'password',
	'query',
	'secret',
	'set-cookie',
	'sql',
	'token',
]);

const REDACTED = '[redacted]';

const isRedacted = (key: string) => REDACTED_FIELDS.has(key.toLowerCase());

/**
 * The innermost message. Drizzle's envelope is `Failed query: <the SQL>`, while the operator needs
 * what Postgres said (`sorry, too many clients already`). Shared with `app.ts`, which reports the
 * reason a readiness probe failed.
 */
export function rootCauseMessage(error: unknown): string {
	let current = error;
	while (current instanceof Error && current.cause instanceof Error) current = current.cause;
	return current instanceof Error ? current.message : String(current);
}

/**
 * A wrapper whose `message` is the failed statement. `DrizzleQueryError` sets no `name`, so it is
 * recognised by the pair of own properties it always carries.
 */
function isQueryError(error: Error): boolean {
	return (
		typeof (error as { query?: unknown }).query === 'string' &&
		Array.isArray((error as { params?: unknown }).params)
	);
}

/**
 * What an error says on the line. A query error's own message *is* the SQL, so it is replaced by
 * what Postgres actually said rather than redacted — the operator needs a reason, not `[redacted]`.
 */
function messageOf(error: Error): string {
	return isQueryError(error) ? rootCauseMessage(error) : error.message;
}

/**
 * A stack begins with `<name>: <message>`, so a query error's stack repeats the statement and every
 * bound value the message was replaced for. Only the frames are kept, under the safe message.
 * `undefined` when nothing recognisable as a frame is left, rather than risk passing the header on.
 */
function stackOf(error: Error): string | undefined {
	if (!error.stack) return undefined;
	if (!isQueryError(error)) return error.stack;
	const frames = error.stack.split('\n').filter((line) => line.trimStart().startsWith('at '));
	return frames.length > 0 ? [messageOf(error), ...frames].join('\n') : undefined;
}

/**
 * Errors do not JSON-serialise on their own (`{}`), so they are flattened into plain fields. Own
 * enumerable extras (`status`, `code`, …) come along: they are usually the most useful part of a
 * custom error such as `AiServiceError` or `ORPCError` — minus anything on `REDACTED_FIELDS`.
 */
function serializeError(error: Error): Record<string, unknown> {
	const out: Record<string, unknown> = { name: error.name, message: messageOf(error) };
	const stack = stackOf(error);
	if (stack) out.stack = stack;
	for (const [key, value] of Object.entries(error)) {
		if (key in out || key === 'cause') continue;
		out[key] = isRedacted(key) ? REDACTED : toJson(value);
	}
	if (error.cause !== undefined) out.cause = toJson(error.cause);
	return out;
}

function toJson(value: unknown): unknown {
	if (value instanceof Error) return serializeError(value);
	if (typeof value === 'bigint') return value.toString();
	return value;
}

/** Redaction runs here too, so a denied key nested anywhere under a logged value is caught. */
const replacer = (key: string, value: unknown) => (isRedacted(key) ? REDACTED : toJson(value));

/**
 * The slow path for a cyclic value: a back-reference to an object still being serialised becomes
 * `"[Circular]"` and everything else stays. `this` is the holder of `value`, which is what tells a
 * cycle apart from a plain repeated reference (one object under two siblings).
 */
function circularReplacer() {
	const ancestors: object[] = [];
	return function (this: object, key: string, value: unknown): unknown {
		if (isRedacted(key)) return REDACTED;
		const json = toJson(value);
		if (typeof json !== 'object' || json === null) return json;
		while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
		if (ancestors.includes(json)) return '[Circular]';
		ancestors.push(json);
		return json;
	};
}

/** `JSON.stringify` that survives cycles and BigInts instead of taking the log line down with it. */
function stringify(record: Record<string, unknown>): string {
	try {
		return JSON.stringify(record, replacer);
	} catch {
		return JSON.stringify(record, circularReplacer());
	}
}

/** Ids of the active span, so lines can be joined with traces. Absent when telemetry is off. */
function traceFields(): { traceId: string; spanId: string } | undefined {
	const spanContext = trace.getActiveSpan()?.spanContext();
	if (!spanContext || !isSpanContextValid(spanContext)) return undefined;
	return { traceId: spanContext.traceId, spanId: spanContext.spanId };
}

// Pretty output: level colours and a dim timestamp, nothing fancier.
const ANSI = {
	reset: '\x1b[0m',
	dim: '\x1b[2m',
	bold: '\x1b[1m',
	red: '\x1b[31m',
	yellow: '\x1b[33m',
	green: '\x1b[32m',
	cyan: '\x1b[36m',
	magenta: '\x1b[35m',
} as const;

const LEVEL_COLOR: Record<LogLevel, string> = {
	debug: ANSI.magenta,
	info: ANSI.green,
	warn: ANSI.yellow,
	error: ANSI.red,
};

/** Bare when it can be read back unambiguously (`key=value`), JSON-quoted otherwise. */
const quote = (text: string) => (text === '' || /[\s"=]/.test(text) ? JSON.stringify(text) : text);

function prettyValue(value: unknown): string {
	if (value instanceof Error) return quote(`${value.name}: ${messageOf(value)}`);
	if (typeof value === 'string') return quote(value);
	if (typeof value === 'bigint') return value.toString();
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'object' && value !== null) {
		return stringify(value as Record<string, unknown>);
	}
	return String(value);
}

/** Local wall-clock time: a developer reads this next to their editor, not next to a dashboard. */
function localClock(time: Date): string {
	const two = (n: number) => String(n).padStart(2, '0');
	return `${two(time.getHours())}:${two(time.getMinutes())}:${two(time.getSeconds())}`;
}

function formatPretty(
	time: Date,
	level: LogLevel,
	message: string,
	fields: Record<string, unknown>,
	color: boolean,
): string {
	const paint = (code: string, text: string) => (color ? `${code}${text}${ANSI.reset}` : text);
	const clock = localClock(time);
	const parts = [
		paint(ANSI.dim, clock),
		paint(LEVEL_COLOR[level], level.padEnd(5)),
		paint(ANSI.bold, message),
	];
	const stacks: string[] = [];
	for (const [key, value] of Object.entries(fields)) {
		if (value === undefined) continue;
		parts.push(`${paint(ANSI.cyan, key)}=${isRedacted(key) ? REDACTED : prettyValue(value)}`);
		// A stack trace is unreadable inline; it follows the line, indented.
		const stack = value instanceof Error ? stackOf(value) : undefined;
		if (stack) {
			stacks.push(
				stack
					.split('\n')
					.slice(1)
					.map((frame) => `    ${frame.trim()}`)
					.join('\n'),
			);
		}
	}
	const line = parts.join(' ');
	return stacks.length > 0 ? `${line}\n${stacks.join('\n')}` : line;
}

export function createLogger(options: LoggerOptions = {}): Logger {
	const format = options.format ?? logFormat();
	const minRank = LEVEL_RANK[options.level ?? logLevel()];
	const sink = options.sink ?? defaultSink;
	const color = options.color ?? (process.stdout.isTTY === true && !process.env.NO_COLOR);
	const now = options.now ?? (() => new Date());

	function write(level: LogLevel, bound: LogFields, message: string, fields?: LogFields) {
		if (LEVEL_RANK[level] < minRank) return;
		const time = now();
		const merged: LogFields = {
			...requestContext.getStore(),
			...bound,
			...fields,
			...traceFields(),
		};
		const stream = level === 'warn' || level === 'error' ? 'stderr' : 'stdout';
		if (format === 'json') {
			const record: Record<string, unknown> = { time: time.toISOString(), level, msg: message };
			// Top-level errors are flattened here rather than in the replacer: `JSON.stringify` runs
			// a value's own `toJSON()` (which `ORPCError` has) before the replacer ever sees it.
			for (const [key, value] of Object.entries(merged)) {
				if (isRedacted(key)) record[key] = REDACTED;
				else record[key] = value instanceof Error ? serializeError(value) : value;
			}
			sink(stream, stringify(record));
		} else {
			sink(stream, formatPretty(time, level, message, merged, color));
		}
	}

	function bind(bound: LogFields): Logger {
		return {
			debug: (message, fields) => write('debug', bound, message, fields),
			info: (message, fields) => write('info', bound, message, fields),
			warn: (message, fields) => write('warn', bound, message, fields),
			error: (message, fields) => write('error', bound, message, fields),
			with: (fields) => bind({ ...bound, ...fields }),
		};
	}

	return bind({});
}

/** The process-wide logger. Modules take `log.with({ component })` for their own prefix. */
export const log: Logger = createLogger();
