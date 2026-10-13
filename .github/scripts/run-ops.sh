#!/usr/bin/env bash
# Runs infra/scripts/ops.sh on the server, in OPS_CHECKOUT, after ssh-target.sh. The ops workflows
# (server-status, server-logs, server-backup, admin-bootstrap) call it.
#
#   OPS_CHECKOUT=<path> OPS_COMPOSE_FILE=<infra/compose.yml|infra/demo/compose.yml> \
#     [COMPOSE_PROJECT=<name>] [OPS_SECRET=<one line>] bash .github/scripts/run-ops.sh <command> [args…]
#
# This runner's copy of ops.sh is shipped on every run, so it works against a server checkout of any
# age, 1.0.0 included. It travels over stdin into a private temporary file and runs from there with
# stdin closed: fed to `bash -s` instead, the first `docker compose exec` would swallow the rest of
# it. A secret, when there is one, is the first line of that same stream, so it never appears on a
# command line.
#
# ops.sh does nothing in a checkout that resolves to another Compose project than the one expected
# here: COMPOSE_PROJECT when the workflow passes it (production, from the repository variable
# COMPOSE_PROJECT_NAME), else the `name:` that OPS_COMPOSE_FILE has in this repository.
set -euo pipefail
cd "$(dirname "$0")/../.."

fail() {
	echo "::error title=$1::$2"
	exit 1
}

checkout="${OPS_CHECKOUT:-}"
# Single-quoted into the remote command below, like every argument.
[[ "$checkout" =~ ^/[A-Za-z0-9._/-]+$ ]] ||
	fail 'No checkout path' "'$checkout' is not an absolute path of letters, digits and . _ - / only."
case "${OPS_COMPOSE_FILE:-}" in
infra/compose.yml | infra/demo/compose.yml) ;;
*) fail 'No Compose file' "OPS_COMPOSE_FILE must be infra/compose.yml or infra/demo/compose.yml." ;;
esac
expected="${COMPOSE_PROJECT:-$(sed -n 's/^name: *//p' "$OPS_COMPOSE_FILE" | head -n 1)}"
[[ "$expected" =~ ^[a-z0-9][a-z0-9_-]*$ ]] ||
	fail 'No Compose project' "Cannot tell which Compose project to expect ('$expected'). Set the repository variable COMPOSE_PROJECT_NAME to the project the server's .env names."

command="${1:-}"
case "$command" in
status | logs | backup | admin) ;;
*) fail 'Unknown command' "'$command' is not an ops command." ;;
esac
args=
for arg in "$@"; do
	# Inputs are typed into a form: allow what an email, a name, a service or a time needs, and
	# nothing that could end the quotes around it.
	[[ "$arg" =~ ^[A-Za-z0-9@._+:\ -]*$ ]] ||
		fail 'Unsafe input' "'$arg' has a character other than letters, digits, spaces and @ . _ + : -"
	args="$args '$arg'"
done
secret="${OPS_SECRET:-}"
# The remote side reads one line: the rest of a longer secret would run as the start of the script.
[[ "$secret" != *$'\n'* && "$secret" != *$'\r'* ]] || fail 'Unusable secret' 'The secret must be one line.'

log="${RUNNER_TEMP:?}/ops-$command.log"
{
	printf '%s\n' "$secret"
	cat infra/scripts/ops.sh
} | ssh target "set -eu
	umask 077
	IFS= read -r OPS_SECRET
	export OPS_SECRET
	script=\$(mktemp \"\${TMPDIR:-/tmp}/ops.XXXXXX\")
	trap 'rm -f \"\$script\"' EXIT
	cat >\"\$script\"
	cd '$checkout'
	EXPECTED_PROJECT='$expected' bash \"\$script\"$args </dev/null" | tee "$log"
# A dropped connection can end the stream without an error: only ops.sh's last line proves it ran.
grep -Fxq "STARTERDOUGH_OPS_COMPLETE=$command" "$log"
