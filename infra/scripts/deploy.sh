#!/usr/bin/env bash
# Deploy (or roll back) the compose stack on the server: check out a commit, pull that commit's
# images, restart what changed, wait for health, and prove the API can reach the database.
# This is what .github/workflows/deploy.yml runs over SSH; it is just as valid by hand:
#
#   bash infra/scripts/deploy.sh                                 # current checkout, IMAGE_TAG from .env
#   IMAGE_TAG=sha-abc1234 GIT_REF=abc1234 bash infra/scripts/deploy.sh   # a specific build (rollback)
#   IMAGE_TAG=latest BUILD=1 bash infra/scripts/deploy.sh        # build the images here instead of pulling
#
# IMAGE_TAG and IMAGE_REGISTRY are written back into .env, so a later plain `docker compose up -d`
# keeps running the same build from the same registry.
#
# Profiles must live in .env (`COMPOSE_PROFILES=backup,worker`), never only on the command line:
# `up --remove-orphans` below deletes the containers of every service whose profile is not active in
# *this* invocation, so `docker compose --profile backup up -d` followed by this script would remove
# the backup scheduler.
#
# Before it stops anything it runs the product's pre-deploy hooks and takes a release backup, a
# database-only restore point for this release's migrations (RELEASE_BACKUP=off skips it). After
# the new release is ready it keeps the three newest local builds of each image and runs the
# post-deploy hooks (infra/scripts/hooks/README.md).
#
# Run from anywhere; it cds to the repository root. Requires a filled-in .env (infra/README.md).
set -euo pipefail
cd "$(dirname "$0")/../.."

# A deployment and its recovery must share one host-wide lock. The Actions workflow may hand
# the descriptor down as FD 8; acquire_operation_lock validates that it is the real lock.
source infra/scripts/operation-lock.sh
STARTERDOUGH_OPERATION_LOCK_WAIT_SECONDS="${STARTERDOUGH_OPERATION_LOCK_WAIT_SECONDS:-1800}"
export STARTERDOUGH_OPERATION_LOCK_WAIT_SECONDS
acquire_operation_lock || {
	echo "another production operation is already running" >&2
	exit 1
}
source infra/scripts/deployment-recovery.sh
deployment_refuse_pending || exit 1

if [ -n "${GIT_REF:-}" ]; then
	echo "▸ checking out $GIT_REF"
	# The Deploy workflow pushes every release it deploys into this checkout, so rolling back to one
	# of those needs no fetch, and no credential for a private repository on this box. A branch name,
	# or a commit this checkout has never seen, still comes from origin.
	case "$GIT_REF" in
	*[!0-9a-f]*) git fetch --quiet origin ;;
	*) git cat-file -e "$GIT_REF^{commit}" 2>/dev/null || git fetch --quiet origin ;;
	esac
	for path in infra/scripts/operation-lock.sh infra/scripts/deployment-recovery.py infra/scripts/deployment-recovery.sh infra/scripts/recover-deployment.sh; do
		git cat-file -e "$GIT_REF:$path" || {
			echo "ref $GIT_REF predates deployment recovery safeguards" >&2
			exit 1
		}
	done
	# Consume the full source: grep -q may close early and turn a healthy git stream into SIGPIPE
	# under pipefail. These checks keep a rollback from replacing the loaded helper files.
	git show "$GIT_REF:infra/scripts/deploy.sh" | grep -F 'deployment-recovery.sh' >/dev/null || {
		echo "ref $GIT_REF predates deployment recovery safeguards" >&2
		exit 1
	}
	git checkout --quiet --detach "$GIT_REF"
fi

if [ ! -f .env ]; then
	echo "no .env in $(pwd) — copy .env.example, fill it in (infra/README.md), then rerun" >&2
	exit 1
fi

# The tag passed in wins; otherwise whatever .env pins; otherwise `latest`.
if [ -z "${IMAGE_TAG:-}" ]; then
	IMAGE_TAG="$(grep -E '^IMAGE_TAG=' .env | cut -d= -f2- || true)"
fi
export IMAGE_TAG="${IMAGE_TAG:-latest}"
# Pin it in .env too, so a later `docker compose up -d` by hand keeps running this build (a rollback
# would otherwise silently revert to whatever .env still named, usually the broken `latest`).
if grep -qE '^IMAGE_TAG=' .env; then
	sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=$IMAGE_TAG|" .env
else
	printf 'IMAGE_TAG=%s\n' "$IMAGE_TAG" >>.env
fi

# Same for the registry: the workflow passes its own GHCR namespace (a fork's, not the kit's), and
# pinning it keeps a later `docker compose pull` by hand looking in the same place. Unset = whatever
# .env already names.
if [ -n "${IMAGE_REGISTRY:-}" ]; then
	export IMAGE_REGISTRY
	if grep -qE '^IMAGE_REGISTRY=' .env; then
		sed -i "s|^IMAGE_REGISTRY=.*|IMAGE_REGISTRY=$IMAGE_REGISTRY|" .env
	else
		printf 'IMAGE_REGISTRY=%s\n' "$IMAGE_REGISTRY" >>.env
	fi
fi

if [ "${BUILD:-0}" = 1 ]; then
	echo "▸ building images (IMAGE_TAG=$IMAGE_TAG)"
	docker compose build --pull
else
	# Without a registry the compose `image:` defaults resolve to the local namespace
	# (`starterdough/api:<tag>`), so a pull would fail with docker's own "pull access denied", which
	# says nothing about what to set. BUILD=1 needs no registry at all.
	registry="${IMAGE_REGISTRY:-$(grep -E '^IMAGE_REGISTRY=' .env | cut -d= -f2- || true)}"
	if [ -z "$registry" ]; then
		echo "no IMAGE_REGISTRY in $(pwd)/.env — set it to YOUR fork's namespace" >&2
		echo "(ghcr.io/<owner>/<repo>, lowercase; .github/workflows/deploy.yml pushes there and passes" >&2
		echo "it to this script), or build on this box instead: BUILD=1 bash infra/scripts/deploy.sh" >&2
		exit 1
	fi
	echo "▸ pulling images ($registry, IMAGE_TAG=$IMAGE_TAG)"
	docker compose pull --quiet
fi

# The product's own hooks: every infra/scripts/hooks/<stage>.d/*.sh, in name order, from the
# repository root, under this deploy's host lock (FD 8), with stdin closed.
run_hooks() {
	local stage="$1" hook revision
	revision="$(git rev-parse HEAD)"
	for hook in infra/scripts/hooks/"$stage".d/*.sh; do
		[ -f "$hook" ] || continue
		echo "▸ $stage hook ${hook##*/}"
		IMAGE_TAG="$IMAGE_TAG" DEPLOY_REVISION="$revision" bash "$hook" </dev/null || {
			echo "$stage hook ${hook##*/} failed" >&2
			return 1
		}
	done
}

# Nothing has been stopped yet, so a failing hook leaves production on its current release.
run_hooks pre-deploy

# The restore point for this release's migrations, which are forward-only. It is taken online, last
# before the writers stop, so it misses only what they write while it runs, and a failure stops the
# deploy here with production untouched. RELEASE_BACKUP=off, in the environment or in .env, skips it.
release_backup="${RELEASE_BACKUP:-$(grep -E '^RELEASE_BACKUP=' .env | cut -d= -f2- || true)}"
case "${release_backup:-on}" in
on)
	# Named, because the backup profile may be inactive: `config --services` lists only active
	# profiles, while a service named on the command line resolves whatever COMPOSE_PROFILES says,
	# as it does for the pull and the run below.
	docker compose config --format json backup 2>/dev/null |
		python3 -c 'import json, sys; sys.exit("backup" not in json.load(sys.stdin)["services"])' 2>/dev/null || {
		echo "RELEASE_BACKUP is on, but this stack defines no backup service; set RELEASE_BACKUP=off in .env to deploy without a restore point" >&2
		exit 1
	}
	echo "▸ release backup (the database, before any migration)"
	if [ "${BUILD:-0}" = 1 ]; then
		docker compose build backup
	else
		docker compose pull --quiet backup
	fi
	# --no-recreate: a running Postgres keeps its container even when this release changes its
	# image (the `up` below replaces it once the writers have stopped); a first deploy creates it.
	docker compose up -d --no-recreate --wait --wait-timeout 180 postgres
	docker compose run --rm --no-deps -T backup bun src/cli.ts backup --release </dev/null
	;;
off) echo "⚠ RELEASE_BACKUP=off: no restore point before this release's migrations" >&2 ;;
*)
	echo "RELEASE_BACKUP must be on or off, not '$release_backup'" >&2
	exit 1
	;;
esac

# Capture the old API before stopping it. The forward-only boundary is durable before Compose can
# run a migration, so recovery never revives code that may no longer match the database schema.
writers=(api)
deployment_begin stack "${writers[@]}"
deployment_stop_recorded
deployment_mark_forward_only

# --wait returns once every service is running and healthy (and one-shots like `migrate` have
# completed) or fails after the timeout, so a broken deploy fails here.
echo "▸ starting"
docker compose up -d --remove-orphans --wait --wait-timeout 180 --no-build --pull never

echo "▸ readiness (database reachable through the API)"
docker compose exec -T api bun -e \
	"fetch('http://127.0.0.1:3000/readyz').then(async (r) => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1); })"

docker compose ps
deployment_complete api

# Keep the three newest local builds of each image, so a rollback to a recent release needs no
# pull, and drop the rest. `docker image rm` refuses an image a container still uses (the demo's,
# say), which is the point. The release is live by now, so nothing here may fail the deploy.
namespace="${IMAGE_REGISTRY:-$(grep -E '^IMAGE_REGISTRY=' .env | cut -d= -f2- || true)}"
{
	docker image ls --format '{{.Repository}}\t{{.Tag}}' --filter "reference=${namespace:-starterdough}/*" |
		awk -F '\t' '$2 != "<none>" && ++seen[$1] > 3 { print $1 ":" $2 }' |
		while read -r image; do docker image rm "$image" >/dev/null 2>&1 || true; done
	docker image prune -f >/dev/null
} || true

run_hooks post-deploy || {
	echo "deployed $IMAGE_TAG, but a post-deploy hook failed" >&2
	exit 1
}
echo "✓ deployed $IMAGE_TAG"
