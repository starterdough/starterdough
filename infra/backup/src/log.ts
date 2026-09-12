export type LogLevel = 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

export interface Logger {
	info(msg: string, fields?: LogFields): void;
	warn(msg: string, fields?: LogFields): void;
	error(msg: string, fields?: LogFields): void;
}

/**
 * One JSON object per line (`{ time, level, msg, ...fields }`), so `docker compose logs backup`
 * stays greppable and `jq`-able. Errors are flattened to their message because a stack trace
 * across many lines defeats the one-line format.
 */
export function createLogger(
	write: (line: string, level: LogLevel) => void = defaultWrite,
): Logger {
	const emit = (level: LogLevel, msg: string, fields?: LogFields) => {
		write(
			JSON.stringify({ time: new Date().toISOString(), level, msg, ...normalize(fields) }),
			level,
		);
	};
	return {
		info: (msg, fields) => emit('info', msg, fields),
		warn: (msg, fields) => emit('warn', msg, fields),
		error: (msg, fields) => emit('error', msg, fields),
	};
}

/**
 * `info` on stdout, `warn` and `error` on stderr: a one-shot `docker compose run` can then pipe
 * the run's output through `jq` while problems still reach the terminal, and `2>` alone captures
 * everything that went wrong.
 */
function defaultWrite(line: string, level: LogLevel): void {
	const stream = level === 'info' ? process.stdout : process.stderr;
	stream.write(`${line}\n`);
}

function normalize(fields: LogFields | undefined): LogFields {
	if (!fields) return {};
	const out: LogFields = {};
	for (const [key, value] of Object.entries(fields)) {
		if (value === undefined) continue;
		out[key] = value instanceof Error ? errorMessage(value) : value;
	}
	return out;
}

/** The message plus the chain of causes, which is where spawn and S3 errors keep the details. */
export function errorMessage(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	let message = error.message;
	let cause: unknown = error.cause;
	for (let depth = 0; cause !== undefined && depth < 5; depth++) {
		message += `: ${cause instanceof Error ? cause.message : String(cause)}`;
		cause = cause instanceof Error ? cause.cause : undefined;
	}
	return message;
}
