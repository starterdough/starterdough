import { log } from './log';

/**
 * What both entrypoints (`index.ts`, `worker.ts`) wire into the process before doing any work.
 *
 * `bun --hot` re-runs an entrypoint, so the handlers live in one `globalThis` slot and the previous
 * evaluation's are unhooked first: otherwise every reload stacks another `shutdown` closure holding
 * a stale server, worker and telemetry handle next to this one.
 */
const HANDLERS = Symbol.for('starterdough.process.handlers');

interface ProcessHandlers {
	SIGINT: () => void;
	SIGTERM: () => void;
	unhandledRejection: (reason: unknown) => void;
	uncaughtException: (error: Error) => void;
}

type Global = typeof globalThis & { [HANDLERS]?: ProcessHandlers };

/**
 * A rejection or exception nobody handled leaves the process in a state we cannot reason about (a
 * half-written response, a job neither completed nor failed), so it is logged and the process exits
 * non-zero for the supervisor to restart. Silence here is how a container serves 500s for hours.
 */
function fatal(message: string, error: unknown): void {
	log.error(message, { error });
	process.exit(1);
}

/** Signals (graceful `shutdown`) and the two fatal-error events, de-duplicated across reloads. */
export function installProcessHandlers(shutdown: (signal: string) => void | Promise<void>): void {
	const g = globalThis as Global;
	const previous = g[HANDLERS];
	if (previous) {
		process.off('SIGINT', previous.SIGINT);
		process.off('SIGTERM', previous.SIGTERM);
		process.off('unhandledRejection', previous.unhandledRejection);
		process.off('uncaughtException', previous.uncaughtException);
	}

	const handlers: ProcessHandlers = {
		SIGINT: () => void shutdown('SIGINT'),
		SIGTERM: () => void shutdown('SIGTERM'),
		unhandledRejection: (reason) => fatal('unhandled rejection', reason),
		uncaughtException: (error) => fatal('uncaught exception', error),
	};
	g[HANDLERS] = handlers;
	process.on('SIGINT', handlers.SIGINT);
	process.on('SIGTERM', handlers.SIGTERM);
	process.on('unhandledRejection', handlers.unhandledRejection);
	process.on('uncaughtException', handlers.uncaughtException);
}

/**
 * Shutdown budget, shared by both entrypoints. Compose SIGKILLs the container `stop_grace_period`
 * (15 s, `infra/compose.yml`) after SIGTERM, so the bounded steps below must fit inside it: better
 * to close cleanly and flush spans than to be killed
 * mid-write:
 *
 *   DRAIN_TIMEOUT_MS + TELEMETRY_FLUSH_CAP_MS + PG_CLOSE_TIMEOUT_S × 1000  <  15 s
 */
const DRAIN_TIMEOUT_MS = 10_000;
/** The OTLP exporter would otherwise wait out its own 10 s timeout on an unreachable collector. */
const TELEMETRY_FLUSH_CAP_MS = 3_000;
/** How long (seconds) `pg.close()` waits for a query a cut-off job left before dropping it. */
const PG_CLOSE_TIMEOUT_S = 1;

export interface ShutdownSteps {
	/** Stop taking new work and wait for what is in flight. Resolves however long it takes. */
	drain(): Promise<void>;
	/** What to log (and do) when `drain` did not finish inside `afterMs`. */
	onDrainTimeout(afterMs: number): void | Promise<void>;
	/** Flush telemetry, bounded by `TELEMETRY_FLUSH_CAP_MS`. */
	flushTelemetry(capMs: number): Promise<void>;
	/** Close the database pool with a `timeout` in seconds. */
	closeDatabase(timeoutSeconds: number): Promise<void>;
	/** Defaults to `process.exit`; the unit test passes its own so the sequence can be observed. */
	exit?(code: number): void;
}

/**
 * The one graceful-shutdown sequence, called once however many signals arrive. Every step is
 * best-effort: a teardown that throws must still reach the exit, or the container ends up killed
 * with its pool open and an unexplained non-zero exit code. Exported for its unit test.
 */
export function createShutdown(
	steps: ShutdownSteps,
	/** Overridden only by the unit test, which cannot afford to wait out the real budget. */
	drainMs = DRAIN_TIMEOUT_MS,
): (signal: string) => Promise<void> {
	let stopping = false;
	return async (signal: string) => {
		if (stopping) return;
		stopping = true;
		log.info('shutting down', { signal });
		try {
			const finished = await Promise.race([
				steps.drain().then(() => true),
				Bun.sleep(drainMs).then(() => false),
			]);
			if (!finished) await steps.onDrainTimeout(drainMs);
			await steps.flushTelemetry(TELEMETRY_FLUSH_CAP_MS);
			// Bounded: without a timeout `close()` waits for every query, including one a cut-off job left.
			await steps.closeDatabase(PG_CLOSE_TIMEOUT_S);
			log.info('shutdown complete');
		} catch (error) {
			log.error('shutdown failed', { error });
		} finally {
			if (steps.exit) steps.exit(0);
			else process.exit(0);
		}
	};
}

/** The three bounded steps' budget, asserted against compose's `stop_grace_period` in the test. */
export const shutdownBudgetMs =
	DRAIN_TIMEOUT_MS + TELEMETRY_FLUSH_CAP_MS + PG_CLOSE_TIMEOUT_S * 1000;
