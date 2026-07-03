use std::sync::Mutex;

use tauri::menu::{
    AboutMetadata, Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, State, Wry};

#[derive(serde::Deserialize)]
struct RecentItem {
    /// Open spec (local path or mdviewer:// URL) used as the menu item id suffix.
    spec: String,
    label: String,
}

/// Files the OS asked us to open before the frontend was ready to receive events.
#[derive(Default)]
struct PendingFiles {
    paths: Vec<String>,
    frontend_ready: bool,
}

struct AppState(Mutex<PendingFiles>);

/// Allow the asset protocol to serve files (images) from a document's folder.
/// The static asset scope is empty; access is granted per opened document
/// instead of blanket filesystem access.
fn allow_assets_near(app: &AppHandle, path: &str) {
    if let Some(parent) = std::path::Path::new(path).parent() {
        let _ = app.asset_protocol_scope().allow_directory(parent, true);
    }
}

#[tauri::command]
fn read_file(app: AppHandle, path: String) -> Result<String, String> {
    let contents =
        std::fs::read_to_string(&path).map_err(|e| format!("Could not read {path}: {e}"))?;
    allow_assets_near(&app, &path);
    Ok(contents)
}

#[tauri::command]
fn write_file(app: AppHandle, path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("Could not write {path}: {e}"))?;
    allow_assets_near(&app, &path);
    Ok(())
}

/// Single-quote a path for a remote POSIX shell, leaving a leading `~/` (home)
/// unquoted so the remote shell still expands it.
fn shell_quote(path: &str) -> String {
    let quote = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
    if path == "~" {
        "~".to_string()
    } else if let Some(rest) = path.strip_prefix("~/") {
        format!("~/{}", quote(rest))
    } else {
        quote(path)
    }
}

/// Reject anything that isn't a plain `[user@]host` token. Critically this
/// blocks a leading `-`, which `ssh` would otherwise treat as an option
/// (e.g. `-oProxyCommand=…` = arbitrary command execution) — reachable via the
/// mdviewer:// URL scheme, so this is a hard gate, not just hygiene.
fn validate_host(host: &str) -> Result<(), String> {
    let ok = !host.is_empty()
        && !host.starts_with('-')
        && host.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '@' | ':' | '[' | ']')
        });
    if ok {
        Ok(())
    } else {
        Err(format!("Invalid SSH host: {host:?}"))
    }
}

fn ssh_base() -> std::process::Command {
    let mut cmd = std::process::Command::new("ssh");
    cmd.arg("-o").arg("ConnectTimeout=12").arg("-o").arg("BatchMode=yes");
    cmd
}

/// Read a file from a remote host over SSH (`ssh HOST cat -- PATH`).
#[tauri::command]
async fn read_remote(host: String, path: String) -> Result<String, String> {
    validate_host(&host)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let output = ssh_base()
            // `--` ends ssh option parsing; the host can never be read as a flag.
            .arg("--")
            .arg(&host)
            .arg(format!("cat -- {}", shell_quote(&path)))
            .output()
            .map_err(|e| format!("Could not run ssh: {e}"))?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "Could not read {host}:{path}\n{}",
                err.trim()
            ));
        }
        String::from_utf8(output.stdout).map_err(|_| "File is not valid UTF-8".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write a file to a remote host over SSH, atomically (temp file + mv).
#[tauri::command]
async fn write_remote(host: String, path: String, contents: String) -> Result<(), String> {
    use std::io::Write;
    use std::process::Stdio;

    validate_host(&host)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let q = shell_quote(&path);
        // Write to a sibling temp file, then atomically move it into place so a
        // dropped connection can't truncate the original. `mv --` guards against
        // a path that begins with `-`.
        let remote = format!("tmp={q}.mdtmp.$$; cat > \"$tmp\" && mv -f -- \"$tmp\" {q}");
        let mut child = ssh_base()
            // `--` ends ssh option parsing; the host can never be read as a flag.
            .arg("--")
            .arg(&host)
            .arg(remote)
            .stdin(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Could not run ssh: {e}"))?;

        child
            .stdin
            .take()
            .ok_or("Could not open ssh stdin")?
            .write_all(contents.as_bytes())
            .map_err(|e| e.to_string())?;

        let output = child
            .wait_with_output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Could not save {host}:{path}\n{}", err.trim()));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Allow a single dropped/referenced image file to be served by the asset protocol.
#[tauri::command]
fn allow_asset(app: AppHandle, path: String) -> Result<(), String> {
    app.asset_protocol_scope()
        .allow_file(std::path::Path::new(&path))
        .map_err(|e| e.to_string())
}

/// Whether a local path exists (used to decide if a clicked file link is openable).
#[tauri::command]
fn path_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

/// Frontend startup errors land here so release builds (no devtools) are debuggable.
#[tauri::command]
fn log_error(message: String) {
    eprintln!("[frontend] {message}");
}

fn find_submenu_in(sub: &Submenu<Wry>, id: &str) -> Option<Submenu<Wry>> {
    for kind in sub.items().ok()? {
        if let Some(s) = kind.as_submenu() {
            if s.id().0 == id {
                return Some(s.clone());
            }
            if let Some(found) = find_submenu_in(s, id) {
                return Some(found);
            }
        }
    }
    None
}

fn find_submenu(menu: &Menu<Wry>, id: &str) -> Option<Submenu<Wry>> {
    for kind in menu.items().ok()? {
        if let Some(s) = kind.as_submenu() {
            if s.id().0 == id {
                return Some(s.clone());
            }
            if let Some(found) = find_submenu_in(s, id) {
                return Some(found);
            }
        }
    }
    None
}

/// Rebuild the File → Open Recent submenu from the frontend's recent list.
#[tauri::command]
fn set_recent_files(app: AppHandle, items: Vec<RecentItem>) -> Result<(), String> {
    let menu = app.menu().ok_or("application menu is not available")?;
    let submenu = find_submenu(&menu, "recent-menu").ok_or("recent menu not found")?;

    while let Ok(Some(_)) = submenu.remove_at(0) {}

    if items.is_empty() {
        let empty = MenuItemBuilder::with_id("recent-empty", "No Recent Files")
            .enabled(false)
            .build(&app)
            .map_err(|e| e.to_string())?;
        submenu.append(&empty).map_err(|e| e.to_string())?;
        return Ok(());
    }

    for item in &items {
        let entry = MenuItemBuilder::with_id(format!("recent:{}", item.spec), &item.label)
            .build(&app)
            .map_err(|e| e.to_string())?;
        submenu.append(&entry).map_err(|e| e.to_string())?;
    }
    submenu
        .append(&PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let clear = MenuItemBuilder::with_id("clear-recent", "Clear Menu")
        .build(&app)
        .map_err(|e| e.to_string())?;
    submenu.append(&clear).map_err(|e| e.to_string())?;
    Ok(())
}

fn find_menu_item(
    menu: &tauri::menu::Menu<tauri::Wry>,
    id: &str,
) -> Option<tauri::menu::MenuItem<tauri::Wry>> {
    if let Some(kind) = menu.get(id) {
        if let Some(item) = kind.as_menuitem() {
            return Some(item.clone());
        }
    }
    for kind in menu.items().ok()? {
        if let Some(submenu) = kind.as_submenu() {
            if let Some(found) = submenu.get(id) {
                if let Some(item) = found.as_menuitem() {
                    return Some(item.clone());
                }
            }
        }
    }
    None
}

/// Update menu item accelerators (configurable keybindings). An empty string
/// clears the accelerator.
#[tauri::command]
fn set_menu_accelerators(
    app: AppHandle,
    accelerators: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    let Some(menu) = app.menu() else {
        return Err("application menu is not available".into());
    };
    for (id, accelerator) in accelerators {
        if let Some(item) = find_menu_item(&menu, &id) {
            let value: Option<&str> = if accelerator.is_empty() {
                None
            } else {
                Some(accelerator.as_str())
            };
            item.set_accelerator(value).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Called by the frontend once its event listeners are installed.
/// Returns any file paths that were requested before that point (Finder
/// "Open With", double-click on an associated file, CLI args).
#[tauri::command]
fn frontend_ready(state: State<'_, AppState>) -> Vec<String> {
    let mut pending = state.0.lock().unwrap();
    pending.frontend_ready = true;
    std::mem::take(&mut pending.paths)
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Make this app the default handler for Markdown files. Only meaningful for
/// the bundled release build (the dev binary has no registered bundle).
#[cfg(all(target_os = "macos", not(debug_assertions)))]
fn register_as_default_markdown_app() {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};

    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn LSSetDefaultRoleHandlerForContentType(
            content_type: CFStringRef,
            role: u32,
            handler_bundle_id: CFStringRef,
        ) -> i32;
        fn LSSetDefaultHandlerForURLScheme(
            url_scheme: CFStringRef,
            handler_bundle_id: CFStringRef,
        ) -> i32;
    }

    const ROLES_ALL: u32 = 0xFFFF_FFFF;
    let bundle_id = CFString::new("com.maxleiter.md-viewer");
    for uti in ["net.daringfireball.markdown", "public.markdown"] {
        let content_type = CFString::new(uti);
        unsafe {
            LSSetDefaultRoleHandlerForContentType(
                content_type.as_concrete_TypeRef(),
                ROLES_ALL,
                bundle_id.as_concrete_TypeRef(),
            );
        }
    }

    // Claim the mdviewer:// URL scheme (remote-file deep links).
    let scheme = CFString::new("mdviewer");
    unsafe {
        LSSetDefaultHandlerForURLScheme(
            scheme.as_concrete_TypeRef(),
            bundle_id.as_concrete_TypeRef(),
        );
    }
}

fn build_menu(app: &AppHandle) -> tauri::Result<()> {
    let app_menu = SubmenuBuilder::new(app, "Markdown")
        .about(Some(AboutMetadata::default()))
        .separator()
        .item(
            &MenuItemBuilder::with_id("settings", "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?,
        )
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(
            &MenuItemBuilder::with_id("quit", "Quit Markdown")
                .accelerator("CmdOrCtrl+Q")
                .build(app)?,
        )
        .build()?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(
            &MenuItemBuilder::with_id("new", "New")
                .accelerator("CmdOrCtrl+N")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("open", "Open…")
                .accelerator("CmdOrCtrl+O")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("open-remote", "Open Remote…")
                .accelerator("Shift+CmdOrCtrl+O")
                .build(app)?,
        )
        .item(
            &SubmenuBuilder::with_id(app, "recent-menu", "Open Recent")
                .item(
                    &MenuItemBuilder::with_id("recent-empty", "No Recent Files")
                        .enabled(false)
                        .build(app)?,
                )
                .build()?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("save", "Save")
                .accelerator("CmdOrCtrl+S")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("save-as", "Save As…")
                .accelerator("Shift+CmdOrCtrl+S")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("export-html", "Export as HTML…")
                .accelerator("Shift+CmdOrCtrl+E")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("close-pane", "Close Pane")
                .accelerator("CmdOrCtrl+W")
                .build(app)?,
        )
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .item(
            &MenuItemBuilder::with_id("paste-plain", "Paste and Match Style")
                .accelerator("Shift+CmdOrCtrl+V")
                .build(app)?,
        )
        .select_all()
        .separator()
        .item(
            &MenuItemBuilder::with_id("format", "Format Document")
                .accelerator("Shift+Alt+F")
                .build(app)?,
        )
        .build()?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(
            &MenuItemBuilder::with_id("mode-editor", "Editor Only")
                .accelerator("CmdOrCtrl+1")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("mode-split", "Editor & Preview")
                .accelerator("CmdOrCtrl+2")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("mode-preview", "Preview Only")
                .accelerator("CmdOrCtrl+3")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("toggle-outline", "Toggle Outline")
                .accelerator("Ctrl+CmdOrCtrl+O")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("split-right", "Split Right")
                .accelerator("CmdOrCtrl+D")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("split-down", "Split Down")
                .accelerator("Shift+CmdOrCtrl+D")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("focus-next", "Focus Next Pane")
                .accelerator("Ctrl+Tab")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("focus-prev", "Focus Previous Pane")
                .accelerator("Ctrl+Shift+Tab")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("zoom-in", "Zoom In")
                .accelerator("CmdOrCtrl+=")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("zoom-out", "Zoom Out")
                .accelerator("CmdOrCtrl+-")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("zoom-reset", "Actual Size")
                .accelerator("CmdOrCtrl+0")
                .build(app)?,
        )
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .item(&PredefinedMenuItem::maximize(app, Some("Zoom"))?)
        .separator()
        .fullscreen()
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu])
        .build()?;
    app.set_menu(menu)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be the first plugin: a second launch (e.g. `mdv file.md`)
        // forwards its file/remote args to the running window instead of
        // spawning another app instance.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let specs: Vec<String> = argv
                .into_iter()
                .skip(1)
                .filter(|a| !a.starts_with('-'))
                .collect();
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
            if !specs.is_empty() {
                let _ = app.emit("open-files", specs);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState(Mutex::new(PendingFiles::default())))
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            read_remote,
            write_remote,
            allow_asset,
            path_exists,
            log_error,
            set_recent_files,
            set_menu_accelerators,
            frontend_ready,
            quit_app
        ])
        .setup(|app| {
            // Files passed as CLI arguments (e.g. `markdown notes.md`).
            let args: Vec<String> = std::env::args()
                .skip(1)
                .filter(|a| !a.starts_with('-'))
                .collect();
            if !args.is_empty() {
                let state: State<'_, AppState> = app.state();
                state.0.lock().unwrap().paths.extend(args);
            }
            // A menu failure (e.g. an accelerator the OS rejects) shouldn't
            // prevent the app from starting.
            if let Err(err) = build_menu(app.handle()) {
                eprintln!("failed to build application menu: {err}");
            }
            #[cfg(all(target_os = "macos", not(debug_assertions)))]
            register_as_default_markdown_app();
            Ok(())
        })
        .on_menu_event(|app, event| {
            let _ = app.emit("menu", event.id().as_ref().to_string());
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // macOS: files opened via Finder ("Open With", double-click) arrive
            // as Apple events, not CLI args.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = event {
                // File opens arrive as file:// URLs; mdviewer:// deep links
                // (remote files) pass through as their raw string for the
                // frontend to classify.
                let paths: Vec<String> = urls
                    .iter()
                    .map(|u| {
                        u.to_file_path()
                            .map(|p| p.to_string_lossy().into_owned())
                            .unwrap_or_else(|_| u.to_string())
                    })
                    .collect();
                if paths.is_empty() {
                    return;
                }
                let state: State<'_, AppState> = app.state();
                let mut pending = state.0.lock().unwrap();
                if pending.frontend_ready {
                    drop(pending);
                    let _ = app.emit("open-files", paths);
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.set_focus();
                    }
                } else {
                    pending.paths.extend(paths);
                }
            }
        });
}
