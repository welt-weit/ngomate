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
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
