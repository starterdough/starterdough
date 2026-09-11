import { describe, expect, it } from 'bun:test';
import { isProbeUrl, stripSearch } from './otel';

// Only the pure helpers: the SDK stays dynamically imported behind OTEL_EXPORTER_OTLP_ENDPOINT.
describe('otel', () => {
	it('strips the query string from a span URL — that is where signatures and tokens travel', () => {
		expect(stripSearch('http://localhost:3000/uploads/org_1/doc_1?exp=1700000000&sig=abc')).toBe(
			'http://localhost:3000/uploads/org_1/doc_1',
		);
		expect(stripSearch('https://api.example.com/api/auth/verify-email?token=t&callbackURL=/')).toBe(
			'https://api.example.com/api/auth/verify-email',
		);
		expect(stripSearch('http://localhost:3000/api/v1/health')).toBe(
			'http://localhost:3000/api/v1/health',
		);
	});

	it('recognises the probes by path alone', () => {
		expect(isProbeUrl('http://api:3000/healthz')).toBe(true);
		expect(isProbeUrl('http://api:3000/readyz?verbose=1')).toBe(true);
		expect(isProbeUrl('http://api:3000/api/v1/health')).toBe(false);
		expect(isProbeUrl('http://api:3000/healthz/extra')).toBe(false);
		expect(isProbeUrl('not a url')).toBe(false);
	});
});
