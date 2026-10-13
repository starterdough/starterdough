# Upgrading

The kit is a repository, not a package. There is no `bun update` for it. You pull a release into
your fork with git, on a branch, and read the diff. This page is that procedure, including after
you have renamed everything.

Every release from 1.0.0 on is a git tag (`v1.0.0`, `v1.1.0`, …) with a dated section in
[`CHANGELOG.md`](CHANGELOG.md); the ones before it were never tagged. Read that section first. It
marks what breaks a fork: moved files, renamed exports, new environment variables, migrations.
What a release asks of you beyond the merge is under [Release by release](#release-by-release).
Merge release tags, never the kit's `main`: between releases, `main` is work in progress.

In your repository the kit's tags are named `kit/v1.0.0`, `kit/v1.1.0`, … so they never collide
with your own product's `v*` tags, which the deploy and desktop workflows build from. The commands
below use `kit/v1.0.0` for the release you start from, `kit/v1.1.0` for the release you upgrade to,
and Acme for your product. Put your own values in. `git tag -l "kit/*" --sort=-v:refname` lists the
kit's releases, newest first. Run the commands one line at a time and stop at the first that
fails: each line assumes the ones before it worked.

## Once, when you start

**Keep the kit's git history.** Clone the kit, move `main` to the release you start from, then
point `origin` at your own empty repository:

```sh
git clone --no-tags https://github.com/starterdough/starterdough.git my-product
cd my-product
git remote rename origin kit
git config --add remote.kit.fetch "+refs/tags/*:refs/tags/kit/*"
git fetch kit
git remote add origin git@github.com:me/my-product.git
git reset --hard kit/v1.0.0 && git push -u origin main
```

`--no-tags` and the extra fetch line are what file the kit's tags under `kit/`; every later
`git fetch kit` brings the new ones the same way. `reset --hard` moves the fresh clone's `main`
from the kit's work in progress to the release, which loses nothing on a clone you have not
touched. You now have `kit` as a second remote and a shared ancestor with every future release.
That is what makes a three-way merge possible.

The push waits for the reset. If the release you named has no tag, `git reset` stops with
`unknown revision` and nothing reaches your repository: `git tag -l "kit/*"` shows the tags there
are. Tags start at `v1.0.0`; there is nothing older to start from. Once the tag is published, run
`git fetch kit` and then the block's last line again, in the same clone.

If you started from a downloaded archive, add the remote now:

```sh
git remote add kit https://github.com/starterdough/starterdough.git
git config remote.kit.tagOpt --no-tags
git config --add remote.kit.fetch "+refs/tags/*:refs/tags/kit/*"
git fetch kit
```

A clone made before `v1.0.0`, when the kit had no tags, needs the same setup once: run the last
three of those commands. A `git fetch kit` you ran before them may already have brought the kit's
tags in under their plain names, next to your own: delete those, `git tag -d v1.0.0` and so on.

A downloaded archive's `main` shares no history with the kit, and git merges no release into it
until you record the release the archive held as merged. If you renamed it, run the "Already
renamed `main` another way?" block below with `--allow-unrelated-histories` added to its
`git merge -s ours` line. If you have not, run
`git merge -s ours --allow-unrelated-histories kit/v1.0.0` once, naming the release the archive
held; every other block on this page then works as written.

Two habits make every upgrade easier:

- **Put your code in new files** where you can: a new route, a new procedure, a new package. New
  files never conflict.
- **Do not reformat or reorganise kit files.** A whitespace-only change to a file we also change
  turns a clean merge into a manual one.

### Rename on a branch the kit can follow

`bun run rename` changes the product name, the slug, the Tauri identifier and the workspace scope
on hundreds of lines. Merge a later release straight into a renamed `main` and every line the
release touches that holds one of those four is a conflict. So the rename happens on a branch of
its own, `kit-renamed`, which holds each release you take, renamed. Your `main` merges that
branch, never the tags, and a merge only ever sees what the kit changed between two releases.

```sh
git switch --no-track -c kit-renamed kit/v1.0.0
bun run rename --name Acme --slug acme --identifier com.acme.desktop --scope @acme --write
bun install
bun run lint:fix
git commit -am "Starterdough v1.0.0, renamed to Acme"
git switch main
git merge kit-renamed
git push origin main kit-renamed
```

`--no-track` keeps `kit-renamed` from tracking whatever it starts from, even a branch: it is a
branch of your own, pushed to your repository. `bun install` records the renamed workspace packages
in `bun.lock`, and `lint:fix` re-sorts the imports and re-wraps the lines whose length the rename
changed. `rename` itself leaves every dependency map in a `package.json` it rewrites in the order
`bun add` keeps, so your first `bun add` on `main` moves no renamed line, and the next snapshot
agrees with `main` about where each one goes. The snapshot is then exactly what your `main` will
hold, and a fresh `main` fast-forwards to it. Push `kit-renamed` with `main`: the next upgrade
starts from it, on whichever machine runs it. `bun install` also installed the git hooks, so this
push runs `bun run verify` first. It needs no `.env` and no database.

Use exactly these arguments at every upgrade. A different `--slug` makes every slug line a
conflict again. If you forget them, they are in your own tree: the slug is `name` in the root
`package.json`, the name and identifier are `productName` and `identifier` in
`apps/native/src-tauri/tauri.conf.json`, and the scope begins every workspace package's name.

**Already renamed `main` another way?** If you ran `rename` on `main` itself, build the snapshot
of the release you started from with the arguments you used, and record it as merged without
changing a line. Only the merge differs from the commands above, and a `kit-renamed` branch left
over from an earlier version of this page has to go first: `git branch -D kit-renamed`.

```sh
git switch --no-track -c kit-renamed kit/v1.0.0
bun run rename --name Acme --slug acme --identifier com.acme.desktop --scope @acme --write
bun install
bun run lint:fix
git commit -am "Starterdough v1.0.0, renamed to Acme"
git switch main
git merge -s ours kit-renamed -m "Take the renamed v1.0.0 as merged"
git push origin main kit-renamed
```

`-s ours` keeps your tree exactly as it is. It only tells git that `main` already holds the
snapshot, so the next upgrade brings in what changed after `v1.0.0` and nothing before. That is
true only for the release you really started from, so name that one. If you started before
`v1.0.0`, use the kit commit your `main` last took in, `git merge-base main kit/main`, in place of
`kit/v1.0.0`.

## Every upgrade

Start from a clean `git status`. `git switch` carries uncommitted changes from one branch to the
next, and the snapshot must hold only the release.
A clone of your own repository that has never had the `kit` remote, a teammate's or a second
machine's, needs the four commands for a downloaded archive above once.

**If you renamed the kit**, rename the new release on `kit-renamed`, then merge it on a branch:

```sh
git fetch kit
git switch kit-renamed && git restore --source=kit/v1.1.0 --staged --worktree :/
bun run rename --name Acme --slug acme --identifier com.acme.desktop --scope @acme --write
bun install
bun run lint:fix
git commit -am "Starterdough v1.1.0, renamed to Acme"
git switch main
git switch -c upgrade/v1.1.0
git merge kit-renamed
```

`git restore` swaps every tracked file on `kit-renamed` for the release's, deletions included, and
leaves untracked files such as `.env` and `node_modules` alone. It runs only once `git switch` has
landed on `kit-renamed`: on `main` it would replace your work with the release. The new snapshot's
parent is the previous one, so the merge base is the last release your `main` took, already
renamed. Skipping a release works the same way: snapshot the newest one, and the merge still
starts from the last release you took.

**If you kept the kit's name**, merge the tag:

```sh
git fetch kit
git switch -c upgrade/v1.1.0
git merge kit/v1.1.0
```

Then, in order:

1. **Resolve conflicts and install.** A conflict now means the release and you changed the same
   lines. For `bun.lock`, take the release's side and regenerate it:
   `git checkout --theirs bun.lock`. Then run `bun install` whether or not anything conflicted,
   and commit. The next `bun run build:desktop` refreshes `Cargo.lock`.
   Upgrading from 1.0.0 with migrations of your own? If the merge stops on
   `packages/db/drizzle/meta`, run `bun run db:move-product-migrations` now, before you resolve
   anything in that folder (1.1.0, under "Release by release"). It is the one release step that
   runs while the merge is still open: it reads the journal your side had before the merge.
2. **Diff `.env.example` against your `.env`.** New variables land there first.
   `git diff main -- .env.example` shows what this upgrade changed.
3. **Apply migrations.** Run `bun run db:migrate` against a copy of production first. It applies
   the release's kit migrations, then yours, and exits 1 when one of either is still pending after
   the run; "Migrations" below says what to do then. A kit release never changes your migrations.
   A migration may also fail on purpose instead of deleting rows to fit a new constraint. It names
   the offending key, and its header comment carries the query that finds the duplicates.
4. **`bun run verify`.** Lint, typecheck and tests, the same three gates CI runs.
   `bun run licenses --strict` is the fourth gate. It notices a dependency licence the release
   added that you now have to comply with.
5. **`bun run test:e2e`** if the release touched auth, routing or the app shell.
6. **Merge to `main` and push.**

   ```sh
   git switch main
   git merge upgrade/v1.1.0
   git push origin main
   ```

   If you renamed the kit, push the new snapshot too: `git push origin kit-renamed`. The Deploy
   workflow then releases `main` once CI passes on that push, if the repository variable
   `DEPLOY_ENABLED` is `true`.

`rename` leaves the kit's own repository URL alone, so the `kit` remote keeps working after a
rename. It also leaves `LICENSE.md`, `THIRD-PARTY.md`, `CHANGELOG.md` and `UPGRADING.md` as they
are, so those four merge cleanly at every upgrade.

## Migrations

Your database has two migration histories. The kit's is `packages/db/drizzle`, recorded in
`drizzle.__drizzle_migrations`, and only kit releases add to it. Yours is
`packages/db/drizzle-product`, recorded in `drizzle.__product_migrations`: `bun run db:generate`
writes it from the tables `packages/db/src/schema/product.ts` exports. `bun run db:migrate` applies
the kit's history, then yours, so a kit release that adds a migration never conflicts with yours.

The order differs between databases. A fresh one runs every kit migration before any of yours; an
existing one runs a new release's kit migrations after yours. Kit migrations never touch your
tables. Yours must not depend on something in a kit table that a later release may change, such
as an index on a kit column the kit later drops: it would fail on a fresh database.

**The kit's tables.** Rather than changing one, add a table of your own keyed by its id, such as
`user_profile (user_id primary key references "user")`. When a kit table itself has to change (a
Better Auth plugin after `bun run auth:schema`, an index of yours on a kit table),
`bun run db:kit-drift` prints the SQL; put it in `bun run db:generate --custom --name=<name>` and
check that it drops nothing. `bun run test` fails while any of that SQL is still outstanding.

**`db:migrate` says a migration is still pending after the run.** Drizzle applies a migration only
when its timestamp is newer than the newest one applied from the same history, and skips it for
good otherwise. The message names each one with its history:

- `(product)`: two branches of yours each generated a migration, and the merge put an older one
  after a newer one that has already run. If the older one has not run anywhere you keep, delete
  its `.sql` file, its snapshot and its journal entry, and run `bun run db:generate` on the merged
  tree. Otherwise apply it by hand (`psql -1 "$DATABASE_URL" -f <file>`) and record it in
  `drizzle.__product_migrations`: `hash` is the file's `shasum -a 256`, `created_at` its `when` in
  the journal.
- `(kit)`: a migration of yours still sits in `packages/db/drizzle`, generated before 1.1.0 or left
  there by resolving the 1.1.0 merge the old way. Run
  `bun run db:move-product-migrations --kit <the release you merged>`, which also works after the
  merge is committed as long as the kit's journal still lists your migration, commit, and deploy
  again. The database recovers by itself: once your migration's row has moved to your history, the
  kit migration Drizzle skipped applies.

`/admin/system` shows both histories. An `unknown` count there means rows that no migration in the
running build accounts for: a newer build has migrated this database.

## Release by release

Some releases ask for more than the steps above: a change to your own code, a setting, a command
to run once. Each has a section here, named after the release that brought it. Work through it
after step 1, once the merge is committed, and before step 4, which checks it; the one step that
runs during step 1 instead, while the merge is open, says so. Commit what it changes on the upgrade
branch: step 6 merges commits, not your working tree. Skipping releases? Work through the sections
of every release you skip, oldest first.

### Product files, migrations and versions (1.1.0)

1. **Migrations of your own in `packages/db/drizzle`.** On 1.0.0 `bun run db:generate` wrote your
   migrations into the kit's history; from 1.1.0 they live in `packages/db/drizzle-product`
   ("Migrations" above). Run `bun run db:move-product-migrations` during step 1, while the merge is
   still open: it moves each of yours with the same SQL and timestamp, makes the kit's folder
   exactly the release's, and stages both. If that folder merged without a conflict, run it once
   the merge is committed instead, naming what you merged: `--kit kit-renamed` if you renamed the
   kit, `--kit kit/v1.1.0` if you did not. Then export your tables from
   `packages/db/src/schema/product.ts` instead of `schema/index.ts`; the command names each one
   `schema/index.ts` still exports, which `db:generate` would otherwise propose to drop. Run
   `bun run db:generate`, which must say "No schema changes", and commit. Each database prints
   `✓ moved N migration(s) of yours to the product history` at its next `bun run db:migrate`. From
   then on a build from before 1.1.0 cannot migrate it (it would run your migrations again), so
   roll back across this release by restoring the dump you took before step 3.
2. **Optional: move your additions out of kit files.** Procedures you spread into `contract`,
   routers you mounted in `router.ts`, your messages in the kit's catalogues and your links in the
   app shell each have a product file now:
   [Where your code goes](apps/docs/src/content/docs/guides/product-files.md) lists them. Moved
   there, they stop conflicting with later releases. They may keep their names: a procedure keeps
   its route, and a message its key.
3. **Versions.** `version` in the root `package.json` is now your product's, and the kit's release
   is the new `kitVersion`, which only kit releases change: never edit it. This release sets
   `version` to 0.1.0 once, there, in `apps/native/package.json` and in
   `apps/native/src-tauri/Cargo.toml`. If the merge conflicts on any of those lines, keep yours. If
   it took 0.1.0 and your product had a version of its own, set it again in all three.
4. **`GET /api/v1/admin/system`.** `database.migrations` is now `{ kit, product }`, each with the
   fields it had, and the response gains `kitVersion`. This matters only if you read it yourself.
5. **After `bun run auth:schema`**, `bun run db:kit-drift` prints the SQL for a custom migration
   of yours ("Migrations" above). `bun run db:generate` no longer sees the kit's tables.

### Better Auth and `TRUSTED_ORIGINS` (1.1.0)

- **Better Auth 1.7.7.** The upgrade's `bun install` takes Better Auth and its plugins from 1.7.3
  to 1.7.7, which fixes three security advisories. It needs no schema change: `bun run auth:schema`
  writes the same tables, so there is nothing to generate or migrate. Raise any Better Auth
  package you pinned yourself to ^1.7.7.
- **`null` in `TRUSTED_ORIGINS` now stops the API at start-up.** Sandboxed iframes, `data:` URLs
  and `file:` pages send that origin, so trusting it let any website call the API with a visitor's
  session. Remove it before you deploy, from every `.env` and from `infra/env/production.enc.env`
  if you deploy with SOPS. A Tauri shell's origins are `tauri://localhost` and
  `http://tauri.localhost`.


### What your deploys publish (1.1.0)

1. **The kit's release notes and posts leave your site.** `apps/site/src/content/changelog` and
   `apps/site/src/content/blog` now hold one draft sample each, which `astro dev` shows and no
   build publishes, and the merge deletes the kit's notes for 0.1.0 to 1.0.0 and its two posts.
   If you edited one of those, git stops on a modify/delete conflict: keep yours with
   `git add <path>`. From this release on both folders are yours, like
   `apps/docs/src/content/product` ("What we will not do to you").
2. **`docs.<domain>`, or `/docs`, serves your product's docs.** A docs build now publishes
   `apps/docs/src/content/product`: a splash page, a getting-started guide and the interactive API
   reference. The kit's manual in `apps/docs/src/content/docs` is built only with
   `DOCS_CONTENT=kit`; read it with `bun run dev:manual`. Move any page you added to the manual
   for your users into `apps/docs/src/content/product/guides/` or `reference/`, where the sidebar
   lists it by itself. The site's "Read the guides" and "Read the docs" buttons now open the docs
   home, which both have.
3. **A production site build refuses unfinished legal pages.** When `SITE_URL` is a real origin,
   a tailnet `*.ts.net` one included, the build fails while a page in `apps/site/src/content/legal`
   still holds a `**[placeholder]**` or the "Template: review with counsel" note, and names each
   file and what is left. Fill them in before your next deploy. For a staging or trial deploy, set
   `ALLOW_LEGAL_PLACEHOLDERS=1` instead: as a repository variable for the Deploy workflow, as a row
   of the server's root `.env` for a build on the box, or in `apps/site/.env`.
4. **The demo banner links where `PUBLIC_DEMO_CTA_URL` says**, and nowhere while it is empty; it
   linked to the seller's site. `infra/demo/compose.yml` defaults it to the demo's own marketing
   site. `infra/demo/.env.example` now ships `DOMAIN`, `EMAIL_FROM` and `IMAGE_REGISTRY` empty
   instead of the seller's demo values; an existing demo `.env` is untouched.
5. **`infra/scripts/provision.sh` needs `REPO_URL`.** Its default was the kit's repository, which
   provisioned the kit instead of your product.
6. **Renamed forks: two one-time changes in the first renamed snapshot.** `rename` now rewrites
   the `STARTERDOUGH_` prefix of the deploy scripts' variables to your slug in capitals
   (`ACME_STATE_DIR`); if you set `STARTERDOUGH_STATE_DIR` or
   `STARTERDOUGH_OPERATION_LOCK_WAIT_SECONDS` on a server, set it again under the new name. It also
   sorts the dependency maps of each `package.json` it rewrites. If you ran `bun add` after your
   rename, the merge may stop inside such a map: keep the snapshot's order and your own entries.

### Deploys and operations (1.1.0)

1. **Set `DEPLOY_PATH` and `DEPLOY_KNOWN_HOSTS` before you merge**, as repository variables, or the
   Deploy workflow stops in its plan job and names the one that is missing. `DEPLOY_PATH` has no
   default any more: set it to the checkout on the server. If you kept `provision.sh`'s default,
   that is `/opt/<your slug>`: `/opt/starterdough` if you never renamed, `/opt/acme` after
   `rename --slug acme`. Your `deploy.yml` from before the merge names it, in
   `vars.DEPLOY_PATH || '…'`. `DEPLOY_KNOWN_HOSTS` is the server's SSH host key, which every
   workflow that reaches the server now checks (`StrictHostKeyChecking yes`); the `accept-new` it
   replaces accepted any key, because a hosted runner starts every job with an empty
   `known_hosts`. Compare `ssh-keyscan -t ed25519 <host> | ssh-keygen -lf -` with the fingerprint
   your provider's console shows, or with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` run on
   the box, and once they match, set the variable to the line `ssh-keyscan -t ed25519 <host>`
   prints. If the server's `.env` sets `COMPOSE_PROJECT_NAME`, set a repository variable of the
   same name: before it replaces the server's `.env`, a deploy now refuses a checkout that shares
   no history with the release or runs another Compose project.
2. **Every deploy takes a release backup** before it stops anything: a dump of the database in the
   `backups` volume under `release/`, up to four of them. Expect it in every deploy log. Set
   `RELEASE_BACKUP=off` in the server's `.env` if you rely on provider snapshots or the database is
   too large to dump on every deploy, and if your stack has no `backup` service, which the deploy
   otherwise refuses.
3. **Desktop installers are opt-in.** `desktop.yml` builds nothing on a `v*` tag until the
   repository variable `DESKTOP_ENABLED` is `true`. Set it if you ship installers.
4. **Postgres restarts once.** The image line is now `pgvector/pgvector:0.8.7-pg17`, the same image
   as `pg17`, but a changed line makes Compose recreate the container, which the first deploy does
   after the writers have stopped. Every base and service image is now pinned to a patch release,
   and `oven/bun` to the Bun in `packageManager`: `infra/scripts/image-pins.test.ts` fails until
   the four `oven/bun` lines move with that field. If you changed one of those lines, keep the
   release's pin.
5. **Steps of your own in `infra/scripts/deploy.sh`** belong in
   `infra/scripts/hooks/pre-deploy.d/` or `post-deploy.d/` now (the README there has the
   contract). The kit never changes those folders, so the steps stop conflicting with releases.
6. **Products without a surface.** CI's Rust job now skips itself when `apps/native` is gone, and
   Deploy skips an image whose Dockerfile is gone. If you deleted a job or an image from a workflow
   for that reason, the merge may stop there: take the release's side.
7. **Optional.** `SENTRY_DSN` now reports the API's unexpected errors as well as the web's.
   `ADMIN_BOOTSTRAP_PASSWORD`, a secret of the `production` environment, feeds the new Admin
   bootstrap workflow; delete it after the first sign-in. That workflow can also promote an
   existing account without any secret, so add required reviewers to the `production` environment
   if the repository has collaborators. Run the new Registry cleanup workflow by hand with
   `dry-run` before its first weekly run. Recover deployment's new `abandon` cannot drop a journal
   that a 1.0.0 deploy wrote; `recover` still finishes one.


### Email in the user's language (1.1.0)

- **A template takes the recipient's locale** as its second argument, and is written once per
  language with `defineTemplate({ en, de })`. Move each template you added to
  `packages/email/src/index.ts` into `productTemplates` in `packages/email/src/product.ts`, with an
  `en` and a `de` copy: `bun run check` fails while one is missing. A call without a locale still
  compiles and sends English. In a procedure, `localeOf(context.headers)` picks the language from
  the caller's `Accept-Language`
  ([Authentication](apps/docs/src/content/docs/guides/authentication.md), "Email: templates and
  language").


### Setup and deploys (1.0.0)

- **Run `bun run setup` once.** It creates any local `.env` you lack from the `.env.example` next
  to it, generates a `BETTER_AUTH_SECRET` where none is set, gives an empty `SITE_URL` in
  `apps/site/.env` or `apps/docs/.env` the local origin, and leaves every value you set alone.
- **A public `SITE_URL` before you deploy a site.** `apps/site/.env.example` and
  `apps/docs/.env.example` now ship the local origins, and `deploy:cloudflare` refuses a localhost
  `SITE_URL`. Set each site's `SITE_URL` to its public origin before you deploy it.
- **Switch deploys on.** The Deploy workflow builds and deploys nothing until the repository
  variable `DEPLOY_ENABLED` is `true` (Settings → Secrets and variables → Actions → Variables). If
  you deploy from Actions, set it when you merge this release, or your deploys stop. From now on a
  deploy waits for CI to pass on `main`, and the server no longer fetches from GitHub: the workflow
  pushes the release commit into the server's checkout over the deploy login, so a private
  repository needs no deploy key or token on the server. A pushed `v*` tag still builds images but
  no longer deploys. `infra/README.md`, "Deploy, update, roll back", has the setup in order.
- **`python3` and `flock` on a server deployed before 1.0.0.** Install both before its first
  deploy of this release (`sudo apt-get install python3 util-linux` on Debian or Ubuntu;
  util-linux supplies `flock`). A deploy now holds a host lock with `flock` and records the
  containers it replaces with `python3`, so that an interrupted one can be recovered.
  `provision.sh` installs both on a new server.
- **`AGENTS.md` and `CLAUDE.md` are new at the repository root.** If your fork already has either
  (Claude Code's `/init` writes a `CLAUDE.md`), the merge stops on an add/add conflict there. Keep
  your file, and add the line `@AGENTS.md` to your `CLAUDE.md` so Claude Code reads the kit's
  rules as well, or carry the rules you want into your own `AGENTS.md`.
- **A complete production environment.** The production API now refuses to boot without
  `RESEND_API_KEY` or with an `EMAIL_FROM` on a domain no provider accepts (`localhost`,
  `example.com` and the like). Set both in the server's `.env`, or in
  `infra/env/production.enc.env` if you deploy with SOPS, before you deploy this release.

### SvelteKit 3 (1.0.0)

1.0.0 moves `apps/web` from SvelteKit 2 to SvelteKit 3.0.1. The kit's own files arrive migrated
with the merge, so these steps are for code you added under `apps/web`, and for kit files you
edited: a conflict there usually sits on an import line, where you keep your change in the
release's spelling.

1. **Node.js.** Optional. But if `node` is on your PATH (or your CI runner's), it must be 22.17 or
   newer: `bun run dev` and `bun run build` start Vite with it, and `bun run doctor` fails on an
   older one. Without Node, Bun runs Vite itself.
2. **Versions.** The root `package.json` catalog now has `@sveltejs/kit` ^3.0.1, adapter-node ^6,
   adapter-static ^4, adapter-cloudflare ^8, `svelte` ^5.57.2 and `svelte-check` ^4.7.5.
   `apps/web/package.json` has `sveltekit-superforms` ^3.0.0 and a new
   `"imports": { "#lib/*": "./src/lib/*" }`. The upgrade's `bun install` brought them in; raise
   anything you pinned yourself to match.
3. **Find what is left.** From the repository root:

   ```sh
   git grep -nE '[$]lib|[$]env/|[$]app/(environment|stores)|[$]service-worker|invalidateAll|replaceState|pushState|keepFocus|noScroll' -- apps/web/src
   ```

   `invalidateAll: false` in `apps/web/src/lib/forms.ts` is a Superforms option and stays. Hits in
   comments are cosmetic.
4. **`$lib` becomes `#lib`, with the file extension.** `#lib/*` is a subpath import, and those
   name the file: `#lib/api.js` for `api.ts`, `#lib/pwa.svelte.js` for `pwa.svelte.ts`, and
   `#lib/components/Foo.svelte` unchanged. This rewrites every quoted `$lib/...` specifier in your
   files (imports, `import()`, `vi.mock`) and picks the extension from the file on disk:

   ```sh
   bun run --cwd apps/web i18n:compile
   cd apps/web
   git grep -lz -F '$lib/' -- src | xargs -0 -r perl -pi -e 's{(["\x27])\$lib/([^"\x27]+)\1}{my ($q, $p) = ($1, $2); $p .= ".js" if !-f "src/lib/$p" && (-f "src/lib/$p.ts" || -f "src/lib/$p.js"); $p .= "/index.js" if -d "src/lib/$p"; "$q#lib/$p$q"}ge'
   cd ../..
   ```

   Only quoted specifiers change, commented-out imports included; prose in comments keeps its
   `$lib`. It skips two cases: a bare `'$lib'` (write `'#lib/index.js'` and add
   `"#lib": "./src/lib/index.js"` to `imports`), and `@import '$lib/...'` inside a `<style>` block
   (use a relative path).
5. **Everything else**, by hand:
   - `$app/environment` becomes `$app/env`, with the same exports: `browser`, `dev`, `building`,
     `version`.
   - `$env/dynamic/*` and `$env/static/*`: declare the variable in `apps/web/src/env.ts` (copy an
     entry, with `public: true` if the browser reads it), then import it by name from
     `$app/env/public` or `$app/env/private`. SvelteKit 3 gives the app nothing that is not
     declared there. A test that mocked `$env/dynamic/public` with `{ env: { ... } }` now mocks
     `$app/env/public` with the variable names themselves.
   - `$app/stores` is gone: use `$app/state`, read without the `$`.
   - `page.url` is read-only. Copy it before changing it (`new URL(page.url.href)`). Helpers can
     take `ReadonlyURL` from `$app/state`.
   - `goto` no longer takes `noScroll` or `keepFocus` (an error in development): pass
     `reset: false`.
   - `goto()` now rejects a path that no page matches; SvelteKit 2 loaded it in full instead. Pass
     paths you did not write yourself (a `?next=`, a stored link) through `routable()` from
     `#lib/utils/redirect.js`, as the sign-in pages do.
   - Still working but deprecated, with a warning in development: `invalidateAll()` (use
     `refreshAll()`, which keeps `page.state`), `goto`'s `replaceState` and `invalidateAll`
     options (`replace` and `refreshAll`), `pushState(url, state)` (use
     `goto(url, { shallow: true, state })`) and `replaceState(url, state)` (use
     `goto(url, { shallow: true, replace: true, state })`). Shallow navigations now run
     `beforeNavigate`/`onNavigate`/`afterNavigate`; check `navigation.shallow` where that matters
     (the kit's page-view tracking skips them).
   - `Handle`, `HandleFetch`, `HandleServerError`, `HandleClientError`, `ServerInit` and
     `sequence` now come from `@sveltejs/kit/hooks`. `handleError` receives every error with a
     `kind` (`'app'` for an `error(...)` you threw) and no `status`/`message`;
     `src/hooks.server.ts` shows the pattern. `event.request` is read-only.
   - If you edited the service worker: it is now `src/service-worker/index.ts`. `$service-worker`
     becomes `$app/manifest` (`immutable`, `assets`, `prerendered`), `version` comes from
     `$app/env`, and paths are built with `resolve` from `$app/paths`.
   - In `vite.config.ts`, the `KitConfig` type is now `Config` from `@sveltejs/kit/vite`.
   - Anything else your own code uses is in SvelteKit's
     [migration guide](https://svelte.dev/docs/kit/migrating-to-sveltekit-3), `base` and `assets`
     gone from `$app/paths` and external redirects that must be opted into among them. Its
     `sv migrate sveltekit-3` also rewrites the kit's own files, the `catalog:` versions in
     `apps/web/package.json` among them, so this page does not use it.
6. **Deployments.** adapter-node 6 ignores `ORIGIN`. The web server takes the origin from the
   `Host` header and assumes https. Remove `ORIGIN` from your own compose or env files. Behind a
   proxy that rewrites `Host` or serves plain http, set `HOST_HEADER` or `PROTOCOL_HEADER`
   (adapter-node docs).
7. **Check and commit.** Run `bun run lint:fix` (Biome now sorts `#lib` imports before `$app`
   ones), then `bun run --cwd apps/web check` and `bun run test`, and commit the result on the
   upgrade branch.

### Forged-request checks, `db:push` and JSON columns (1.0.0)

- **A client of your own that calls `/rpc` must send `x-csrf-token: orpc`** on every call, or the
  API answers `403`. Everything the kit ships builds its client with `createApiClient` from
  `@repo/api-client`, which sends it, so this concerns only a client you wrote against the RPC
  transport yourself. If you changed the CORS `allowHeaders` in `apps/api/src/app.ts`, keep
  `X-CSRF-Token` in the list when you resolve the merge, or browsers fail the preflight wherever
  the app and the API are on different origins.
- **A page of your own that writes to `/api/v1` with the session cookie** must be served from
  `WEB_URL` or an origin in `TRUSTED_ORIGINS`. From anywhere else its `POST`, `PUT`, `PATCH` and
  `DELETE` requests now answer `403 forbidden_origin`. Callers with a bearer or service token and
  no cookie are not affected.
- **`bun run db:push` no longer exists.** Replace it wherever you run it (a script, CI, your own
  notes) with `bun run db:generate` for a schema change and `bun run db:migrate` to apply it. A
  development database that `db:push` built has no migration history for `db:migrate` to continue
  from: drop it, create it empty, and run `bun run db:migrate`.
- **A JSON column of your own**, declared with drizzle-orm's `jsonb()` or `json()`, has stored every
  object as a JSON string, which reads back as an object but which SQL's `->>` cannot see into.
  `packages/db/src/jsonb.test.ts` now fails on it. Declare it with `jsonb` from `./jsonb` instead;
  for a `jsonb()` column `bun run db:generate` then finds nothing to change. That `jsonb` returns
  what Postgres stores, so every row written before the change reads as the JSON text it holds
  until a migration converts it: ship the new type and that migration in the same deploy, never
  one without the other. `bun run db:generate --custom --name=repair_my_json` creates an empty
  migration. For each such column it needs:

  ```sql
  UPDATE "my_table" SET "my_column" = ("my_column" #>> '{}')::jsonb
  WHERE jsonb_typeof("my_column") = 'string';
  ```

  It fails, and changes nothing, on a string that is not JSON jsonb can hold (one carrying
  `\u0000`, say); the same `WHERE` finds the rows to look at. Run it in that migration and nowhere
  else: after the deploy, a string in the column is one the new type wrote on purpose, and a second
  run would turn one such as `"42"` into the number 42.

## Moving to the full edition

This edition is generated from a larger kit by removing the tenant layer and everything built on
it. The full edition adds organizations, teams and workspaces, roles and invitations, an audit
log, Stripe billing per organization, S3-backed documents with storage quotas, a Postgres job
queue and its worker, and a FastAPI service for semantic search and OCR. It is one payment at
[starterdough.dev](https://starterdough.dev). You receive an invitation to the private repository
it is published from.

Moving across takes a remote of its own: `kit` already names this edition, and the full
edition's tags would overwrite its `kit/` ones. Add the full edition with `git remote add full`
and the address in your invitation, then file its tags under `full/`:

```sh
git config remote.full.tagOpt --no-tags
git config --add remote.full.fetch "+refs/tags/*:refs/tags/full/*"
git fetch full
```

Its releases are then `full/v1.0.0` and so on; read `full/` wherever this page says `kit/`. This
repository has its own public release history, so it shares no ancestor with the paid one: the
first merge needs `--allow-unrelated-histories` and reads as the whole tree. It is a real merge,
not the `-s ours` an archive takes, because your tree does not hold the full edition yet.
Cloning the paid edition and merging your work onto it is usually shorter than the reverse.

Your database moves too: the full edition's `bun run db:migrate` adopts a database this edition
migrated, along with your own migrations in `packages/db/drizzle-product`. Take a dump first. If a
table, index or function of yours has a name one of the full edition's migrations creates, it
names it and changes nothing, and this edition still migrates the database: rename yours first.
If a release before 1.1.0 generated your migrations into `packages/db/drizzle`, run
`bun run db:move-product-migrations --kit kit/v1.1.0` on this edition's 1.1.0 and commit before
you move across.

In the merge, keep your side of every product file both editions ship: each `product.ts`,
`product.json` and `packages/db/drizzle-product`. They carry no edition markers and are the same
in both, so your side holds everything the full edition's does, plus your own code. The full
edition's own product files arrive as new files.

## What we will not do to you

- **No silent schema changes.** Every schema change ships as a migration file in
  `packages/db/drizzle`, and the changelog says so.
- **No renamed environment variables without a note.** If a variable changes name, the changelog
  lists both.
- **No release changes a product file.** Your migrations in `packages/db/drizzle-product`, and
  every `product.ts`, `product-*.ts` and `product.json`, are yours from 1.1.0 on:
  [Where your code goes](apps/docs/src/content/docs/guides/product-files.md) lists them. A new
  extension point arrives as a new file. So are the site's `apps/site/src/content/changelog/` and
  `apps/site/src/content/blog/`, and your docs in `apps/docs/src/content/product/`: no release
  adds, changes or deletes a file there.
- **No new required paid service.** Anything that needs a key stays dormant without one, as
  Sentry and PostHog already do, and as email does in development. Email in production is the
  one exception, from 1.0.0: without a provider nobody can verify an address or reset a
  password, so the production API refuses to boot without one. Resend is the provider wired in;
  another goes in `packages/email`.

## When an upgrade goes wrong

You merged onto a branch, so you can walk away from it: `git merge --abort` while the merge is
still open, `git switch main`, and `git branch -D upgrade/v1.1.0` so the next attempt can create it
again.

If you renamed the kit, `kit-renamed` may also hold a snapshot `main` never took. If the
snapshot's commit never happened, because `bun install`, `lint:fix` or a hook failed after
`git restore`, the half-built snapshot is still in your working tree, and `git switch` would
either refuse to leave it or carry it onto `main`: run `git reset --hard` on `kit-renamed` first,
which throws away only that. Then, back on `main`,
`git branch -f kit-renamed "$(git merge-base main kit-renamed)"` points `kit-renamed` at the last
snapshot `main` took, and the next attempt builds the new one again. Running it twice changes
nothing.

The database is the one thing not on a branch: take a dump before step 3
(`docker compose run --rm backup bun src/cli.ts backup` on a self-hosted server, or `pg_dump` by
hand) and you can start the upgrade over.
