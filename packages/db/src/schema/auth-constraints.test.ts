import { describe, expect, it } from 'bun:test';
import { index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import * as authSchema from './auth';
import {
	describeConstraint,
	findMissingConstraints,
	HAND_ADDED_AUTH_CONSTRAINTS,
	missingConstraintsReport,
} from './auth-constraints';

/**
 * One line per missing constraint, so a failure names each one. `tables` narrows the check to the
 * constraints on those tables, so a test of the check itself does not depend on the committed file.
 */
function missing(schema: Record<string, unknown>, tables?: readonly string[]): string[] {
	const expected = tables
		? HAND_ADDED_AUTH_CONSTRAINTS.filter(({ table }) => tables.includes(table))
		: HAND_ADDED_AUTH_CONSTRAINTS;
	return findMissingConstraints(schema, expected).map(
		({ constraint, found }) => `${describeConstraint(constraint)}: ${found}`,
	);
}

/** `passkey` with the given credential index, as the Better Auth CLI writes the rest of it. */
function passkeyWith(credentialIndex: typeof index) {
	return pgTable(
		'passkey',
		{
			id: text('id').primaryKey(),
			userId: text('user_id').notNull(),
			credentialID: text('credential_id').notNull(),
		},
		(table) => [
			index('passkey_userId_idx').on(table.userId),
			credentialIndex('passkey_credentialID_idx').on(table.credentialID),
		],
	);
}

const PASSKEY = 'passkey: unique index passkey_credentialID_idx on (credential_id)';

describe('hand-added auth constraints', () => {
	// What `bun run auth:schema` checks after it regenerates the file. A regenerated auth.ts that
	// was committed without putting them back fails here, in CI and in the pre-push `verify`.
	it('are all in the committed auth.ts', () => {
		expect(missing(authSchema)).toEqual([]);
	});

	it('reports the passkey credential index the CLI generates as a plain one', () => {
		expect(missing({ passkey: passkeyWith(index) }, ['passkey'])).toEqual([
			`${PASSKEY}: passkey_credentialID_idx is a plain index, not a unique one`,
		]);
		expect(missing({ passkey: passkeyWith(uniqueIndex) }, ['passkey'])).toEqual([]);
	});

	it('reports a table the schema no longer has', () => {
		expect(missing({ user: authSchema.user }, ['passkey'])).toEqual([
			`${PASSKEY}: no passkey table in the schema`,
		]);
	});

	it('tells the reader what to put back and how to check again', () => {
		const report = missingConstraintsReport(findMissingConstraints({}));
		expect(report).toContain(
			`is missing ${HAND_ADDED_AUTH_CONSTRAINTS.length} of its hand-added constraints`,
		);
		for (const constraint of HAND_ADDED_AUTH_CONSTRAINTS) {
			expect(report).toContain(describeConstraint(constraint));
			expect(report).toContain(`put back: ${constraint.restore}`);
		}
		expect(report).toContain('git diff packages/db/src/schema/auth.ts');
		expect(report).toContain('bun packages/db/src/schema/auth-constraints.ts');
	});

	it('tells the reader who removed a plugin to delete its entries instead', () => {
		const passkeyOnly = HAND_ADDED_AUTH_CONSTRAINTS.filter(({ table }) => table === 'passkey');
		const report = (schema: Record<string, unknown>) =>
			missingConstraintsReport(findMissingConstraints(schema, passkeyOnly));
		expect(report({ user: authSchema.user })).toContain(
			'or, if you removed the plugin that owns passkey: delete this entry from\n' +
				'    HAND_ADDED_AUTH_CONSTRAINTS in packages/db/src/schema/auth-constraints.ts',
		);
		// A table that is there without its constraint is only ever put back.
		expect(report({ passkey: passkeyWith(index) })).not.toContain('removed the plugin');
	});
});
