import { getTableName, is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as authSchema from './auth';

/** A constraint `auth.ts` needs that the Better Auth CLI does not generate. */
export type HandAddedConstraint = {
	/** SQL name of the table. */
	table: string;
	/** SQL names of the columns, in order. */
	columns: readonly string[];
	/** The code to put back in `auth.ts` when it is missing. */
	restore: string;
} & (
	| { kind: 'unique index'; name: string }
	/** A foreign key to `references.id`, deleted with the row it points at. */
	| { kind: 'foreign key'; references: string }
);

/**
 * The constraints `auth.ts` carries on top of the Better Auth CLI's output. `findMissingConstraints`
 * checks that they are still there.
 *
 * The CLI does not emit them, so every `bun run auth:schema` regenerates `auth.ts` without them,
 * and the `bun run db:generate` after it writes a migration that drops them from the database.
 * Lint, typecheck and every other test pass either way, so three things run this check:
 *
 * - `bun run auth:schema`, right after the CLI writes the file: it runs this module, which exits
 *   non-zero, so a chained `auth:schema && db:generate` stops before the migration is written.
 * - `auth-constraints.test.ts`, so CI and the pre-push `verify` fail on a schema that lost one.
 * - `bun packages/db/src/schema/auth-constraints.ts`, to check again after putting them back.
 *
 * This list is the only place they are named for the check. A constraint added to `auth.ts` by hand
 * goes here and in that file's header too. Removing the plugin that owns a table means deleting its
 * entries here and in the header: the check reports a table it cannot find.
 */
export const HAND_ADDED_AUTH_CONSTRAINTS: readonly HandAddedConstraint[] = [
	{
		// WebAuthn credential ids are globally unique, and a second row for the same one would let a
		// lookup pick the wrong user's public key.
		table: 'passkey',
		kind: 'unique index',
		name: 'passkey_credentialID_idx',
		columns: ['credential_id'],
		restore: 'uniqueIndex("passkey_credentialID_idx").on(table.credentialID)',
	},
];

/** One line naming the constraint, for a failure to print. */
export function describeConstraint(constraint: HandAddedConstraint): string {
	const columns = constraint.columns.join(', ');
	return constraint.kind === 'unique index'
		? `${constraint.table}: unique index ${constraint.name} on (${columns})`
		: `${constraint.table}: foreign key (${columns}) → ${constraint.references}.id on delete cascade`;
}

export type MissingConstraint = {
	constraint: HandAddedConstraint;
	found: string;
	/** The schema has no table of that name: put back, or the plugin that owned it was removed. */
	tableMissing: boolean;
};

/**
 * Every constraint in `expected` the schema module lacks, with what it has instead. Tables are
 * matched by SQL name among the module's exports, so a test can pass a module with one replaced.
 */
export function findMissingConstraints(
	schema: Record<string, unknown> = authSchema,
	expected: readonly HandAddedConstraint[] = HAND_ADDED_AUTH_CONSTRAINTS,
): MissingConstraint[] {
	const tables = new Map<string, PgTable>();
	for (const value of Object.values(schema)) {
		if (is(value, PgTable)) tables.set(getTableName(value), value);
	}
	const missing: MissingConstraint[] = [];
	for (const constraint of expected) {
		const table = tables.get(constraint.table);
		if (!table) {
			missing.push({
				constraint,
				found: `no ${constraint.table} table in the schema`,
				tableMissing: true,
			});
			continue;
		}
		const found = problemWith(constraint, table);
		if (found) missing.push({ constraint, found, tableMissing: false });
	}
	return missing;
}

/** What is wrong with `constraint` on `table`, or `undefined` when it is there as expected. */
function problemWith(constraint: HandAddedConstraint, table: PgTable): string | undefined {
	const config = getTableConfig(table);
	const expected = constraint.columns.join(', ');
	if (constraint.kind === 'unique index') {
		const index = config.indexes.find((candidate) => candidate.config.name === constraint.name);
		if (!index) return `no index named ${constraint.name}`;
		const columns = index.config.columns
			.map((column) => ('name' in column ? column.name : undefined) ?? 'an expression')
			.join(', ');
		if (columns !== expected) return `${constraint.name} covers (${columns})`;
		if (!index.config.unique) return `${constraint.name} is a plain index, not a unique one`;
		return undefined;
	}
	const keys = config.foreignKeys
		.map((key) => {
			const { columns, foreignTable, foreignColumns } = key.reference();
			return {
				columns: columns.map((column) => column.name).join(', '),
				target: `${getTableName(foreignTable)}.${foreignColumns.map((column) => column.name).join(', ')}`,
				onDelete: key.onDelete ?? 'no action',
			};
		})
		.filter((key) => key.columns === expected);
	if (!keys.length) return `no foreign key on (${expected})`;
	const target = `${constraint.references}.id`;
	if (keys.some((key) => key.target === target && key.onDelete === 'cascade')) return undefined;
	return keys.map((key) => `a foreign key to ${key.target} on delete ${key.onDelete}`).join('; ');
}

/** The failure `bun run auth:schema` prints: what is missing, and how to put it back. */
export function missingConstraintsReport(missing: readonly MissingConstraint[]): string {
	const file = 'packages/db/src/schema/auth.ts';
	const tables = new Intl.ListFormat('en', { type: 'disjunction' }).format(
		new Set(HAND_ADDED_AUTH_CONSTRAINTS.map(({ table }) => table)),
	);
	const listed = missing.map(
		({ constraint, found, tableMissing }) =>
			`  ${describeConstraint(constraint)}\n` +
			`    found:    ${found}\n` +
			`    put back: ${constraint.restore}` +
			(tableMissing
				? `\n    or, if you removed the plugin that owns ${constraint.table}: delete this entry from\n` +
					'    HAND_ADDED_AUTH_CONSTRAINTS in packages/db/src/schema/auth-constraints.ts, and its\n' +
					`    line in the header of ${file}`
				: ''),
	);
	return [
		`✗ ${file} is missing ${missing.length} of its hand-added constraints.`,
		'',
		'The Better Auth CLI does not emit them, so every `bun run auth:schema` drops them, and',
		'`bun run db:generate` would now write a migration that drops them from the database:',
		'',
		...listed,
		'',
		'To restore them, from the repository root:',
		'',
		`  1. git diff ${file}`,
		'     The removed lines are what the generator dropped: the header comment, and the constraints',
		'     above with their comments (and the `uniqueIndex` import, if it went). Put them back, and',
		'     keep what it changed for your new auth config.',
		'  2. bun packages/db/src/schema/auth-constraints.ts',
		'     Checks again without regenerating. Running auth:schema again would undo step 1.',
		'  3. bun run db:generate',
		'     Read the migration before db:migrate: a DROP INDEX or DROP CONSTRAINT on',
		`     ${tables} means a constraint is still missing.`,
	].join('\n');
}

// Only when run as the script (`bun run auth:schema` runs it after the CLI): the test imports it.
if (import.meta.main) {
	const missing = findMissingConstraints();
	if (missing.length) {
		console.error(missingConstraintsReport(missing));
		process.exitCode = 1;
	} else {
		console.log(
			`✓ ${HAND_ADDED_AUTH_CONSTRAINTS.length} hand-added constraint(s) present in packages/db/src/schema/auth.ts`,
		);
	}
}
