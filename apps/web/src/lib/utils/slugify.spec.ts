import { describe, expect, it } from 'vitest';
import { slugify } from './slugify';

describe('slugify', () => {
	it('lowercases, strips accents and collapses separators', () => {
		expect(slugify('  Ünïcode  Wörkspace! ')).toBe('unicode-workspace');
	});

	it('trims leading/trailing dashes', () => {
		expect(slugify('--hello--')).toBe('hello');
	});
});
