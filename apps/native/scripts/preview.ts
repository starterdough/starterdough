/**
 * Preview the shell the way it ships — the static build embedded in the binary and served from
 * the app origin (`http://tauri.localhost` on Windows, `tauri://localhost` elsewhere) — without a
 * release build: `tauri build --debug --no-bundle`, then run the debug binary.
 *
 * `dev:desktop` is the daily driver (Vite dev server + HMR, origin `http://localhost:5175`); this
 * is the pre-release check for everything that depends on the real origin: bearer auth with no
 * cookies, the CSP from `scripts/tauri-config.ts`, the locale persisted in `localStorage`.
 *
 *   bun run preview:desktop            # build (web static + debug binary) and open the window
 *   bun run preview:desktop -- --run   # skip the build, just open the last binary
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const binary = resolve(
	root,
	'src-tauri/target/debug',
	process.platform === 'win32' ? 'starterdough.exe' : 'starterdough',
);

async function run(cmd: string[]) {
	const proc = Bun.spawn(cmd, { cwd: root, stdio: ['inherit', 'inherit', 'inherit'] });
	const code = await proc.exited;
	if (code !== 0) process.exit(code);
}

if (!process.argv.includes('--run')) {
	await run(['bun', 'scripts/tauri-config.ts']);
	await run([
		'bun',
		'run',
		'tauri',
		'build',
		'--debug',
		'--no-bundle',
		'--config',
		'tauri.build.conf.json',
	]);
}

if (!existsSync(binary)) {
	console.error(`No debug binary at ${binary} — run without --run to build it first.`);
	process.exit(1);
}

await run([binary]);
