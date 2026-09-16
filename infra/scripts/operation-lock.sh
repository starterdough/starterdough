#!/usr/bin/env bash
# Source this file, then call acquire_operation_lock. A parent may pass the lock on FD 8; the
# inode check prevents an environment flag from pretending that an unrelated descriptor is it.

operation_lock_path() {
	printf '%s\n' "${STARTERDOUGH_STATE_DIR:-${HOME}/.local/state/starterdough}/operations.lock"
}

acquire_operation_lock() {
	local state_dir lock_path recovery=false
	case "${1:-}" in '') ;; --deployment-recovery) recovery=true ;; *) return 1 ;; esac
	state_dir="${STARTERDOUGH_STATE_DIR:-${HOME}/.local/state/starterdough}"
	lock_path="$state_dir/operations.lock"
	mkdir -p "$state_dir" || return 1
	chmod 700 "$state_dir" || return 1

	if [ "${STARTERDOUGH_OPERATION_LOCK_HELD:-}" = 1 ] && python3 - "$lock_path" <<'PY'
import os
import sys

try:
    inherited = os.fstat(8)
    lock = os.stat(sys.argv[1])
except OSError:
    raise SystemExit(1)
raise SystemExit(0 if (inherited.st_dev, inherited.st_ino) == (lock.st_dev, lock.st_ino) else 1)
PY
	then
		flock -n 8 || return
	else
		exec 8>"$lock_path" || return 1
		if [ "${STARTERDOUGH_OPERATION_LOCK_WAIT_SECONDS:-0}" = 0 ]; then
			flock -n 8 || return
		else
			[[ "$STARTERDOUGH_OPERATION_LOCK_WAIT_SECONDS" =~ ^[0-9]+$ ]] || return 1
			flock -w "$STARTERDOUGH_OPERATION_LOCK_WAIT_SECONDS" 8 || return
		fi
		export STARTERDOUGH_OPERATION_LOCK_HELD=1
	fi
	if [ "$recovery" = false ] && { [ -e "$state_dir/deployment-interrupted" ] || [ -L "$state_dir/deployment-interrupted" ]; }; then
		echo 'deployment recovery is pending; run recover-deployment.sh recover from the recorded checkout' >&2
		return 1
	fi
}
