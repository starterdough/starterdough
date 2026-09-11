import { describe, expect, it } from 'bun:test';
import { createShutdown, shutdownBudgetMs } from './lifecycle';

/**
 * The sequence both entrypoints share. What matters is the order (drain → flush → close → exit), that
 * a second signal does nothing, and that a step which throws still reaches the exit — a teardown that
 * escapes leaves the container to be killed with its pool open and an unexplained exit code.
 */
const DRAIN_MS = 20;

function steps(overrides: Partial<Parameters<typeof createShutdown>[0]> = {}) {
	const order: string[] = [];
	const shutdown = createShutdown(
		{
			drain: async () => void order.push('drain'),
			onDrainTimeout: (afterMs) => void order.push(`drainTimeout:${afterMs}`),
			flushTelemetry: async (capMs) => void order.push(`flush:${capMs}`),
			closeDatabase: async (timeout) => void order.push(`close:${timeout}`),
			exit: (code) => order.push(`exit:${code}`),
			...overrides,
		},
		DRAIN_MS,
	);
	return { order, shutdown };
}

describe('shutdown sequence', () => {
	it('drains, flushes telemetry, closes the pool and exits zero', async () => {
		const { order, shutdown } = steps();
		await shutdown('SIGTERM');
		expect(order).toEqual(['drain', 'flush:3000', 'close:1', 'exit:0']);
	});

	it('fits the compose stop grace period', () => {
		// The three bounded steps must add up to less than `stop_grace_period` (15 s), or the container
		// is SIGKILLed mid-write instead of closing cleanly.
		expect(shutdownBudgetMs).toBeLessThan(15_000);
	});

	it('runs once however many signals arrive', async () => {
		const { order, shutdown } = steps();
		await Promise.all([shutdown('SIGINT'), shutdown('SIGTERM'), shutdown('SIGTERM')]);
		expect(order.filter((step) => step === 'drain')).toHaveLength(1);
		expect(order.filter((step) => step.startsWith('exit'))).toHaveLength(1);
	});

	it('forces the remaining work closed when the drain outlives its budget', async () => {
		const { order, shutdown } = steps({
			// Never resolves: the SSE streams are the normal case for this branch.
			drain: () => new Promise<void>(() => {}),
		});
		await shutdown('SIGTERM');
		expect(order).toEqual([`drainTimeout:${DRAIN_MS}`, 'flush:3000', 'close:1', 'exit:0']);
	});

	it('still exits when a step throws', async () => {
		const { order, shutdown } = steps({
			flushTelemetry: () => Promise.reject(new Error('collector unreachable')),
		});
		await shutdown('SIGTERM');
		expect(order).toEqual(['drain', 'exit:0']);
	});
});
