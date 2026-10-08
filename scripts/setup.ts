/**
 * Create the local environment files, so a fresh clone runs without editing one by hand.
 *
 *   bun run setup
 *
 * Every `.env` a local process reads is created from the `.env.example` next to it, and the rows a
 * template ships empty on purpose are filled in: generated secrets, and the canonical origin a local
 * build of each Astro site needs. Run it again at any time. An existing file is completed, never
 * rewritten: a row is filled only while it is absent or blank, which is how every reader of these
 * files treats it, so a value someone set is never replaced.
 *
 * The secrets are generated per checkout rather than shipped in the templates: a value in a tracked
 * file is a value every copy of the kit shares. They are for this machine; a deployment generates
 * its own. Nothing secret is printed.
 *
 * `bun run doctor` points at this script for every gap it can close.
 */
import { randomBytes } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

/**
 * What the Astro configs fall back to for `astro dev`, and the ports in each app's `dev` script.
 * `astro build` refuses to guess a canonical origin, so a local build needs them written down.
 */
const LOCAL_SITE_URL = 'http://localhost:4321';
const LOCAL_DOCS_URL = 'http://localhost:4322';

interface ManagedFile {
	/** Repository-relative path of the file setup writes; its template is `${path}.example`. */
	path: string;
	/** Rows filled while they are unset, with what the report says about each instead of its value. */
	fills: Record<string, { value: (generate: Generate) => string; describe: string }>;
}

/** Hex-encoded random bytes. */
type Generate = (bytes: number) => string;

const MANAGED_FILES: readonly ManagedFile[] = [
	{
		path: '.env',
		fills: {
			// Signs every session. The API refuses to start without one of at least 32 characters.
			BETTER_AUTH_SECRET: { value: (generate) => generate(32), describe: 'generated' },
		},
	},
	{ path: 'apps/web/.env', fills: {} },
	{
		path: 'apps/site/.env',
		fills: { SITE_URL: { value: () => LOCAL_SITE_URL, describe: LOCAL_SITE_URL } },
	},
	{
		path: 'apps/docs/.env',
		fills: { SITE_URL: { value: () => LOCAL_DOCS_URL, describe: LOCAL_DOCS_URL } },
	},
];

export interface SetupDependencies {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	/** Defaults to the system's cryptographic generator; tests pin it. */
	generate?: Generate;
}

/** One file setup creates or completes. */
export interface FileChange {
	/** Repository-relative path. */
	path: string;
	/** Created from its template, rather than completed in place. */
	created: boolean;
	/** The rows filled, each with its description (never the value). */
	filled: { name: string; describe: string }[];
	/** The file's new content. */
	text: string;
}

export interface SetupPlan {
	changes: FileChange[];
	/** Files that are already complete. */
	unchanged: string[];
	/** Files with neither a copy nor a template, e.g. an app the fork removed. */
	skipped: string[];
	/** What setup cannot fix without replacing a value someone set. */
	problems: string[];
}

/** A row's value, blank counting as unset: every reader of these files treats it that way. */
function rowValue(text: string, name: string): string | undefined {
	return parseEnv(text)[name]?.trim() || undefined;
}

/**
 * Set `name` in a dotenv text whose value for it is unset. The last assignment is the one every
 * reader keeps, so that is the line completed; an absent row is appended. Line endings survive.
 */
export function fillRow(text: string, name: string, value: string): string {
	const lines = text.split('\n');
	const assignment = new RegExp(`^(\\s*(?:export\\s+)?${name}\\s*=)`);
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index] ?? '';
		const match = assignment.exec(line);
		if (!match) continue;
		lines[index] = `${match[1]}${value}${line.endsWith('\r') ? '\r' : ''}`;
		return lines.join('\n');
	}
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	return `${text === '' || text.endsWith('\n') ? text : `${text}${eol}`}${name}=${value}${eol}`;
}

/** Work out what setup would write, without writing anything. */
export async function planSetup(
	rootDir: string,
	dependencies: SetupDependencies,
): Promise<SetupPlan> {
	const generate: Generate =
		dependencies.generate ?? ((bytes) => randomBytes(bytes).toString('hex'));
	const plan: SetupPlan = { changes: [], unchanged: [], skipped: [], problems: [] };

	// Each file's current text, or its template's when it does not exist yet.
	const drafts = new Map<string, { created: boolean; text: string }>();
	for (const file of MANAGED_FILES) {
		const path = join(rootDir, file.path);
		if (await dependencies.exists(path)) {
			drafts.set(file.path, { created: false, text: await dependencies.read(path) });
		} else if (await dependencies.exists(`${path}.example`)) {
			drafts.set(file.path, { created: true, text: await dependencies.read(`${path}.example`) });
		} else {
			plan.skipped.push(file.path);
		}
	}

	const filled = new Map<string, { name: string; describe: string }[]>();
	function fill(path: string, name: string, value: string, describe: string): void {
		const draft = drafts.get(path);
		if (!draft) return;
		draft.text = fillRow(draft.text, name, value);
		filled.set(path, [...(filled.get(path) ?? []), { name, describe }]);
	}

	for (const file of MANAGED_FILES) {
		const draft = drafts.get(file.path);
		if (!draft) continue;
		for (const [name, { value, describe }] of Object.entries(file.fills)) {
			if (!rowValue(draft.text, name)) fill(file.path, name, value(generate), describe);
		}
	}

	for (const file of MANAGED_FILES) {
		const draft = drafts.get(file.path);
		if (!draft) continue;
		const rows = filled.get(file.path) ?? [];
		if (!draft.created && rows.length === 0) plan.unchanged.push(file.path);
		else
			plan.changes.push({
				path: file.path,
				created: draft.created,
				filled: rows,
				text: draft.text,
			});
	}
	return plan;
}

/**
 * Write a plan. A created file is opened exclusively, so a file that appeared since the plan was
 * made is never replaced, and is readable by its owner only: the root one holds the secrets.
 */
export async function applySetup(rootDir: string, plan: SetupPlan): Promise<void> {
	for (const change of plan.changes) {
		const path = join(rootDir, change.path);
		if (change.created) await writeFile(path, change.text, { flag: 'wx', mode: 0o600 });
		else await writeFile(path, change.text);
	}
}

export function formatSetupReport(plan: SetupPlan): string {
	const width = Math.max(
		...[...plan.changes.map((change) => change.path), ...plan.unchanged, ...plan.skipped].map(
			(path) => path.length,
		),
	);
	const lines = ['Starterdough setup', ''];
	for (const change of plan.changes) {
		const rows = change.filled.map(({ name, describe }) => `${name} (${describe})`).join(', ');
		const action = change.created ? `created from ${change.path}.example` : 'completed';
		lines.push(`  ${change.path.padEnd(width)}  ${action}${rows ? `; set ${rows}` : ''}`);
	}
	for (const path of plan.unchanged) {
		lines.push(`  ${path.padEnd(width)}  already complete; left as it is`);
	}
	for (const path of plan.skipped) {
		lines.push(`  ${path.padEnd(width)}  skipped: no ${path}.example to create it from`);
	}
	if (plan.problems.length) {
		lines.push('', 'Not changed, because that would replace a value you set:');
		for (const problem of plan.problems) lines.push(`  ✗ ${problem}`);
	}
	lines.push(
		'',
		'Next, from the repository root (QUICKSTART.md explains each step):',
		'  bun run doctor       read-only check of Docker and these files',
		'  bun run db:up        Postgres 17 in Docker on 127.0.0.1:5433',
		'  bun run db:migrate',
		'  bun run dev:app      the API on http://localhost:3000, the app on http://localhost:5173',
		'No Docker? Point DATABASE_URL at your own Postgres 17, skip db:up, and use `bun run doctor -- --database=external`.',
		'',
		'The generated secrets are for this machine only. A deployment generates its own.',
	);
	return lines.join('\n');
}

export const HELP = `Usage: bun run setup

Creates every local .env from the .env.example next to it and fills the rows a template ships
empty: generated secrets and the local SITE_URL of the marketing site and the docs. Safe to run
again: it never replaces a value that is already set, and it prints no secret.`;

if (import.meta.main) {
	const argv = Bun.argv.slice(2).filter((argument) => argument !== '--');
	if (argv.includes('--help') || argv.includes('-h')) {
		console.log(HELP);
	} else if (argv.length) {
		console.error('setup: unknown option; use --help');
		process.exitCode = 1;
	} else {
		const rootDir = resolve(import.meta.dir, '..');
		try {
			const plan = await planSetup(rootDir, {
				async exists(path) {
					try {
						await stat(path);
						return true;
					} catch {
						return false;
					}
				},
				read: (path) => readFile(path, 'utf8'),
			});
			await applySetup(rootDir, plan);
			console.log(formatSetupReport(plan));
			if (plan.problems.length) process.exitCode = 1;
		} catch (error) {
			console.error(`setup: ${error instanceof Error ? error.message : 'unexpected failure'}`);
			process.exitCode = 1;
		}
	}
}
