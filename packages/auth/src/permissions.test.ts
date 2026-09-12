import { describe, expect, it } from 'bun:test';
import { isAdmin } from './permissions';

describe('platform administrators', () => {
	it('recognises the admin user role, including in multi-role strings', () => {
		expect(isAdmin('admin')).toBe(true);
		expect(isAdmin('user,admin')).toBe(true);
		expect(isAdmin('user')).toBe(false);
		expect(isAdmin(null)).toBe(false);
		expect(isAdmin('')).toBe(false);
	});
});
