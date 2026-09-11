import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	dialect: 'postgresql',
	schema: './src/schema/index.ts',
	out: './drizzle',
	dbCredentials: {
		// 5433 is the repo's dev database (Docker `pgvector/pgvector:pg17`); 5432 would silently
		// target a host Postgres that is not this project's.
		url:
			process.env.DATABASE_URL ??
			'postgres://starterdough:starterdough@localhost:5433/starterdough',
	},
	// Write camelCase in TypeScript, get snake_case columns in Postgres.
	casing: 'snake_case',
	strict: true,
	verbose: true,
});
