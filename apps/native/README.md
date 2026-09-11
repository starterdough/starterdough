# @repo/native

Tauri 2 shell for desktop (Windows, macOS, Linux) and mobile (Android, iOS).

**No IPC by design (D9, D26).** The shell loads the static build of `@repo/web` and the frontend
talks to the API over HTTP exactly like the browser does. The Rust side (`src-tauri/src/lib.rs`) is
~20 lines and only grows for native capabilities the web platform lacks (tray, autostart, deep
links, updater, notifications, biometrics) — as Tauri plugins, never as a data layer. The frontend
does not import `@tauri-apps/api`.

## Prerequisites

- Rust toolchain (`rustup`) — the shell is a Cargo project; everything else in this repo runs on Bun.
- Platform deps: https://v2.tauri.app/start/prerequisites/ (Windows: Visual Studio C++ build tools
  + WebView2, present on Windows 10/11; Linux: webkit2gtk 4.1 et al.; macOS: Xcode CLT).
- Mobile: Android Studio + NDK (Android), Xcode (iOS, macOS only).
- The API must be running (`bun run dev:api` or `bun run dev:app` from the repo root) — the shell
  is a client of `PUBLIC_API_URL` (`apps/web/.env`), nothing more.

## Three ways to run it

| Command (repo root) | What happens | Origin inside the webview | Use it for |
| --- | --- | --- | --- |
| `bun run dev:desktop` | `tauri dev`: starts `apps/web` as `dev:static` (Vite, `ADAPTER=static`, port 5175) and opens the shell on it. HMR works. | `http://localhost:5175` | Daily work on the UI inside the shell |
| `bun run preview:desktop` | `tauri build --debug --no-bundle` with the generated CSP, then runs `src-tauri/target/debug/starterdough(.exe)`. The static build is embedded and served by Tauri itself. | `http://tauri.localhost` (Windows) · `tauri://localhost` (others) | The pre-release check: bearer auth with **no** cookies, the tightened CSP, locale persistence — everything that depends on the real origin |
| `bun run build:desktop` | `tauri build` with the generated CSP → installers in `src-tauri/target/release/bundle/` (NSIS + MSI on Windows, DMG/.app on macOS, AppImage/.deb/.rpm on Linux). Refuses to start unless `PUBLIC_API_URL` and `PUBLIC_WEB_URL` are set to something that is not a placeholder. | same as preview | Shipping |

`preview:desktop -- --run` skips the build and opens the last debug binary. Inside `apps/native`
the same scripts exist without the root prefix, plus `bun run tauri …` for anything else.

The first Cargo build takes minutes; later ones are incremental. `tauri dev` restarts the app when
anything under `src-tauri/` changes (`tauri.build.conf.json` therefore lives one level up).

## What is different inside the shell

- **Auth is bearer, not cookies.** `ADAPTER=static` makes `usesBearerAuth` true
  (`apps/web/src/lib/token-store.ts`): the session token from the API's `set-auth-token` header is
  kept in `localStorage` and sent as `Authorization: Bearer …` by `@repo/auth/client` and
  `@repo/api-client`. Sign-out clears it. The webview's storage lives in the app's data directory
  (`%LOCALAPPDATA%\dev.starterdough.native\EBWebView` on Windows), so the session survives restarts.
  Moving the token to the OS keychain is a roadmap item (§7).
- **Locale** is resolved `cookie → localStorage → navigator.languages → en`
  (`apps/web/project.inlang/paraglide.config.ts`). `setLocale()` writes both stores; webviews on
  custom schemes that drop cookies between launches still find the choice in `localStorage`.
- **CORS / trusted origins.** Outside production the API allows `http://localhost:5175`,
  `http://tauri.localhost`, `https://tauri.localhost` and `tauri://localhost` automatically
  (`trustedOrigins()` in `@repo/env`). Production must list the shell origins in `TRUSTED_ORIGINS`
  (`.env.example` does) — otherwise every request from the shell fails the origin check.
- **CSP.** `src-tauri/tauri.conf.json` carries a base policy (`connect-src 'self' https:
  http://localhost:*`) and a permissive `devCsp` for Vite (inline/eval, `ws:`). `scripts/tauri-config.ts`
  writes `tauri.build.conf.json`, a fragment merged over it by `--config`, whose `connect-src` is
  exactly the API origin (`PUBLIC_API_URL`), the object store the browser PUTs presigned uploads to
  (`PUBLIC_STORAGE_ORIGIN` — leave it empty for the local disk driver, whose URLs are already on the
  API origin), and Sentry / PostHog when their `PUBLIC_*` keys are set. It reads `apps/web/.env`,
  `.env.local`, `.env.production` and `.env.production.local` in Vite's own order, with the process
  environment last, so the policy cannot drift from the URLs baked into the SPA. Tauri sends the
  policy as a response header rather than a `<meta>` tag, so the fragment can also carry
  `base-uri 'self'`, `form-action 'self'` and `frame-ancestors 'none'`. `build:desktop`,
  `preview:desktop` and the mobile `*:build` scripts run it first; a plain `tauri build` uses the
  base policy.
- **Version.** The root `package.json` `version` is the single source of truth. The generator injects
  it into the fragment (which is what names `Starterdough_<version>_x64-setup.exe`) and writes it back
  into `src-tauri/Cargo.toml` and `apps/native/package.json`, so `cargo`, `tauri dev` and the
  installers agree. `src-tauri/tauri.conf.json` deliberately has no `version` key — Tauri falls back
  to `Cargo.toml`, and a fourth copy would be a fourth thing to keep in step.
- **Capabilities.** `src-tauri/capabilities/default.json` grants exactly one permission,
  `core:webview:allow-internal-toggle-devtools`, for the devtools hotkey Tauri injects into debug
  builds. Nothing else is granted because nothing else is called: the frontend does no IPC, and the
  Rust side (window creation, `open_url`) is not gated by capabilities. `core:default` used to be
  granted, which included reading any image file off disk (`core:image:allow-from-path`).
- **Logs.** Both profiles write to the OS log directory —
  `%LOCALAPPDATA%\dev.starterdough.native\logs\Starterdough.log` on Windows,
  `~/Library/Logs/dev.starterdough.native` on macOS, `$XDG_DATA_HOME/dev.starterdough.native/logs` on Linux —
  capped at 1 MB plus one rotation; debug builds also print to the terminal. A failure before the
  window exists (which on Windows would otherwise be a silent exit, because a release binary has no
  console) also drops `dev.starterdough.native-startup-error.txt` in the temp directory. Ask for both when
  a user reports "it opens and closes again".
- **No service worker, no install prompt** — `$lib/pwa.svelte.ts` detects `__TAURI_INTERNALS__`.

## Debugging the webview

Right-click → Inspect works in debug builds. For scripted checks (Playwright over CDP) start the
shell with WebView2's remote-debugging flag — on Windows:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9333"
bun run dev:desktop          # or preview:desktop
# then: chromium.connectOverCDP('http://127.0.0.1:9333') → browser.contexts()[0].pages()[0]
```

Never `page.close()` from such a script — that closes the window; `browser.close()` only disconnects.

## Two ways to ship the frontend

1. **Bundled (default)** — `frontendDist: ../../web/build-static`, written by
   `bun run --cwd apps/web build:static:desktop` (`STATIC_OUT_DIR=build-static`, so a desktop build
   never overwrites a web build sitting in `apps/web/build`). The shell works offline for its own
   files; the API URL is baked in via `PUBLIC_API_URL` at build time.
2. **Remote (thin client)** — set `frontendDist` to `https://app.example.com` and grant that origin
   in a capability (`remote.urls`). Ship the app once, update the frontend by deploying the web app.
   The web app then runs with cookies against its own origin, exactly like the browser.

## Releases

`.github/workflows/desktop.yml` builds the installers for Windows, macOS (both architectures) and
Linux with `tauri-apps/tauri-action` on `v*` tags. Each leg uploads its installers as a workflow
artifact and a final job that `needs` the whole matrix collects them into one **draft** release, so a
partial installer set can never reach a release even though `fail-fast: false` lets every leg finish.

The pushed tag must be exactly `v<root package.json version>`; a mismatch fails the run before
anything is built, and each leg then re-checks that every file it produced carries that version.

Required repository variables (Settings → Secrets and variables → Actions → Variables):
`PUBLIC_API_URL` and `PUBLIC_WEB_URL` — unset or still an `example.com` placeholder fails the run
rather than shipping installers nobody can use. Optional: `PUBLIC_STORAGE_ORIGIN` (needed for
S3/R2 uploads to pass the CSP), `PUBLIC_SENTRY_DSN`, `PUBLIC_POSTHOG_KEY`, `PUBLIC_POSTHOG_HOST`.
Signing and notarisation secrets are listed at the top of the workflow; without them the binaries are
unsigned (Windows SmartScreen and macOS Gatekeeper will warn).

## Not yet (ROADMAP §7)

- **OAuth inside the shell.** Social sign-in is a redirect to a third party and back to `WEB_URL` —
  fine in a browser, wrong inside a cookie-less webview. The plan is `tauri-plugin-deep-link`
  (`starterdough://` scheme), a Better Auth hook that puts the session token on the deep-link
  callback, and `tauri-plugin-opener` so that flow runs in the system browser. Until then use
  email/password (+ 2FA / passkeys) in the shell.
- **Updater** (`tauri-plugin-updater`, signed releases — needs the owner's key pair), **tray /
  autostart / notifications**, **Android / iOS init** (need Android Studio / Xcode on the machine),
  **secure token storage** (Stronghold or an OS-keychain plugin instead of `localStorage`).
