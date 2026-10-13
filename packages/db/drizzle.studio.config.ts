import { defineConfig } from 'drizzle-kit';

/**
 * `bun run db:studio`: browse the kit's tables and yours together. Studio only reads the schema,
 * so it can take both entry points; generating migrations from this config would mix the two
 * histories, which is why `drizzle.config.ts` and `drizzle.kit.config.ts` each take one.
 */
export default defineConfig({
	dialect: 'postgresql',
	schema: ['./src/schema/index.ts', './src/schema/product.ts'],
	dbCredentials: {
		// 5433 is the repo's dev database (Docker `pgvector/pgvector:0.8.7-pg17`); 5432 would
		// silently target a host Postgres that is not this project's.
		url:
			process.env.DATABASE_URL ??
			'postgres://starterdough:starterdough@localhost:5433/starterdough',
	},
	casing: 'snake_case',
});
