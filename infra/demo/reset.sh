#!/usr/bin/env bash
# Return the public demo to empty: drop its database, create it again, run the migrations, start
# the stack. Idempotent; run it by hand or from demo-reset.timer:
#
#   bash infra/demo/reset.sh
#
# It refuses to touch anything that is not the demo stack, and refusing means nothing happened:
# the compose project resolved from the current .env must be `starterdough-demo` with a `demo-api`
# service, and that service's container must run with PUBLIC_DEMO_MODE=true. Run from the
# production clone (project `starterdough`, service `api`) it stops at the first check, before any
# command that writes.
#
# Whoever is signed in when this fires loses that session and the account behind it: their next
# request answers 401, the app sends them to sign-in, and they sign up again into an empty account.
# The demo answers 502 through the production Caddy for the ~30 s demo-api is down.
set -euo pipefail
cd "$(dirname "$0")/../.."

refuse() {
	echo "demo reset: $*" >&2
	echo "demo reset: nothing was changed" >&2
	exit 1
}

[ -f .env ] || refuse "no .env in $(pwd)"

# The project name and the service list come from the compose file .env points at. A .env that
# does not even interpolate (production's, say) leaves the name empty, which refuses below.
project="$( (docker compose config 2>/dev/null || true) | sed -n 's/^name: //p' | head -n 1)"
[ "$project" = starterdough-demo ] || refuse "the compose project here is '${project:-none}', not starterdough-demo"
docker compose config --services | grep -qx demo-api || refuse "no demo-api service in this compose project"

# And the container that owns the database must be a demo, which its own environment says.
container="$(docker compose ps -a -q demo-api)"
[ -n "$container" ] || refuse "demo-api has no container; is the stack up? (docker compose up -d)"
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$container" | grep -qx 'PUBLIC_DEMO_MODE=true' ||
	refuse "the demo-api container does not run with PUBLIC_DEMO_MODE=true"

echo "▸ stopping demo-web and demo-api"
docker compose stop demo-web demo-api

echo "▸ dropping and recreating the database"
# WITH (FORCE) ends any session still connected; IF EXISTS lets a rerun finish what a failed run started.
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U starterdough -d postgres \
	-c 'DROP DATABASE IF EXISTS starterdough WITH (FORCE)' \
	-c 'CREATE DATABASE starterdough'

echo "▸ migrating and starting"
# `up` runs migrate again (every migration is pending on a fresh database), then demo-api and demo-web.
docker compose up -d --wait --wait-timeout 180
echo "✓ demo reset"
