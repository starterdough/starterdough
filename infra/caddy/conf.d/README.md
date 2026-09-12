# Caddy drop-ins

Both Caddyfiles end with `import /etc/caddy/conf.d/*.caddy`, and `compose.yml` mounts this
directory there. Every `*.caddy` file you put here is read as part of the Caddyfile, after the
shipped snippets and site blocks, so it can hold extra site blocks for other things on the same
box (another compose project, a static site, a redirect) and reuse the snippets: `import security`,
`import logs`, `import upstream`, `import resilient`.

The directory ships empty. Caddy logs `No files matching import glob pattern` as a warning while it
stays that way; that is expected. `*.caddy` is ignored by git here because a drop-in is deployment
configuration, like `.env`; `git add -f` one you want versioned.

After adding or changing a file:

```sh
docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
```

To reach the containers of another compose project by name, add `compose.proxy-network.yml` to
`COMPOSE_FILE` (its header says how). The public demo in `infra/README.md` is the worked example.
