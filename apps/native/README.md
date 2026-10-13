# @repo/native

Tauri 2 shell for desktop (Windows, macOS, Linux), with mobile (Android, iOS) scripts that have not
been run yet. It opens the static build of `@repo/web` in the operating system's webview, and the
frontend talks to the API over HTTP exactly like the browser does.

**No IPC by design (D9, D26).** The Rust side (`src-tauri/src/lib.rs`) only grows for native
capabilities the web platform lacks (tray, autostart, deep links, updater, notifications,
biometrics), as Tauri plugins, never as a data layer. The frontend does not import
`@tauri-apps/api`.

## Status, in plain words

A desktop build runs the whole app with email and password sign-in. It is a starting point, not a
finished desktop product: social sign-in and passkeys are not available in it, an account with
two-factor turned on cannot sign in to it yet, admins cannot impersonate users from it, the session
token is not in the OS keychain, there is no auto-update, Windows installers are unsigned, and
nothing is set up for any app store. Mobile has never been initialised or run. The two lists below
say what works and what does not, so you can decide what to finish before you ship.

What has been run by hand, on Windows only: sign-up, sign-in, sign-out, reloads and the language
choice, in `dev:desktop`, `preview:desktop` and a release binary (D26 in `docs/DECISIONS.md`, early
September 2026; the app has changed a lot since). Nobody has yet run the macOS or Linux shell, or
installed what the Desktop workflow builds. Treat your first release as the test.

## What works in a shell build

- **Email and password sign-in**, with email verification and password reset. The session is a
  bearer token, so it survives restarts. Two-factor can be turned on and off in the shell's
  settings, but read the first item of the next list before you rely on it.
- **The rest of the app.** Its screens make plain HTTP calls to the API, the same as in a browser,
  so they need nothing special in the shell. The one exception is the admin panel's Impersonate,
  in the next list.
- **Emailed links** (verification, password reset, email change, account deletion) point at
  `PUBLIC_WEB_URL`, so they open the web app in the user's browser. After verifying an address
  there, the user comes back to the shell and signs in. Every such link is built by `returnUrl()`
  in `apps/web/src/lib/api.ts`, and a test fails if a page builds one from `location.origin`, which
  in the shell is an address no browser can open.
- **External links** open in the system browser (`on_navigation` in `src-tauri/src/lib.rs`). The
  webview never leaves the app, because a shell has no address bar and no back button.

## What does not work yet

- **Signing in to an account that has two-factor turned on.** Better Auth keeps the half-finished
  sign-in in a cookie (`two_factor`) until the code is checked. The shell's page and the API are
  different sites, and a browser engine drops a `SameSite=Lax` cookie that a cross-site `fetch`
  tries to set, so the code check would fail ("invalid two factor cookie"). This was checked in
  Chromium, the engine behind WebView2, with a page and an API on different sites, not in a shell;
  WebKit, behind the macOS and Linux webviews, is at least as strict. (`dev:desktop` would get away
  with it, because `localhost:5175` and `localhost:3000` count as the same site.) So the shell's
  code page says the app cannot finish this step and points back to sign-in, and its security
  settings warn before two-factor is turned on (`TWO_FACTOR_SIGN_IN_AVAILABLE`). Until it is fixed,
  an account with two-factor on can only use the web app. The fix is the bearer plugin's trick
  applied to that one cookie: the API hands its value to the client in a response header, the client
  sends it back in a request header on `/two-factor/*`, and the API turns it back into the cookie;
  then lift the constant.
- **GitHub and Google sign-in.** Hidden in shell builds (`SOCIAL_SIGN_IN_AVAILABLE` in
  `apps/web/src/lib/api.ts`). The provider's page opens in the system browser, and the round trip
  ends with a session cookie in that browser, so at best the user is signed in to the web app there
  while the shell stays on its sign-in page. Making it work needs a way back into the app:
  `tauri-plugin-deep-link` (a `starterdough://` scheme) with `tauri-plugin-single-instance`, a
  Better Auth hook that redirects to that scheme with a short-lived one-time code (never the session
  token itself), and an API endpoint that trades the code for a bearer token. The Rust side can
  hand the code over by navigating the webview to an app page, so the no-IPC rule can stay. Plan on
  about a week, including registering the scheme on each OS.
- **Passkeys.** The shell can neither sign in with a passkey nor add one, so it offers neither
  (`PASSKEYS_AVAILABLE`). WebAuthn ties a passkey to the web app's hostname (the API's `rpID`,
  taken from `WEB_URL`) and refuses, with a `SecurityError`, on any page whose own origin is on a
  different host. The shell's origin is `tauri://localhost` or `http://tauri.localhost`. Passkeys
  added in a browser are still listed in the shell's security settings, where they can be renamed
  or removed. Real native passkeys need a platform plugin plus Apple associated domains and Android
  Digital Asset Links: weeks of work, not days.
- **Impersonating a user from the admin panel.** Better Auth swaps the session for the other
  user's, which the bearer plugin hands to the shell, and parks the admin's own session in an
  `admin_session` cookie. That cookie is dropped for the same cross-site reason as `two_factor`, so
  "Stop impersonating" could never bring the admin back. The shell's admin panel has no Impersonate
  button and says to use the web app (`IMPERSONATION_AVAILABLE`). If a shell is impersonating
  anyway, as an older build could be, "Stop impersonating" signs that session out and the admin
  signs in again. The fix is the same header trick as for two-factor, applied to `admin_session`.
- **Secure token storage.** The bearer token sits in the webview's `localStorage`, an ordinary file
  in the app's data directory. Any script running in the webview can read it, and anyone who can
  read the user's files can copy it. It is valid for 7 days and renewed as it is used. The fix is an
  OS-keychain (or Stronghold) plugin behind the existing `TokenStore` interface. That one does need
  a little IPC, because the webview has to get the token back from Rust; record it as a decision.
- **Auto-update.** `tauri-plugin-updater` is not wired. An installed app stays on its version until
  the user downloads a new installer. The header of `.github/workflows/desktop.yml` lists the steps
  (a signing key pair, the `.sig` files and a `latest.json`).
- **Signed installers.** macOS builds are signed and notarised only when the Apple secrets listed in
  `desktop.yml` are set, which needs a paid Apple Developer account. The workflow has no Windows
  signing step at all, so Windows installers are always unsigned and SmartScreen warns before they
  run. Linux packages are unsigned, which is usual there.
- **App stores.** Nothing is prepared for the Mac App Store, the Microsoft Store, Google Play or the
  App Store (sandboxing, store manifests, review). The Desktop workflow drafts a GitHub release with
  plain installers, and publishing it is up to you.
- **Mobile.** Never initialised, built or run. `src-tauri/gen/android` and `src-tauri/gen/apple` do
  not exist; `android:init` and `ios:init` create them on a machine with Android Studio and the NDK,
  or Xcode. Set your own bundle identifier first: `bun run rename` takes it as `--identifier`,
  together with the `--name`, `--slug` and `--scope` it also requires, for example
  `bun run rename --name Acme --slug acme --identifier com.acme.desktop --scope @acme --write`. An
  Android package name cannot contain a Java keyword, and the identifier the kit ships ends in one,
  `native`. Then come icons, testing on real devices, and every item in this list again.
- **Tray, autostart, notifications.** None of these exist yet.
- **The remote (thin-client) mode** described below has not been tried. `is_app_url` in
  `src-tauri/src/lib.rs` treats every origin except the bundled one and the dev server as external
  and hands it to the system browser, so add your web app's origin there first. That mode runs the
  web build (cookies, not bearer tokens), so the GitHub and Google buttons come back, with the same
  dead end as above.

## Prerequisites

- Rust toolchain (`rustup`). The shell is a Cargo project; everything else in this repo runs on Bun.
- Platform dependencies: https://v2.tauri.app/start/prerequisites/ (Windows: Visual Studio C++
  build tools + WebView2, present on Windows 10/11; Linux: webkit2gtk 4.1 and friends; macOS:
  Xcode CLT).
- Mobile: Android Studio + NDK (Android), Xcode (iOS, macOS only).
- The API must be running (`bun run dev:api` or `bun run dev:app` from the repo root). The shell is
  a client of `PUBLIC_API_URL` (`apps/web/.env`).

## Three ways to run it

| Command (repo root) | What happens | Origin inside the webview | Use it for |
| --- | --- | --- | --- |
| `bun run dev:desktop` | `tauri dev`: starts `apps/web` as `dev:static` (Vite, `ADAPTER=static`, port 5175) and opens the shell on it. HMR works. | `http://localhost:5175` | Daily work on the UI inside the shell |
| `bun run preview:desktop` | `tauri build --debug --no-bundle` with the generated CSP, then runs `src-tauri/target/debug/starterdough(.exe)`. The static build is embedded and served by Tauri itself. | `http://tauri.localhost` (Windows) · `tauri://localhost` (others) | The pre-release check: bearer auth with **no** cookies, the tightened CSP, locale persistence |
| `bun run build:desktop` | `tauri build` with the generated CSP. Installers land in `src-tauri/target/release/bundle/` (NSIS + MSI on Windows, DMG/.app on macOS, AppImage/.deb/.rpm on Linux). Refuses to start unless `PUBLIC_API_URL` and `PUBLIC_WEB_URL` hold real values. | same as preview | Shipping |

`preview:desktop -- --run` skips the build and opens the last debug binary. Inside `apps/native`
the same scripts exist without the root prefix, plus `bun run tauri …` for anything else.

The first Cargo build takes minutes; later ones are incremental. `tauri dev` restarts the app when
anything under `src-tauri/` changes, so `tauri.build.conf.json` lives one level up.

## What is different inside the shell

- **Auth is bearer, not cookies.** `ADAPTER=static` makes `usesBearerAuth` true
  (`apps/web/src/lib/token-store.ts`). The session token from the API's `set-auth-token` header is
  kept in `localStorage` and sent as `Authorization: Bearer …` by `@repo/auth/client` and
  `@repo/api-client`. Sign-out clears it. The webview's storage lives in the app's data directory
  (`%LOCALAPPDATA%\dev.starterdough.native\EBWebView` on Windows), so the session survives restarts.
  Inside the shell (`usesBearerAuth` plus Tauri's `__TAURI_INTERNALS__`), the app also turns off
  social sign-in, passkeys, the two-factor step and impersonation (see above); the same static
  build served from a static host keeps them.
- **Locale** is resolved `cookie → localStorage → navigator.languages → en`
  (`apps/web/project.inlang/paraglide.config.ts`). `setLocale()` writes both stores, so webviews
  that drop cookies between launches still find the choice in `localStorage`.
- **CORS / trusted origins.** Outside production the API allows `http://localhost:5175`,
  `http://tauri.localhost`, `https://tauri.localhost` and `tauri://localhost` automatically
  (`trustedOrigins()` in `@repo/env`). Production must list the shell origins in `TRUSTED_ORIGINS`
  (`.env.example` does). Otherwise every request from the shell fails the origin check.
- **CSP.** `src-tauri/tauri.conf.json` carries a base policy and a permissive `devCsp` for Vite.
  `scripts/tauri-config.ts` writes `tauri.build.conf.json`, a fragment merged over it by
  `--config`. Its `connect-src` is exactly the API origin (`PUBLIC_API_URL`), the object store
  (`PUBLIC_STORAGE_ORIGIN`; leave it empty for the local disk driver) and Sentry / PostHog when
  their `PUBLIC_*` keys are set. It reads `apps/web/.env`, `.env.local`, `.env.production` and
  `.env.production.local` in Vite's order, with the process environment last, so the policy matches
  the URLs baked into the SPA. Tauri sends the policy as a response header, so the fragment also
  carries `base-uri 'self'`, `form-action 'self'` and `frame-ancestors 'none'`. `build:desktop`,
  `preview:desktop` and the mobile `*:build` scripts run it first. A plain `tauri build` uses the
  base policy.
- **Version.** The root `package.json` `version` is the single source of truth. The generator
  injects it into the fragment (which names `Starterdough_<version>_x64-setup.exe`) and writes it
  back into `src-tauri/Cargo.toml` and `apps/native/package.json`, so `cargo`, `tauri dev` and the
  installers agree. `src-tauri/tauri.conf.json` has no `version` key on purpose: Tauri falls back
  to `Cargo.toml`.
- **Capabilities.** `src-tauri/capabilities/default.json` grants one permission,
  `core:webview:allow-internal-toggle-devtools`, for the devtools hotkey Tauri injects into debug
  builds. Nothing else is granted because nothing else is called: the frontend does no IPC, and the
  Rust side (window creation, `open_url`) is not gated by capabilities.
- **Logs.** Both profiles write to the OS log directory
  (`%LOCALAPPDATA%\dev.starterdough.native\logs\Starterdough.log` on Windows,
  `~/Library/Logs/dev.starterdough.native` on macOS, `$XDG_DATA_HOME/dev.starterdough.native/logs` on
  Linux), capped at 1 MB plus one rotation. Debug builds also print to the terminal. A failure
  before the window exists also drops `dev.starterdough.native-startup-error.txt` in the temp
  directory. Ask for both when a user reports "it opens and closes again".
- **No service worker, no install prompt.** `#lib/pwa.svelte.js` detects `__TAURI_INTERNALS__`.

## Debugging the webview

Right-click → Inspect works in debug builds. For scripted checks (Playwright over CDP) start the
shell with WebView2's remote-debugging flag. On Windows:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9333"
bun run dev:desktop          # or preview:desktop
# then: chromium.connectOverCDP('http://127.0.0.1:9333') → browser.contexts()[0].pages()[0]
```

Never `page.close()` from such a script: that closes the window. `browser.close()` only
disconnects.

## Two ways to ship the frontend

1. **Bundled (default).** `frontendDist: ../../web/build-static`, written by
   `bun run --cwd apps/web build:static:desktop` (`STATIC_OUT_DIR=build-static`, so a desktop build
   never overwrites a web build in `apps/web/build`). The shell works offline for its own files.
   The API URL is baked in via `PUBLIC_API_URL` at build time.
2. **Remote (thin client), untried.** Set `frontendDist` to `https://app.example.com`, grant that
   origin in a capability (`remote.urls`) and add it to `is_app_url` in `src-tauri/src/lib.rs`
   (see above). Ship the app once, update the frontend by deploying the web app. The web app then
   runs with cookies against its own origin, exactly like the browser.

## Releases

`.github/workflows/desktop.yml` builds the installers for Windows, macOS (both architectures) and
Linux with `tauri-apps/tauri-action` on `v*` tags. Each leg uploads its installers as a workflow
artifact. A final job that `needs` the whole matrix collects them into one **draft** release, so a
partial installer set never reaches a release even though `fail-fast: false` lets every leg finish.

The pushed tag must be exactly `v<root package.json version>`. A mismatch fails the run before
anything is built, and each leg re-checks that every file it produced carries that version.

Required repository variables (Settings → Secrets and variables → Actions → Variables):
`PUBLIC_API_URL` and `PUBLIC_WEB_URL`. Unset or still an `example.com` placeholder fails the run.
Optional: `PUBLIC_STORAGE_ORIGIN` (needed for S3/R2 uploads to pass the CSP), `PUBLIC_SENTRY_DSN`,
`PUBLIC_POSTHOG_KEY`, `PUBLIC_POSTHOG_HOST`. The macOS signing and notarisation secrets are listed
at the top of the workflow; without them the macOS binaries are unsigned too, and Gatekeeper warns.
