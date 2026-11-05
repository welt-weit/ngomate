//! What a desktop host needs and a web page cannot do: run a local model, download it, reach the OS
//! keychain, read documents the person picks, keep files, and run connector programs they confirmed.

mod addons;
mod catalog;
mod documents;
mod error;
mod models;
mod runtime;
mod store;

use addons::Addons;
use error::{Error, Result};
use models::{Downloads, FolderChange};
use runtime::{Running, Runtime};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::ipc::Channel;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Manager, RunEvent, Runtime as TauriRuntime, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const KEYCHAIN_SERVICE: &str = "NGOmate";

fn data_root<R: TauriRuntime>(app: &AppHandle<R>) -> Result<PathBuf> {
    Ok(app.path().app_data_dir()?)
}

/// One folder per user, not per app, so two hosts do not each download 5 GB.
fn shared_dir<R: TauriRuntime>(app: &AppHandle<R>) -> Result<PathBuf> {
    Ok(app.path().data_dir()?.join("NGOmate"))
}

fn default_models_dir<R: TauriRuntime>(app: &AppHandle<R>) -> Result<PathBuf> {
    Ok(shared_dir(app)?.join("models"))
}

/// The folder the person chose, kept beside the models so that every host on this computer agrees.
fn chosen_models_dir<R: TauriRuntime>(app: &AppHandle<R>) -> Result<Option<PathBuf>> {
    let text = std::fs::read_to_string(shared_dir(app)?.join("model-folder.txt")).ok();
    Ok(text.map(|path| PathBuf::from(path.trim())).filter(|path| path.is_absolute()))
}

fn choose_models_dir<R: TauriRuntime>(app: &AppHandle<R>, folder: Option<&Path>) -> Result<()> {
    let record = shared_dir(app)?.join("model-folder.txt");
    std::fs::create_dir_all(shared_dir(app)?)?;
    match folder {
        Some(path) => std::fs::write(record, path.to_string_lossy().as_bytes())?,
        None => {
            let _ = std::fs::remove_file(record);
        }
    }
    Ok(())
}

fn models_dir<R: TauriRuntime>(app: &AppHandle<R>) -> Result<PathBuf> {
    if let Ok(path) = std::env::var("NGOMATE_MODELS_DIR") {
        return Ok(PathBuf::from(path));
    }
    Ok(chosen_models_dir(app)?.map_or(default_models_dir(app)?, |path| path))
}

/// Creating a missing folder on a drive that is unplugged would make an empty one in its place, and the
/// models would look as if they had never been downloaded.
fn usable_models_dir<R: TauriRuntime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let dir = models_dir(app)?;
    if !dir.exists() && chosen_models_dir(app)?.as_deref() == Some(dir.as_path()) {
        return Err(Error::msg(format!(
            "The model folder {} is not available. Connect its drive, or choose another folder under Model.",
            dir.display()
        )));
    }
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn model(id: &str) -> Result<&'static catalog::Model> {
    catalog::find(id).ok_or_else(|| Error::msg(format!("Unknown model {id}")))
}

#[tauri::command]
fn store_list<R: TauriRuntime>(app: AppHandle<R>, area: String) -> Result<Vec<store::Entry>> {
    store::list(&data_root(&app)?, store::Area::parse(&area)?)
}

#[tauri::command]
fn store_read<R: TauriRuntime>(app: AppHandle<R>, area: String, name: String) -> Result<Option<String>> {
    store::read(&data_root(&app)?, store::Area::parse(&area)?, &name)
}

#[tauri::command]
fn store_write<R: TauriRuntime>(app: AppHandle<R>, area: String, name: String, text: String) -> Result<()> {
    store::write(&data_root(&app)?, store::Area::parse(&area)?, &name, &text)
}

#[tauri::command]
fn conversation_list<R: TauriRuntime>(app: AppHandle<R>) -> Result<Vec<store::ConversationSummary>> {
    store::conversation_summaries(&data_root(&app)?)
}

#[tauri::command]
fn store_remove<R: TauriRuntime>(app: AppHandle<R>, area: String, name: String) -> Result<()> {
    store::remove(&data_root(&app)?, store::Area::parse(&area)?, &name)
}

fn keychain_entry(name: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, name).map_err(|err| Error::msg(err.to_string()))
}

#[tauri::command]
fn secret_get(name: String) -> Result<Option<String>> {
    match keychain_entry(&name)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(Error::msg(err.to_string())),
    }
}

#[tauri::command]
fn secret_set(name: String, value: String) -> Result<()> {
    keychain_entry(&name)?.set_password(&value).map_err(|err| Error::msg(err.to_string()))
}

#[tauri::command]
fn secret_delete(name: String) -> Result<()> {
    match keychain_entry(&name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(Error::msg(err.to_string())),
    }
}

/// The dialog runs here rather than in the page, so the page can only read what the person picked.
#[tauri::command]
async fn pick_document<R: TauriRuntime>(app: AppHandle<R>) -> Result<Option<documents::Document>> {
    let picked = app
        .dialog()
        .file()
        .add_filter("Documents", &["pdf", "docx", "txt", "md", "csv", "html"])
        .blocking_pick_file();
    let Some(path) = picked.and_then(|file| file.into_path().ok()) else { return Ok(None) };
    tauri::async_runtime::spawn_blocking(move || documents::read_document(&path).map(Some))
        .await
        .map_err(|err| Error::msg(err.to_string()))?
}

#[tauri::command]
async fn save_document<R: TauriRuntime>(app: AppHandle<R>, suggested_name: String, text: String) -> Result<bool> {
    let picked = app.dialog().file().set_file_name(&suggested_name).blocking_save_file();
    let Some(path) = picked.and_then(|file| file.into_path().ok()) else { return Ok(false) };
    tokio::fs::write(path, text).await?;
    Ok(true)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelInfo {
    models: Vec<models::ModelEntry>,
    ram_gb: u64,
    free_ram_gb: f64,
    free_disk_bytes: u64,
    running_id: Option<String>,
    folder: String,
    folder_available: bool,
    folder_is_default: bool,
}

fn total_ram_gb(system: &sysinfo::System) -> u64 {
    (system.total_memory() as f64 / 1_073_741_824.0).round() as u64
}

#[tauri::command]
fn model_info<R: TauriRuntime>(app: AppHandle<R>, runtime: State<'_, Runtime>) -> Result<ModelInfo> {
    let dir = models_dir(&app)?;
    let folder_available = usable_models_dir(&app).is_ok();
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    Ok(ModelInfo {
        models: models::entries(&dir),
        ram_gb: total_ram_gb(&system),
        free_ram_gb: models::free_ram_gb(system.total_memory(), system.used_memory(), system.available_memory()),
        free_disk_bytes: models::free_disk_bytes(&dir),
        running_id: runtime.running_id(),
        folder: dir.to_string_lossy().into_owned(),
        folder_available,
        folder_is_default: chosen_models_dir(&app)?.is_none(),
    })
}

#[tauri::command]
async fn model_download<R: TauriRuntime>(
    app: AppHandle<R>,
    downloads: State<'_, Downloads>,
    id: String,
    on_progress: Channel<models::Progress>,
) -> Result<()> {
    let entry = model(&id)?;
    app.state::<FolderChange>().check()?;
    let dir = usable_models_dir(&app)?;
    models::download(&dir, &downloads, entry, entry.url, move |progress| {
        let _ = on_progress.send(progress);
    })
    .await
}

#[tauri::command]
fn model_cancel_download(downloads: State<'_, Downloads>, id: String) {
    downloads.cancel(&id);
}

#[tauri::command]
async fn model_remove<R: TauriRuntime>(app: AppHandle<R>, runtime: State<'_, Runtime>, id: String) -> Result<()> {
    if runtime.running_id().as_deref() == Some(id.as_str()) {
        runtime.stop();
    }
    app.state::<FolderChange>().check()?;
    models::remove(&models_dir(&app)?, model(&id)?).await
}

#[tauri::command]
async fn model_import<R: TauriRuntime>(app: AppHandle<R>, id: String) -> Result<bool> {
    let picked = app.dialog().file().add_filter("Model file", &["gguf"]).blocking_pick_file();
    let Some(path) = picked.and_then(|file| file.into_path().ok()) else { return Ok(false) };
    app.state::<FolderChange>().check()?;
    models::import(&usable_models_dir(&app)?, model(&id)?, &path).await?;
    Ok(true)
}

/// The running model holds its file open, and a download is writing one, so neither can be mid-way.
async fn switch_models_folder<R: TauriRuntime>(
    app: &AppHandle<R>,
    runtime: &Runtime,
    downloads: &Downloads,
    target: Option<PathBuf>,
) -> Result<()> {
    if downloads.any_active() {
        return Err(Error::msg("Pause the download first."));
    }
    let change = app.state::<FolderChange>();
    let _held = change.begin()?;
    if std::env::var("NGOMATE_MODELS_DIR").is_ok() {
        return Err(Error::msg("The model folder is set by NGOMATE_MODELS_DIR."));
    }
    let from = models_dir(app)?;
    let to = match &target {
        Some(path) => path.clone(),
        None => default_models_dir(app)?,
    };
    if from == to {
        return Ok(());
    }
    if from.exists() && models::has_models(&from) {
        let shown = format!("Move your models to {}? Until it finishes, the app cannot use them. If you leave them, they stay where they are and this folder starts empty.", to.display());
        let moving = app
            .dialog()
            .message(shown)
            .title("Move your models?")
            .buttons(MessageDialogButtons::OkCancelCustom("Move them".to_string(), "Leave them".to_string()))
            .blocking_show();
        // Only now: the model holds its file open, and this can be a long way into an answer.
        runtime.stop();
        if moving {
            models::move_folder(&from, &to).await?;
        }
    }
    runtime.stop();
    tokio::fs::create_dir_all(&to).await?;
    choose_models_dir(app, target.as_deref())
}

#[tauri::command]
async fn model_folder_choose<R: TauriRuntime>(
    app: AppHandle<R>,
    runtime: State<'_, Runtime>,
    downloads: State<'_, Downloads>,
) -> Result<bool> {
    let picked = app.dialog().file().blocking_pick_folder();
    let Some(path) = picked.and_then(|folder| folder.into_path().ok()) else { return Ok(false) };
    switch_models_folder(&app, &runtime, &downloads, Some(path)).await?;
    Ok(true)
}

#[tauri::command]
async fn model_folder_reset<R: TauriRuntime>(
    app: AppHandle<R>,
    runtime: State<'_, Runtime>,
    downloads: State<'_, Downloads>,
) -> Result<()> {
    switch_models_folder(&app, &runtime, &downloads, None).await
}

#[tauri::command]
async fn runtime_start<R: TauriRuntime>(app: AppHandle<R>, runtime: State<'_, Runtime>, id: String) -> Result<Running> {
    app.state::<FolderChange>().check()?;
    let entry = model(&id)?;
    let server = runtime::find_server(app.path().resource_dir().ok())?;
    let path = models::installed_path(&usable_models_dir(&app)?, entry);
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    runtime.start(&server, &id, &path, runtime::context_for_ram(total_ram_gb(&system))).await
}

#[tauri::command]
fn runtime_stop(runtime: State<'_, Runtime>) {
    runtime.stop();
}

/// A program runs with the person's permissions, so the exact command is confirmed in a native dialog
/// the page cannot draw or answer.
#[tauri::command]
async fn addon_start<R: TauriRuntime>(
    app: AppHandle<R>,
    addons: State<'_, Addons>,
    id: String,
    command: String,
    args: Vec<String>,
    on_line: Channel<String>,
    on_close: Channel<()>,
) -> Result<()> {
    let approvals = data_root(&app)?.join("approved-programs.json");
    if !addons::is_approved(&approvals, &command, &args) {
        let shown = std::iter::once(command.as_str()).chain(args.iter().map(String::as_str)).collect::<Vec<_>>().join(" ");
        let allowed = app
            .dialog()
            .message(format!("A connector wants to run this program on your computer, with your permissions:\n\n{shown}\n\nOnly allow it if you trust it."))
            .title("Run this program?")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("Run it".to_string(), "Don't run".to_string()))
            .blocking_show();
        if !allowed {
            return Err(Error::msg("You chose not to run this program."));
        }
        addons::approve(&approvals, &command, &args)?;
    }
    addons
        .start(
            &id,
            &command,
            &args,
            move |line| {
                let _ = on_line.send(line);
            },
            move || {
                let _ = on_close.send(());
            },
        )
        .await
}

#[tauri::command]
async fn addon_send(addons: State<'_, Addons>, id: String, line: String) -> Result<()> {
    addons.send(&id, &line).await
}

#[tauri::command]
async fn addon_stop(addons: State<'_, Addons>, id: String) -> Result<()> {
    addons.stop(&id).await;
    Ok(())
}

pub fn init<R: TauriRuntime>() -> TauriPlugin<R> {
    Builder::new("ngomate")
        .invoke_handler(tauri::generate_handler![
            store_list,
            store_read,
            store_write,
            store_remove,
            conversation_list,
            secret_get,
            secret_set,
            secret_delete,
            pick_document,
            save_document,
            model_info,
            model_download,
            model_cancel_download,
            model_remove,
            model_import,
            model_folder_choose,
            model_folder_reset,
            runtime_start,
            runtime_stop,
            addon_start,
            addon_send,
            addon_stop,
        ])
        .setup(|app, _api| {
            app.manage(Runtime::default());
            app.manage(Downloads::default());
            app.manage(FolderChange::default());
            app.manage(Addons::default());
            Ok(())
        })
        .on_event(|app, event| {
            // A model left running would hold gigabytes of memory after the window closed.
            if let RunEvent::Exit = event {
                app.state::<Runtime>().stop();
                app.state::<Addons>().stop_all();
            }
        })
        .build()
}
