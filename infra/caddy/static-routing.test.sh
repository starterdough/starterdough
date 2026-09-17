#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

if ! command -v docker >/dev/null || ! docker info >/dev/null 2>&1; then
	echo 'static routing: Docker with a running daemon is required' >&2
	exit 1
fi

caddy_image="${CADDY_IMAGE:-caddy:2-alpine}"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/starterdough-caddy-routing.XXXXXX")"
response_body="$fixture_root/response"
containers=()

cleanup() {
	for container in "${containers[@]}"; do
		docker rm -f "$container" >/dev/null 2>&1 || true
	done
	rm -rf "$fixture_root"
}
trap cleanup EXIT

mkdir -p "$fixture_root/site" "$fixture_root/docs/guides/example"
printf '%s\n' 'site index' >"$fixture_root/site/index.html"
printf '%s\n' 'site guide' >"$fixture_root/site/guide.html"
printf '%s\n' 'site custom 404' >"$fixture_root/site/404.html"
printf '%s\n' 'docs index' >"$fixture_root/docs/index.html"
printf '%s\n' 'docs guide' >"$fixture_root/docs/guide.html"
printf '%s\n' 'docs nested guide' >"$fixture_root/docs/guides/example/index.html"
printf '%s\n' 'docs custom 404' >"$fixture_root/docs/404.html"

published_port() {
	docker port "$1" "$2/tcp" | sed -E 's/.*:([0-9]+)$/\1/' | head -n 1
}

expect_response() {
	local expected_status="$1"
	local expected_body="$2"
	local url="$3"
	local resolve_host="${4:-}"
	local actual_status=''
	local curl_args=(-k --connect-timeout 2 --max-time 5 --silent --show-error --output "$response_body" --write-out '%{http_code}')

	if [ -n "$resolve_host" ]; then
		curl_args+=(--resolve "$resolve_host")
	fi
	for _ in {1..50}; do
		actual_status="$(curl "${curl_args[@]}" "$url" 2>/dev/null || true)"
		[ "$actual_status" = "$expected_status" ] && break
		sleep 0.1
	done

	if [ "$actual_status" != "$expected_status" ]; then
		echo "static routing: $url returned ${actual_status:-no status}, expected $expected_status" >&2
		return 1
	fi
	grep -qxF "$expected_body" "$response_body" || {
		echo "static routing: $url did not serve '$expected_body'" >&2
		return 1
	}
}

suffix="$$-$RANDOM"

subdomains="starterdough-routing-subdomains-$suffix"
containers+=("$subdomains")
docker run -d --name "$subdomains" -p 127.0.0.1::443 \
	-v "$PWD/infra/caddy/subdomains.Caddyfile:/etc/caddy/Caddyfile:ro" \
	-v "$fixture_root/site:/srv/site:ro" -v "$fixture_root/docs:/srv/docs:ro" \
	-e DOMAIN=localhost -e API_URL=https://api.localhost -e ACME_EMAIL= \
	"$caddy_image" >/dev/null
subdomains_port="$(published_port "$subdomains" 443)"
expect_response 200 'docs guide' "https://docs.localhost:$subdomains_port/guide" "docs.localhost:$subdomains_port:127.0.0.1"
expect_response 200 'docs nested guide' "https://docs.localhost:$subdomains_port/guides/example/" "docs.localhost:$subdomains_port:127.0.0.1"
expect_response 404 'docs custom 404' "https://docs.localhost:$subdomains_port/__missing__" "docs.localhost:$subdomains_port:127.0.0.1"
expect_response 404 'site custom 404' "https://localhost:$subdomains_port/__missing__" "localhost:$subdomains_port:127.0.0.1"

single_origin="starterdough-routing-single-$suffix"
containers+=("$single_origin")
docker run -d --name "$single_origin" -p 127.0.0.1::80 \
	-v "$PWD/infra/caddy/single-origin.Caddyfile:/etc/caddy/Caddyfile:ro" \
	-v "$fixture_root/docs:/srv/docs:ro" \
	-e API_URL=https://api.localhost \
	"$caddy_image" >/dev/null
single_origin_port="$(published_port "$single_origin" 80)"
expect_response 200 'docs guide' "http://127.0.0.1:$single_origin_port/docs/guide"
expect_response 200 'docs nested guide' "http://127.0.0.1:$single_origin_port/docs/guides/example/"
expect_response 404 'docs custom 404' "http://127.0.0.1:$single_origin_port/docs/__missing__"

demo_static="starterdough-routing-demo-$suffix"
containers+=("$demo_static")
docker run -d --name "$demo_static" -p 127.0.0.1::8080 -p 127.0.0.1::8081 \
	-v "$PWD/infra/demo/caddy/demo-static.Caddyfile:/etc/caddy/Caddyfile:ro" \
	-v "$fixture_root/site:/srv/site:ro" -v "$fixture_root/docs:/srv/docs:ro" \
	-e API_URL=https://app.demo.localhost \
	"$caddy_image" >/dev/null
demo_site_port="$(published_port "$demo_static" 8080)"
demo_docs_port="$(published_port "$demo_static" 8081)"
expect_response 404 'site custom 404' "http://127.0.0.1:$demo_site_port/__missing__"
expect_response 200 'docs guide' "http://127.0.0.1:$demo_docs_port/guide"
expect_response 200 'docs nested guide' "http://127.0.0.1:$demo_docs_port/guides/example/"
expect_response 404 'docs custom 404' "http://127.0.0.1:$demo_docs_port/__missing__"

echo 'static routing: custom pages preserve 404 status in every Caddy layout'
