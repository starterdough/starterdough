#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source infra/scripts/operation-lock.sh
source infra/scripts/deployment-recovery.sh
STARTERDOUGH_OPERATION_LOCK_WAIT_SECONDS=0
acquire_operation_lock --deployment-recovery || { echo 'deployment recovery: another production operation is running' >&2; exit 1; }
case "${1:-status}" in status|recover) deployment_py "${1:-status}" ;; *) echo 'usage: recover-deployment.sh [status|recover]' >&2; exit 1 ;; esac
