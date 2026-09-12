/**
 * `bun run admin:create -- --email you@example.com [--name 'You'] [--yes]`
 *
 * Creates (or promotes) a platform administrator: a `user` row whose `role` is in `ADMIN_ROLES`.
 * The password comes from `ADMIN_PASSWORD` or an interactive prompt, never from argv: a password on
 * the command line lands in shell history and in `ps` for every other user of the box.
 *
 * It goes straight through our own auth config (no network, no CLI download), so it works in the
 * slim API image and cannot drift from the pinned `better-auth`.
 */
import { db, eq, user } from '@repo/db';
import { isProduction } from '@repo/env';
import { ADMIN_ROLES } from '../src/permissions';
import { auth } from '../src/server';

const MIN_PASSWORD_LENGTH = 8;

function flag(name: string): string | undefined {
	const args = process.argv.slice(2);
	const index = args.indexOf(`--${name}`);
	if (index >= 0) return args[index + 1];
	const inline = args.find((arg) => arg.startsWith(`--${name}=`));
	return inline?.slice(name.length + 3);
}

const hasFlag = (name: string) =>
	process.argv.slice(2).some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));

function fail(message: string): never {
	console.error(`\n${message}\n`);
	process.exit(1);
}

const email = flag('email')?.trim().toLowerCase();
if (!email?.includes('@')) {
	fail('Usage: bun run admin:create -- --email you@example.com [--name "You"] [--yes]');
}
const name = flag('name')?.trim() || email.split('@')[0] || 'Admin';
const assumeYes = hasFlag('yes');

function readPassword(): string {
	const fromEnv = process.env.ADMIN_PASSWORD;
	if (fromEnv) return fromEnv;
	// `prompt()` echoes what is typed; Bun has no hidden-input primitive. Set ADMIN_PASSWORD
	// (e.g. `read -s ADMIN_PASSWORD` in bash) when someone can see the screen.
	const typed = prompt(`Password for ${email} (visible while typing):`);
	if (!typed) fail('No password given. Set ADMIN_PASSWORD or type one at the prompt.');
	return typed;
}

const [existing] = await db.select().from(user).where(eq(user.email, email)).limit(1);

if (existing) {
	const roles = (existing.role ?? '')
		.split(',')
		.map((r) => r.trim())
		.filter(Boolean);
	if (roles.some((role) => (ADMIN_ROLES as readonly string[]).includes(role))) {
		console.log(`${email} is already a platform administrator (role: ${existing.role}).`);
		process.exit(0);
	}
	if (!assumeYes) {
		fail(
			`${email} already exists with role "${existing.role ?? 'user'}". Re-run with --yes to promote that account to ${ADMIN_ROLES[0]}.`,
		);
	}
	await db
		.update(user)
		.set({ role: [...roles, ADMIN_ROLES[0]].join(','), updatedAt: new Date() })
		.where(eq(user.id, existing.id));
	console.log(`Promoted ${email} to ${ADMIN_ROLES[0]}.`);
	process.exit(0);
}

const password = readPassword();
if (password.length < MIN_PASSWORD_LENGTH) {
	fail(`The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
}

// Sign-up goes through Better Auth so the password is hashed exactly as a sign-in expects, the
// account row is created, and every hook (name normalisation, welcome email) runs.
const created = await auth.api.signUpEmail({ body: { email, password, name } });

// The role is not something the sign-up endpoint may set (that would be privilege escalation from
// the public API), and an administrator with no way to verify their address cannot sign in when
// REQUIRE_EMAIL_VERIFICATION is on (the production default).
await db
	.update(user)
	.set({ role: ADMIN_ROLES[0], emailVerified: true, updatedAt: new Date() })
	.where(eq(user.id, created.user.id));

console.log(`\nCreated platform administrator ${email} (${ADMIN_ROLES[0]}).`);
if (!isProduction) console.log('Sign in at /signin, then manage further admins from /admin/users.');
process.exit(0);
