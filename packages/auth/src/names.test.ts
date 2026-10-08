import { describe, expect, it } from 'bun:test';

// `createEnv` validates at import time; this suite is about the hook, not this machine's `.env`.
process.env.SKIP_ENV_VALIDATION ??= '1';
const { auth } = await import('./server');

/** The `name` the user hook stores for `name`. */
async function storedName(name: string): Promise<unknown> {
	const before = auth.options.databaseHooks?.user?.create?.before;
	if (!before) throw new Error('the user create hook is missing');
	const result = await before({ name } as never);
	return result && typeof result === 'object' ? result.data.name : name;
}

describe('display names', () => {
	it('cuts a long name at 100 characters without splitting an emoji', async () => {
		const name = `${'a'.repeat(99)}\u{1F600}${'b'.repeat(20)}`;
		// `slice(0, 100)` would keep half of the emoji, which Postgres stores as U+FFFD.
		expect(name.slice(0, 100).isWellFormed()).toBe(false);
		expect(await storedName(name)).toBe(`${'a'.repeat(99)}\u{1F600}`);
		expect([...((await storedName('\u{1F600}'.repeat(150))) as string)]).toHaveLength(100);
	});

	it('leaves a short name alone and still drops control characters', async () => {
		expect(await storedName('Ada \u{1F44B}')).toBe('Ada \u{1F44B}');
		expect(await storedName('Ada\u0000 Lovelace‮')).toBe('Ada Lovelace');
	});
});
