import type { Logger } from './log';

/**
 * Cross-process mutual exclusion between a backup and a restore of the same database, held as a
 * Postgres session-level advisory lock. A file under `BACKUP_DIR` would only cover processes that
 * share that directory; the thing that must not overlap is work on the *database*, and a manual
 * `docker compose run --rm backup … backup` gets its own container and its own filesystem.
 *
 * Known ceiling: the lock lives in one pooled connection. If that connection drops (a Postgres
 * restart, a network blip) the lock is released while the work continues, so this prevents the
 * accident (a nightly tick starting while a human restores), not a determined race.
 */

/** `DIR` in ASCII, so `pg_locks` shows which tool owns the lock. */
const LOCK_CLASS = 0x444952;

export class LockError extends Error {
	override name = 'LockError';
}

export interface HeldLock {
	/**
	 * Backend pid of the session holding the lock. A live restore needs it: the lock session is
	 * connected to the database being restored, so without it every restore would count itself as a
	 * writer and refuse, and `--terminate-connections` would kill the lock it is holding.
	 */
	pid: number;
	release(): Promise<void>;
}

/**
 * FNV-1a over the database name, folded into the signed 32-bit range `pg_try_advisory_lock(int,int)`
 * takes. Advisory locks are cluster-wide, so the database name has to be part of the key or two
 * stacks in one cluster would exclude each other.
 */
export function advisoryKey(database: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < database.length; i++) {
		hash ^= database.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash | 0;
}

/**
 * Takes the lock for `database` on the cluster `url` points at, or throws. `what` names the caller
 * in the error so the operator learns which of the two to wait for.
 */
export async function acquireLock(
	url: string,
	database: string,
	what: string,
	log: Logger,
): Promise<HeldLock> {
	const key = advisoryKey(database);
	// One connection, no idle timeout: a session-level advisory lock is only held while the session
	// that took it is alive, and a pool that recycles the connection would drop it silently.
	const sql = new Bun.SQL(url, { max: 1, idleTimeout: 0, maxLifetime: 0 });
	let rows: { locked: boolean; pid: number }[];
	try {
		rows = await sql.unsafe<{ locked: boolean; pid: number }[]>(
			'select pg_try_advisory_lock($1::int, $2::int) as locked, pg_backend_pid()::int as pid',
			[LOCK_CLASS, key],
		);
	} catch (error) {
		await sql.close().catch(() => {});
		throw new LockError(`could not take the backup lock on ${database}`, { cause: error });
	}
	if (rows[0]?.locked !== true) {
		await sql.close().catch(() => {});
		throw new LockError(
			`another backup or restore is already working on ${database} (advisory lock ${LOCK_CLASS}/${key}). Wait for it to finish, or find it with: select * from pg_locks where locktype = 'advisory' and classid = ${LOCK_CLASS}`,
		);
	}
	const pid = rows[0]?.pid ?? 0;
	log.info('lock acquired', { database, what, key, pid });
	return {
		pid,
		async release() {
			// Closing the session releases the lock; the explicit unlock is for the case where the
			// close is slow and something else is already waiting.
			await sql
				.unsafe('select pg_advisory_unlock($1::int, $2::int)', [LOCK_CLASS, key])
				.catch((error: unknown) => log.warn('releasing the backup lock failed', { error }));
			await sql.close().catch(() => {});
			log.info('lock released', { database, what });
		},
	};
}
