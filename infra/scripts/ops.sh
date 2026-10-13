#!/usr/bin/env bash
# What the ops workflows run on the server: Server status, Server logs, Server backup and Admin
# bootstrap (.github/workflows/). .github/scripts/run-ops.sh ships the runner's copy of this file
# over SSH on every run and starts it in the checkout, so it works against a checkout of any age.
#
#   ops.sh status <lines>                          read-only, no lock: containers, disk, memory and
#                                                  the last <lines> of the API's logs (0 = none)
#   ops.sh logs <service> <lines> [<since>]        read-only, no lock
#   ops.sh backup <backup|list|drill> <nightly|release>
#   ops.sh admin <email> <name> <yes|no>           yes promotes an existing account; no creates
#                                                  one, with the password in OPS_SECRET
#
# Before any command it checks that the checkout runs the Compose project the workflow expects
# (EXPECTED_PROJECT): a DEPLOY_PATH or DEMO_PATH that names another product's checkout must not
# back up, or create an administrator in, that product. Commands that change anything take the
# host operation lock deploys hold, and wait up to 10 minutes for it.
set -euo pipefail
# Nothing below may read the transport's stdin: `docker compose exec` would swallow it.
exec </dev/null

refuse() {
	echo "ops: $*" >&2
	exit 1
}

# The password is read once, here, and kept out of the environment of everything this starts.
secret="${OPS_SECRET:-}"
unset OPS_SECRET
state_dir="${STARTERDOUGH_STATE_DIR:-$HOME/.local/state/starterdough}"

command="${1:-}"
case "$command" in
status | logs | backup | admin) ;;
*) refuse "unknown command '$command'" ;;
esac

[ -f .env ] || refuse "no .env in $(pwd); does DEPLOY_PATH or DEMO_PATH name the checkout?"
[[ "${EXPECTED_PROJECT:-}" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || refuse "no expected Compose project"
project="$( (docker compose config 2>/dev/null || true) | sed -n 's/^name: //p' | head -n 1)"
[ "$project" = "$EXPECTED_PROJECT" ] ||
	refuse "this checkout runs Compose project '${project:-none}', not '$EXPECTED_PROJECT'; check DEPLOY_PATH / DEMO_PATH, or set the repository variable COMPOSE_PROJECT_NAME"

# Only services whose profiles are active, which is what is running.
services() {
	docker compose config --services
}

has_service() {
	grep -Fx -- "$1" <<<"$2" >/dev/null
}

pending() {
	[ -e "$state_dir/deployment-interrupted" ] || [ -L "$state_dir/deployment-interrupted" ]
}

hold_lock() {
	mkdir -p "$state_dir"
	chmod 700 "$state_dir"
	exec 8>"$state_dir/operations.lock"
	flock -w 600 8 || refuse "another operation has held the host lock for 10 minutes; run this again once it is done"
}

case "$command" in
status)
	lines="${2:-}"
	[[ "$lines" =~ ^[0-9]+$ ]] || refuse "status needs a number of log lines"
	echo "== $(uname -n) at $(date -u +%Y-%m-%dT%H:%M:%SZ): project $project in $(pwd) at $(git rev-parse --short HEAD 2>/dev/null || echo '?')"
	uptime
	if pending; then
		echo "== deployment journal: PENDING; run Recover deployment with action status"
	else
		echo "== deployment journal: none"
	fi
	echo "== containers"
	docker compose ps --all
	echo "== disk"
	df -h / "$(docker info --format '{{.DockerRootDir}}')"
	echo "== memory"
	free -m
	echo "== docker"
	docker system df
	echo "== SSH host key (DEPLOY_KNOWN_HOSTS must hold this key)"
	ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub || echo "no ed25519 host key"
	# 0 is what a public repository asks for: anyone can read its run logs, and these lines carry
	# client addresses, paths and ids.
	if [ "$lines" -gt 0 ]; then
		running="$(services)"
		for service in api worker demo-api; do
			has_service "$service" "$running" || continue
			echo "== last $lines lines of $service"
			docker compose logs --no-color --timestamps --tail "$lines" "$service"
		done
	fi
	;;
logs)
	service="${2:-}"
	lines="${3:-}"
	since="${4:-}"
	[[ "$lines" =~ ^[0-9]+$ ]] || refuse "logs needs a number of lines"
	running="$(services)"
	has_service "$service" "$running" ||
		refuse "no service '$service' in this checkout; it runs: $(tr '\n' ' ' <<<"$running")"
	since_args=()
	if [ -n "$since" ]; then
		[[ "$since" =~ ^[0-9][0-9A-Za-z:.+-]*$ ]] ||
			refuse "since must be a duration such as 30m or 2h, or a time such as 2026-10-21T09:00:00Z"
		since_args=(--since "$since")
	fi
	docker compose logs --no-color --timestamps --tail "$lines" ${since_args[@]+"${since_args[@]}"} "$service"
	;;
backup)
	case "${2:-}" in
	backup) args=(backup) ;;
	list) args=(list --no-max-age) ;;
	drill) args=(restore latest --drill) ;;
	*) refuse "unknown backup action '${2:-}'" ;;
	esac
	case "${3:-}" in
	nightly) ;;
	release) args+=(--release) ;;
	*) refuse "unknown backup set '${3:-}'" ;;
	esac
	hold_lock
	# --no-deps: Postgres is the running one. Starting a dependency could recreate it with a newer
	# checkout's image while that release is still being deployed or recovered.
	docker compose run --rm --no-deps -T backup bun src/cli.ts "${args[@]}"
	;;
admin)
	email="${2:-}"
	name="${3:-}"
	# create-admin reads its own flags from argv: a value starting with - could pass for one.
	[[ "$email" == [A-Za-z0-9]*@* ]] || refuse "'$email' is not an email address"
	[[ "$name" != -* ]] || refuse "a name cannot start with -"
	flags=()
	case "${4:-}" in
	yes)
		# A promotion reads no password: an address that has no account fails instead of becoming
		# a new administrator with the bootstrap password.
		flags=(--yes)
		secret=
		;;
	no) [ -n "$secret" ] || refuse "the ADMIN_BOOTSTRAP_PASSWORD secret is empty" ;;
	*) refuse "promote must be yes or no" ;;
	esac
	running="$(services)"
	api=
	for service in api demo-api; do
		if has_service "$service" "$running"; then
			api="$service"
			break
		fi
	done
	[ -n "$api" ] || refuse "no api or demo-api service in this checkout"
	hold_lock
	if pending; then
		refuse "a deployment is waiting for recovery; run Recover deployment first"
	fi
	# The password reaches create-admin's prompt on stdin: never a command line, which `ps` shows,
	# and never the container's environment. The empty ADMIN_PASSWORD makes it prompt even when
	# .env sets one.
	printf '%s\n' "$secret" | docker compose exec -T -e ADMIN_PASSWORD= "$api" \
		bun run admin:create -- --email "$email" --name "$name" ${flags[@]+"${flags[@]}"}
	;;
esac
echo "STARTERDOUGH_OPS_COMPLETE=$command"
