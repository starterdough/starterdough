import { defineConfig } from 'drizzle-kit';

/**
 * The kit's own migration history, for kit maintainers only; a product never runs it. Kit releases
 * generate their migrations with `bun run --cwd packages/db generate:kit`, and `migrate.ts` records
 * them in `drizzle.__drizzle_migrations`. A product's migrations have a config and a history of
 * their own (`drizzle.config.ts`), so nothing a product generates lands in `drizzle/`.
 */
export default defineConfig({
	dialect: 'postgresql',
	schema: './src/schema/index.ts',
	out: './drizzle',
	dbCredentials: {
		// 5433 is the repo's dev database (Docker `pgvector/pgvector:0.8.7-pg17`); 5432 would
		// silently target a host Postgres that is not this project's.
		url:
			process.env.DATABASE_URL ??
			'postgres://starterdough:starterdough@localhost:5433/starterdough',
	},
	// Write camelCase in TypeScript, get snake_case columns in Postgres.
	casing: 'snake_case',
	strict: true,
	verbose: true,
});
