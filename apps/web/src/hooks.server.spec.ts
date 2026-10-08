import type { RequestEvent } from '@sveltejs/kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleError } from './hooks.server';

const event = { url: new URL('https://app.example.com/app/acme') } as RequestEvent;

afterEach(() => {
	vi.restoreAllMocks();
});

// SvelteKit 3 hands this hook every error, with a `kind`; Kit 2 skipped `error(...)` entirely.
describe('handleError', () => {
	it('passes an error thrown on purpose through untouched and unreported', async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const result = await handleError({
			kind: 'app',
			error: { status: 403, message: 'You are not a member of this workspace.' },
			event,
		});
		expect(result).toBeUndefined();
		expect(log).not.toHaveBeenCalled();
	});

	it("answers SvelteKit's own 404 with the localized title, without reporting it", async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const result = await handleError({
			kind: 'framework',
			error: { status: 404, message: 'Not Found' },
			event,
		});
		expect(result).toMatchObject({ message: 'Page not found' });
		expect(log).not.toHaveBeenCalled();
	});

	it('reports anything thrown and hands the page a safe message with a reference id', async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const thrown = new Error('relation "secret_table" does not exist');
		const result = await handleError({ kind: 'unknown', error: thrown, event });
		expect(log).toHaveBeenCalledWith(thrown);
		expect(result).toMatchObject({ message: 'Something went wrong', id: expect.any(String) });
		expect(JSON.stringify(result)).not.toContain('secret_table');
	});
});
