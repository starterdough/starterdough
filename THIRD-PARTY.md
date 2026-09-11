# Third-party components

The kit itself is licensed under [`LICENSE.md`](LICENSE.md). Everything it depends on is not ours:
each package keeps its own licence, and those licences travel with anything you ship. This file
records what the dependency tree contains, the two components that ask for more than attribution,
and how to reproduce the scan on your own tree after you add dependencies.

## How the scan was done

`scripts/licenses.ts` reads the metadata that is already on disk after an install — every
`package.json` under a `node_modules`, plus the `*.dist-info/METADATA` files `uv sync` writes into
the Python service's virtualenv. It adds no dependency of its own, so it cannot itself change what it is
measuring.

```sh
bun install
bun run licenses            # summary by licence + anything that is not plainly permissive
bun run licenses --all      # every package, one line each
bun run licenses --strict   # exit 1 on anything not already noted here — use it as a CI gate
```

`--strict` ignores the packages whose notices are written below (its `ACKNOWLEDGED` list names them),
so it is green today and fails the moment a *new* non-permissive licence appears.

A package counts as *plainly permissive* when its declared SPDX expression resolves to MIT, ISC,
Apache-2.0, BSD-2/3-Clause, 0BSD, MPL-2.0, Unlicense, CC0-1.0, CC-BY-4.0, BlueOak-1.0.0, Zlib,
Python-2.0 or MIT-0 (`OR` needs one permissive half, `AND` needs all of them). Anything else — an
unfamiliar id, a `SEE LICENSE IN …`, an empty field — is printed for a human rather than guessed at.
Where a package declares nothing but ships a `LICENSE` file, the scan reports the id that file opens
with and marks it `(from LICENSE file)`, because that is a reading of prose and not a declaration.

Both dev and production dependencies are included on purpose. Container images and desktop
installers are built from this tree, so the line between the two is not where the obligations fall.

### Result at 0.3.0

823 packages: 775 npm, 48 Python. No AGPL, SSPL, GPL, BUSL, Commons Clause or non-commercial
licence anywhere in either tree. Five entries needed a human:

| Package | Declared | Verdict |
| --- | --- | --- |
| `@sentry/cli`, `@sentry/cli-win32-x64` | FSL-1.1-MIT | Notice below. Source-available, not OSI-approved. |
| `@img/sharp-<platform>` (e.g. `@img/sharp-win32-x64`) | Apache-2.0 AND LGPL-3.0-or-later | Notice below. The LGPL half is the bundled libvips binary. |
| `@lix-js/sdk-win32-x64` | nothing declared | MIT. A native sidecar of `@lix-js/sdk` (MIT, same repository, `opral/lix`) that omits the field and ships no `LICENSE`. Attribution only. |

The Python tree needed no notices; `protobuf` spells BSD-3-Clause in prose and `typing_extensions`
uses `PSF-2.0`, both of which the scan normalises.

## Notice 1 — `@sentry/cli` is FSL-1.1-MIT

The [Functional Source Licence](https://fsl.software/) permits use, modification and distribution for
any purpose **except** building a product that competes with Sentry, and converts to MIT two years
after each release. It is not an OSI-approved open-source licence.

- **Where it comes from.** `apps/web` → `@sentry/sveltekit` → `@sentry/vite-plugin` →
  `@sentry/bundler-plugins` → `@sentry/cli`, which uploads source maps at build time. It is build
  tooling: no part of it is served to a browser or linked into an End Product.
- **What you must do.** Nothing, unless you are building a competitor to Sentry's error-monitoring
  product. If you are, remove `@sentry/sveltekit` — error tracking is already optional in this kit
  and stays dormant until `PUBLIC_SENTRY_DSN` is set.
- **What you must not do.** Ship `@sentry/cli` inside a product that competes with Sentry.

## Notice 2 — `sharp` bundles LGPL-3.0 libvips

`sharp` is Apache-2.0, but the prebuilt `@img/sharp-<platform>` and `@img/sharp-libvips-<platform>`
packages contain a compiled **libvips**, which is **LGPL-3.0-or-later**. The declared expression
`Apache-2.0 AND LGPL-3.0-or-later` is describing exactly that.

- **Where it comes from.** A direct dependency of `apps/docs` (Starlight image optimisation), an
  optional dependency of `astro`, and a dependency of `miniflare` (the Cloudflare dev runtime).
- **If you only deploy a service** — a website, an API, a container you run yourself — the LGPL is
  not triggered by use. You have no obligation here.
- **If you redistribute an artefact containing libvips** — a desktop or mobile installer, a
  container image or archive handed to a third party, a downloadable bundle — then for that artefact
  you must:
  1. keep libvips' copyright notice and a copy of the LGPL-3.0 text with it, and state that libvips
     is used and under which licence;
  2. leave the recipient able to replace libvips with their own build. Because `sharp` loads libvips
     as a separate dynamic library (`@img/sharp-libvips-<platform>`), shipping it as that separate
     file — rather than statically linking it into your own binary — satisfies this; and
  3. offer the libvips source (a link to the matching release of
     [libvips/libvips](https://github.com/libvips/libvips) is enough) for the version you shipped.
- **If none of that suits you**, do not ship it: the Tauri shells in `apps/native` bundle the static
  SvelteKit build and never include `sharp`, and `apps/docs` is a static site whose images are
  optimised at build time on your machine. Removing `sharp` from `apps/docs` disables Starlight's
  image optimisation and nothing else.

## Vendored assets — the scan cannot see these

`bun run licenses` reads `node_modules`. Anything copied *into* `src/` is invisible to it, so it has
to be written down by hand.

| What | Where | Origin | Licence |
| --- | --- | --- | --- |
| Thirteen brand glyphs, as SVG path data | `apps/site/src/lib/stack.ts` | [simple-icons](https://github.com/simple-icons/simple-icons) 16.30.0 | CC0-1.0 |

The paths were copied out of the package once and inlined; simple-icons is not a dependency of this
repo and does not appear in `bun.lock`. CC0-1.0 asks for nothing, not even attribution — this row
exists so the next person knows where the data came from and how to refresh it.

The *logos themselves* are trademarks of their respective owners and are not covered by simple-icons'
licence. They are used on the landing page only to name the technologies the kit is built on, which
is nominative use; that is why they sit in a plain list of names and not in anything that could read
as an endorsement. If you fork this kit and rebrand it, check each owner's trademark guidelines
before reusing the row — several of them publish rules about colour and framing.

## When you add a dependency

1. `bun run licenses` and read the "Needs a human" section. A new entry is a decision, not noise.
2. Refuse AGPL, SSPL, BUSL, Commons Clause and anything non-commercial in code you deploy — a
   copyleft server dependency can oblige you to publish your own source.
3. LGPL is workable but only as a separate dynamic library, as above. Static linking is not.
4. If a licence obliges you to do something, write the obligation into this file rather than into a
   commit message. The next person will look here.
