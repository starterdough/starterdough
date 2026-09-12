#!/usr/bin/env bash
# One-time server setup for infra/compose.yml on Ubuntu 22.04 / 24.04 or Debian 12: Docker, Tailscale,
# a `deploy` user for CI, a firewall, unattended security updates, the repository clone and a .env
# with freshly generated secrets. Run as root on a new VPS:
#
#   curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/infra/scripts/provision.sh \
#     | sudo REPO_URL=https://github.com/<owner>/<repo>.git EXPOSE=tailscale bash
#
# The `curl | bash` bootstrap above reads the script over the *raw* URL, which needs a public
# repository. From a private fork, either download it with a token first
# (`curl -fsSL -H "Authorization: token <PAT>" https://raw.githubusercontent.com/… -o provision.sh`)
# or copy the file to the box, then run it with GIT_TOKEN set so the clone can authenticate.
#
# Variables (all optional):
#   REPO_URL     the repository to clone (default: the kit's)
#   GIT_TOKEN    a PAT / app token with read access, for a private fork. Used for the clone only,
#                through an in-memory `git -c http.extraheader`; it is never written to .git/config
#                or to .env, so later `git pull`s on the box need their own credentials.
#   DEPLOY_USER  user that owns the checkout and runs compose (default deploy)
#   DEPLOY_PATH  where the checkout lives (default /opt/starterdough)
#   EXPOSE       tailscale (default: nothing public; Caddy bound to loopback, reach it via
#                `tailscale serve`/`funnel`, CADDY_MODE=single-origin) or public (Caddy on 0.0.0.0,
#                ufw opens 80/443, CADDY_MODE=subdomains)
#   IMAGE_REGISTRY  where `docker compose pull` looks for images; derived from REPO_URL
#                (ghcr.io/<owner>/<repo>, lowercased) when it is a GitHub URL
#   TS_AUTHKEY   a Tailscale auth key for a non-interactive join; without it the login URL is printed
#
# Idempotent: rerun after fixing anything. It never touches an existing .env, and on an already-active
# firewall it re-applies the rules but leaves the default policies alone.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/starterdough/starterdough.git}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"
DEPLOY_PATH="${DEPLOY_PATH:-/opt/starterdough}"
EXPOSE="${EXPOSE:-tailscale}"

# ghcr.io/<owner>/<repo>, lowercased: GHCR namespaces are case-sensitive and always lowercase.
# Handles both clone URL shapes: https://github.com/Owner/Repo.git and git@github.com:Owner/Repo.git.
derive_image_registry() {
	case "$1" in
	*github.com*) ;;
	*) return 1 ;;
	esac
	local path="${1#*github.com}"
	path="${path#[:/]}"
	path="${path%.git}"
	path="${path%/}"
	[ -n "$path" ] || return 1
	printf 'ghcr.io/%s' "$path" | tr '[:upper:]' '[:lower:]'
}
IMAGE_REGISTRY="${IMAGE_REGISTRY:-$(derive_image_registry "$REPO_URL" || true)}"

if [ "$(id -u)" -ne 0 ]; then
	echo "run as root (sudo)" >&2
	exit 1
fi

echo "▸ base packages"
apt-get update -qq
# unzip: the Bun installer below needs it.
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl git ufw unattended-upgrades openssl unzip >/dev/null

echo "▸ docker"
if ! command -v docker >/dev/null 2>&1; then
	curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null

echo "▸ tailscale"
if ! command -v tailscale >/dev/null 2>&1; then
	curl -fsSL https://tailscale.com/install.sh | sh
fi
if ! tailscale status >/dev/null 2>&1; then
	# Interactive: prints a login URL and keeps going; `tailscale up` again later finishes the join.
	tailscale up ${TS_AUTHKEY:+--auth-key "$TS_AUTHKEY"} --timeout 30s || true
fi

echo "▸ deploy user ($DEPLOY_USER)"
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
	useradd --create-home --shell /bin/bash "$DEPLOY_USER"
fi
usermod -aG docker "$DEPLOY_USER"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
# Cloud images put your key on root; give the deploy user the same keys so CI (DEPLOY_SSH_KEY) and
# you can log in as it. Add the CI key pair's public half here too.
if [ ! -s "/home/$DEPLOY_USER/.ssh/authorized_keys" ] && [ -s /root/.ssh/authorized_keys ]; then
	install -m 600 -o "$DEPLOY_USER" -g "$DEPLOY_USER" /root/.ssh/authorized_keys "/home/$DEPLOY_USER/.ssh/authorized_keys"
fi

echo "▸ firewall (EXPOSE=$EXPOSE)"
# `ufw allow` is idempotent (it answers "Skipping adding existing rule"), so the rules are applied
# whether or not ufw is already up. Only the two `default` policies are conditional: rewriting them
# on an active firewall would silently undo a policy the owner changed by hand.
if ufw status | grep -q inactive; then
	ufw default deny incoming >/dev/null
	ufw default allow outgoing >/dev/null
else
	echo "  ufw already active — keeping its default policies, re-applying the rules"
fi
# Everything over the tailnet, including SSH.
ufw allow in on tailscale0 >/dev/null
# Public SSH stays open until the tailnet is confirmed working: `ufw delete allow 22/tcp` afterwards.
ufw allow 22/tcp >/dev/null
if [ "$EXPOSE" = public ]; then
	ufw allow 80/tcp >/dev/null
	ufw allow 443 >/dev/null # tcp + udp (HTTP/3)
fi
# Enabling an already-enabled ufw is a no-op; --force skips the "may disrupt SSH" prompt.
ufw --force enable >/dev/null

echo "▸ unattended security upgrades"
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null

echo "▸ repository → $DEPLOY_PATH"
if [ ! -d "$DEPLOY_PATH/.git" ]; then
	if [ -n "${GIT_TOKEN:-}" ]; then
		# `git -c` applies to this process only: unlike a token in the remote URL (or `git clone -c`)
		# it is not written into $DEPLOY_PATH/.git/config, so the token never lands on disk.
		git -c "http.extraheader=Authorization: Basic $(printf 'x-access-token:%s' "$GIT_TOKEN" | base64 -w0)" \
			clone --quiet "$REPO_URL" "$DEPLOY_PATH"
	else
		git clone --quiet "$REPO_URL" "$DEPLOY_PATH"
	fi
fi
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$DEPLOY_PATH"

# The documented admin bootstrap (`bun run admin:create`) and the db tooling run from this checkout,
# not from a container, so $DEPLOY_USER needs Bun. The installer only writes to ~/.bashrc, which a
# non-interactive shell skips, hence the explicit PATH line in ~/.profile (what `su - deploy` reads).
echo "▸ bun for $DEPLOY_USER"
if [ ! -x "/home/$DEPLOY_USER/.bun/bin/bun" ]; then
	sudo -u "$DEPLOY_USER" -H bash -c 'curl -fsSL https://bun.sh/install | bash' >/dev/null
fi
if ! grep -q '.bun/bin' "/home/$DEPLOY_USER/.profile" 2>/dev/null; then
	# shellcheck disable=SC2016  # $HOME must stay literal: it is expanded when the profile is read
	printf '\n# bun (infra/scripts/provision.sh)\nexport BUN_INSTALL="$HOME/.bun"\nexport PATH="$BUN_INSTALL/bin:$PATH"\n' \
		>>"/home/$DEPLOY_USER/.profile"
	chown "$DEPLOY_USER:$DEPLOY_USER" "/home/$DEPLOY_USER/.profile"
fi

# Docker publishes ports with its own iptables rules, bypassing ufw: a tailnet-only box must bind
# Caddy to loopback (where `tailscale serve` proxies to) or it is public whatever ufw says.
# DOMAIN stays empty in BOTH modes: a placeholder would have Caddy chase a Let's Encrypt certificate
# for a domain nobody owns, retrying forever while `docker compose ps` reports every container
# healthy. Empty falls back to `localhost` and Caddy's internal CA, and the message printed at the
# end says which row to fill in.
if [ "$EXPOSE" = public ]; then
	CADDY_BIND=0.0.0.0
	CADDY_MODE=subdomains
else
	CADDY_BIND=127.0.0.1
	CADDY_MODE=single-origin
fi
DOMAIN=

echo "▸ .env"
if [ ! -f "$DEPLOY_PATH/.env" ]; then
	cp "$DEPLOY_PATH/.env.example" "$DEPLOY_PATH/.env"
	# DATABASE_URL is what host tooling (admin:create, db:migrate) uses; compose builds its own from
	# POSTGRES_PASSWORD, and Postgres is published on 127.0.0.1:5433 by the shipped .env.
	POSTGRES_PASSWORD="$(openssl rand -hex 16)"
	sed -i \
		-e "s|^NODE_ENV=.*|NODE_ENV=production|" \
		-e "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=$(openssl rand -hex 32)|" \
		-e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$POSTGRES_PASSWORD|" \
		-e "s|^DATABASE_URL=.*|DATABASE_URL=postgres://starterdough:$POSTGRES_PASSWORD@127.0.0.1:5433/starterdough|" \
		-e "s|^SERVICE_TOKEN=.*|SERVICE_TOKEN=$(openssl rand -hex 24)|" \
		-e "s|^COMPOSE_PROFILES=.*|COMPOSE_PROFILES=backup|" \
		-e "s|^CADDY_BIND=.*|CADDY_BIND=$CADDY_BIND|" \
		-e "s|^CADDY_MODE=.*|CADDY_MODE=$CADDY_MODE|" \
		-e "s|^DOMAIN=.*|DOMAIN=$DOMAIN|" \
		"$DEPLOY_PATH/.env"
	# The images CI pushes live under the fork's own namespace, not the kit's.
	if [ -n "$IMAGE_REGISTRY" ]; then
		sed -i -e "s|^IMAGE_REGISTRY=.*|IMAGE_REGISTRY=$IMAGE_REGISTRY|" "$DEPLOY_PATH/.env"
	fi
	chown "$DEPLOY_USER:$DEPLOY_USER" "$DEPLOY_PATH/.env"
	chmod 600 "$DEPLOY_PATH/.env"
	echo "  wrote $DEPLOY_PATH/.env with generated BETTER_AUTH_SECRET, POSTGRES_PASSWORD (+ DATABASE_URL), SERVICE_TOKEN,"
	echo "  CADDY_BIND=$CADDY_BIND CADDY_MODE=$CADDY_MODE DOMAIN=${DOMAIN:-<empty>} IMAGE_REGISTRY=${IMAGE_REGISTRY:-<unchanged>}"
else
	echo "  keeping the existing $DEPLOY_PATH/.env"
fi

TS_HOST="$(tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -n1 || true)"
ORIGIN="https://${TS_HOST:-<host>.<tailnet>.ts.net}"

# The one thing this script cannot guess is the public origin, and nothing works until it is filled:
# print exactly the two (three, with the docs) lines the owner has to write, for the mode it just set.
if [ "$CADDY_MODE" = subdomains ]; then
	URLS="       DOMAIN=<your-domain>  COOKIE_DOMAIN=.<your-domain>
       WEB_URL=https://app.<your-domain>   API_URL=https://api.<your-domain>
       TRUSTED_ORIGINS=https://<your-domain>,https://docs.<your-domain>"
else
	URLS="       WEB_URL=$ORIGIN   API_URL=$ORIGIN   DOCS_URL=$ORIGIN/docs
       (leave DOMAIN and COOKIE_DOMAIN empty: one origin, no CORS, TLS terminated by Tailscale)"
fi

cat <<EOF

Done. Next, as $DEPLOY_USER (\`su - $DEPLOY_USER\`), in $DEPLOY_PATH:

  1. Fill in .env — CADDY_MODE=$CADDY_MODE is already set; these are still empty and required:
$URLS
     plus RESEND_API_KEY / EMAIL_FROM / CONTACT_EMAIL and a BACKUP_HEARTBEAT_URL.
  2. docker compose up -d --build            (or: docker login ghcr.io && docker compose pull && docker compose up -d
                                              — the pull path needs IMAGE_REGISTRY=${IMAGE_REGISTRY:-ghcr.io/<owner>/<repo>})
  3. tailnet only:  sudo tailscale serve --bg 80      (public without open ports: sudo tailscale funnel --bg 80)
  4. The first platform administrator, from this checkout (Bun is installed; .env already carries a
     DATABASE_URL for the compose Postgres on 127.0.0.1:5433):
     bun install
     bun run admin:create -- --email you@example.com --name 'You'
     (it prompts for the password; a password on argv would land in shell history and in ps.
      Set ADMIN_PASSWORD instead when you need it non-interactive.)
  5. docker compose run --rm backup bun src/cli.ts backup     — first backup, then the restore drill:
     docker compose run --rm backup bun src/cli.ts restore latest --drill
  6. CI deploys: set the DEPLOY_HOST variable and the DEPLOY_SSH_KEY secret (.github/workflows/deploy.yml).
EOF
