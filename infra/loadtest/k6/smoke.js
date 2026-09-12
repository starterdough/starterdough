// Load test for the API with k6 (https://k6.io). No install needed:
//
//   docker run --rm -i -e API_URL=http://host.docker.internal:3000 grafana/k6 run - < infra/loadtest/k6/smoke.js
//   (Linux: --network host and API_URL=http://localhost:3000; a real server: API_URL=https://api.example.com)
//
// Three scenarios, ~90 s total:
//   probes   liveness/readiness under constant pressure (what Caddy and Compose poll)
//   public   the unauthenticated procedures (health, auth config) over REST
//   session  sign-in + `me` per virtual user, only when K6_EMAIL and K6_PASSWORD are set
//
// Rate limits: the API allows 300 procedure calls per minute per client IP (apps/api/src/app.ts). To
// measure the server rather than the limiter, this script gives every virtual user its own address in
// X-Forwarded-For. The API reads that header only with TRUST_PROXY=true (what infra/compose.yml sets
// on the api service, which sits behind Caddy) and only when it holds exactly one address; without
// that, every virtual user shares one bucket. Run this against the API origin directly (port 3000,
// Compose network, dev), not through Caddy: Caddy replaces the client-supplied X-Forwarded-For with
// the real client address, so through the edge every virtual user shares one limit.
//
// Thresholds are deliberately modest (one small VPS). Tighten them as you learn your numbers.
import { check, sleep } from 'k6';
import http from 'k6/http';

const API = (__ENV.API_URL || 'http://localhost:3000').replace(/\/+$/, '');
const EMAIL = __ENV.K6_EMAIL || '';
const PASSWORD = __ENV.K6_PASSWORD || '';

export const options = {
	scenarios: {
		probes: {
			executor: 'constant-vus',
			vus: 20,
			duration: '30s',
			exec: 'probes',
		},
		public: {
			executor: 'ramping-vus',
			startTime: '30s',
			stages: [
				{ duration: '15s', target: 25 },
				{ duration: '30s', target: 50 },
				{ duration: '15s', target: 0 },
			],
			exec: 'publicProcedures',
		},
		...(EMAIL && PASSWORD
			? {
					session: {
						executor: 'per-vu-iterations',
						startTime: '30s',
						vus: 10,
						iterations: 5,
						exec: 'session',
					},
				}
			: {}),
	},
	thresholds: {
		http_req_failed: ['rate<0.01'],
		'http_req_duration{scenario:probes}': ['p(95)<200'],
		'http_req_duration{scenario:public}': ['p(95)<500'],
		...(EMAIL && PASSWORD ? { 'http_req_duration{scenario:session}': ['p(95)<1500'] } : {}),
	},
};

/**
 * One stable private address per VU, so the per-IP limiter sees as many clients as there are VUs
 * and each VU runs into its own 300 calls/min budget. Mixing `__ITER` into the address
 * would hand every iteration a fresh IP and the limiter would never be exercised at all.
 */
function clientHeaders(extra = {}) {
	const vu = __VU;
	return {
		'X-Forwarded-For': `10.0.${(vu >> 8) & 255}.${vu & 255}`,
		...extra,
	};
}

export function probes() {
	const live = http.get(`${API}/healthz`, { headers: clientHeaders(), tags: { name: 'healthz' } });
	const ready = http.get(`${API}/readyz`, { headers: clientHeaders(), tags: { name: 'readyz' } });
	check(live, { 'healthz 200': (r) => r.status === 200 });
	check(ready, { 'readyz 200': (r) => r.status === 200 });
	sleep(0.2);
}

export function publicProcedures() {
	const health = http.get(`${API}/api/v1/health`, {
		headers: clientHeaders(),
		tags: { name: 'api/v1/health' },
	});
	const config = http.get(`${API}/api/v1/auth-config`, {
		headers: clientHeaders(),
		tags: { name: 'api/v1/auth-config' },
	});
	check(health, {
		'health 200': (r) => r.status === 200,
		'health has version': (r) => typeof r.json('version') === 'string',
	});
	check(config, { 'auth-config 200': (r) => r.status === 200 });
	sleep(0.5);
}

export function session() {
	// Better Auth sets the session cookie; k6 keeps a cookie jar per VU, so the follow-ups are signed in.
	const signIn = http.post(
		`${API}/api/auth/sign-in/email`,
		JSON.stringify({ email: EMAIL, password: PASSWORD }),
		{
			headers: clientHeaders({ 'Content-Type': 'application/json', Origin: API }),
			tags: { name: 'auth/sign-in' },
		},
	);
	if (!check(signIn, { 'sign-in 200': (r) => r.status === 200 })) return;

	const me = http.get(`${API}/api/v1/me`, {
		headers: clientHeaders(),
		tags: { name: 'api/v1/me' },
	});
	check(me, { 'me 200': (r) => r.status === 200 });

	sleep(1);
}
