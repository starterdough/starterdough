# Backups

Nightly `pg_dump` of the compose Postgres. Copies go to the `backups` volume and, when a bucket is
configured, to S3/R2. Old sets are pruned. A heartbeat URL is pinged after each complete run, so
you hear about backups that stop.

The tool is `@repo/backup`, Bun built-ins only (`Bun.spawn`, `Bun.S3Client`, `Bun.cron`,
`Bun.SQL`). The image is `oven/bun:1.4.2-alpine` plus Alpine's `postgresql17-client` package (and
GNU `tar`/`gzip`), so `pg_dump`, `pg_restore` and `psql` match the server major. Bump the client
major in the Dockerfile's `apk add` in the same commit as a Postgres upgrade. No `bun install` at
runtime.

Logs are one JSON object per line: `info` on stdout, `warn` and `error` on stderr.

## Commands

```sh
# Compose (the usual path: profile `backup`, or COMPOSE_PROFILES=backup in .env)
docker compose run --rm backup bun src/cli.ts backup
docker compose run --rm backup bun src/cli.ts list                            # exit 1 = stale
docker compose run --rm backup bun src/cli.ts restore latest --drill
docker compose run --rm backup bun src/cli.ts restore latest --yes            # live, after `docker compose stop api`

# The scheduled container (what `docker compose --profile backup up -d` starts)
# runs `bun src/cli.ts schedule` and exits cleanly on SIGTERM.
```

| Command | What |
| --- | --- |
| `backup` | take the lock, pre-flight, dump (`--format=custom --compress=6 --no-privileges`; ownership is dropped at restore time by `pg_restore --no-owner`), verify the archive, row counts, manifest, upload **and verify the objects against the bucket**, prune, heartbeat |
| `list` | sets on disk and in the bucket, plus the pre-restore dumps nothing prunes. Freshness and `restore latest` use the newest set with both a dump and manifest on the same source (local directory or bucket); partial newer sets do not shadow an older complete set. **Exits 1 when the newest complete set is older than `--max-age` (default `BACKUP_MAX_AGE`, `36h`).** This is the command a monitor runs |
| `list --no-max-age` | list without the freshness check, so browsing a fresh box exits 0 |
| `backup --release` | the restore point a deploy takes before it migrates: the database only, into `BACKUP_DIR/release`, never copied to the bucket, no heartbeat, the newest 4 sets kept. See [Release sets](#release-sets---release) |
| `list --release`, `restore … --release` | the same commands on the release sets |
| `restore <stamp\|latest> --drill` | restore into a uniquely named scratch database, compare its table list and row counts against the live database and manifest, then drop it |
| | The drill name includes a random suffix and does not drop a database before creating its own. A database left by an interrupted drill has a different name from the next run. |
| `restore <stamp\|latest> --yes` | restore into the live database: clear it, then run the set (`pg_restore --clean --if-exists --single-transaction --exit-on-error` into `psql`), all in one transaction. Refused without `--yes` |
| `restore … --database <name>` | target database (live) or base name of the drill database; defaults to the one in `DATABASE_URL` |
| `restore … --no-safety-dump` | skip the pre-restore dump (below). Only for a target you are certain you never want back |
| `restore … --force-database-mismatch` | restore even though the manifest says the dump came from another database. Without it a staging dump cannot be restored into production by accident |
| `restore … --no-manifest-check` | restore a set whose manifest is missing or unreadable. Nothing is then verified: not the checksum, not the source database |
| `restore … --no-single-transaction` | restore statement by statement. Only for a schema large enough to exhaust `max_locks_per_transaction`; a failure then leaves the database half-restored |
| `restore … --terminate-connections` | disconnect other sessions instead of refusing the restore |
| `schedule` | `Bun.cron(BACKUP_SCHEDULE, …, { tz: 'UTC' })` until SIGTERM. Prunes once at start, then on every tick. A tick that arrives while the previous backup is still running is skipped with a warning. With `BACKUP_CATCHUP` (default `true`) it also takes one backup at start when the newest set is older than one schedule interval. Each run waits up to 30 minutes for the lock (below) |

Exit codes: `0` ok, `1` failure or refused, `2` usage. Durations (`--max-age`, `BACKUP_MAX_AGE`,
`BACKUP_LOCK_TIMEOUT`) are one number and one unit: `90s`, `45m`, `36h`, `2d`. A bare number is
rejected.

Artifacts: `starterdough_<YYYYMMDDTHHMMSSZ>.dump` and `.json` (manifest: stamp, file sizes and
SHA-256s, `pg_dump` version, the `TABLE DATA` entry count of the dump, the row count of every
`public` table at dump time, the source database and the warnings that were in force).

`<db>_<stamp>_pre_restore.dump` files are the pre-restore dumps described below. They sit outside
the artifact naming on purpose, so nothing prunes them, uploads them or lists them as a set. Delete
them yourself once you are sure the restore was the right one.

## What a run checks

- **One backup or restore at a time.** A run takes a Postgres session-level advisory lock on the
  target database (`pg_try_advisory_lock`, class `4475218`, key hashed from the database name).
  A manual `backup` and every `restore` refuse with exit 1 if another process holds it. A scheduled
  backup waits up to 30 minutes for it and a release backup up to 10, trying again every 5 s, so a
  deploy and the nightly run that meet queue behind each other instead of failing or paging. Known
  ceiling: the lock lives in one pooled connection, so a Postgres restart releases it while the
  work continues. It prevents the accident, not a race.
- **Pre-flight, before `pg_dump`.** `BACKUP_DIR` exists and is writable; there is free space on the
  backups filesystem (`df`, skipped on Windows; under 64 MiB fails the run, less than 1.5× the last
  dump warns); and, when a bucket is configured, **the credential is proved to work** by writing,
  `HEAD`-ing and deleting a tiny `<prefix>.preflight` object. A revoked key or a deleted bucket then
  fails in a second instead of after an hour of dumping. A denied *delete* is reported, not fatal:
  a write-only credential is the shape this bucket should have.
- **The archive is opened.** `pg_restore --list` runs against the finished dump while it is still
  the `.part` file. A `pg_dump` that exits 0 can still leave a file no `pg_restore` will read (a
  disk that filled up, a broken compression stream), and zero `TABLE DATA` entries means the
  archive holds no data at all. Either fails the run, the part file is removed, and the heartbeat
  stays silent. The entry count and the dump's SHA-256 go into the manifest.
- **Rows are counted.** `count(*)` on every `public` table (bounded by a 60 s `statement_timeout`
  per query) goes into the manifest, so a drill can assert that the data came back. The counts are
  taken just after the dump, not inside its snapshot, so a database still taking writes drifts by a
  few rows; a drill allows 5 %. Failing to count is a warning, not a failed backup.
- **Nothing pauses writes.** The nightly run, a manual run and the release backup a deploy takes
  all dump while the app keeps running. `pg_dump` reads one consistent snapshot, taken as it
  starts, so writes made while it runs are in the next set, not this one. For a set with no write
  in flight, stop the writer first (`docker compose stop api`), take the backup, then
  `docker compose up -d`.
- **The off-box copy is verified against the bucket.** After each `put` the object is `HEAD`ed and
  the size the *bucket* reports is compared with the local file's. A mismatch deletes the bad
  object and retries once. A second mismatch fails the run, so the heartbeat stays silent and the
  local copy remains the good one.
- **Housekeeping runs either way.** Retention pruning and the sweep of stale `.part` files happen
  after every attempt and once when the scheduler starts, so a container that crash-loops or a
  schedule that never fires still gets tidied. The set just written is never a pruning candidate.
- **Retention has a floor.** `BACKUP_RETENTION_DAYS` never deletes the newest 3 *complete* sets (a
  dump plus its manifest), locally or in the bucket, however old they are. Age-only retention would
  empty the directory precisely when backups have stopped and the last good set is all you have.
- **A wrong clock cannot shadow `latest`.** A set stamped more than an hour in the future is never
  chosen by `restore latest`, never counts as evidence that a backup happened, and is flagged by
  `backup` and `list`. It is still restorable by its stamp, and becomes a `latest` candidate again
  once real time catches up.
- **Every spawned command has a ceiling.** `pg_dump`, `pg_restore` and `tar` are killed after
  `BACKUP_COMMAND_TIMEOUT_MINUTES` (default 6 h); the table-of-contents reads after 10 minutes.
  Bun's spawn has no default timeout, so without this a `pg_dump` waiting on a lock would keep the
  scheduler's overlap guard closed for weeks.

## Detecting a *stale* backup

A failed run is loud. A run that silently stops happening is not, and that is the failure that
loses data. Three things cover it, and none of them replaces the other two:

- `BACKUP_HEARTBEAT_URL`: an external monitor that pages when the ping stops. **Not setting it is
  warned about at every run and at scheduler start.** On-box logs nobody reads are not monitoring.
- `list` (or `list --max-age 12h`) exits **1** when the newest restorable set is older than the
  limit. Run it from cron or a container healthcheck; the exit code is the whole interface.
- `BACKUP_CATCHUP` (default `true`): `Bun.cron` has no catch-up, so a box that reboots at 03:00 with
  a `30 2 * * *` schedule would wait for the next night. At start the scheduler compares the newest
  set with one schedule interval and takes a backup now if it is older. `BACKUP_ON_START=true` is
  the stronger form that always runs one at start.

## Release sets (`--release`)

`backup --release` is the restore point a deploy needs before its migrations run.
`infra/scripts/deploy.sh` takes one under the deploy lock, after pulling the new images and before
it stops anything, so a failed backup leaves the running production release untouched.
`RELEASE_BACKUP=off` in `.env` turns it off (`infra/README.md`).

It is the same dump, archive check, manifest and drill as a nightly set, with four differences in
how it is taken:

- **The database only, in `BACKUP_DIR/release`** (`/backups/release` in the image). A migration
  changes the database and nothing else.
- **It stays on this machine,** even when a bucket is configured. It guards against a bad migration,
  not against losing the box, which the nightly off-site copy covers, and a bucket outage must not
  block a deploy.
- **No heartbeat.** A release set must not tell the nightly monitor that a backup ran.
- **The newest four are kept.** Retention is zero days plus the floor of three complete sets, so a
  run keeps the set it wrote and the three before it. Nothing else prunes them.

A release backup waits up to 10 minutes for the lock, so a deploy that lands during the nightly
run waits for that run to finish; the nightly run waits up to 30 minutes for a release backup in
the same way.
`pg_dump` gets a 30-minute ceiling (or `BACKUP_COMMAND_TIMEOUT_MINUTES`, if lower), so a stuck dump
fails the deploy instead of holding it. On a database with no tables yet, which is a first deploy
before `migrate` has run, it logs `release backup skipped: the database has no tables yet (first
deploy)` and exits 0.

```sh
docker compose run --rm backup bun src/cli.ts list --release
docker compose run --rm backup bun src/cli.ts restore latest --release --drill
```

A release set holds the schema from before its deploy's migrations, so its drill warns about the
tables the live database has gained since (`drill: the live database has tables this set
predates`) instead of failing on them as a nightly drill does. The tables in the set's manifest
must still all come back.

A live restore works as for a nightly set (writers stopped first, see [Compose](#compose)), with
`--release` added: `restore <stamp> --release --yes`. The set is taken online, so writes made while
`pg_dump` ran are not in it, and restoring it after the new release has served traffic loses
everything written since. The restore leaves the database holding exactly what the set holds: the
tables, types, functions and schemas the new migrations created go, and the migrations journal goes
back to before them, so a release that runs the same migrations again applies them as it did the
first time. `list --release` checks no freshness unless you pass `--max-age`: the age of a release
set only says when the last deploy was.

## Encryption at rest

**The dump is written unencrypted and every run says so.** `pg_dump --format=custom` is
compressed, not protected. Anyone who can read the `backups` volume or list the bucket can read
every row, including password hashes and session tokens.

The tool does not encrypt on purpose: that would mean a passphrase in the environment, a second
format for `pg_restore --list` and the drill to see through, and a key whose loss is
indistinguishable from losing the backup. Encrypt the layers underneath instead, where the key
management already exists:

- the host filesystem or volume holding `BACKUP_DIR` (LUKS, or the provider's volume encryption);
- server-side encryption on the bucket (SSE-S3/SSE-KMS on AWS, on by default on R2);
- for an air-gapped copy, encrypt the artifact yourself before moving it:
  `openssl enc -aes-256-cbc -pbkdf2 -salt -in starterdough_<stamp>.dump -out starterdough_<stamp>.dump.enc`
  and `openssl enc -d …` before restoring. The tool never sees the encrypted file, so `list`,
  retention and the drill do not apply to it.

## Restoring

A live restore is destructive. Before it drops a single object:

1. The set's **manifest is loaded and the dump's SHA-256 re-computed and compared**.
   `pg_restore --list` reads the table of contents and decompresses no data block, so a corrupt
   archive passes it; the checksum catches bit rot on the volume, a truncated download and an
   object a bucket mangled. A missing manifest refuses the restore (`--no-manifest-check`
   overrides). A checksum that does not match always refuses; restore a different set.
2. **`manifest.database` is compared with the target.** A dump from `staging` restored into
   `production` is one wrong stamp away, and the file name carries only a timestamp.
   `--force-database-mismatch` is the deliberate override.
3. The dump is opened with `pg_restore --list` as the cheap first check.
4. **Other sessions block the restore.** `pg_stat_activity` is checked and the restore *refuses*
   while anything else is connected. An API that keeps writing during the restore ends up with rows
   pointing at objects that were dropped underneath it, and the restore's one transaction cannot
   take its locks while another session holds them. `--terminate-connections`
   disconnects them instead (they come back if their service is still running, so stop it).
5. The current contents of the target database are dumped to `<db>_<stamp>_pre_restore.dump` in
   `BACKUP_DIR`, and the path is logged with the `pg_restore` command that puts it back.
   `--no-safety-dump` skips this.

The restore itself is `pg_restore --clean --if-exists --single-transaction --exit-on-error --file -`
piped into `psql` with `ON_ERROR_STOP`, under `PGOPTIONS='-c lock_timeout=<BACKUP_LOCK_TIMEOUT>'`.
psql first clears the database (every table, view, sequence, function and type of its own, and
every schema but `public` and an extension's; extensions themselves stay), then runs the set, in
one transaction that only the set's last statement commits. So it is all-or-nothing, cannot hang
forever on a lock, and ends with the database holding exactly what the set holds.

Clearing first is what lets a set restore over a database that has changed since it was taken.
`--clean` alone drops only what the set holds, without `CASCADE`, so the first newer object that
depends on one of them stops it: a table a migration added with a foreign key into a table the set
holds fails the `DROP CONSTRAINT` of that table's primary key, and the restore with it. Two
trade-offs to know:

- One transaction that clears and recreates everything requires the target to have **no** other
  open connections (hence the blocking check), and in a large schema it can exhaust
  `max_locks_per_transaction` (`ERROR: out of shared memory`). Raise `max_locks_per_transaction`
  first. `--no-single-transaction` is the fallback, and then a failure can leave the database
  half-restored, which is what the pre-restore dump is for.
- `--exit-on-error` is why the drill is worth anything. pg_restore's default is to log an error and
  carry on, so a restore whose data entries nearly all failed would still exit 0 with an identical
  table list. The drill also compares the restored row counts against the manifest's (5 %
  tolerance, and a table the manifest says has rows may not come back empty).

`restore latest` compares the newest complete set on disk with the newest complete set in the bucket
and takes the newer of the two (a tie goes to the local copy, which needs no download). It never
combines a local dump with a remote manifest. The chosen source is logged. An explicit stamp remains
available for recovery when a set is partial or future-dated.

### Bare-metal disaster recovery

New box, nothing but Docker and the repository:

```sh
git clone <repo> && cd starterdough
# 1. Put the production .env back (SOPS copy, password manager, wherever it lives).
#    A dump without BETTER_AUTH_SECRET is not a restore.
cp /secure/place/.env .env

# 2. Postgres alone first: nothing else may talk to it while it is being replaced.
docker compose up -d postgres

# 3. Put the backup set where the tool will find it: /backups is the `backups` volume, or set
#    BACKUP_S3_* in .env and the restore downloads the set from the bucket. --no-max-age because on
#    a recovery box the newest set is deliberately old and `list` would otherwise exit 1.
docker compose run --rm backup bun src/cli.ts list --no-max-age

# 4. Restore. `latest`, or the stamp you want.
docker compose run --rm backup bun src/cli.ts restore <stamp> --yes

# 5. Everything else, migrations included (`migrate` runs on every `up`).
docker compose up -d
```

`pg_dump` is a single-database dump, so two things are not in it:

- **The database itself.** Compose's `postgres` image creates `starterdough` on a fresh `pgdata`
  volume. Restoring into an existing cluster that has no `starterdough` database needs a
  `CREATE DATABASE starterdough` first.
- **Roles and their passwords** (`pg_dumpall --roles-only` would be needed). The compose stack
  creates the `starterdough` role from `POSTGRES_PASSWORD`, which is why the `.env` is part of the
  backup. `--no-owner --no-privileges` lets the objects land under whatever role connects.

## Variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | required | What to dump. Compose sets this to the postgres service. |
| `BACKUP_DIR` | `./backups` (`/backups` in the image) | Where artifacts land on disk. Checked for write access in the pre-flight. |
| `BACKUP_RETENTION_DAYS` | `14` | Sets older than this are pruned, on disk and in the bucket, except the newest 3 complete sets, which are never pruned. |
| `BACKUP_SCHEDULE` | `30 2 * * *` | Cron, UTC. |
| `BACKUP_ON_START` | `false` | `true` runs one backup as soon as `schedule` starts, unconditionally. Useful on a new box and for testing the whole path once. |
| `BACKUP_CATCHUP` | `true` | At `schedule` start, run one backup when the newest set is older than one schedule interval. `Bun.cron` has no catch-up, so a reboot past the scheduled time would otherwise skip the night in silence. |
| `BACKUP_MAX_AGE` | `36h` | `list` exits 1 when the newest restorable set is older than this. A day and a half: one missed nightly run is a warning, two are an outage. `--max-age` overrides it per run. |
| `BACKUP_COMMAND_TIMEOUT_MINUTES` | `360` | Ceiling on `pg_dump`, `pg_restore` and `tar`. Raise it if a real dump takes longer than 6 h. |
| `BACKUP_LOCK_TIMEOUT` | `60s` | `lock_timeout` for a restore session (`PGOPTIONS`), so a live restore fails instead of waiting forever for a leftover reader's lock. |
| `BACKUP_S3_BUCKET` + `BACKUP_S3_ENDPOINT` / `BACKUP_S3_REGION` / `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY` | empty | Off-box copy. `BACKUP_S3_REGION` defaults to `auto`, which is only valid together with an endpoint (R2 and other S3-compatible services); with no endpoint a real AWS region is required. Key id and secret must be set together. |
| `BACKUP_S3_PREFIX` | `backups/` | Key prefix inside the bucket. One prefix per deployment; see below. |
| `BACKUP_HEARTBEAT_URL` | empty | `GET` after a complete backup; `GET <url>/fail` when a scheduled run fails (10 s timeout, best effort, logged). Healthchecks.io, Uptime Kuma push and Better Stack heartbeats all accept a plain GET. |

Without `BACKUP_S3_BUCKET`, backups stay on the same box. The tool logs a warning. That is not a
backup.

**One prefix per deployment.** Pruning deletes every artifact under `BACKUP_S3_PREFIX` that is past
retention, whichever machine wrote it, so two stacks sharing `bucket/backups/` prune each other's
sets and their stamps collide. Give each deployment its own prefix
(`BACKUP_S3_PREFIX=backups/prod/`, `backups/staging/`).

## Compose

`infra/compose.yml` service `backup`, profile `backup`. It mounts the `backups` volume at
`/backups`. The scheduled container is what `up -d` starts; `run --rm` is for one-shots (backup,
list, drill, restore).

A real restore writes to the live database. Stop the writer first (`docker compose stop api`),
restore, then start it again. The drill never touches the live database.

The database password never goes on the `pg_dump`/`pg_restore` command line. It is passed as
`PGPASSWORD`, and the URL on argv has it stripped.

Keep the production `.env` (or its SOPS copy) with the backups. A dump without `BETTER_AUTH_SECRET`
is not a restore.

## S3 / R2 / B2

Create a bucket and put its name and credentials in `BACKUP_S3_*`.
The bucket and valid credentials must already exist; configure its name, endpoint or AWS region,
access key ID and secret access key in the environment. Do not put credential values in
documentation or logs.
For Cloudflare R2 the endpoint is `https://<account-id>.r2.cloudflarestorage.com` and the region is
`auto`. CORS is not involved: this is a server-side copy, not a browser upload.

For Backblaze B2, use the bucket's S3 endpoint and region with the dedicated `BACKUP_S3_*`
settings. The tool prunes by object key without a version ID. B2 treats that operation as a
delete marker: old versions continue occupying storage until removed. Configure a lifecycle rule
for hidden/noncurrent versions under the deployment's backup prefix, with a recovery interval
chosen for your retention policy. Keep current versions under the tool's retention policy so its
newest-three-set floor still applies. Verify a real upload, download and restore with your account;
S3 API compatibility alone is not an integration test. See
[B2 deletion behavior](https://www.backblaze.com/apidocs/s3-delete-object) and
[B2 lifecycle rules](https://www.backblaze.com/docs/cloud-storage-lifecycle-rules).

### The backup bucket holds a credential that can delete every off-site copy

Retention pruning means the key in `BACKUP_S3_*` has `DeleteObject`. On a compromised box that key
deletes the backups before the data. Configure the bucket so it cannot:

- **Object versioning on**, so a delete or overwrite leaves the previous version recoverable. Keep
  noncurrent versions for at least `BACKUP_RETENTION_DAYS` (R2: bucket versioning; AWS: versioning
  plus a noncurrent-version expiry rule).
- **Object Lock / immutability in compliance mode** for the retention window, if the provider
  offers it (AWS S3 Object Lock; R2 has no equivalent yet). Then no key and no root account can
  shorten it.
- **A separate write-only credential for this bucket.** Give the backup box `PutObject` and
  `GetObject`/`HeadObject` only (the pre-flight probe needs `HEAD`, and it treats a denied delete as
  a warning, not a failure) and run retention pruning from somewhere else, or let a lifecycle rule
  do it.
- **A lifecycle rule for `AbortIncompleteMultipartUpload`** after 1 to 7 days. A dump interrupted
  mid-upload leaves parts that are invisible to `list` and billed indefinitely.
- **A separate prefix per deployment** (above), and a bucket that is not public in any way.

## Heartbeat

Point `BACKUP_HEARTBEAT_URL` at a Healthchecks.io check or an Uptime Kuma push monitor. When the
nightly run stops (container down, disk full, Postgres unreachable) the ping stops and you get
paged. A successful run pings the URL. A *failed* scheduled run pings `<url>/fail`, so the alert
arrives immediately instead of at the next missed ping. One-shot runs never ping `/fail`, and a
release backup (`--release`) pings neither URL.

Leaving it unset is a warning at every run and at scheduler start: the backup then has no external
observer at all. Pair it with `list --max-age` (above) so a *stale* set is caught as well as a
missing run.
