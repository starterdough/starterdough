---
title: Server access and break glass
description: One product per server, a way in that survives a lost CI key, what to do when a deploy fails, and how to share a box when you must.
---

The Deploy workflow and the ops workflows run a product without a shell on its server
([Operations](/guides/operations/#operate-without-a-shell)). This page is for the times they
cannot: a way in prepared before anything breaks, the failures that need it, and a second product
on the same box.

## One product per server

Give each product a server of its own. Two products on one box share more than its CPU:

- **Ports.** One Caddy owns 80 and 443 and terminates TLS for every host on the box, and each stack
  publishes its Postgres on a loopback port (`POSTGRES_PORT`).
- **One lock and one state directory per Linux user.** Deploys, deployment recovery, the ops
  workflows that change something and the demo's reset take one host lock, and the recovery journal
  lives in one directory (`~/.local/state/starterdough`). Two products under one user queue behind
  each other, and an interrupted deploy of one blocks every deploy of the other until it is
  recovered.
- **A noisy neighbour.** A migration, a backup or a burst of traffic on one takes memory, CPU and
  disk from the other. Compose caps the app containers, not Postgres.
- **One `docker` group.** A deploy user can start any container, which on that box is as good as
  root, so each product's deploy key reaches every other product's data.

A second small VPS costs less than the hours a shared box takes. The public demo is the one case
the kit itself puts next to production (`infra/README.md`, "A public demo"): its data is
disposable, and it shares production's user, lock and Caddy on purpose.

## Break glass, prepared at provisioning

CI's deploy key is not your way in. It lives in a repository secret, and you revoke it the moment
it leaks. Prepare a way in of your own before you need one:

1. **A hardware-backed key of your own**, made on a security key and added to root's
   `authorized_keys` before you run `provision.sh`, which gives the deploy user root's keys when it
   has none yet:

   ```sh
   ssh-keygen -t ed25519-sk -O resident -O verify-required -C break-glass
   ```

   `resident` keeps the key on the token, so `ssh-keygen -K` loads it on a new laptop, and
   `verify-required` asks for the token's PIN as well as a touch. Register a second token the same
   way and keep it somewhere else. `provision.sh` ends with this advice when root has no `sk-` key.
2. **The provider's rescue console**: its browser console (VNC or serial) and its rescue system.
   Try both once while nothing is wrong. They are the way in when SSH is down, the firewall shuts
   you out or the disk is full.
3. **The root password** that console asks for, in your password manager.
4. **One deploy key pair per product**, made for CI alone and authorized only for that product's
   deploy user. Never put your personal key in `DEPLOY_SSH_KEY`, and never one key in two
   repositories.
5. **Rotation without a gap.** Append the new public half to `/home/deploy/.ssh/authorized_keys`,
   replace the `DEPLOY_SSH_KEY` secret, run **Server status** to prove the new key works, then
   delete the old line. After a leak, delete the old line first.
6. **A pinned host key.** `DEPLOY_KNOWN_HOSTS` holds the server's SSH host key, and every workflow
   refuses a server that presents another one (`Host key verification failed`). A rebuilt box has a
   new key: compare `ssh-keyscan -t ed25519 <host> | ssh-keygen -lf -` with
   `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` run in the provider's console, and once they
   match, set the variable to the line `ssh-keyscan -t ed25519 <host>` prints. Keep one server's
   key in it: every key in the variable is trusted. Tailscale SSH (`tailscale up --ssh`) answers
   with a host key of its own, and `provision.sh` does not turn it on.

## When a deploy fails

Read the Deploy run's log first, then run **Server status** for production: it shows the containers
and whether a deployment journal is pending.

- **It failed before anything stopped**: the pull, a pre-deploy hook or the release backup.
  Production still runs the previous release and no journal exists. Fix the cause and run Deploy
  again. A release backup that gave up on the backup lock met a nightly backup that ran for more
  than 10 minutes: run Deploy again. With `DEMO_PATH` set, the demo has already moved to the new
  build.
- **It was interrupted**: the run was cancelled or timed out, SSH dropped, the box rebooted. Run
  **Recover deployment** with `status`, then `recover`. Before the forward-only phase it restarts
  the previous release's containers; once that phase is recorded, it finishes starting the new
  release instead.
- **A migration fails every time.** `recover` would only run it again, and the journal blocks every
  deploy, the fix included. Run **Recover deployment** with `abandon` and, in `confirm`, the first 7
  characters of the revision `status` printed. It drops the journal and starts nothing. Then deploy
  the fix, or the previous tag.
- **A migration ran and damaged data.** Restore the release set the deploy took just before it
  stopped the writers, which takes a shell on the box (below).

As the deploy user, in the checkout: stop the writers, find the set taken just before the deploy
that ran the migration (a later deploy's set already holds the damage), restore it, and drop the
journal if `status` shows one:

```sh
docker compose stop api
docker compose run --rm backup bun src/cli.ts list --release
docker compose run --rm backup bun src/cli.ts restore <stamp> --release --yes
bash infra/scripts/recover-deployment.sh abandon <first 7 characters of the revision>
```

Then deploy the previous tag (Actions → Deploy → Run workflow, with `tag`), whose code matches the
restored schema. Whatever was written after the release backup is lost, the new release's traffic
included. The restore writes a dump of the database it replaces first, so it can itself be undone.
It leaves the database holding exactly what the set holds: the tables, types and functions the
migration created go too, so a release that runs that migration again applies it from the start.

A journal that a 1.0.0 deploy wrote is recovered by the 1.0.0 scripts in that checkout, which have
`recover` but no `abandon`. Dropping one takes a shell: check that
`bash infra/scripts/recover-deployment.sh status` prints `deployment_recovery_phase=forward-only`,
then delete `~/.local/state/starterdough/deployment-interrupted`, which is all `abandon` does.

## Sharing a box anyway

When a second product has to live on the same server, give it its own copy of everything the first
section lists. On the box, as root, and in the second product's repository:

1. **Its own Linux user**, so its own home, state directory and host lock. Run `provision.sh` again
   with a `DEPLOY_USER`, a `DEPLOY_PATH` and a `REPO_URL` of its own, and `EXPOSE=tailscale`. It
   leaves Docker, the firewall and the first checkout as they are, and writes the second
   checkout's `.env`.
2. **Its own checkout, `DEPLOY_PATH` and deploy key**, in its repository's variables and secrets.
   `DEPLOY_KNOWN_HOSTS` is the same host key in both.
3. **A Compose project of its own.** `bun run rename` sets the `name:` in `infra/compose.yml` to the
   product's slug, which keeps its containers and volumes apart from the first product's. Two
   products that kept the kit's name would both be `starterdough` and share volumes, and a deploy's
   project check could not tell them apart, so rename before you share a box.
4. **Free ports**, in its `.env`: `POSTGRES_PORT=5434`, with the same port in `DATABASE_URL`, and
   `CADDY_HTTP_PORT` and `CADDY_HTTPS_PORT` that nothing else on the box uses, such as `8081` and
   `8444`. `EXPOSE=tailscale` has already set `CADDY_MODE=single-origin` and
   `CADDY_BIND=127.0.0.1`: its Caddy serves plain HTTP on one origin, the app at `/`, the API
   under `/api` and `/rpc`, the docs under `/docs`, and no marketing site. Set its `WEB_URL` and
   `API_URL` to that origin, `https://acme.example.com`, and `DOCS_URL` to the same with `/docs`.
5. **The first product's Caddy in front of it.** Both join one Docker network: set
   `PROXY_NETWORK=box-proxy` in both `.env` files, run `docker network create box-proxy`, and add
   `infra/compose.proxy-network.yml` to the first product's `COMPOSE_FILE`. The second product
   joins under a name no other container on that network has, with an overlay of its own, say
   `infra/compose.box.yml`, added to its `COMPOSE_FILE`
   (`COMPOSE_FILE=infra/compose.yml:infra/compose.box.yml`):

   ```yaml
   services:
     caddy:
       networks:
         default:
         proxy:
           aliases: [acme-caddy]
     postgres:
       deploy:
         resources:
           limits:
             memory: 1g
   networks:
     proxy:
       external: true
       name: ${PROXY_NETWORK:?set PROXY_NETWORK in .env}
   ```

   The first product's Caddy then proxies the domain to it from a drop-in,
   `infra/caddy/conf.d/acme.caddy` in the first checkout, which you validate and reload as
   `infra/caddy/conf.d/README.md` says:

   ```text
   acme.example.com {
   	import security
   	import logs
   	reverse_proxy acme-caddy:80 {
   		import upstream
   		import resilient
   		health_uri /healthz
   	}
   }
   ```

6. **A memory cap on both Postgres containers**, `deploy.resources.limits.memory` as above. The
   first product needs an overlay of its own for it, with only the `postgres` part. Size both caps
   so that the two databases, the two stacks and the page cache fit the box.
7. **A bucket prefix of its own**: a distinct `BACKUP_S3_PREFIX` when both back up to one bucket.
