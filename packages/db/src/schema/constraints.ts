import { type SQL, sql } from 'drizzle-orm';

/**
 * `"status" in ('queued', …)` as literal SQL, built from the TypeScript enum so a `CHECK` and the
 * type it mirrors cannot drift apart. Without one, a value written by psql or a migration becomes a
 * type lie the moment a row is read back into the contract's enum.
 *
 * `sql.raw` on purpose: drizzle-kit renders bound parameters into generated DDL as `$1` placeholders,
 * which a migration file cannot execute. `column` and `values` are always our own literals here.
 */
export function oneOf(column: string, values: readonly string[]): SQL {
	return sql.raw(`"${column}" in (${values.map((value) => `'${value}'`).join(', ')})`);
}
