mod menu;

pub fn run() {
    let builder = tauri::Builder::default();
    // First, as its documentation asks: an invite link opened while the app runs reaches this window.
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {}));
    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_ngomate::init())
        .invoke_handler(tauri::generate_handler![menu::menu_update])
        .on_menu_event(|app, event| menu::handle(app, event.id().as_ref()))
        .setup(|app| {
            // The macOS menu bar, until the interface sends the teams.
            #[cfg(target_os = "macos")]
            app.set_menu(menu::build(app.handle(), &menu::MenuState::default())?)?;
            // The updater refuses to start without its public key, and a plugin that fails stops the
            // whole app. So it runs only when the build carries an updater section; without one the
            // app never offers an update.
            if app.config().plugins.0.contains_key("updater") {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            // macOS learns the scheme from the installed app; Windows and Linux are told at start, which
            // also covers a build run without installing. Invites still work pasted if this fails.
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register_all();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the app could not start");
}
