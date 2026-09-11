import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Feature flags, toggled from `/admin/flags`.
 *
 *   feature_flag           one row per flag with its global default
 *
 * Flags are keyed by a stable slug (`new-editor`), never by id, so code can reference them
 * literally.
 */
export const featureFlags = pgTable('feature_flag', {
	key: text().primaryKey(),
	description: text().notNull().default(''),
	enabled: boolean().notNull().default(false),
	createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp({ withTimezone: true })
		.notNull()
		.defaultNow()
		.$onUpdate(() => new Date()),
});

export type FeatureFlag = typeof featureFlags.$inferSelect;
