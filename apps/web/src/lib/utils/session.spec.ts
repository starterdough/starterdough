import { describe, expect, it } from 'vitest';
import { noSessionReason, sessionPayloadWithoutToken } from './session';

describe('noSessionReason', () => {
	it('treats an answered 4xx as a real sign-out', () => {
		expect(noSessionReason({ status: 401 })).toBe('signed_out');
		expect(noSessionReason({ status: 403 })).toBe('signed_out');
	});

	it('treats no answer and a server failure as an outage', () => {
		// The fetch threw: no status at all.
		expect(noSessionReason({})).toBe('unreachable');
		expect(noSessionReason(undefined)).toBe('unreachable');
		expect(noSessionReason({ status: 0 })).toBe('unreachable');
		expect(noSessionReason({ status: 502 })).toBe('unreachable');
	});
});

describe('sessionPayloadWithoutToken', () => {
	it('removes the bearer credential and keeps everything the UI reads', () => {
		const payload = {
			user: { id: 'u1', email: 'a@b.com', role: 'admin' },
			session: { id: 's1', token: 'live-credential', activeOrganizationId: 'org1' },
		};

		const clean = sessionPayloadWithoutToken(payload) as typeof payload;

		expect(clean.session).not.toHaveProperty('token');
		expect(clean.session.activeOrganizationId).toBe('org1');
		expect(clean.user).toEqual(payload.user);
		// The original is untouched: the same object is still handed to the load that asked for it.
		expect(payload.session.token).toBe('live-credential');
	});

	it('passes through anything that is not a session payload', () => {
		expect(sessionPayloadWithoutToken(null)).toBeNull();
		expect(sessionPayloadWithoutToken({ session: null })).toEqual({ session: null });
		expect(sessionPayloadWithoutToken('nope')).toBe('nope');
	});
});
