#!/usr/bin/env bash
# `ssh target` for a job that operates the server: the deploy key, the server's pinned host key and
# one Host block. Every workflow that reaches the server runs this first.
#
#   bash .github/scripts/ssh-target.sh [--recovery]
#
# The host key is pinned (StrictHostKeyChecking yes). A GitHub-hosted runner starts every job with an
# empty known_hosts, so trust on first use (`accept-new`) would accept whatever key answers, on every
# run. DEPLOY_KNOWN_HOSTS holds the server's public host key, as provision.sh prints it, or the line
# `ssh-keyscan` prints. The host name in such a line is ignored and every key is filed under one
# alias, so DEPLOY_HOST may be an IP, a DNS name or a tailnet name. That also means every key in the
# variable is trusted for this server: keep one server's key in it, nothing else.
set -euo pipefail

fail() {
	echo "::error title=$1::$2"
	exit 1
}

# Recovery stays possible with deploys switched off: turning DEPLOY_ENABLED off is a reasonable first
# move in an incident, and it must not lock the owner out of the interrupted rollout.
if [ "${1:-}" != --recovery ]; then
	[ "${DEPLOY_ENABLED:-}" = true ] ||
		fail 'Deployment is switched off' 'Set the repository variable DEPLOY_ENABLED=true once the server is set up (infra/README.md, "Deploy, update, roll back").'
fi
[[ "${DEPLOY_HOST:-}" =~ ^[A-Za-z0-9][A-Za-z0-9.:-]*$ ]] ||
	fail 'No server' 'Set the repository variable DEPLOY_HOST to the server: a host name, an IP or a tailnet name.'
[[ "${DEPLOY_USER:-}" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] ||
	fail 'Bad DEPLOY_USER' "'${DEPLOY_USER:-}' is not a user name."
# Both paths are single-quoted into the scripts the workflows run on the server.
[[ "${DEPLOY_PATH:-}" =~ ^/[A-Za-z0-9._/-]+$ ]] ||
	fail 'No checkout path' 'Set the repository variable DEPLOY_PATH to the absolute path of the checkout on the server, as provision.sh printed it. It has no default.'
if [ -n "${DEMO_PATH:-}" ] && ! [[ "$DEMO_PATH" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
	fail 'Bad DEMO_PATH' 'The repository variable DEMO_PATH must be an absolute path of letters, digits and . _ - / only.'
fi
[ -n "${DEPLOY_SSH_KEY:-}" ] || fail 'No deploy key' 'Set the secret DEPLOY_SSH_KEY.'
[ -n "${DEPLOY_KNOWN_HOSTS:-}" ] ||
	fail 'No host key' 'Set the repository variable DEPLOY_KNOWN_HOSTS to the server SSH host key provision.sh printed, or to the line `ssh-keyscan -t ed25519 <host>` prints once its fingerprint matches the one on the server.'

umask 077
mkdir -p ~/.ssh
chmod 700 ~/.ssh
printf '%s\n' "$DEPLOY_SSH_KEY" >~/.ssh/deploy
# A value pasted from Windows carries CRs, which would end up inside the key. A line is a key when
# a field is an OpenSSH key type and the next one is a key's base64, so a host name that merely
# starts like a key type (`ssh-prod.example.com`, `sk-prod`) is not taken for one.
printf '%s\n' "$DEPLOY_KNOWN_HOSTS" | tr -d '\r' | awk '
	function is_type(field) {
		return field ~ /^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh[.]com)$/
	}
	function is_key(field) { return field ~ /^AAAA[A-Za-z0-9+\/]+=*$/ }
	NF == 0 || /^#/ { next }
	NF >= 2 && is_type($1) && is_key($2) { print "deploy-target", $1, $2; next }
	NF >= 3 && is_type($2) && is_key($3) { print "deploy-target", $2, $3; next }
	{ bad = 1 }
	END { exit bad }
' >~/.ssh/known_hosts_deploy && [ -s ~/.ssh/known_hosts_deploy ] ||
	fail 'Unreadable DEPLOY_KNOWN_HOSTS' 'Each line must be a public host key (ssh-ed25519 AAAA…) or a known_hosts line (host ssh-ed25519 AAAA…).'
cat >~/.ssh/config <<CONFIG
Host target
  HostName $DEPLOY_HOST
  User $DEPLOY_USER
  IdentityFile ~/.ssh/deploy
  IdentitiesOnly yes
  BatchMode yes
  HostKeyAlias deploy-target
  UserKnownHostsFile ~/.ssh/known_hosts_deploy
  StrictHostKeyChecking yes
  ConnectTimeout 15
  ServerAliveInterval 15
  ServerAliveCountMax 6
CONFIG
