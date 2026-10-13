#!/usr/bin/env bash
# Compares the server's clock with this runner's, after ssh-target.sh. Fails past 30 seconds: TOTP
# two-factor codes, which use 30-second steps, start failing there, and S3 request signatures past
# 15 minutes. `warn` reports the drift instead of failing, for a workflow that only reads.
#
#   bash .github/scripts/check-clock.sh [warn]
set -euo pipefail
before="$(date +%s)"
server="$(ssh target 'date +%s' </dev/null)"
after="$(date +%s)"
[[ "$server" =~ ^[0-9]{10}$ ]] || {
	echo "::error title=Server clock::The server did not report its time."
	exit 1
}
if ((server < before - 30 || server > after + 30)); then
	message="The server clock is $((server - after)) s off this runner's. Repair time synchronisation on the server (timedatectl, systemd-timesyncd or chrony) before deploying."
	if [ "${1:-}" = warn ]; then
		echo "::warning title=Server clock::$message"
		exit 0
	fi
	echo "::error title=Server clock::$message"
	exit 1
fi
echo "server clock within 30 s of the runner's"
