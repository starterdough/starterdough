# Build from the repository root so the path matches the other images and the compose file:
#   docker build -f infra/backup/Dockerfile -t starterdough-backup .
#
# Bun's own Alpine image plus Alpine's PostgreSQL 17 client package: pg_dump/pg_restore match the
# postgres:17-alpine server major (pg_dump must not be older than the server), GNU tar and gzip
# from apk (`--no-overwrite-dir`, which the restore relies on, is not in busybox tar), and the
# image keeps the `bun` user (uid 1000, the same as the api image, so files on the shared uploads
# volume are readable). Building on postgres:17-alpine instead would drag in its data VOLUME and
# an entrypoint that starts a server when the first argument looks like a flag.
FROM oven/bun:1.4-alpine
# Unpinned on purpose (Alpine only keeps one build of each package), but the major must match the
# `postgres` service image: bump `postgresql17-client` here in the same commit as a Postgres upgrade.
RUN apk add --no-cache postgresql17-client tar gzip

WORKDIR /repo/infra/backup
# No `bun install`: the tool only uses Bun built-ins, so the sources are all it needs. Copied
# file by file so a developer checkout's local `backups/` never ends up inside the image.
COPY infra/backup/package.json infra/backup/tsconfig.json ./
COPY infra/backup/src ./src

# Compose mounts the backups volume at /backups and the uploads volume read-only at /data/uploads
# (a restore with --uploads is a one-shot `run` with a writable mount, see README.md).
# Both directories exist and belong to `bun`, so a fresh (empty) volume is writable right away.
RUN mkdir -p /backups /data/uploads && chown -R bun:bun /backups /data /repo
USER bun

ENV BACKUP_DIR=/backups
CMD ["bun", "src/cli.ts", "schedule"]
