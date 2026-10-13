import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';

/**
 * Every third-party image is pinned to a patch release, so a rebuild or a `compose pull` changes
 * nothing until a reviewed commit moves the pin, and the Bun in every image is the Bun CI and
 * development run: package.json's `packageManager`.
 */
const repository = resolve(import.meta.dir, '../..');

/** A tag that names a patch release: `1.4.2`, `2.11.7-alpine`, `0.8.7-pg17`. */
const PATCH = /^v?\d+\.\d+\.\d+(?:$|[-+_.])/;

type Reference = { file: string; image: string };

/** Tracked files matching `patterns`. A git pathspec's `*` also matches `/`, so subdirectories count. */
async function tracked(...patterns: string[]): Promise<string[]> {
	const child = Bun.spawn(['git', 'ls-files', '-z', '--', ...patterns], {
		cwd: repository,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [listing, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
	if (exitCode !== 0) throw new Error(`git ls-files ${patterns.join(' ')} exited ${exitCode}`);
	return listing.split('\0').filter(Boolean);
}

/** The text of a tracked file, or null for one deleted from the working tree but not yet committed. */
async function read(file: string): Promise<string | null> {
	const source = Bun.file(resolve(repository, file));
	return (await source.exists()) ? source.text() : null;
}

function matches(text: string, pattern: RegExp): string[] {
	return [...text.matchAll(pattern)].map((match) => match[1] ?? '');
}

/** Every image a build, a Compose file, a workflow or the routing test pulls by name. */
async function references(): Promise<Reference[]> {
	const found: Reference[] = [];
	const add = (file: string, images: string[]) => {
		for (const image of images) found.push({ file, image });
	};
	for (const file of await tracked('*Dockerfile*')) {
		const text = await read(file);
		if (text === null) continue;
		// A stage that builds on an earlier one names it (`FROM base`), and `scratch` is no image.
		const stages = new Set(
			matches(text, /^FROM\s.*\sAS\s+(\S+)\s*$/gim).map((stage) => stage.toLowerCase()),
		);
		stages.add('scratch');
		const images = matches(text, /^FROM\s+(?:--platform=\S+\s+)?(\S+)/gim).filter(
			(image) => !stages.has(image.toLowerCase()),
		);
		add(file, images);
	}
	for (const file of await tracked('infra/*.yml', '.github/workflows/*.yml')) {
		const text = await read(file);
		if (text === null) continue;
		add(file, matches(text, /^\s*-?\s*image:\s*['"]?([^\s'"#]+)/gm));
		// The throwaway containers the workflows start with `docker run`, wherever the image lands:
		// several of those commands continue over lines ending in `\`.
		if (file.startsWith('.github/'))
			add(file, matches(text, /(?:^|[\s'"])((?:caddy|grafana\/k6):[\w.-]+)/gm));
	}
	const routing = 'infra/caddy/static-routing.test.sh';
	const text = await read(routing);
	if (text !== null) add(routing, matches(text, /\$\{CADDY_IMAGE:-([^}]+)\}/g));
	// This repository's own images take their tag from IMAGE_REGISTRY and IMAGE_TAG. An image with
	// no tag at all stays in: it floats on `latest`.
	return found.filter(({ image }) => !image.includes('${'));
}

function tag(image: string): string {
	// The tag follows the last colon; a registry port (`host:5000/name`) comes before a slash.
	const last = image.slice(image.lastIndexOf('/') + 1);
	return last.includes(':') ? last.slice(last.indexOf(':') + 1) : '';
}

/** The image without its tag or digest: `caddy` for `caddy:2.11.7-alpine`. */
function name(image: string): string {
	const bare = image.split('@')[0] ?? image;
	const colon = bare.lastIndexOf(':');
	return colon > bare.lastIndexOf('/') ? bare.slice(0, colon) : bare;
}

describe('container image pins', () => {
	it('finds the images in Dockerfiles, Compose files, workflows and the routing test', async () => {
		const found = await references();
		const files = new Set(found.map(({ file }) => file));
		for (const file of [
			'apps/api/Dockerfile',
			'infra/compose.yml',
			'infra/compose.dev.yml',
			'.github/workflows/ci.yml',
			'infra/caddy/static-routing.test.sh',
		])
			expect(files).toContain(file);
		// The caddy images of ci.yml's multi-line `docker run` commands, not only the one-line ones.
		const caddy = found.filter(
			({ file, image }) => file === '.github/workflows/ci.yml' && image.startsWith('caddy:'),
		);
		expect(caddy.length).toBeGreaterThan(4);
	});

	it('pins every third-party image to a patch release', async () => {
		const floating = (await references()).filter(
			({ image }) => !image.includes('@sha256:') && !PATCH.test(tag(image)),
		);
		expect(floating).toEqual([]);
	});

	it('pins each image to the same release everywhere', async () => {
		// Dependabot moves the Dockerfiles and Compose files it finds, not ci.yml's `docker run` and
		// service images or the routing test's default, so its pull request fails here until the
		// rest follow. Bun is held to packageManager below, in a plain and an `-alpine` variant.
		const pins = new Map<string, Set<string>>();
		for (const { image } of await references()) {
			if (name(image) === 'oven/bun') continue;
			pins.set(name(image), (pins.get(name(image)) ?? new Set<string>()).add(image));
		}
		const split = [...pins.values()]
			.filter((images) => images.size > 1)
			.map((images) => [...images]);
		expect(split).toEqual([]);
	});

	it('builds every Bun image on the packageManager version', async () => {
		const { packageManager } = await Bun.file(resolve(repository, 'package.json')).json();
		const version = String(packageManager).replace(/^bun@/, '');
		const bun = (await references()).filter(({ image }) => image.startsWith('oven/bun:'));
		expect(bun.length).toBeGreaterThan(0);
		const other = bun.filter(({ image }) => !new RegExp(`^${version}(?:-|$)`).test(tag(image)));
		expect(other).toEqual([]);
	});
});
