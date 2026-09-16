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
	git fetch --quiet origin
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

# Capture the old API before stopping it. The forward-only boundary is durable before Compose can
# run a migration, so recovery never revives code that may no longer match the database schema.
writers=(api)
deployment_begin starterdough "${writers[@]}"
deployment_stop_recorded
deployment_mark_forward_only

# --wait returns once every service is running and healthy (and one-shots like `migrate` have
# completed) or fails after the timeout, so a broken deploy fails here.
echo "▸ starting"
docker compose up -d --remove-orphans --wait --wait-timeout 180 --no-build --pull never

echo "▸ readiness (database reachable through the API)"
docker compose exec -T api bun -e \
	"fetch('http://127.0.0.1:3000/readyz').then(async (r) => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1); })"

# Images from previous deploys stay pullable in the registry; drop the local copies.
docker image prune -f >/dev/null

docker compose ps
deployment_complete api
echo "✓ deployed $IMAGE_TAG"
