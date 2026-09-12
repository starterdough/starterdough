/**
 * Rename the kit to your product.
 *
 *   bun run rename --name Acme --slug acme --identifier com.acme.desktop --scope @acme
 *   bun run rename --name Acme --slug acme --identifier com.acme.desktop --scope @acme --write
 *
 * Dry run unless `--write` is passed. Add `--verbose` to see every changed line.
 *
 * Rewrites four tokens across the tracked text files: the product name, the lowercase slug (npm
 * package name, Cargo crate, Compose project, Postgres role, container names, the
 * `x-<slug>-client-ip` header, the backup artefact prefix), the Tauri bundle identifier, and the
 * workspace scope. The current values are read from the repo, so a second run with different
 * arguments works.
 *
 * What a text substitution cannot safely do (Docker volumes, an existing dev database, the
 * untracked `.env`, lockfiles, the seller's GitHub coordinates) is printed as a checklist at the end.
 */
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..');

/**
 * The seller's own repository, left verbatim everywhere: `UPGRADING.md` needs it to stay pointed
 * at the kit. Each edition is published from its own repository, so the value is per edition.
 */
const KIT_REPO = 'starterdough/starterdough';

/**
 * The seller's own site, left verbatim. The slug rule is `starterdough(?![a-z])` and a dot is not
 * `[a-z]`, so an unprotected rewrite would turn `starterdough.dev` into a domain you do not own.
 */
const SELLER_SITE = 'starterdough.dev';

/** Strings the rewrite steps over instead of substituting. None is a prefix of another. */
const VERBATIM = [KIT_REPO, SELLER_SITE];

/** Files that describe the kit rather than your product; renaming them makes them wrong. */
const KEEP_VERBATIM = new Set([
	'LICENSE.md',
	'THIRD-PARTY.md',
	'CHANGELOG.md',
	'UPGRADING.md',
	'scripts/rename.ts',
]);

/** Lockfiles are regenerated, not edited; the rest is generated or binary. */
const SKIP_PATTERNS = [/\.lock$/, /(^|\/)src-tauri\/gen\//, /(^|\/)dist\//, /(^|\/)build\//];
const BINARY_EXTENSIONS = new Set([
	'png',
	'ico',
	'icns',
	'jpg',
	'jpeg',
	'gif',
	'webp',
	'woff',
	'woff2',
	'ttf',
	'otf',
	'pdf',
	'mp4',
	'zip',
	'gz',
	'node',
	'wasm',
]);

type Args = {
	name?: string;
	slug?: string;
	identifier?: string;
	scope?: string;
	write: boolean;
	verbose: boolean;
};

function parseArgs(argv: string[]): Args {
	const args: Args = { write: false, verbose: false };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === '--write') {
			args.write = true;
			continue;
		}
		if (flag === '--verbose') {
			args.verbose = true;
			continue;
		}
		const value = argv[i + 1];
		if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) {
			fail(`missing value for ${flag}`);
		}
		switch (flag) {
			case '--name':
				args.name = value;
				break;
			case '--slug':
				args.slug = value;
				break;
			case '--identifier':
				args.identifier = value;
				break;
			case '--scope':
				args.scope = value;
				break;
			default:
				fail(`unknown option ${flag}`);
		}
		i++;
	}
	return args;
}

function fail(message: string): never {
	console.error(`rename: ${message}\n`);
	console.error(
		'usage: bun run rename --name <ProductName> --slug <slug> --identifier <com.example.desktop> --scope <@scope> [--write] [--verbose]',
	);
	process.exit(1);
}

const args = parseArgs(Bun.argv.slice(2));
const { name, slug, identifier, scope: rawScope } = args;
if (!name || !slug || !identifier || !rawScope) {
	fail('--name, --slug, --identifier and --scope are all required');
}

// The slug becomes a Cargo crate name, an npm package name and a Compose project name at once.
if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
	fail(`--slug must be lowercase letters, digits and dashes: got "${slug}"`);
}
if (/\n/.test(name) || !name.trim()) fail('--name must be a single non-empty line');
if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(identifier)) {
	fail(`--identifier must be reverse-domain form, e.g. com.acme.desktop: got "${identifier}"`);
}
// macOS rejects a bundle identifier ending in `.app`.
if (identifier.endsWith('.app')) {
	fail('--identifier must not end in ".app" — macOS rejects that bundle identifier');
}
const scope = rawScope.startsWith('@') ? rawScope : `@${rawScope}`;
if (!/^@[a-z0-9][a-z0-9-]*$/.test(scope)) {
	fail(`--scope must be @ plus lowercase letters, digits and dashes: got "${rawScope}"`);
}

/** Reads the values currently in the repo so the script is not pinned to "Starterdough". */
async function currentValues() {
	const rootManifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
		name?: string;
	};
	const tauri = JSON.parse(
		await readFile(join(repoRoot, 'apps/native/src-tauri/tauri.conf.json'), 'utf8'),
	) as { productName?: string; identifier?: string };
	const shared = JSON.parse(
		await readFile(join(repoRoot, 'packages/tsconfig/package.json'), 'utf8'),
	) as { name?: string };
	const currentScope = shared.name?.split('/')[0];
	if (!rootManifest.name || !tauri.productName || !tauri.identifier || !currentScope) {
		fail('could not read the current name, slug, identifier and scope from the repo');
	}
	return {
		name: tauri.productName,
		slug: rootManifest.name,
		identifier: tauri.identifier,
		scope: currentScope,
	};
}

const current = await currentValues();

/**
 * Order matters: the identifier contains the slug, so it is replaced first. `(?![a-z])` stops the
 * slug matching inside a longer word (a slug that is a prefix of an English word) while still
 * matching `<slug>_`, `<slug>-api`, `<slug>:` and `<slug>` at end of line.
 */
const rules: Array<{ label: string; from: RegExp; to: string }> = [];
if (current.identifier !== identifier) {
	rules.push({
		label: `identifier  ${current.identifier} → ${identifier}`,
		from: new RegExp(escapeRegExp(current.identifier), 'g'),
		to: identifier,
	});
}
if (current.scope !== scope) {
	rules.push({
		label: `scope       ${current.scope}/ → ${scope}/`,
		from: new RegExp(`${escapeRegExp(current.scope)}/`, 'g'),
		to: `${scope}/`,
	});
}
if (current.name !== name) {
	rules.push({
		label: `name        ${current.name} → ${name}`,
		from: new RegExp(`${escapeRegExp(current.name)}(?![a-z])`, 'g'),
		to: name,
	});
}
if (current.slug !== slug) {
	rules.push({
		label: `slug        ${current.slug} → ${slug}`,
		from: new RegExp(`${escapeRegExp(current.slug)}(?![a-z])`, 'g'),
		to: slug,
	});
}
if (!rules.length) {
	console.log('Nothing to do: the repo already uses these values.');
	process.exit(0);
}

function escapeRegExp(value: string): string {
	return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Split on the strings that must survive and rewrite only the segments around them. The capturing
 * group makes `String.split` return the separators at the odd indices.
 */
const VERBATIM_PATTERN = new RegExp(`(${VERBATIM.map(escapeRegExp).join('|')})`);

function rewrite(text: string): { output: string; replacements: number } {
	let replacements = 0;
	const output = text
		.split(VERBATIM_PATTERN)
		.map((segment, index) => {
			if (index % 2 === 1) return segment;
			let rewritten = segment;
			for (const rule of rules) {
				rewritten = rewritten.replace(rule.from, () => {
					replacements++;
					return rule.to;
				});
			}
			return rewritten;
		})
		.join('');
	return { output, replacements };
}

async function trackedFiles(): Promise<string[]> {
	const git = Bun.spawn(['git', 'ls-files', '-z'], { cwd: repoRoot, stdout: 'pipe' });
	const stdout = await new Response(git.stdout).text();
	if ((await git.exited) !== 0) fail('`git ls-files` failed — run this from inside the checkout');
	return stdout.split('\0').filter(Boolean);
}

function skipped(path: string): string | undefined {
	if (KEEP_VERBATIM.has(path)) return 'describes the kit, not your product';
	if (SKIP_PATTERNS.some((pattern) => pattern.test(path))) return 'generated or a lockfile';
	const extension = basename(path).split('.').pop()?.toLowerCase();
	if (extension && BINARY_EXTENSIONS.has(extension)) return 'binary';
	return undefined;
}

type Change = { path: string; replacements: number; lines: Array<[string, string]> };

const changes: Change[] = [];
const skippedWithMatches: string[] = [];
let scanned = 0;

for (const path of await trackedFiles()) {
	const reason = skipped(path);
	const absolute = join(repoRoot, path);
	let text: string;
	try {
		text = await readFile(absolute, 'utf8');
	} catch {
		continue;
	}
	// A NUL byte means it really is binary and slipped past the extension list.
	if (text.includes(String.fromCharCode(0))) continue;
	if (reason) {
		if (rewrite(text).replacements > 0) skippedWithMatches.push(`${path} (${reason})`);
		continue;
	}
	scanned++;
	const { output, replacements } = rewrite(text);
	if (!replacements) continue;
	const before = text.split(/\r?\n/);
	const after = output.split(/\r?\n/);
	const lines: Array<[string, string]> = [];
	for (let i = 0; i < before.length; i++) {
		const oldLine = before[i] ?? '';
		const newLine = after[i] ?? '';
		if (oldLine !== newLine) lines.push([oldLine.trim(), newLine.trim()]);
	}
	changes.push({ path, replacements, lines });
	if (args.write) await Bun.write(absolute, output);
}

const totalReplacements = changes.reduce((sum, change) => sum + change.replacements, 0);

console.log(`\n${args.write ? 'Rewrote' : 'Would rewrite'} — ${rules.length} token(s):\n`);
for (const rule of rules) console.log(`  ${rule.label}`);

console.log(
	`\n${changes.length} of ${scanned} tracked text files, ${totalReplacements} occurrences:\n`,
);
changes.sort((a, b) => b.replacements - a.replacements);
const listed = args.verbose ? changes : changes.slice(0, 30);
for (const change of listed) {
	console.log(`  ${String(change.replacements).padStart(4)}  ${change.path}`);
	if (args.verbose) {
		for (const [oldLine, newLine] of change.lines) {
			console.log(`        - ${oldLine}`);
			console.log(`        + ${newLine}`);
		}
	}
}
if (listed.length < changes.length) {
	const rest = changes.slice(listed.length);
	const restCount = rest.reduce((sum, change) => sum + change.replacements, 0);
	console.log(`  … and ${rest.length} more files (${restCount} occurrences) — --verbose for all`);
}

if (skippedWithMatches.length) {
	console.log('\nLeft verbatim on purpose:\n');
	for (const entry of skippedWithMatches) console.log(`  ${entry}`);
}

const verbatimSites = await (async () => {
	const args = VERBATIM.flatMap((value) => ['-e', value]);
	const grep = Bun.spawn(['git', 'grep', '-n', '--fixed-strings', ...args], {
		cwd: repoRoot,
		stdout: 'pipe',
		stderr: 'ignore',
	});
	const stdout = await new Response(grep.stdout).text();
	await grep.exited;
	return stdout.split('\n').filter(Boolean);
})();

const oldSlug = current.slug;
console.log(`
================================================================================
Residue checklist — none of this is a text substitution, so the script left it
================================================================================

1. Docker volumes. The Compose project name changed (${oldSlug} → ${slug}, ${oldSlug}-dev →
   ${slug}-dev), so Compose will look for new, empty volumes and your data will look like it
   vanished. Either copy each volume across before the next \`up\`:

     docker volume create ${slug}_pgdata
     docker run --rm -v ${oldSlug}_pgdata:/from -v ${slug}_pgdata:/to alpine sh -c 'cd /from && cp -a . /to'

   (repeat for ${oldSlug}_uploads and, for the dev database, ${oldSlug}-dev_pgdata → ${slug}-dev_pgdata)
   — or, if you have no data worth keeping, delete the old ones and start clean:

     bun run db:down && docker volume rm ${oldSlug}-dev_pgdata && bun run db:up && bun run db:migrate

2. The existing Postgres role. compose.dev.yml now creates the role and database "${slug}", but a
   volume that already exists was initialised with "${oldSlug}" and POSTGRES_USER is only read on
   first boot. Recreate the volume as above, or keep the old credentials in your .env.

3. .env is untracked, so it was not touched. Update by hand: DATABASE_URL, EMAIL_FROM,
   BETTER_AUTH_URL, PUBLIC_APP_URL, PUBLIC_API_URL, SITE_URL, DOCS_URL, DOMAIN, IMAGE_REGISTRY,
   OTEL_SERVICE_NAME. Compare against .env.example, which was rewritten.

4. Lockfiles were not edited. Run \`bun install\` to refresh bun.lock for the new package names and
   commit it, or CI's \`--frozen-lockfile\` will fail. Cargo.lock is refreshed by the next
   \`bun run build:desktop\`.

5. The kit's own coordinates were left verbatim, on purpose. Point the repository URLs at your fork;
   delete anything else here that you do not want in your own README:
${verbatimSites.map((line) => `     ${line}`).join('\n') || '     (none found)'}

6. Existing backup artefacts keep the old "${oldSlug}_" prefix while the tool now writes "${slug}_",
   so \`bun run --cwd infra/backup list\` will not see them. Rename the files, or restore what
   you need before renaming.

7. Domains, DNS and hosting: the Cloudflare worker names in apps/*/wrangler.jsonc, Caddy's DOMAIN,
   the GitHub repository itself, and the IMAGE_REGISTRY / SITE_URL / DOCS_URL / PUBLIC_APP_URL /
   PUBLIC_API_URL repository variables the deploy workflow reads.

8. Desktop: replace the icons in apps/native/src-tauri/icons/, and note that changing the bundle
   identifier changes the OS application-data directory — an already-installed build will not see
   its old local state, and app stores treat it as a different application.

9. Product copy is still ours: the landing and legal pages under apps/site/src/content, the docs
   under apps/docs/src/content, the OG images, and the blog posts. Read them before you publish.

Then: bun install && bun run verify
`);

if (!args.write) {
	console.log('Dry run. Re-run with --write to apply.\n');
}
