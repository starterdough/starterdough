# Backups

Nightly `pg_dump` of the compose Postgres, plus a tarball of the uploads directory when the API
uses the local storage driver. Copies go to the `backups` volume and, when a bucket is configured,
to S3/R2. Old sets are pruned. A heartbeat URL is pinged after each complete run, and its `/fail`
endpoint is pinged when the uploads archive is known to be incomplete, so you hear about backups
that stop or lose files.

The tool is `@repo/backup`, Bun built-ins only (`Bun.spawn`, `Bun.S3Client`, `Bun.cron`,
`Bun.SQL`). The image is `oven/bun:1.4-alpine` plus Alpine's `postgresql17-client` package (and GNU
`tar`/`gzip`), so `pg_dump` matches the server major. Bump the client major in the Dockerfile's
`apk add` in the same commit as a Postgres upgrade. No `bun install` at runtime.

Logs are one JSON object per line: `info` on stdout, `warn` and `error` on stderr.

## Commands

```sh
# Compose (the usual path: profile `backup`, or COMPOSE_PROFILES=backup in .env)
docker compose run --rm backup bun src/cli.ts backup
docker compose run --rm backup bun src/cli.ts list                            # exit 1 = stale
docker compose run --rm backup bun src/cli.ts restore latest --drill
docker compose run --rm backup bun src/cli.ts restore latest --yes            # live, after `docker compose stop api worker`

# Uploads too: the service mounts /data/uploads read-only and that mount wins over a `run -v` on the
# same path, so mount the volume somewhere else and point STORAGE_DIR at it for the one-shot.
docker compose run --rm -v starterdough_uploads:/restore/uploads -e STORAGE_DIR=/restore/uploads \
  backup bun src/cli.ts restore <stamp> --yes --uploads

# The scheduled container (what `docker compose --profile backup up -d` starts)
# runs `bun src/cli.ts schedule` and exits cleanly on SIGTERM.
```

| Command | What |
| --- | --- |
| `backup` | take the lock, pre-flight, dump (`--format=custom --compress=6 --no-privileges`; ownership is dropped at restore time by `pg_restore --no-owner`), verify the archive, optional uploads tarball, row counts, manifest, upload **and verify the objects against the bucket**, prune, heartbeat |
| `list` | sets on disk and in the bucket, plus the pre-restore dumps nothing prunes. Freshness and `restore latest` use the newest set with both a dump and manifest on the same source (local directory or bucket); partial newer sets do not shadow an older complete set. **Exits 1 when the newest complete set is older than `--max-age` (default `BACKUP_MAX_AGE`, `36h`).** This is the command a monitor runs |
| `list --no-max-age` | list without the freshness check, so browsing a fresh box exits 0 |
| `restore <stamp\|latest> --drill` | restore into a uniquely named scratch database, compare its table list and row counts against the live database and manifest, extract and verify the uploads archive, then drop it |
| | The drill name includes a random suffix and does not drop a database before creating its own. A database left by an interrupted drill has a different name from the next run. |
| `restore <stamp\|latest> --yes` | restore into the live database (`--clean --if-exists --single-transaction --exit-on-error`). Refused without `--yes` |
| `restore … --uploads` | also restore the tarball into `STORAGE_DIR` (never by default). The archive is located, checksum-verified and fully extracted into staging on the uploads filesystem *before* `pg_restore`; see the one-shot command above for the writable mount |
| `restore … --database <name>` | target database (live) or base name of the drill database; defaults to the one in `DATABASE_URL` |
| `restore … --no-safety-dump` | skip the pre-restore dump (below). Only for a target you are certain you never want back |
| `restore … --force-database-mismatch` | restore even though the manifest says the dump came from another database. Without it a staging dump cannot be restored into production by accident |
| `restore … --no-manifest-check` | restore a set whose manifest is missing or unreadable. Nothing is then verified: not the checksum, not the source database |
| `restore … --no-single-transaction` | restore statement by statement. Only for a schema large enough to exhaust `max_locks_per_transaction`; a failure then leaves the database half-restored |
| `restore … --terminate-connections` | disconnect other sessions instead of refusing the restore |
| `schedule` | `Bun.cron(BACKUP_SCHEDULE, …, { tz: 'UTC' })` until SIGTERM. Prunes once at start, then on every tick. A tick that arrives while the previous backup is still running is skipped with a warning. With `BACKUP_CATCHUP` (default `true`) it also takes one backup at start when the newest set is older than one schedule interval |

Exit codes: `0` ok, `1` failure or refused, `2` usage. Durations (`--max-age`, `BACKUP_MAX_AGE`,
`BACKUP_LOCK_TIMEOUT`) are one number and one unit: `90s`, `45m`, `36h`, `2d`. A bare number is
rejected.


Artifacts: `starterdough_<YYYYMMDDTHHMMSSZ>.dump`, `.uploads.tar.gz` (local driver only), `.json`
(manifest: stamp, file sizes and SHA-256s, `pg_dump` version, the `TABLE DATA` entry count of the
dump, the row count of every `public` table at dump time, whether uploads were included and whether
the archive was incomplete, the source database and the warnings that were in force).

`<db>_<stamp>_pre_restore.dump` files are the pre-restore dumps described below. They sit outside
the artifact naming on purpose, so nothing prunes them, uploads them or lists them as a set. Delete
them yourself once you are sure the restore was the right one.

## What a run checks

- **One backup or restore at a time.** A run takes a Postgres session-level advisory lock on the
  target database (`pg_try_advisory_lock`, class `4475218`, key hashed from the database name) and
  refuses with exit 1 if another process holds it. Known ceiling: the lock lives in one pooled
  connection, so a Postgres restart releases it while the work continues. It prevents the accident,
  not a race.
- **Pre-flight, before `pg_dump`.** `BACKUP_DIR` exists and is writable; with the local storage
  driver `STORAGE_DIR` is a directory; there is free space on the backups filesystem (`df`, skipped
  on Windows; under 64 MiB fails the run, less than 1.5× the last dump warns); and, when a bucket
  is configured, **the credential is proved to work** by writing, `HEAD`-ing and deleting a tiny
  `<prefix>.preflight` object. A revoked key or a deleted bucket then fails in a second instead of
  after an hour of dumping. A denied *delete* is reported, not fatal: a write-only credential is the
  shape this bucket should have.
- **The archive is opened.** `pg_restore --list` runs against the finished dump while it is still
  the `.part` file. A `pg_dump` that exits 0 can still leave a file no `pg_restore` will read (a
  disk that filled up, a broken compression stream), and zero `TABLE DATA` entries means the
  archive holds no data at all. Either fails the run, the part file is removed, and the heartbeat
  stays silent. The entry count and the dump's SHA-256 go into the manifest.
- **Rows are counted.** `count(*)` on every `public` table (bounded by a 60 s `statement_timeout`
  per query) goes into the manifest, so a drill can assert that the data came back. The counts are
  taken just after the dump, not inside its snapshot, so a database still taking writes drifts by a
  few rows; a drill allows 5 %. Failing to count is a warning, not a failed backup.
- **A local backup does not pause writes.** The built-in schedule runs `pg_dump` while the app may be
  changing the database and uploads. PostgreSQL's dump is internally consistent, but the uploads
  archive is captured separately, so database references and files can reflect different moments.
  Use a coordinated host backup that quiesces the API/worker across both captures when that
  cross-resource consistency fence is required.
- **The off-box copy is verified against the bucket.** After each `put` the object is `HEAD`ed and
  the size the *bucket* reports is compared with the local file's. A mismatch deletes the bad
  object and retries once. A second mismatch fails the run, so the heartbeat stays silent and the
  local copy remains the good one.
- **A degraded uploads archive pages the monitor.** Tar exit code 1 keeps the useful database dump
  and readable upload files, and the manifest records why the archive is incomplete. The heartbeat
  goes to `<BACKUP_HEARTBEAT_URL>/fail` instead of the success URL for that set.
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

A live restore is destructive. Before `pg_restore --clean --if-exists` drops a single object:

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
   while anything else is connected. An API that keeps writing during `--clean --if-exists` ends up
   with rows pointing at objects that were dropped underneath it, and `--single-transaction` with
   `--clean` cannot take its locks while another session holds them. `--terminate-connections`
   disconnects them instead (they come back if their service is still running, so stop it).
5. With `--uploads`, the verified tarball is fully extracted into a unique hidden staging directory
   inside `STORAGE_DIR`. This consumes capacity on the actual uploads volume and catches corrupt
   data, insufficient space and extraction I/O errors before PostgreSQL changes.
6. The current contents of the target database are dumped to `<db>_<stamp>_pre_restore.dump` in
   `BACKUP_DIR`, and the path is logged with the `pg_restore` command that puts it back.
   `--no-safety-dump` skips this.

The restore itself runs `--single-transaction --exit-on-error` with
`PGOPTIONS='-c lock_timeout=<BACKUP_LOCK_TIMEOUT>'`, so it is all-or-nothing and cannot hang forever
on a lock. Two trade-offs to know:

- `--single-transaction` together with `--clean` requires the target to have **no** other open
  connections (hence the blocking check), and one transaction dropping and recreating every object
  in a large schema can exhaust `max_locks_per_transaction` (`ERROR: out of shared memory`). Raise
  `max_locks_per_transaction` first. `--no-single-transaction` is the fallback, and then a failure
  can leave the database half-restored, which is what the pre-restore dump is for.
- `--exit-on-error` is why the drill is worth anything. pg_restore's default is to log an error and
  carry on, so a restore whose data entries nearly all failed would still exit 0 with an identical
  table list. The drill also compares the restored row counts against the manifest's (5 %
  tolerance, and a table the manifest says has rows may not come back empty).

`--uploads` extracts into staging before the database restore, then promotes the staged files with
same-filesystem renames after PostgreSQL commits. Promotion **merges** into `STORAGE_DIR`: it
restores what the archive holds and leaves everything else alone. Documents deleted after the
backup was taken reappear, and documents added since survive. Nothing is deleted. For an exact copy
of the backup's state, empty `STORAGE_DIR` first. PostgreSQL and the filesystem still cannot commit
atomically. If promotion fails after PostgreSQL succeeds, the command exits 1, keeps the remaining
staged files, and reports both their path and the pre-restore safety dump so the operator can finish
or roll back. Interrupted staging directories are excluded from later upload archives.

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
#    With the local storage driver, the documents as well:
docker compose run --rm -v starterdough_uploads:/restore/uploads -e STORAGE_DIR=/restore/uploads \
  backup bun src/cli.ts restore <stamp> --yes --uploads

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
| `STORAGE_DIR` | empty | Local storage driver: archive this directory. Skipped when `S3_BUCKET` is set (objects already live in S3) or when unset. Set but missing (mount gone, typo) fails the run in the pre-flight, before `pg_dump`, so the heartbeat stays silent. |
| `BACKUP_S3_BUCKET` + `BACKUP_S3_ENDPOINT` / `BACKUP_S3_REGION` / `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY` | empty | Off-box copy. `BACKUP_S3_REGION` defaults to `auto`, which is only valid together with an endpoint (R2 and other S3-compatible services); with no endpoint a real AWS region is required. Key id and secret must be set together. |
| `BACKUP_S3_PREFIX` | `backups/` | Key prefix inside the bucket. One prefix per deployment; see below. |
| `BACKUP_HEARTBEAT_URL` | empty | `GET` after a complete backup; `GET <url>/fail` when a scheduled run fails or the uploads archive is known to be incomplete (10 s timeout, best effort, logged). Healthchecks.io, Uptime Kuma push and Better Stack heartbeats all accept a plain GET. |
| `S3_BUCKET` (and the other `S3_*`) | empty | Fallback: when `BACKUP_S3_BUCKET` is empty and the uploads bucket is set, copies go there under `BACKUP_S3_PREFIX`. |

With neither bucket, backups stay on the same box. The tool logs a warning. That is not a backup.

**With the S3 storage driver (`S3_BUCKET` set) the documents are not backed up at all.** A set then
covers the database only; the tool warns on every run. Turn on **object versioning** and a
**lifecycle rule** (expire noncurrent versions after, say, 30 days) on the uploads bucket, or an
overwritten or deleted document has no copy anywhere.

**One prefix per deployment.** Pruning deletes every artifact under `BACKUP_S3_PREFIX` that is past
retention, whichever machine wrote it, so two stacks sharing `bucket/backups/` prune each other's
sets and their stamps collide. Give each deployment its own prefix
(`BACKUP_S3_PREFIX=backups/prod/`, `backups/staging/`).

## Compose

`infra/compose.yml` service `backup`, profile `backup`. It mounts the `uploads` volume read-only
and the `backups` volume at `/backups`. The scheduled container is what `up -d` starts; `run --rm`
is for one-shots (backup, list, drill, restore).

A real restore writes to the live database. Stop the writers first (`docker compose stop api
worker`), restore, then start them again. The drill never touches the live database.

Restoring the uploads needs a writable mount, and
`docker compose run -v starterdough_uploads:/data/uploads` does **not** get one: Compose keeps the
service's `:ro` mode for that target path, even if the flag says `:rw`. Mount the volume at another
path for the one-shot and point `STORAGE_DIR` at it
(`-v starterdough_uploads:/restore/uploads -e STORAGE_DIR=/restore/uploads`, as in the commands
above; the compose project is `starterdough`, so the volume is `starterdough_uploads`). A plain
`docker run -v starterdough_uploads:/data/uploads …` is writable too, but then the network, `.env`
and the other service settings are yours to pass.

The database password never goes on the `pg_dump`/`pg_restore` command line. It is passed as
`PGPASSWORD`, and the URL on argv has it stripped.

Keep the production `.env` (or its SOPS copy) with the backups. A dump without `BETTER_AUTH_SECRET`
is not a restore.

## S3 / R2 / B2

Create a bucket and put its name and credentials in `BACKUP_S3_*` (or reuse the uploads bucket).
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
  do it. Never reuse the uploads bucket's credential.
- **A lifecycle rule for `AbortIncompleteMultipartUpload`** after 1 to 7 days. A dump interrupted
  mid-upload leaves parts that are invisible to `list` and billed indefinitely.
- **A separate prefix per deployment** (above), and a bucket that is not public in any way.

## Heartbeat

Point `BACKUP_HEARTBEAT_URL` at a Healthchecks.io check or an Uptime Kuma push monitor. When the
nightly run stops (container down, disk full, Postgres unreachable) the ping stops and you get
paged. A successful run pings the URL. A *failed* scheduled run pings `<url>/fail`, so the alert
arrives immediately instead of at the next missed ping. One-shot runs never ping `/fail`.

Leaving it unset is a warning at every run and at scheduler start: the backup then has no external
observer at all. Pair it with `list --max-age` (above) so a *stale* set is caught as well as a
missing run.
