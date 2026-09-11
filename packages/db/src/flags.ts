import { asc, eq, sql } from 'drizzle-orm';
import { db } from './client';
import { type FeatureFlag, featureFlags } from './schema/flags';

/** Effective value per flag key for one tenant: override wins, else the global default. */
export function resolveFlags(
	flags: Pick<FeatureFlag, 'key' | 'enabled'>[],
): Record<string, boolean> {
	return Object.fromEntries(flags.map((flag) => [flag.key, flag.enabled]));
}

export async function listFlags(): Promise<FeatureFlag[]> {
	return db.select().from(featureFlags).orderBy(asc(featureFlags.key));
}

/** Create or update a flag; `description`/`enabled` are only touched when given. */
export async function upsertFlag(input: {
	key: string;
	description?: string;
	enabled?: boolean;
}): Promise<FeatureFlag> {
	const [row] = await db
		.insert(featureFlags)
		.values({
			key: input.key,
			description: input.description ?? '',
			enabled: input.enabled ?? false,
		})
		.onConflictDoUpdate({
			target: featureFlags.key,
			set: {
				...(input.description !== undefined ? { description: input.description } : {}),
				...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
				updatedAt: sql`now()`,
			},
		})
		.returning();
	return row as FeatureFlag;
}

export async function deleteFlag(key: string): Promise<boolean> {
	const rows = await db.delete(featureFlags).where(eq(featureFlags.key, key)).returning();
	return rows.length > 0;
}

/** What a client should see: every flag at its global default. */
export async function effectiveFlags(): Promise<Record<string, boolean>> {
	const flags = await db
		.select({ key: featureFlags.key, enabled: featureFlags.enabled })
		.from(featureFlags);
	return resolveFlags(flags);
}
