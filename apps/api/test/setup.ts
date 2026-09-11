// Loaded before every test file (see bunfig.toml). Tests never touch a real database:
// the Bun SQL client connects lazily, so providing a placeholder URL is enough.
process.env.NODE_ENV ??= 'test';
process.env.SKIP_ENV_VALIDATION ??= '1';
process.env.API_URL ??= 'http://localhost:3000';
process.env.WEB_URL ??= 'http://localhost:5173';
process.env.DATABASE_URL ??=
	'postgres://starterdough:starterdough@localhost:5432/starterdough_test';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-test-secret';
// Local storage driver (no S3_BUCKET) writing to a scratch directory, never the repo.
