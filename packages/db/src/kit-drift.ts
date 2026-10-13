/**
 * `bun run db:kit-drift`: the SQL your schema needs on the kit's own tables (a Better Auth plugin
 * or `additionalFields` column after `bun run auth:schema`, an index of yours on a kit table) that
 * no migration of yours holds yet. `db:generate` cannot write it, because it diffs only what
 * `schema/product.ts` exports, and the kit's history (`drizzle/`) is the kit's. Put what this prints
 * in `bun run db:generate --custom --name=<name>`. In the kit's own repository the same check finds
 * a kit schema change nobody ran `generate:kit` for. Writes nothing in the repository.
 */
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const packageDir = resolve(import.meta.dir, '..');

/** The statements Drizzle would add to the kit's history, minus those a product migration holds. */
export function kitDrift(): string[] {
	// drizzle-kit resolves `out` against the working directory even when it is absolute, so the
	// scratch copy has to live under this package; node_modules keeps it out of git and Biome.
	const scratch = join('node_modules', `.kit-drift-${process.pid}`);
	const scratchDir = join(packageDir, scratch);
	try {
		cpSync(join(packageDir, 'drizzle'), join(scratchDir, 'drizzle'), { recursive: true });
		const config = join(scratchDir, 'drizzle.config.json');
		writeFileSync(
			config,
			JSON.stringify({
				dialect: 'postgresql',
				schema: join(packageDir, 'src/schema/index.ts'),
				out: join(scratch, 'drizzle'),
				casing: 'snake_case',
			}),
		);
		const run = Bun.spawnSync(
			[process.execPath, 'x', 'drizzle-kit', 'generate', '--config', config, '--name', 'drift'],
			// No stdin: a rename drizzle-kit wants answered fails here instead of waiting for a reply.
			{ cwd: packageDir, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
		);
		const output = `${run.stdout}${run.stderr}`;
		// drizzle-kit exits 0 on some failures; it prints one of these on every success.
		if (run.exitCode !== 0 || !/Your SQL migration file|No schema changes/.test(output)) {
			throw new Error(`drizzle-kit generate failed:\n${output}`);
		}
		const generated = readdirSync(join(scratchDir, 'drizzle')).find((name) =>
			name.endsWith('_drift.sql'),
		);
		if (!generated) return [];
		const statements = readFileSync(join(scratchDir, 'drizzle', generated), 'utf8')
			.split('--> statement-breakpoint')
			.map((statement) => statement.trim())
			.filter(Boolean);
		return statements.filter((statement) => !productSql().includes(statement));
	} finally {
		rmSync(scratchDir, { recursive: true, force: true });
	}
}

/** Every product migration's SQL, as one string to search. */
function productSql(): string {
	const dir = join(packageDir, 'drizzle-product');
	if (!existsSync(dir)) return '';
	return readdirSync(dir)
		.filter((name) => name.endsWith('.sql'))
		.map((name) => readFileSync(join(dir, name), 'utf8'))
		.join('\n');
}

if (import.meta.main) {
	try {
		const statements = kitDrift();
		console.log(
			statements.length > 0
				? statements.join('\n--> statement-breakpoint\n')
				: 'No changes to kit tables that a migration of yours does not already make.',
		);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
