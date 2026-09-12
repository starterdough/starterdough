# @repo/docs

Product documentation for Starterdough. Astro 7 + Starlight, fully static. The content quotes
`README.md`, `docs/DECISIONS.md`, `infra/README.md` and the app READMEs. When those change, update
the page that quotes them.

## Develop

```sh
cp .env.example .env
bun run dev            # http://localhost:4322
bun run check          # astro check
bun run build          # dist/
bun run preview
```

## Environment

| Variable | Default | Used for |
| --- | --- | --- |
| `SITE_URL` | `http://localhost:4322` for `dev`/`check`; **required** for `build` | Canonical origin at build time, and the `Sitemap:` line of the generated `robots.txt`. A path is allowed and becomes the site's `base` (`https://example.com/docs` in the single-origin Caddy mode). `astro build` refuses an unset value and an `example.com` placeholder |
| `PUBLIC_API_URL` | `http://localhost:3000` | The interactive API reference loads `${PUBLIC_API_URL}/api/v1/openapi.json` in the browser. The API's `TRUSTED_ORIGINS` must include this site's origin |
| `DOCS_REPO_URL` | empty | Optional. The repository these docs are edited in. Adds the header's GitHub link and Starlight's "Edit this page". Unset, neither is rendered |

## Information architecture

Sidebar in `astro.config.mjs`; content in `src/content/docs/`.

| Section | Pages |
| --- | --- |
| Start | `start/quickstart.md`, `start/configuration.md` (every env var of the API, the web app and the sites) |
| Guides | one `guides/*.md` page per subsystem, in the order the sidebar in `astro.config.mjs` lists them |
| Reference | `reference/api.md` (RPC vs REST, every procedure with its route, errors and paging), `reference/commands.md`, `reference/architecture.md`, and the interactive **API reference** |

`index.mdx` is the splash page. `src/pages/robots.txt.ts` generates `robots.txt`, so its `Sitemap:`
line follows `SITE_URL` and the base.

The interactive API reference is a custom page, `src/pages/reference/api-reference.astro`, rendered
inside Starlight's `StarlightPage` component with `template: splash`. It loads Scalar from jsDelivr,
pinned to an exact version with a Subresource Integrity hash of that file (bump both together; the
recipe is in the file's comment), and points it at the API's OpenAPI document. Nothing is fetched
at build time. The page shows a fallback (a link to `reference/api.md` and to the raw document)
when the script errors or when nothing has mounted after a few seconds.

Starlight config: `title: 'Starterdough'`. The GitHub and "Edit this page" links appear only when
`DOCS_REPO_URL` is set.

## Deploy

```sh
bun run deploy:cloudflare    # astro build && wrangler deploy (Workers static assets, wrangler.jsonc)
```

Or serve `dist/`. `infra/docker/Dockerfile.static` builds it into Caddy for the self-hosted stack.
Set `SITE_URL` and `PUBLIC_API_URL` for the target environment before building. The build fails
without a real `SITE_URL`.
