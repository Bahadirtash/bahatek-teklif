mod gmail;

/// Yalnızca geliştirme sürümü: BAHATEK_SELFTEST=<eml yolu> ve BAHATEK_SELFTEST_ARCHIVE=<klasör>
/// verilirse arayüz uçtan uca öz-test çalıştırır (src/devtest.ts).
#[tauri::command]
fn dev_selftest() -> Option<(String, String)> {
    if !cfg!(debug_assertions) {
        return None;
    }
    Some((std::env::var("BAHATEK_SELFTEST").ok()?, std::env::var("BAHATEK_SELFTEST_ARCHIVE").ok()?))
}

#[tauri::command]
fn dev_exit(app: tauri::AppHandle) {
    if cfg!(debug_assertions) {
        app.exit(0);
    }
}
mod offer;
mod store;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        use tauri::Manager;
        // Açılışta başlayan uygulama ikinci kez açılırsa mevcut pencereyi öne getir.
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }))
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                Some(vec!["--autostart"]),
            ));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(gmail::GmailState::default())
        .invoke_handler(tauri::generate_handler![
            store::store_read,
            store::store_write,
            store::default_archive_root,
            store::read_eml,
            store::record_items,
            store::record_result,
            store::record_file,
            store::log_frontend,
            offer::save_offer,
            gmail::gmail_status,
            gmail::gmail_connect,
            gmail::gmail_disconnect,
            gmail::gmail_list,
            gmail::gmail_raw,
            dev_selftest,
            dev_exit,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
