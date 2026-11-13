pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_ngomate::init())
        .setup(|app| {
            // The updater refuses to start without its public key, and a plugin that fails stops the
            // whole app. So it runs only when the build carries an updater section; without one the
            // app never offers an update.
            if app.config().plugins.0.contains_key("updater") {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the app could not start");
}
