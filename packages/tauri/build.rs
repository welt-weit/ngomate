const COMMANDS: &[&str] = &[
    "store_list",
    "store_read",
    "store_write",
    "store_remove",
    "conversation_list",
    "secret_get",
    "secret_set",
    "secret_delete",
    "pick_document",
    "save_document",
    "model_info",
    "folder_choose",
    "wake_set",
    "wake_started_for_jobs",
    "wake_done_with_jobs",
    "file_write_new",
    "voice_info",
    "voice_prepare",
    "voice_transcribe",
    "model_download",
    "model_cancel_download",
    "model_remove",
    "model_import",
    "model_folder_choose",
    "model_folder_reset",
    "runtime_start",
    "runtime_stop",
    "addon_start",
    "addon_send",
    "addon_stop",
    "teams",
    "team_location",
    "team_switch",
    "team_label",
    "team_folder_choose",
    "team_use",
    "team_forget",
    "team_note_copies_load",
    "team_note_copies_save",
    "nextcloud_login_start",
    "nextcloud_login_wait",
    "team_list",
    "team_read",
    "team_write",
    "team_remove",
    "team_file_read",
    "team_file_write",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
    link_clang_runtime();
}

/// whisper.cpp's Metal code asks which macOS it runs on (`@available`). Built for an older macOS than it
/// asks about, as the app is (11.0), that check needs `___isPlatformVersionAtLeast` from clang's runtime
/// library, which rustc leaves out of the link (`-nodefaultlibs`): the release build then fails to link.
fn link_clang_runtime() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let Ok(output) = std::process::Command::new("clang").arg("--print-runtime-dir").output() else {
        return;
    };
    let dir = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() && std::path::Path::new(&dir).join("libclang_rt.osx.a").exists() {
        println!("cargo:rustc-link-search=native={dir}");
        println!("cargo:rustc-link-lib=static=clang_rt.osx");
    }
}
