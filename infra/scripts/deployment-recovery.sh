#!/usr/bin/env bash
deployment_state_dir() { printf '%s\n' "${STARTERDOUGH_STATE_DIR:-${HOME}/.local/state/starterdough}"; }
deployment_journal_path() { printf '%s/deployment-interrupted\n' "$(deployment_state_dir)"; }
deployment_py() { python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deployment-recovery.py" "$@"; }
deployment_refuse_pending() {
	local journal
	journal="$(deployment_journal_path)"
	if [ -e "$journal" ] || [ -L "$journal" ]; then
		echo 'deployment recovery: interrupted deployment requires recover-deployment.sh recover' >&2
		return 1
	fi
}
deployment_begin() { deployment_py begin "$@"; }
deployment_stop_recorded() { deployment_py stop; }
deployment_mark_forward_only() { deployment_py forward; }
deployment_complete() { deployment_py complete "$1"; }
