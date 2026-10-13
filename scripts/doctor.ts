import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parseEnv as parseDotEnv } from 'node:util';

const MINIMUM_BUN = [1, 4, 0] as const;
/**
 * SvelteKit 3's floor. Node is optional, but `bun run dev` and `bun run build` start Vite through
 * its `#!/usr/bin/env node` shebang, so a `node` on PATH is what runs it; only without one does
 * Bun run Vite itself.
 */
const MINIMUM_NODE = [22, 17, 0] as const;
const COMMAND_TIMEOUT_MS = 5_000;

/** What every failed Docker check offers instead of Docker: a Postgres you already run. */
const OWN_POSTGRES = 'Postgres 17';
const WITHOUT_DOCKER = `or rerun with \`bun run doctor -- --database=external\` to use your own ${OWN_POSTGRES}`;

export type DatabaseMode = 'docker' | 'external';

export interface DoctorOptions {
	build: boolean;
	database: DatabaseMode;
	rootDir: string;
}

export interface DoctorCheck {
	name: string;
	ok: boolean;
	detail: string;
	/** Printed with `!` and never fails the run: a setting that is usually, not always, a mistake. */
	warning?: boolean;
}

export interface DoctorReport {
	checks: DoctorCheck[];
	ok: boolean;
}

export interface DoctorDependencies {
	bunVersion: string;
	env: Record<string, string | undefined>;
	exists(path: string): Promise<boolean>;
	/**
	 * What `node --version` prints for the `node` first on PATH: `null` when there is none, an empty
	 * string when it would not run.
	 */
	nodeVersion(timeoutMs: number): Promise<string | null>;
	read(path: string): Promise<string>;
	run(argv: string[], timeoutMs: number): Promise<boolean>;
}

type ParsedEnv = {
	errors: string[];
	values: Record<string, string | undefined>;
};

type LoadedEnv = ParsedEnv & { exists: boolean };

async function loadEnv(path: string, dependencies: DoctorDependencies): Promise<LoadedEnv> {
	if (!(await dependencies.exists(path))) return { errors: [], exists: false, values: {} };
	try {
		return { errors: [], exists: true, values: parseDotEnv(await dependencies.read(path)) };
	} catch {
		return { errors: ['could not be parsed as an environment file'], exists: true, values: {} };
	}
}

function mergeEnv(
	files: readonly ParsedEnv[],
	processEnvironment: Record<string, string | undefined>,
): Record<string, string | undefined> {
	const merged: Record<string, string | undefined> = {};
	for (const file of files) Object.assign(merged, file.values);
	for (const [name, value] of Object.entries(processEnvironment)) {
		if (value !== undefined) merged[name] = value;
	}
	return merged;
}

/** The Astro configs treat a blank higher-precedence SITE_URL as absent and keep looking. */
function siteEnvironment(
	files: readonly ParsedEnv[],
	processEnvironment: Record<string, string | undefined>,
): Record<string, string | undefined> {
	const merged = mergeEnv(files, processEnvironment);
	merged.SITE_URL =
		value(processEnvironment, 'SITE_URL') ??
		[...files]
			.reverse()
			.map((file) => value(file.values, 'SITE_URL'))
			.find(Boolean);
	return merged;
}

function value(environment: Record<string, string | undefined>, name: string): string | undefined {
	return environment[name]?.trim() || undefined;
}

function isHttpUrl(raw: string | undefined): boolean {
	if (!raw) return false;
	try {
		return ['http:', 'https:'].includes(new URL(raw).protocol);
	} catch {
		return false;
	}
}

function isPostgresUrl(raw: string | undefined): boolean {
	if (!raw) return false;
	try {
		return ['postgres:', 'postgresql:'].includes(new URL(raw).protocol);
	} catch {
		return false;
	}
}

function urlPort(raw: string | undefined, defaultPort: number): number | undefined {
	if (!raw) return undefined;
	try {
		const parsed = new URL(raw);
		return parsed.port ? Number(parsed.port) : defaultPort;
	} catch {
		return undefined;
	}
}

function sameUrl(left: string | undefined, right: string | undefined): boolean {
	if (!left || !right) return true;
	try {
		return new URL(left).href.replace(/\/$/, '') === new URL(right).href.replace(/\/$/, '');
	} catch {
		return true;
	}
}

function isPlaceholderHost(raw: string): boolean {
	try {
		return /(^|\.)example\.(com|org|net)$/.test(new URL(raw).hostname.toLowerCase());
	} catch {
		return false;
	}
}

function parseVersion(version: string): number[] | undefined {
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
	return match ? match.slice(1).map(Number) : undefined;
}

function meetsMinimum(version: string, minimum: readonly number[]): boolean {
	const current = parseVersion(version);
	if (!current) return false;
	for (let index = 0; index < minimum.length; index += 1) {
		const difference = (current[index] ?? 0) - (minimum[index] ?? 0);
		if (difference !== 0) return difference > 0;
	}
	return true;
}

function nodeCheck(printed: string | null): DoctorCheck {
	if (printed === null) {
		return { name: 'Node.js', ok: true, detail: 'not on PATH; Bun runs Vite itself' };
	}
	// Only the parsed digits are shown: the doctor prints no raw subprocess output.
	const version = parseVersion(printed.trim().replace(/^v/, ''))?.join('.');
	if (version && meetsMinimum(version, MINIMUM_NODE)) {
		return {
			name: 'Node.js',
			ok: true,
			detail: `Node ${version} satisfies SvelteKit 3's >=22.17.0 requirement`,
		};
	}
	return {
		name: 'Node.js',
		ok: false,
		detail: `Node ${version ?? 'of an unreadable version'} is on your PATH; SvelteKit 3 needs 22.17 or newer (bun run starts Vite with it). Upgrade Node or remove it from PATH`,
	};
}

function rootEnvironmentProblems(
	environment: Record<string, string | undefined>,
	databaseMode: DatabaseMode,
): string[] {
	const problems: string[] = [];
	const databaseUrl = value(environment, 'DATABASE_URL');
	const authSecret = value(environment, 'BETTER_AUTH_SECRET');
	const nodeEnvironment = value(environment, 'NODE_ENV');
	const apiUrl = value(environment, 'API_URL') ?? 'http://localhost:3000';
	const apiPort = value(environment, 'PORT') ?? '3000';

	if (!databaseUrl) problems.push('DATABASE_URL is missing');
	else if (!isPostgresUrl(databaseUrl)) {
		problems.push('DATABASE_URL must be an absolute postgres:// or postgresql:// URL');
	}
	if (!authSecret) problems.push('BETTER_AUTH_SECRET is missing; `bun run setup` generates one');
	else if (authSecret.length < 32) {
		problems.push('BETTER_AUTH_SECRET must contain at least 32 characters');
	}
	if (nodeEnvironment === 'production') {
		problems.push(
			'NODE_ENV=production is outside this local doctor; the API validates production configuration when it starts',
		);
	} else if (nodeEnvironment && !['development', 'test'].includes(nodeEnvironment)) {
		problems.push('NODE_ENV must be development or test for the local doctor');
	}
	for (const name of ['API_URL', 'WEB_URL'] as const) {
		const configured = value(environment, name);
		if (configured && !isHttpUrl(configured)) {
			problems.push(`${name} must be an absolute http(s) URL`);
		}
	}
	if (!/^\d+$/.test(apiPort) || Number(apiPort) < 1 || Number(apiPort) > 65_535) {
		problems.push('PORT must be an integer from 1 to 65535');
	} else if (
		isHttpUrl(apiUrl) &&
		['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(apiUrl).hostname) &&
		urlPort(apiUrl, new URL(apiUrl).protocol === 'https:' ? 443 : 80) !== Number(apiPort)
	) {
		problems.push('API_URL port must match PORT for local development');
	}

	if (databaseMode === 'docker' && isPostgresUrl(databaseUrl)) {
		const parsed = new URL(databaseUrl ?? '');
		if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname)) {
			problems.push(
				'DATABASE_URL is not local; rerun with --database=external if that is intentional',
			);
		}
		const postgresPort = value(environment, 'POSTGRES_PORT') ?? '5433';
		if (!/^\d+$/.test(postgresPort) || Number(postgresPort) < 1 || Number(postgresPort) > 65_535) {
			problems.push('POSTGRES_PORT must be an integer from 1 to 65535');
		} else if (urlPort(databaseUrl, 5432) !== Number(postgresPort)) {
			problems.push('DATABASE_URL port must match POSTGRES_PORT for the Docker database');
		}
	}

	return problems;
}

/**
 * What the repository is called now: `name` in the root package.json (the slug `bun run rename`
 * writes into the dev database, the Compose project and the containers) and `productName` in the
 * Tauri config (the name). Either is undefined when its file is missing or unreadable.
 */
async function productIdentity(
	rootDir: string,
	dependencies: DoctorDependencies,
): Promise<{ slug?: string; name?: string }> {
	const field = async (path: string, key: string): Promise<string | undefined> => {
		try {
			if (!(await dependencies.exists(join(rootDir, path)))) return undefined;
			const parsed = JSON.parse(await dependencies.read(join(rootDir, path))) as Record<
				string,
				unknown
			>;
			return typeof parsed[key] === 'string' ? parsed[key] : undefined;
		} catch {
			return undefined;
		}
	};
	return {
		slug: await field('package.json', 'name'),
		name: await field('apps/native/src-tauri/tauri.conf.json', 'productName'),
	};
}

/**
 * Rows of the untracked `.env` that still name a product other than the repository's, the usual
 * leftover of renaming after `bun run setup`. Names the rows, never their values. A warning, not a
 * failure: keeping the old role and Compose project is right for a volume kept on purpose.
 */
function renameLeftovers(
	environment: Record<string, string | undefined>,
	identity: { slug?: string; name?: string },
	databaseMode: DatabaseMode,
): string[] {
	const rows: string[] = [];
	const { slug, name } = identity;
	const databaseUrl = value(environment, 'DATABASE_URL');
	if (slug && databaseMode === 'docker' && isPostgresUrl(databaseUrl)) {
		const parsed = new URL(databaseUrl ?? '');
		const role = decodeURIComponent(parsed.username);
		const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
		if (role !== slug || database !== slug) rows.push("DATABASE_URL's role or database");
	}
	const project = value(environment, 'COMPOSE_PROJECT_NAME');
	if (slug && project && project !== slug) rows.push('COMPOSE_PROJECT_NAME');
	const sender = /^\s*"?([^"<]*?)"?\s*</.exec(value(environment, 'EMAIL_FROM') ?? '')?.[1]?.trim();
	if (name && sender && !sender.toLowerCase().includes(name.toLowerCase())) {
		rows.push("EMAIL_FROM's display name");
	}
	return rows;
}

function webEnvironmentProblems(environment: Record<string, string | undefined>): string[] {
	const problems: string[] = [];
	for (const name of [
		'PUBLIC_API_URL',
		'API_URL',
		'PUBLIC_WEB_URL',
		'PUBLIC_STORAGE_ORIGIN',
		'PUBLIC_SENTRY_DSN',
		'PUBLIC_POSTHOG_HOST',
	] as const) {
		const configured = value(environment, name);
		if (configured && !isHttpUrl(configured)) {
			problems.push(`${name} must be an absolute http(s) URL`);
		}
	}
	if (!value(environment, 'PUBLIC_API_URL')) problems.push('PUBLIC_API_URL is missing');

	const demo = value(environment, 'PUBLIC_DEMO_MODE');
	if (demo && !['true', 'false'].includes(demo)) {
		problems.push('PUBLIC_DEMO_MODE must be true or false when set');
	}
	return problems;
}

function siteEnvironmentProblems(
	environment: Record<string, string | undefined>,
	kind: 'site' | 'docs',
): string[] {
	const problems: string[] = [];
	const siteUrl = value(environment, 'SITE_URL');
	if (!siteUrl) problems.push('SITE_URL is missing; `bun run setup` sets the local origin');
	else if (!isHttpUrl(siteUrl)) problems.push('SITE_URL must be an absolute http(s) URL');
	else if (isPlaceholderHost(siteUrl))
		problems.push('SITE_URL still uses a reserved placeholder host');

	const publicUrls =
		kind === 'site'
			? (['PUBLIC_APP_URL', 'PUBLIC_DOCS_URL', 'PUBLIC_API_URL'] as const)
			: (['PUBLIC_API_URL'] as const);
	for (const name of publicUrls) {
		const configured = value(environment, name);
		if (configured && !isHttpUrl(configured)) {
			problems.push(`${name} must be an absolute http(s) URL`);
		}
	}
	return problems;
}

function environmentCheck(
	name: string,
	file: LoadedEnv,
	requiredPath: string,
	problems: string[],
): DoctorCheck {
	if (!file.exists) {
		return {
			name,
			ok: false,
			detail: `missing ${requiredPath}; run \`bun run setup\` to create it from ${requiredPath}.example`,
		};
	}
	const allProblems = [...file.errors, ...problems];
	return {
		name,
		ok: allProblems.length === 0,
		detail:
			allProblems.length === 0
				? `checked local settings in ${requiredPath} pass`
				: allProblems.join('; '),
	};
}

function optionalEnvironmentCheck(
	name: string,
	files: LoadedEnv[],
	paths: string[],
	problems: string[],
): DoctorCheck {
	const parseErrors = files.flatMap((file) => file.errors);
	const configured = files.some((file) => file.exists);
	const allProblems = [...parseErrors, ...problems];
	return {
		name,
		ok: allProblems.length === 0,
		detail:
			allProblems.length > 0
				? allProblems.join('; ')
				: configured
					? `checked build settings in ${paths.join(' / ')} pass`
					: 'configured by the process environment',
	};
}

export async function runDoctor(
	options: DoctorOptions,
	dependencies: DoctorDependencies = defaultDependencies(options.rootDir),
): Promise<DoctorReport> {
	const checks: DoctorCheck[] = [];
	checks.push({
		name: 'Bun runtime',
		ok: meetsMinimum(dependencies.bunVersion, MINIMUM_BUN),
		detail: meetsMinimum(dependencies.bunVersion, MINIMUM_BUN)
			? `Bun ${dependencies.bunVersion} satisfies the >=1.4.0 requirement`
			: `Bun ${dependencies.bunVersion} is too old; install Bun 1.4.0 or newer`,
	});
	checks.push(nodeCheck(await dependencies.nodeVersion(COMMAND_TIMEOUT_MS)));

	const dependencyPaths = [
		'bun.lock',
		'node_modules/.bin/turbo',
		'node_modules/zod',
		'node_modules/hono',
		'node_modules/astro',
		'node_modules/@sveltejs/kit',
	].map((path) => join(options.rootDir, path));
	const dependenciesInstalled = (
		await Promise.all(dependencyPaths.map((path) => dependencies.exists(path)))
	).every(Boolean);
	checks.push({
		name: 'Dependencies',
		ok: dependenciesInstalled,
		detail: dependenciesInstalled
			? 'the lockfile and key installed dependencies are present'
			: 'dependencies are incomplete; run `bun install --frozen-lockfile`',
	});

	// API, database and auth commands explicitly load the root `.env`; inherited shell variables
	// are their only higher-precedence source. Keep the doctor on that same boundary.
	const rootFile = await loadEnv(join(options.rootDir, '.env'), dependencies);
	const rootEnvironment = mergeEnv([rootFile], dependencies.env);
	checks.push(
		environmentCheck(
			'Root environment',
			rootFile,
			'.env',
			rootEnvironmentProblems(rootEnvironment, options.database),
		),
	);

	const identity = await productIdentity(options.rootDir, dependencies);
	const leftovers = renameLeftovers(rootEnvironment, identity, options.database);
	if (leftovers.length > 0) {
		checks.push({
			name: 'Product name',
			ok: false,
			warning: true,
			detail: `${leftovers.join(', ')} in .env name another product than package.json (${identity.slug}), the usual sign of a .env written before \`bun run rename\`. Copy those rows from .env.example; keep the old database role and Compose project only for a volume you kept on purpose (the checklist \`bun run rename\` prints, items 1 to 3)`,
		});
	}

	const webPaths = [
		'.env',
		'.env.local',
		`.env.${options.build ? 'production' : 'development'}`,
		`.env.${options.build ? 'production' : 'development'}.local`,
	];
	const webFiles = await Promise.all(
		webPaths.map((name) => loadEnv(join(options.rootDir, 'apps/web', name), dependencies)),
	);
	const webEnvironment = mergeEnv(webFiles, rootEnvironment);
	checks.push(
		environmentCheck(
			'Web app environment',
			webFiles[0] ?? { errors: [], exists: false, values: {} },
			'apps/web/.env',
			[
				...webFiles.slice(1).flatMap((file) => file.errors),
				...webEnvironmentProblems(webEnvironment),
			],
		),
	);
	const rootApiUrl = value(rootEnvironment, 'API_URL') ?? 'http://localhost:3000';
	if (!sameUrl(rootApiUrl, value(webEnvironment, 'PUBLIC_API_URL'))) {
		checks.push({
			name: 'App API origin',
			ok: false,
			detail: 'PUBLIC_API_URL must match the public API_URL used by the local API',
		});
	}
	const publicWebUrl = value(webEnvironment, 'PUBLIC_WEB_URL');
	if (
		publicWebUrl &&
		!sameUrl(value(rootEnvironment, 'WEB_URL') ?? 'http://localhost:5173', publicWebUrl)
	) {
		checks.push({
			name: 'App web origin',
			ok: false,
			detail: 'PUBLIC_WEB_URL must match WEB_URL when it is set',
		});
	}

	if (options.build) {
		for (const kind of ['site', 'docs'] as const) {
			const paths = ['.env', '.env.local', '.env.production', '.env.production.local'];
			const files = await Promise.all(
				paths.map((name) => loadEnv(join(options.rootDir, `apps/${kind}`, name), dependencies)),
			);
			const canonicalEnvironment = siteEnvironment(files.slice(0, 2), rootEnvironment);
			const environment = mergeEnv(files, rootEnvironment);
			// Astro's canonical loader deliberately ignores production-mode files; Vite does not.
			environment.SITE_URL = canonicalEnvironment.SITE_URL;
			checks.push(
				optionalEnvironmentCheck(
					kind === 'site' ? 'Marketing site build' : 'Documentation build',
					files,
					paths.map((name) => `apps/${kind}/${name}`),
					siteEnvironmentProblems(environment, kind),
				),
			);
		}
	}

	if (options.database === 'external') {
		checks.push({
			name: 'Database path',
			ok: isPostgresUrl(value(rootEnvironment, 'DATABASE_URL')),
			detail: isPostgresUrl(value(rootEnvironment, 'DATABASE_URL'))
				? 'external PostgreSQL selected; Docker checks are skipped'
				: 'external PostgreSQL needs a valid DATABASE_URL',
		});
	} else {
		const dockerCli = await dependencies.run(['docker', '--version'], COMMAND_TIMEOUT_MS);
		checks.push({
			name: 'Docker CLI',
			ok: dockerCli,
			detail: dockerCli
				? 'Docker CLI is available'
				: `Docker CLI is unavailable; install Docker, ${WITHOUT_DOCKER}`,
		});
		const compose = await dependencies.run(['docker', 'compose', 'version'], COMMAND_TIMEOUT_MS);
		checks.push({
			name: 'Docker Compose plugin',
			ok: compose,
			detail: compose
				? 'the `docker compose` plugin is available'
				: `the \`docker compose\` plugin is unavailable; install Docker Compose v2, ${WITHOUT_DOCKER}`,
		});
		const daemon = await dependencies.run(
			['docker', 'info', '--format', '{{.ServerVersion}}'],
			COMMAND_TIMEOUT_MS,
		);
		checks.push({
			name: 'Docker daemon',
			ok: daemon,
			detail: daemon
				? 'the Docker daemon is reachable'
				: `the Docker daemon is not reachable; start Docker and try again, ${WITHOUT_DOCKER}`,
		});
	}

	return { checks, ok: checks.every((check) => check.ok || check.warning) };
}

export function formatDoctorReport(report: DoctorReport): string {
	const lines = ['Starterdough doctor', ''];
	for (const check of report.checks) {
		lines.push(`${check.ok ? '✓' : check.warning ? '!' : '✗'} ${check.name}: ${check.detail}`);
	}
	const failures = report.checks.filter((check) => !check.ok && !check.warning).length;
	lines.push(
		'',
		failures === 0
			? 'Named local prerequisites pass. PostgreSQL reachability, migrations, and full API environment validation were not run.'
			: `${failures} blocking check${failures === 1 ? '' : 's'} failed. No files or services were changed.`,
	);
	return lines.join('\n');
}

export function parseDoctorArgs(
	argv: string[],
	rootDir = resolve(import.meta.dir, '..'),
): { help: true } | ({ help: false } & DoctorOptions) {
	let build = false;
	let database: DatabaseMode = 'docker';
	for (const argument of argv) {
		if (argument === '--') continue;
		if (argument === '--help' || argument === '-h') return { help: true };
		if (argument === '--build') {
			build = true;
			continue;
		}
		if (argument === '--database=external') {
			database = 'external';
			continue;
		}
		throw new Error('unknown option; use --build, --database=external, or --help');
	}
	return { build, database, help: false, rootDir };
}

export const HELP = `Usage: bun run doctor [-- --build] [-- --database=external]

Checks the local app setup by default, including Docker for the shipped development database.
\`bun run setup\` creates and completes the environment files it checks.
  --build              also validate marketing-site and documentation build origins
  --database=external  use DATABASE_URL for an existing PostgreSQL and skip Docker checks

The doctor checks only these named local prerequisites. It is read-only: it does not connect to
PostgreSQL, run migrations, start containers, validate the full production environment, or print
environment values and subprocess output.`;

function defaultDependencies(rootDir: string): DoctorDependencies {
	return {
		bunVersion: Bun.version,
		env: process.env,
		async exists(path) {
			try {
				await stat(path);
				return true;
			} catch {
				return false;
			}
		},
		async nodeVersion(timeoutMs) {
			// The same lookup the shebang does, so this is the Node that `bun run dev` would start.
			const node = Bun.which('node');
			if (!node) return null;
			try {
				// Without a real Node, `bun run` puts Bun itself on PATH under that name, in a temporary
				// `bun-node-*` directory, and that one answers `--version` with an error. Where it is a
				// link the path gives it away too.
				if (basename(dirname(node)).startsWith('bun-node')) return null;
				if ((await realpath(node)) === (await realpath(process.execPath))) return null;
				const child = Bun.spawn([node, '--version'], {
					cwd: rootDir,
					killSignal: 'SIGKILL',
					stderr: 'ignore',
					stdout: 'pipe',
					timeout: timeoutMs,
				});
				const [printed, code] = await Promise.all([
					new Response(child.stdout).text(),
					child.exited,
				]);
				return code === 0 ? printed : '';
			} catch {
				return '';
			}
		},
		read: (path) => readFile(path, 'utf8'),
		async run(argv, timeoutMs) {
			try {
				const child = Bun.spawn(argv, {
					cwd: rootDir,
					killSignal: 'SIGKILL',
					stderr: 'ignore',
					stdout: 'ignore',
					timeout: timeoutMs,
				});
				return (await child.exited) === 0;
			} catch {
				return false;
			}
		},
	};
}

if (import.meta.main) {
	try {
		const options = parseDoctorArgs(Bun.argv.slice(2));
		if (options.help) console.log(HELP);
		else {
			const report = await runDoctor(options);
			console.log(formatDoctorReport(report));
			if (!report.ok) process.exitCode = 1;
		}
	} catch (error) {
		console.error(`doctor: ${error instanceof Error ? error.message : 'unexpected failure'}`);
		process.exitCode = 1;
	}
}
