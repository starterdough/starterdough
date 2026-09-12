# @repo/site

The public marketing site: landing, features, changelog, blog, legal pages and a contact
form. Astro 7, fully static (`output: 'static'`), Tailwind 4 with the shared design tokens from
`@repo/ui/theme.css`. The tokens are `light-dark()` pairs, so the site follows the OS color scheme
with no JavaScript and no theme toggle.

The site never imports server-only packages. Its only workspace dependency is
`@repo/ui/theme.css`.

## Develop

```sh
cp .env.example .env
bun run dev            # http://localhost:4321
bun run check          # astro check (types in .astro files, content frontmatter)
bun run build          # dist/, plus the OG images, sitemap, RSS and robots.txt
bun run preview
```

## Environment

| Variable | Default | Used for |
| --- | --- | --- |
| `SITE_URL` | `http://localhost:4321` for `dev`/`check`; **required** for `build` | Canonical origin at build time: `<link rel="canonical">`, sitemap, RSS, absolute `og:image` URLs and the `Sitemap:` line in `robots.txt`. `astro build` refuses an unset value and an `example.com` placeholder |
| `PUBLIC_DOCS_URL` | `http://localhost:4322` | "Docs" links and the API reference link in the footer |
| `PUBLIC_API_URL` | `http://localhost:3000` | The contact form POSTs to `${PUBLIC_API_URL}/api/v1/contact` |
| `PUBLIC_REPO_URL` | empty | Optional. Your public repository: the footer link, "View on GitHub" on the landing page, the changelog's commit history, the contact page's "found a bug". Unset, none of them render |
| `PUBLIC_CONTACT_EMAIL` | empty | Optional. Shown to visitors who cannot use the contact form (no JavaScript). The form itself delivers to the API's `CONTACT_EMAIL`, which never reaches the browser |
| `PUBLIC_APP_URL` | `http://localhost:5173` | "Sign in" and "Open the app" |

All of them are read at build time. Rebuild after changing them. The version shown on `/changelog`
comes from the root `package.json`.

## Pages

| Route | Source | Notes |
| --- | --- | --- |
| `/` | `src/pages/index.astro` | hero, "one HTTP API, every surface", feature grid, "how a request flows", quickstart CTA |
| `/features` | `src/pages/features.astro` | long-form version of the grid from `src/lib/features.ts`, stack table |
| `/changelog` | `src/pages/changelog.astro` | every entry of the `changelog` collection, newest first |
| `/blog`, `/blog/[slug]` | `src/pages/blog/` | the `blog` collection |
| `/legal/[slug]` | `src/pages/legal/[slug].astro` | the `legal` collection (`/legal/privacy`, `/legal/terms`) |
| `/contact` | `src/pages/contact.astro` | contact / waitlist form (see below) |
| `/404` | `src/pages/404.astro` | served by Cloudflare (`not_found_handling: 404-page`) and Caddy |
| `/rss.xml` | `src/pages/rss.xml.ts` | `@astrojs/rss` over the blog collection |
| `/robots.txt` | `src/pages/robots.txt.ts` | generated so the `Sitemap:` line follows `SITE_URL` |
| `/sitemap-index.xml` | `@astrojs/sitemap` | HTML pages only (OG images, RSS and robots are filtered out) |
| `/og/*.png` | `src/pages/og/[...route].ts` | Open Graph images, see below |

Layout and shared pieces: `src/layouts/Base.astro` (skip link, header, one `<main id="main">`,
footer, `<slot name="head">` for extra tags), `src/components/SEO.astro` (title, description,
canonical from `Astro.site` + pathname, Open Graph + Twitter tags, RSS and sitemap links),
`Header.astro`, `Footer.astro`, `PageHeader.astro`, `Logo.astro`. Site-wide constants, the env
fallbacks and the metadata of every static page live in `src/lib/site.ts`.

## Content collections (`src/content.config.ts`)

| Collection | Folder | Frontmatter |
| --- | --- | --- |
| `blog` | `src/content/blog/*.md` | `title`, `description`, `pubDate`, `author`, `tags[]` |
| `changelog` | `src/content/changelog/*.md` | `title`, `version`, `date` |
| `legal` | `src/content/legal/*.md` | `title`, `description`, `updated` |

The file name is the slug (`one-http-api.md` → `/blog/one-http-api/`). The legal texts are
templates with `[Company name]`, `[Contact email]` and similar placeholders and a visible "review
with counsel" note. Replace them before publishing. The privacy template's sub-processor table lists
every third party the kit can send data to, including the ones that only apply when configured;
delete the rows that
do not apply to your deployment. The rendered "Updated" date comes from each file's `updated`
frontmatter.

## Open Graph images

Generated at build time by `astro-og-canvas` (CanvasKit, no runtime): one image per static page,
blog post and legal document at `/og/<route>.png`. `Base.astro` derives the key from the current
pathname (`/` → `index`, `/blog/x/` → `blog/x`), so every page's `og:image` exists. Pass `ogImage`
to override (the 404 page reuses the home image). Fonts (Inter 400/700) are downloaded from
fontsource during the build and cached in `node_modules/.astro-og-canvas`, so the first build needs
network access.

## Contact form

`/contact` is a plain HTML form with **no `action`**, enhanced by a small script that POSTs JSON to
`${PUBLIC_API_URL}/api/v1/contact` (`contact.send` in the API contract). The submit button ships
`disabled` and the script enables it. A `<noscript>` block offers `PUBLIC_CONTACT_EMAIL` (or the
repository) as another way through.

- Request: `{ "email": string, "name"?: string, "message": string }` (message 10 to 2000 chars),
  plus a hidden honeypot field `website` that the API drops silently when filled.
- Responses: `200 { ok: true }` shows success inline; `400` maps the API's validation issues onto
  the fields; `412` means "not configured on this deployment" (the API has an email provider but no
  `CONTACT_EMAIL`); `429` shows the rate-limited message; a network error shows "could not reach the
  server".

The API's CORS allow-list (`TRUSTED_ORIGINS` in the root `.env`) must include this site's origin.
**Cloudflare Turnstile** is not wired yet: the form has a comment where the widget goes, and the
submit handler has the line that would forward the `cf-turnstile-response` token as
`turnstileToken`.

## Deploy

```sh
bun run deploy:cloudflare    # astro build && wrangler deploy (Workers static assets, wrangler.jsonc)
```

Or serve `dist/` with any static host. `infra/docker/Dockerfile.static` builds it into Caddy for
the self-hosted stack. Set `SITE_URL`, `PUBLIC_APP_URL`, `PUBLIC_DOCS_URL` and `PUBLIC_API_URL` for
the target environment before building. The build fails without a real `SITE_URL`.
