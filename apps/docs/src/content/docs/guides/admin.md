---
title: Admin
description: Platform administrators. Users, feature flags and system health, without a second app or a second auth system.
---

Platform administrators are **users whose `role` is `admin`**, a flag on the account itself.
The same role list drives Better Auth's `admin({ adminRoles })`, the API's `requireAdmin` middleware
and the `/admin` route guard (a universal `load` that redirects non-admins to `/app`).

## Bootstrap

```sh
ADMIN_PASSWORD='…' bun run admin:create -- --email you@example.com --name 'You'
# add --yes to promote an account that already exists
```

With `ADMIN_PASSWORD` unset the script prompts for a password. It is never read from the command
line, because arguments stay in shell history and are visible in `ps`. The script uses the kit's own
auth config and downloads no CLI, so it also runs inside the `api` container.

Promote further admins from `/admin/users`.

## `/admin/users`: people (Better Auth admin plugin)

Search, ban and unban with a reason and an optional expiry, set role, revoke sessions, impersonate.
These come from the Better Auth admin plugin at `/api/auth/admin/*`. Starterdough adds no procedures
for them.

Impersonation sessions last **one hour** and cannot target other admins. While one is active the
app shell shows a banner with **Stop impersonating**. Starting an impersonation and revoking a
user's sessions both ask for confirmation first, because neither can be undone.

## `/admin/flags`: feature flags

Flags live in `feature_flag`, one row per flag with its global default. Admins manage them
(`admin.flags.list | upsert | delete`). Clients read the resolved map from `system.flags`
(`GET /api/v1/flags`).

In the app, the `(app)` layout load fetches the flags once per session. Components read
`flag('key')` from `$lib/flags`. An unreachable API means "nothing is on".
Keys are stable slugs used literally in code: lowercase letters, numbers, dots, dashes and
underscores.

## `/admin/system`: health

`admin.system.status` reports the version (read from the root `package.json`), the environment and
runtime, uptime, counts (users, sessions), a database probe with migration state (journal shipped
in the build vs. `drizzle.__drizzle_migrations`), and which optional subsystems are configured:
the email provider and sender, social sign-in and email verification. Never secrets.

## Consequences to know

- Flag reads are one indexed query per page load with no caching. Add a short cache when flags are
  read on hot paths.
- Deleting users is not exposed in the UI.
