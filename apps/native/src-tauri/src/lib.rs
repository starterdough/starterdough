//! The native shell is deliberately dumb: it opens a system webview on the SvelteKit
//! static build and gets out of the way. All data flows over HTTP to the API, so there
//! are no Tauri commands / IPC here and the same frontend code runs in the browser.
//!
//! Add Rust only for things the web platform cannot do (tray, autostart, deep links,
//! updater, notifications, biometrics), as Tauri plugins, not as an IPC data layer.
//!
//! The one native behaviour so far: anything that would take the webview away from the
//! app (an OAuth provider, a payment page, a docs link) opens in the system browser
//! instead. A shell has no address bar and no back button, so a foreign page inside it
//! is a dead end; the browser also has the user's cookies, which the shell does not.
//!
//! Everything the shell does is logged to the OS log directory in both profiles, and a
//! failure to start says so somewhere a user can find it; see [`log_plugin`] and
//! [`report_fatal`], because a Windows release build has no console to print to.

use tauri::{
    webview::{NewWindowFeatures, NewWindowResponse},
    Url, WebviewWindowBuilder,
};
use tauri_plugin_log::{Target, TargetKind};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Err(error) = build_and_run() {
        report_fatal(&error);
        std::process::exit(1);
    }
}

fn build_and_run() -> tauri::Result<()> {
    tauri::Builder::default()
        .plugin(log_plugin())
        .setup(|app| {
            log::info!(
                "Starterdough {} starting ({} build)",
                app.package_info().version,
                if cfg!(debug_assertions) {
                    "debug"
                } else {
                    "release"
                }
            );

            // `app.windows[0]` has `create: false` so the window can be built here, with the
            // navigation rules attached (they exist only on the builder).
            let config = app.config();
            let window = config
                .app
                .windows
                .first()
                .expect("tauri.conf.json: app.windows[0] is the main window");

            // Origins that belong to the app: the bundled SPA (`tauri://localhost` or
            // `http(s)://tauri.localhost`) and, in development, the Vite dev server.
            let dev_origin = if cfg!(dev) {
                config.build.dev_url.as_ref().map(Url::origin)
            } else {
                None
            };
            let is_app_url = move |url: &Url| {
                matches!(url.scheme(), "tauri" | "about" | "blob" | "data")
                    || url.host_str() == Some("tauri.localhost")
                    || dev_origin
                        .as_ref()
                        .is_some_and(|origin| &url.origin() == origin)
            };
            let allow_navigation = is_app_url.clone();

            WebviewWindowBuilder::from_config(app.handle(), window)?
                .on_navigation(move |url| {
                    if allow_navigation(url) {
                        return true;
                    }
                    open_externally(url);
                    false
                })
                .on_new_window(move |url: Url, _features: NewWindowFeatures| {
                    // `window.open` / `target="_blank"`: never a second webview.
                    if !is_app_url(&url) {
                        open_externally(&url);
                    }
                    NewWindowResponse::Deny
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
}

/// Without this, a release build produces no logs at all, so "it opens and closes again" comes with
/// nothing to send. The plugin writes to the OS log directory in both profiles
/// (`%LOCALAPPDATA%\dev.starterdough.native\logs` on Windows, `~/Library/Logs/dev.starterdough.native` on
/// macOS, `$XDG_DATA_HOME/dev.starterdough.native/logs` on Linux), capped at one 1 MB file plus one
/// rotation; debug builds also print to the terminal. `TargetKind::Webview` is deliberately absent:
/// forwarding logs into the page needs the frontend to subscribe over IPC, and the shell has none.
fn log_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let mut targets = vec![Target::new(TargetKind::LogDir { file_name: None })];
    if cfg!(debug_assertions) {
        targets.push(Target::new(TargetKind::Stdout));
    }
    tauri_plugin_log::Builder::default()
        .targets(targets)
        .level(log::LevelFilter::Info)
        .max_file_size(1_000_000)
        .build()
}

/// A failure before the window exists exits silently on Windows: `windows_subsystem = "windows"`
/// leaves no console for a panic message, and there is no window yet to show a dialog in (Tauri's
/// `dialog` plugin is not a dependency and is not worth adding for one message). So write the reason
/// where it can be found: the log file, plus a plain-text note in the temp directory, which needs no
/// `AppHandle` and survives a failure of the log plugin itself.
fn report_fatal(error: &tauri::Error) {
    let message = format!(
        "Starterdough {} failed to start: {error}",
        env!("CARGO_PKG_VERSION")
    );
    log::error!("{message}");
    eprintln!("{message}");

    let note = std::env::temp_dir().join("dev.starterdough.native-startup-error.txt");
    match std::fs::write(&note, &message) {
        Ok(()) => eprintln!("wrote {}", note.display()),
        Err(write_error) => eprintln!("could not write {}: {write_error}", note.display()),
    }
}

/// Hand a URL to the operating system's default browser. Only web URLs: a shell must not
/// become a launcher for arbitrary schemes.
fn open_externally(url: &Url) {
    if !matches!(url.scheme(), "http" | "https" | "mailto") {
        log::warn!("blocked navigation to {url}");
        return;
    }
    if let Err(error) = tauri_plugin_opener::open_url(url.as_str(), None::<&str>) {
        log::warn!("could not open {url} in the system browser: {error}");
    }
}
