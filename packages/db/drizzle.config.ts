import { defineConfig } from 'drizzle-kit';

/**
 * Your product's migrations. `bun run db:generate` diffs what `src/schema/product.ts` exports
 * against `drizzle-product/meta/` and writes the next migration there; a bare `drizzle-kit`
 * command in this directory acts on the same history. The kit's tables and its history
 * (`drizzle.kit.config.ts`, `drizzle/`) are never part of it, so a kit release that adds a
 * migration never touches a file of yours. `migrate.ts` applies the kit's history first, then this
 * one, recorded in `drizzle.__product_migrations`.
 */
export default defineConfig({
	dialect: 'postgresql',
	schema: './src/schema/product.ts',
	out: './drizzle-product',
	dbCredentials: {
		// 5433 is the repo's dev database (Docker `pgvector/pgvector:0.8.7-pg17`); 5432 would
		// silently target a host Postgres that is not this project's.
		url:
			process.env.DATABASE_URL ??
			'postgres://starterdough:starterdough@localhost:5433/starterdough',
	},
	migrations: { schema: 'drizzle', table: '__product_migrations' },
	// Write camelCase in TypeScript, get snake_case columns in Postgres.
	casing: 'snake_case',
	strict: true,
	verbose: true,
});
