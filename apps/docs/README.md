# @repo/docs

Documentation for Starterdough. Astro 7 + Starlight, fully static. It holds two content sets, and
a build serves one of them:

- **Your product's documentation** (`src/content/product/`), the default: a splash page, a getting
  started guide and the interactive API reference. This is what every deploy publishes. The kit
  wrote it once, in 1.1.0, and never changes it in an upgrade, so rewrite it for your users.
- **The kit's developer manual** (`src/content/docs/`), built only with `DOCS_CONTENT=kit`. It
  documents the kit, not your product. Its pages quote `README.md`, `docs/DECISIONS.md`,
  `infra/README.md` and the app READMEs; when those change, update the page that quotes them.

`content-set.mjs` reads `DOCS_CONTENT`, and both `astro.config.mjs` (title, sidebar) and
`src/content.config.ts` (the folder the `docs` collection loads) take the set from it.

## Develop

```sh
cp .env.example .env   # `bun run setup` at the repository root writes this and every other .env
bun run dev            # your product's docs on http://localhost:4322
bun run dev:manual     # the kit's manual on the same port (`bun run dev:manual` from the root too)
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
| `DOCS_CONTENT` | `product` | The content set: `product` (also when unset or blank) or `kit`, the manual. Anything else fails the build. Set it in the build environment only (`dev:manual`, a CI step, the `DOCS_CONTENT` build arg of `Dockerfile.static`), never in `.env`: every row of `.env` reaches the build, so `kit` there would make every local build and every `deploy:cloudflare` publish the manual |

## Information architecture

**Your product's docs** (`src/content/product/`): `index.mdx` is the splash page and
`guides/getting-started.md` the first guide. The sidebar lists every page under `guides/` and
`reference/` by itself, after a link to the interactive API reference, so a new page needs no edit
to `astro.config.mjs`; order pages with `sidebar.order` in their frontmatter. A prose page about
your API goes in `reference/api.md`, and the interactive reference links to it once it exists.
Starlight config: `title: 'Starterdough'`, which `bun run rename` rewrites.

**The kit's manual** (`src/content/docs/`), with the sidebar `kitSidebar` in `astro.config.mjs`:

| Section | Pages |
| --- | --- |
| Start | `start/quickstart.md`, `start/configuration.md` (every env var of the API, the web app and the sites) |
| Guides | one `guides/*.md` page per subsystem, in the order `kitSidebar` lists them |
| Reference | `reference/api.md` (RPC vs REST, every procedure with its route, errors and paging), `reference/commands.md`, `reference/architecture.md`, and the interactive **API reference** |

Starlight fails a build on a sidebar slug that does not exist, so a new manual page goes into
`kitSidebar` and must build with `DOCS_CONTENT=kit`, which CI runs.

`src/pages/robots.txt.ts` generates `robots.txt`, so its `Sitemap:` line follows `SITE_URL` and the
base. Astro's content cache is kept per set (`node_modules/.astro/<set>`), so switching sets never
reconciles one set's pages against the other's.

The interactive API reference is a custom page, `src/pages/reference/api-reference.astro`, rendered
inside Starlight's `StarlightPage` component with `template: splash`, in both sets. It loads Scalar
from jsDelivr, pinned to an exact version with a Subresource Integrity hash of that file (bump both
together; the recipe is in the file's comment), and points it at the API's OpenAPI document.
Nothing is fetched at build time. The page shows a fallback (a link to the raw document, and to
`reference/api.md` when the set has one) when the script errors or when nothing has mounted after a
few seconds.

The GitHub and "Edit this page" links appear only when `DOCS_REPO_URL` is set.

## Deploy

```sh
bun run deploy:cloudflare    # astro build && wrangler deploy (Workers static assets, wrangler.jsonc)
```

Or serve `dist/`. `infra/docker/Dockerfile.static` builds it into Caddy for the self-hosted stack.
Set `SITE_URL` and `PUBLIC_API_URL` for the target environment before building. The build fails
without a real `SITE_URL`.

Every deploy publishes your product's docs. The free edition's licence lets you publish the manual
as well: add `DOCS_CONTENT=kit` to the `caddy` image's build args (or set it for
`deploy:cloudflare`), and that build serves the manual instead.
