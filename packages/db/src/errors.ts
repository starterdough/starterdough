import { SQL } from 'bun';

/**
 * A Postgres unique violation (SQLSTATE `23505`), as Bun's client reports it.
 *
 * Bun's `PostgresError` keeps the server's SQLSTATE in `errno`; its `code` is Bun's own
 * (`ERR_POSTGRES_SERVER_ERROR` for anything the server refused), so `code === '23505'`, the
 * node-postgres convention, never matches. Drizzle wraps every failure in a `DrizzleQueryError` and
 * keeps the driver's error as `cause`, while a query sent on `pg` throws the driver's error itself:
 * both are recognised.
 *
 * A procedure that pre-checks uniqueness still loses the race sometimes; the index is what actually
 * enforces it, and its violation must surface as the `CONFLICT` the contract declares, not a 500.
 */
export function isUniqueViolation(error: unknown): boolean {
	const cause = error instanceof Error ? error.cause : undefined;
	return [error, cause].some(
		(candidate) => candidate instanceof SQL.PostgresError && candidate.errno === '23505',
	);
}
