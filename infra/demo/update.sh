#!/usr/bin/env bash
# Move the public demo onto the build production is running: check out that commit, rebuild the two
# static sites for the demo's own origins, pull the images and restart. Run it from the demo clone:
#
#   bash infra/demo/update.sh                                            # whatever .env already pins
#   IMAGE_TAG=sha-abc1234 GIT_REF=abc1234 bash infra/demo/update.sh      # a specific build
#
# .github/workflows/deploy.yml runs exactly this over SSH after every production deploy, with the
# tag and commit it just deployed, when the repository variable DEMO_PATH names the demo clone.
# That is what keeps the demo showing the version the site sells; without it the demo stays on
# whatever it was last given and drifts away from the product it is supposed to be advertising.
#
# It touches nothing of production's: not the drop-in site blocks, not the production clone, not
# production's .env or containers. And it is not a reset: the database, the volume and whatever
# visitors have signed up with are left exactly as they are (infra/demo/reset.sh does that job, on
# a timer). What visitors do lose is their session, when demo-api and demo-web restart.
#
# Idempotent: a second run checks out the same commit, hits the build cache, pulls nothing new and
# recreates nothing.
set -euo pipefail
cd "$(dirname "$0")/../.."

refuse() {
	echo "demo update: $*" >&2
	echo "demo update: nothing was changed" >&2
	exit 1
}

# Identity first, before the checkout below moves anything. reset.sh runs the same two checks (and a
# third against the running container, because it is about to drop a database); here they are enough,
# since nothing this script does is destructive, and they must pass while the stack may still be down.
[ -f .env ] || refuse "no .env in $(pwd)"
project="$( (docker compose config 2>/dev/null || true) | sed -n 's/^name: //p' | head -n 1)"
[ "$project" = starterdough-demo ] || refuse "the compose project here is '${project:-none}', not starterdough-demo"
docker compose config --services | grep -qx demo-api || refuse "no demo-api service in this compose project"

# The compose file and the migrations have to match the images, exactly as on production
# (infra/scripts/deploy.sh). Detached, because this clone tracks whatever production was given, not
# a branch of its own.
if [ -n "${GIT_REF:-}" ]; then
	echo "▸ checking out $GIT_REF"
	git fetch --quiet origin
	git checkout --quiet --detach "$GIT_REF"
fi

# Same contract as deploy.sh: the tag passed in wins, otherwise whatever .env pins, and the result is
# written back so a later plain `docker compose up -d` here keeps running this build.
if [ -z "${IMAGE_TAG:-}" ]; then
	IMAGE_TAG="$(grep -E '^IMAGE_TAG=' .env | cut -d= -f2- || true)"
fi
export IMAGE_TAG="${IMAGE_TAG:-latest}"
if grep -qE '^IMAGE_TAG=' .env; then
	sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=$IMAGE_TAG|" .env
else
	printf 'IMAGE_TAG=%s\n' "$IMAGE_TAG" >>.env
fi
# And the registry, so a fork never edits that row by hand: the workflow passes its own GHCR namespace.
if [ -n "${IMAGE_REGISTRY:-}" ]; then
	export IMAGE_REGISTRY
	if grep -qE '^IMAGE_REGISTRY=' .env; then
		sed -i "s|^IMAGE_REGISTRY=.*|IMAGE_REGISTRY=$IMAGE_REGISTRY|" .env
	else
		printf 'IMAGE_REGISTRY=%s\n' "$IMAGE_REGISTRY" >>.env
	fi
fi
registry="${IMAGE_REGISTRY:-$(grep -E '^IMAGE_REGISTRY=' .env | cut -d= -f2- || true)}"
if [ -z "$registry" ]; then
	# Without one the compose defaults resolve to the local namespace and the pull below fails with
	# docker's own "pull access denied", which says nothing about what to set.
	refuse "no IMAGE_REGISTRY in $(pwd)/.env; set it to the namespace CI pushes to (ghcr.io/<owner>/<repo>, lowercase)"
fi

# The one image that cannot be production's: Dockerfile.static compiles SITE_URL, DOCS_URL,
# PUBLIC_APP_URL and PUBLIC_API_URL into every page, so production's `caddy` image would serve the
# demo a site whose every link points at production. A cache hit unless apps/site, apps/docs,
# packages/ or the lockfile changed, and minutes when they did.
echo "▸ building demo-static (IMAGE_TAG=$IMAGE_TAG)"
docker compose build demo-static

# demo-static has no `image:`, so a build-only service is skipped here rather than failing the pull.
echo "▸ pulling the images production runs ($registry, IMAGE_TAG=$IMAGE_TAG)"
if ! docker compose pull --quiet; then
	# Nearly always the GHCR login. deploy.yml logs this box in with the workflow's own token, which
	# is revoked when that job ends, so a by-hand run hours later gets a bare "denied" from the
	# registry. That on its own is not fatal here: the demo runs the images production runs, and on
	# a shared box production has already pulled this exact tag. Trust that only for a
	# `sha-<commit>` tag, which names one immutable build, so a local copy cannot be some other
	# build wearing the same name the way `latest` or `main` could be.
	echo "  pull failed; checking whether this box already has every image for $IMAGE_TAG"
	usable=1
	case "$IMAGE_TAG" in
	sha-*) ;;
	*)
		usable=0
		echo "  $IMAGE_TAG is not a sha-<commit> tag, so a local copy of it proves nothing"
		;;
	esac
	# Includes demo-static under its generated name, which the build above has just produced.
	for image in $(docker compose config --images); do
		docker image inspect "$image" >/dev/null 2>&1 || { usable=0; echo "  not on this box: $image"; }
	done
	if [ "$usable" != 1 ]; then
		echo "✗ cannot pull, and what is here is not enough to run this build." >&2
		echo "  Give the box a login of its own, with a PAT that has read:packages:" >&2
		echo "    docker login ghcr.io -u <github-user> --password-stdin" >&2
		echo "  Set that PAT as the GHCR_PULL_TOKEN secret and every deploy leaves behind a login that" >&2
		echo "  does not expire with the job (.github/workflows/deploy.yml)." >&2
		exit 1
	fi
	echo "✓ every image for $IMAGE_TAG is already on this box; carrying on with those"
fi

# --wait returns once every service is healthy and `migrate` has completed, so a bad build fails here.
echo "▸ starting"
docker compose up -d --remove-orphans --wait --wait-timeout 300

echo "▸ readiness (database reachable through the demo API)"
docker compose exec -T demo-api bun -e \
	"fetch('http://127.0.0.1:3000/readyz').then(async (r) => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1); })"

# Previous builds stay pullable in the registry; drop the local copies. The demo shares the box's
# docker with production, so this is the same prune deploy.sh already runs.
docker image prune -f >/dev/null

docker compose ps
echo "✓ demo updated to $IMAGE_TAG"
