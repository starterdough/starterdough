# Security policy

## Reporting a vulnerability

Email **security@starterdough.dev** with what you found, how to reproduce it, and what an attacker
could do with it. If you can, include the affected file and line, the version you tested
(`package.json` → `version`, or the commit), and whether the default configuration is affected or
only a particular one.

Please do not open a public issue for a vulnerability, and please do not test against anyone
else's deployment of this kit.

What to expect:

- **Acknowledgement within 3 working days.** If you hear nothing, assume the mail did not arrive
  and send it again.
- **An assessment within 10 working days**, saying whether we consider it a vulnerability, at what
  severity, and when we intend to fix it.
- **Credit in the changelog** if you want it, and a note when the fix ships.

There is no bug-bounty programme.

## Supported versions

The kit is sold as a repository, so "supported" means we publish a fix that you merge. Only the
latest release gets security fixes. Merging a newer release is the same operation as merging a
fix (see [`UPGRADING.md`](UPGRADING.md)).

| Version | Security fixes |
| --- | --- |
| latest release | yes |
| anything older | no; merge the latest release |

Dependency advisories are separate: `bun audit --prod --audit-level=high` runs on every CI
build, so a vulnerable dependency fails the build.

## In scope

Anything in this repository that is wrong in its default configuration, or wrong in a configuration
the documentation tells a buyer to use:

- Authentication, session handling, and the bearer-token path used by the static and desktop
  builds.
- Authorization: any procedure reachable without the permission it declares, and any escalation
  to the admin role.
- Injection of any kind, unsafe deserialisation, or unsanitised interpolation into HTML, SQL,
  shell arguments or email.
- Secrets reaching somewhere they should not: a log line, a build artefact, a cached response, a
  client bundle, a container image layer.
- The infrastructure we ship: `infra/compose.yml`, both Caddyfiles, the Dockerfiles, the
  provisioning script, the deploy workflow, and the backup tool.

## Out of scope

- **Your deployment.** Weak secrets, an exposed database port, a stale image, a misconfigured
  Cloudflare account, an unpatched host. The runbook covers what to check.
- **Vulnerabilities in third-party dependencies.** Report those upstream. Tell us if we use one in
  a way that makes an upstream issue exploitable here, or if we are pinned to a version with a
  known advisory.
- **Missing hardening that is a documented decision**, such as the AI service having no
  authentication beyond `X-Service-Token` (it is never internet-facing) or the plaintext database
  dump (recorded in the backup tool's README).
- **Anything requiring a platform administrator's credentials.** An admin can impersonate users by
  design, and it is audited.
- Missing security headers with no demonstrated impact, automated-scanner output without a working
  proof, denial of service through sheer volume, social engineering, and physical attacks.

## If you deploy this kit

The security of your deployment depends on you. The operations runbook has the full list. The
short version: generate real secrets, keep Postgres off the public internet, put Caddy or another
TLS terminator in front, set `TRUST_PROXY` only behind a proxy you control, verify that backups
restore, and read `THIRD-PARTY.md` before you redistribute an artefact.
