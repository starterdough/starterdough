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
git switch -c kit-renamed kit/v1.0.0
bun run rename --name Acme --slug acme --identifier com.acme.desktop --scope @acme --write
bun install
bun run lint:fix
git commit -am "Starterdough v1.0.0, renamed to Acme"
git switch main
git merge kit-renamed
git push origin main kit-renamed
```

`bun install` records the renamed workspace packages in `bun.lock`, and `lint:fix` re-sorts the
imports and re-wraps the lines whose length the rename changed. The snapshot is then exactly what
your `main` will hold, and a fresh `main` fast-forwards to it. Push `kit-renamed` with `main`: the
next upgrade starts from it, on whichever machine runs it. `bun install` also installed the git
hooks, so this push runs `bun run verify` first. It needs no `.env` and no database.

Use exactly these arguments at every upgrade. A different `--slug` makes every slug line a
conflict again. If you forget them, they are in your own tree: the slug is `name` in the root
`package.json`, the name and identifier are `productName` and `identifier` in
`apps/native/src-tauri/tauri.conf.json`, and the scope begins every workspace package's name.

**Already renamed `main` another way?** If you ran `rename` on `main` itself, build the snapshot
of the release you started from with the arguments you used, and record it as merged without
changing a line. Only the merge differs from the commands above, and a `kit-renamed` branch left
over from an earlier version of this page has to go first: `git branch -D kit-renamed`.

```sh
git switch -c kit-renamed kit/v1.0.0
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
next, and the snapshot must hold only the release. A clone of your own repository that has never
had the `kit` remote, a teammate's or a second machine's, needs the four commands for a
downloaded archive above once.

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
2. **Diff `.env.example` against your `.env`.** New variables land there first.
   `git diff main -- .env.example` shows what this upgrade changed.
3. **Apply migrations.** Run `bun run db:migrate` against a copy of production first. The command
   exits 1 when a migration is still pending after the run. Drizzle skips a migration whose
   timestamp sorts before the newest applied one, which a merge can produce. Read the journal
   (`packages/db/drizzle/meta/_journal.json`), regenerate those migrations so they sort last, or
   apply them by hand. A migration may also fail on purpose instead of deleting rows to fit a new
   constraint. It names the offending key, and its header comment carries the query that finds
   the duplicates.
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

## Release by release

Some releases ask for more than the steps above: a change to your own code, a setting, a command
to run once. Each has a section here, named after the release that brought it. Work through it
after step 1, once the merge is committed, and before step 4, which checks it. Commit what it
changes on the upgrade branch: step 6 merges commits, not your working tree. Skipping releases?
Work through the sections of every release you skip, oldest first.

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
migrated. Take a dump first.

## What we will not do to you

- **No silent schema changes.** Every schema change ships as a migration file in
  `packages/db/drizzle`, and the changelog says so.
- **No renamed environment variables without a note.** If a variable changes name, the changelog
  lists both.
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
