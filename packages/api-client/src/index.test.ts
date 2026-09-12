import { describe, expect, it } from 'bun:test';
import { createApiClient } from './index';

describe('createApiClient', () => {
	it('sends bearer tokens and targets the /rpc prefix', async () => {
		let seen: Request | undefined;
		const client = createApiClient({
			baseUrl: 'http://api.test/',
			getToken: () => 'token-123',
			fetch: async (input, init) => {
				seen = new Request(input, init);
				return Response.json({
					json: { status: 'ok', version: '0', time: new Date().toISOString() },
				});
			},
		});

		await client.system.health();

		expect(seen).toBeDefined();
		expect(seen?.url.startsWith('http://api.test/rpc/system/health')).toBe(true);
		expect(seen?.headers.get('authorization')).toBe('Bearer token-123');
	});
});
