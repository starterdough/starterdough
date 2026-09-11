/**
 * Dependency licence inventory — the scan behind `THIRD-PARTY.md`.
 *
 *   bun run licenses            # summary + anything that is not plainly permissive
 *   bun run licenses --all      # every package, one line each
 *   bun run licenses --strict   # exit 1 when something needs review (for a CI gate)
 *
 * No dependencies on purpose: it reads the metadata that is already on disk after `bun install`
 * (every `package.json` under a `node_modules`) and, when a Python virtualenv exists, the
 * `*.dist-info/METADATA` files `uv sync` wrote. Packages that are not installed are not reported —
 * install first, and note that the npm pass covers dev dependencies too, because a buyer who
 * redistributes container images ships some of them.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** SPDX ids we accept without a notice. Everything else is printed for a human to read. */
const PERMISSIVE = new Set([
	'0BSD',
	'Apache-2.0',
	'BlueOak-1.0.0',
	'BSD-2-Clause',
	'BSD-3-Clause',
	'CC0-1.0',
	'CC-BY-3.0',
	'CC-BY-4.0',
	'ISC',
	'MIT',
	'MIT-0',
	'MPL-2.0',
	'Python-2.0',
	'Unlicense',
	'WTFPL',
	'Zlib',
]);

/**
 * Packages whose non-permissive licence already has a written notice in `THIRD-PARTY.md`. They are
 * still printed, but they do not fail `--strict` — otherwise the gate could never be green. Prefixes,
 * because each of these ships one package per platform. Delete an entry when you drop the dependency,
 * and re-read the notice when its licence expression changes.
 */
const ACKNOWLEDGED = ['@sentry/cli', '@img/sharp-', '@lix-js/sdk-'];

function isAcknowledged(entry: Entry): boolean {
	return ACKNOWLEDGED.some((prefix) => entry.name.startsWith(prefix));
}

/** Non-SPDX spellings seen in the wild, mapped to the id they mean. */
const ALIASES: Record<string, string> = {
	'3-Clause BSD License': 'BSD-3-Clause',
	'BSD 3-Clause License': 'BSD-3-Clause',
	'PSF-2.0': 'Python-2.0',
	'Apache 2.0': 'Apache-2.0',
	'The MIT License (MIT)': 'MIT',
};

/**
 * A handful of packages ship a LICENSE file and no `license` field (native sidecars, mostly).
 * Reading the file's opening line is a heuristic, so it is reported as such rather than folded
 * silently into the declared ids.
 */
const LICENSE_FILE_HINTS: ReadonlyArray<readonly [RegExp, string]> = [
	[/^MIT No Attribution/im, 'MIT-0'],
	[/MIT License|Permission is hereby granted, free of charge/i, 'MIT'],
	[/Apache License,?\s+Version 2\.0/i, 'Apache-2.0'],
	[/ISC License/i, 'ISC'],
	[/BSD 3-Clause|Redistributions in binary form/i, 'BSD-3-Clause'],
];

type Entry = {
	name: string;
	version: string;
	license: string;
	/** Where the metadata was read from, so a flagged entry can be inspected by hand. */
	source: string;
};

const repoRoot = resolve(import.meta.dir, '..');

/**
 * `MIT OR Apache-2.0` is fine if either half is; `(MIT AND CC-BY-4.0)` only if both are. Anything
 * we cannot parse into known ids — a `SEE LICENSE IN …`, a bare `UNLICENSED`, an empty field — is
 * deliberately treated as needing review rather than guessed at.
 */
function isPermissive(expression: string): boolean {
	const cleaned = expression
		.replace(/ \(from LICENSE file\)$/, '')
		.replaceAll(/[()]/g, ' ')
		.trim();
	if (!cleaned) return false;
	if (/\bWITH\b/i.test(cleaned)) {
		// `Apache-2.0 WITH LLVM-exception` and friends: exceptions only add permissions.
		return isPermissive(cleaned.split(/\bWITH\b/i)[0] ?? '');
	}
	if (/\bOR\b/.test(cleaned)) return cleaned.split(/\bOR\b/).some(isPermissive);
	if (/\bAND\b/.test(cleaned)) return cleaned.split(/\bAND\b/).every(isPermissive);
	const id = cleaned.trim();
	return PERMISSIVE.has(ALIASES[id] ?? id);
}

/** Last resort for a package with no declared licence: what does its LICENSE file open with? */
async function licenseFromFile(dir: string): Promise<string | undefined> {
	for (const name of ['LICENSE', 'LICENSE.md', 'LICENCE', 'LICENSE.txt', 'license']) {
		let text: string;
		try {
			text = (await readFile(join(dir, name), 'utf8')).slice(0, 2000);
		} catch {
			continue;
		}
		const hint = LICENSE_FILE_HINTS.find(([pattern]) => pattern.test(text));
		if (hint) return `${hint[1]} (from LICENSE file)`;
	}
	return undefined;
}

/** `license`, the deprecated `licenses` array, or nothing at all. */
function licenseOf(manifest: Record<string, unknown>): string {
	const { license, licenses } = manifest;
	if (typeof license === 'string' && license) return license;
	if (license && typeof license === 'object' && 'type' in license) {
		const type = (license as { type?: unknown }).type;
		if (typeof type === 'string') return type;
	}
	if (Array.isArray(licenses)) {
		const ids = licenses
			.map((entry) => (typeof entry === 'object' && entry && 'type' in entry ? entry.type : entry))
			.filter((id): id is string => typeof id === 'string');
		if (ids.length) return ids.join(' OR ');
	}
	return '(none declared)';
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
	try {
		return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/**
 * Walks one `node_modules` directory: its packages, its scopes, and each package's own nested
 * `node_modules` (Bun hoists, but a version conflict still nests).
 */
async function collectNpm(nodeModules: string, into: Map<string, Entry>): Promise<void> {
	let names: string[];
	try {
		names = await readdir(nodeModules);
	} catch {
		return;
	}
	for (const name of names) {
		if (name === '.bin' || name === '.cache') continue;
		const dir = join(nodeModules, name);
		if (name.startsWith('@')) {
			let scoped: string[];
			try {
				scoped = await readdir(dir);
			} catch {
				continue;
			}
			for (const inner of scoped) await collectPackage(join(dir, inner), into);
			continue;
		}
		await collectPackage(dir, into);
	}
}

async function collectPackage(dir: string, into: Map<string, Entry>): Promise<void> {
	const manifest = await readJson(join(dir, 'package.json'));
	if (manifest) {
		const name = typeof manifest.name === 'string' ? manifest.name : undefined;
		const version = typeof manifest.version === 'string' ? manifest.version : '0.0.0';
		// Workspace packages are symlinked in here too. They are ours, and `private` marks them.
		if (name && manifest.private !== true) {
			const key = `${name}@${version}`;
			if (!into.has(key)) {
				let license = licenseOf(manifest);
				if (license === '(none declared)') license = (await licenseFromFile(dir)) ?? license;
				into.set(key, {
					name,
					version,
					license,
					source: dir.slice(repoRoot.length + 1).replaceAll('\\', '/'),
				});
			}
		}
	}
	await collectNpm(join(dir, 'node_modules'), into);
}

/** `Classifier: License :: OSI Approved :: MIT License` → `MIT`, for the wheels that use it. */
const CLASSIFIER_TO_SPDX: ReadonlyArray<readonly [RegExp, string]> = [
	[/MIT No Attribution/i, 'MIT-0'],
	[/MIT License/i, 'MIT'],
	[/Apache Software License/i, 'Apache-2.0'],
	[/BSD License/i, 'BSD-3-Clause'],
	[/ISC License/i, 'ISC'],
	[/Mozilla Public License 2\.0/i, 'MPL-2.0'],
	[/Python Software Foundation License/i, 'Python-2.0'],
	[/GNU Lesser General Public License/i, 'LGPL'],
	[/GNU General Public License/i, 'GPL'],
	[/GNU Affero/i, 'AGPL-3.0'],
];

async function collectPython(into: Map<string, Entry>): Promise<void> {
	// `uv` puts the interpreter's site-packages under Lib on Windows and lib/python3.x elsewhere.
	const venv = join(repoRoot, 'services', 'ai', '.venv');
	const candidates = [join(venv, 'Lib', 'site-packages')];
	try {
		for (const entry of await readdir(join(venv, 'lib'))) {
			candidates.push(join(venv, 'lib', entry, 'site-packages'));
		}
	} catch {
		// Not a POSIX venv layout.
	}
	for (const sitePackages of candidates) {
		let names: string[];
		try {
			names = await readdir(sitePackages);
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.endsWith('.dist-info')) continue;
			// The service itself is installed editable into its own venv — our code, not a dependency.
			if (await exists(join(sitePackages, name, 'direct_url.json'))) {
				const direct = await readJson(join(sitePackages, name, 'direct_url.json'));
				if (typeof direct?.url === 'string' && direct.url.startsWith('file:')) continue;
			}
			let metadata: string;
			try {
				metadata = await readFile(join(sitePackages, name, 'METADATA'), 'utf8');
			} catch {
				continue;
			}
			const field = (key: string) =>
				metadata.match(new RegExp(`^${key}:[ \\t]*(.+)$`, 'm'))?.[1]?.trim();
			const pkg = field('Name') ?? name.replace(/\.dist-info$/, '');
			const version = field('Version') ?? '0.0.0';
			const declared = field('License-Expression') ?? field('License');
			let license = declared && declared.length < 60 ? declared : undefined;
			if (!license) {
				for (const line of metadata.matchAll(/^Classifier: License ::(.+)$/gm)) {
					const match = CLASSIFIER_TO_SPDX.find(([pattern]) => pattern.test(line[1] ?? ''));
					if (match) {
						license = match[1];
						break;
					}
				}
			}
			const key = `py:${pkg}@${version}`;
			if (!into.has(key)) {
				into.set(key, {
					name: pkg,
					version,
					license: license ?? '(none declared)',
					source: `python venv …/${name}`,
				});
			}
		}
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

const args = new Set(Bun.argv.slice(2));
const showAll = args.has('--all');
const strict = args.has('--strict');

const npm = new Map<string, Entry>();
await collectNpm(join(repoRoot, 'node_modules'), npm);
// A package can hold its own node_modules (a nested version, or a binary shim).
for (const group of ['apps', 'packages', 'infra']) {
	const base = join(repoRoot, group);
	let members: string[] = [];
	try {
		members = await readdir(base);
	} catch {
		continue;
	}
	for (const member of members) await collectNpm(join(base, member, 'node_modules'), npm);
}

const python = new Map<string, Entry>();
const venvPresent = await exists(join(repoRoot, 'services', 'ai', '.venv'));
if (venvPresent) await collectPython(python);

function report(label: string, entries: Entry[]): void {
	console.log(`\n## ${label} — ${entries.length} packages\n`);
	const byLicense = new Map<string, number>();
	for (const entry of entries) {
		byLicense.set(entry.license, (byLicense.get(entry.license) ?? 0) + 1);
	}
	for (const [license, count] of [...byLicense].sort((a, b) => b[1] - a[1])) {
		console.log(
			`${String(count).padStart(5)}  ${license}${isPermissive(license) ? '' : '  ← review'}`,
		);
	}
	const review = entries.filter((entry) => !isPermissive(entry.license));
	if (review.length) {
		console.log(`\n### Needs a human — ${review.length}\n`);
		for (const entry of review.sort((a, b) => a.name.localeCompare(b.name))) {
			const note = isAcknowledged(entry) ? ' — noted in THIRD-PARTY.md' : '';
			console.log(`- ${entry.name}@${entry.version} — ${entry.license} (${entry.source})${note}`);
		}
	}
	if (showAll) {
		console.log('\n### All packages\n');
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			console.log(`- ${entry.name}@${entry.version} — ${entry.license}`);
		}
	}
}

const npmEntries = [...npm.values()];
const pythonEntries = [...python.values()];
report('npm', npmEntries);
if (venvPresent) {
	report('python', pythonEntries);
} else {
	console.log('\n## python — skipped\n\nNo Python virtualenv; run `uv sync` first.');
}

const flagged = [...npmEntries, ...pythonEntries].filter((entry) => !isPermissive(entry.license));
const unacknowledged = flagged.filter((entry) => !isAcknowledged(entry));
console.log(
	`\n${flagged.length} of ${npmEntries.length + pythonEntries.length} packages need a human; ` +
		`${unacknowledged.length} of those are not yet noted in THIRD-PARTY.md.`,
);
// `--strict` is only useful as a gate if the notices we have already written down pass it.
if (strict && unacknowledged.length) process.exitCode = 1;
