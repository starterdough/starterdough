import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

// The message only: importing migrate.ts does not run it, and nothing here needs a database.
process.env.SKIP_ENV_VALIDATION ??= '1';
const { failureMessage } = await import('./migrate');

const url = 'postgres://starterdough:s3cret-pass@db.internal:6543/app';

function postgresError(message: string, fields: { code: string; errno?: string }): Error {
	return Object.assign(new Error(message), fields);
}

describe('a failed migration run', () => {
	it('names the database it could not reach, never the password, and what to do', () => {
		const line = failureMessage(
			postgresError('Failed to connect', { code: 'ERR_POSTGRES_CONNECTION_REFUSED' }),
			url,
		);
		expect(line).toBe(
			'✗ migration failed: Failed to connect (DATABASE_URL points at db.internal:6543/app). Start Postgres with `bun run db:up`, or check DATABASE_URL.',
		);
		expect(line).not.toContain('s3cret-pass');
		expect(line).not.toContain('starterdough');
	});

	it('fills in the default port', () => {
		const error = postgresError('Connection timeout', { code: 'ERR_POSTGRES_CONNECTION_TIMEOUT' });
		expect(failureMessage(error, 'postgres://u:p@localhost/dev')).toContain(
			'points at localhost:5432/dev)',
		);
	});

	it('names an IPv6 host, a URL without a password, and a password holding `@`', () => {
		const error = postgresError('Failed to connect', { code: 'ERR_POSTGRES_CONNECTION_REFUSED' });
		const target = (databaseUrl: string) =>
			/\(DATABASE_URL points at (.*)\)\./.exec(failureMessage(error, databaseUrl))?.[1];
		expect(target('postgres://u:s3cret@[::1]:6543/app')).toBe('[::1]:6543/app');
		expect(target('postgres://app@db.internal/app')).toBe('db.internal:5432/app');
		expect(target('postgres://db.internal:6543/app')).toBe('db.internal:6543/app');
		// URL takes the last `@` of the authority, so the first one stays in the password.
		expect(target('postgres://u:s3c@ret@db.internal:6543/app')).toBe('db.internal:6543/app');
	});

	it('never prints a user or password that an unencoded `/`, `?`, `#` or `\\` cut short', () => {
		// URL ends the authority at the first `/`, `?` or `#`, wherever the `@` is, so the rest of the
		// password became the path and, before it, the user the host and the password the port. The
		// check treats `\\` the same way, as URL does for http.
		const error = postgresError('Failed to connect', { code: 'ERR_POSTGRES_CONNECTION_REFUSED' });
		for (const databaseUrl of [
			'postgres://app:4821/9xQ@127.0.0.1:5432/app',
			'postgres://u:s3cret@ss#x@127.0.0.1:5432/db',
			'postgres://u:12?x@127.0.0.1:5432/db',
			'postgres://u/ser:s3cret@127.0.0.1:5432/db',
			'postgres://u:top\\secret@127.0.0.1:5432/db',
		]) {
			expect(failureMessage(error, databaseUrl)).toBe(
				'✗ migration failed: Failed to connect (DATABASE_URL could not be parsed safely: percent-encode any `/`, `?`, `#`, `\\` or `@` in its user name or password). Start Postgres with `bun run db:up`, or check DATABASE_URL.',
			);
		}
		expect(failureMessage(error, 'not a url')).toContain(
			'(DATABASE_URL points at a value that is not a URL)',
		);
	});

	it('points at DATABASE_URL when the server refuses the login, without the user it names', () => {
		for (const [errno, message] of [
			['28P01', 'password authentication failed for user "starterdough"'],
			['28000', 'no pg_hba.conf entry for host "10.0.0.5", user "starterdough", database "app"'],
		] as const) {
			const error = postgresError(message, { code: 'ERR_POSTGRES_SERVER_ERROR', errno });
			expect(failureMessage(error, url)).toBe(
				`✗ migration failed: the server refused the login, SQLSTATE ${errno} (DATABASE_URL points at db.internal:6543/app). Check the user and password in DATABASE_URL; the Postgres log says why it refused them.`,
			);
		}
	});

	it('points at DATABASE_URL when the server lacks the database', () => {
		const error = postgresError('database "app" does not exist', {
			code: 'ERR_POSTGRES_SERVER_ERROR',
			errno: '3D000',
		});
		expect(failureMessage(error, url)).toBe(
			'✗ migration failed: database "app" does not exist (DATABASE_URL points at db.internal:6543/app). Check DATABASE_URL.',
		);
	});

	it('prints any other failure as it was raised', () => {
		const error = postgresError('relation "x" already exists', {
			code: 'ERR_POSTGRES_SERVER_ERROR',
			errno: '42P07',
		});
		expect(failureMessage(error, url)).toBe('✗ migration failed: relation "x" already exists');
		expect(failureMessage('still pending after the run: 0012_x', url)).toBe(
			'✗ migration failed: still pending after the run: 0012_x',
		);
	});

	it('says so when nothing listens where DATABASE_URL points', () => {
		// A port that was free a moment ago: Bun's driver, not a stand-in, decides the error.
		const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
		const port = listener.port;
		listener.stop(true);
		const result = Bun.spawnSync(['bun', 'run', 'src/migrate.ts'], {
			cwd: join(import.meta.dir, '..'),
			env: {
				...process.env,
				SKIP_ENV_VALIDATION: '1',
				DATABASE_URL: `postgres://starterdough:s3cret-pass@127.0.0.1:${port}/app`,
			},
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const output = `${result.stdout}${result.stderr}`;
		expect(result.exitCode).toBe(1);
		expect(output).toContain(`DATABASE_URL points at 127.0.0.1:${port}/app`);
		expect(output).toContain('bun run db:up');
		expect(output).not.toContain('s3cret-pass');
	});
});
