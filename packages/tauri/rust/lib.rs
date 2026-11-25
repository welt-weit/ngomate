//! What a desktop host needs and a web page cannot do: run a local model, download it, reach the OS
//! keychain, read documents the person picks, keep files, and run connector programs they confirmed.

mod addons;
mod catalog;
mod documents;
mod error;
mod files;
mod guard;
mod models;
mod runtime;
mod store;
mod team;
mod team_s3;
mod team_webdav;
mod voice;
mod wake;

use addons::Addons;
use error::{Error, Result};
use models::{Downloads, FolderChange};
use runtime::{Running, Runtime};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::ipc::Channel;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Manager, RunEvent, Runtime as TauriRuntime, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const KEYCHAIN_SERVICE: &str = "NGOmate";

fn data_root<R: TauriRuntime>(app: &AppHandle<R>) -> Result<PathBuf> {
    Ok(app.path().app_data_dir()?)
}

/// What each model had read of the last conversation, kept so the next answer need not read it again.
fn prompt_cache_dir<R: TauriRuntime>(app: &AppHandle<R>) -> Result<PathBuf> {
    Ok(data_root(app)?.join("prompt-cache"))
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

/// A chat or voice model, for what both are handled alike: downloading, pausing, removing.
fn any_model(id: &str) -> Result<&'static catalog::Model> {
    catalog::find_any(id).ok_or_else(|| Error::msg(format!("Unknown model {id}")))
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
async fn store_remove<R: TauriRuntime>(
    app: AppHandle<R>,
    runtime: State<'_, Runtime>,
    area: String,
    name: String,
) -> Result<()> {
    let area = store::Area::parse(&area)?;
    store::remove(&data_root(&app)?, area, &name)?;
    if matches!(area, store::Area::Conversations) {
        // A deleted conversation must not live on in what the model kept of it.
        runtime.forget(&prompt_cache_dir(&app)?).await;
    }
    Ok(())
}

/// The teams this person is in, kept here: a folder is only ever one the person picked in a native
/// dialog, never a path the interface hands in.
fn teams_record<R: TauriRuntime>(app: &AppHandle<R>) -> Result<PathBuf> {
    Ok(data_root(app)?.join("teams.json"))
}

fn read_teams<R: TauriRuntime>(app: &AppHandle<R>) -> Result<team::Teams> {
    match std::fs::read_to_string(teams_record(app)?) {
        Ok(text) => Ok(serde_json::from_str(&text).unwrap_or_default()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(team::Teams::default()),
        Err(err) => Err(err.into()),
    }
}

fn keep_teams<R: TauriRuntime>(app: &AppHandle<R>, teams: &team::Teams) -> Result<()> {
    std::fs::create_dir_all(data_root(app)?)?;
    let text = serde_json::to_string_pretty(teams).map_err(|err| Error::msg(err.to_string()))?;
    let record = teams_record(app)?;
    let temp = record.with_extension("json.tmp");
    std::fs::write(&temp, text)?;
    std::fs::rename(temp, record)?;
    Ok(())
}

/// Each team's key or password, apart from every other team's.
fn team_secret(id: &str) -> Result<keyring::Entry> {
    keychain_entry(&format!("team:{id}"))
}

fn new_team_id() -> String {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("t{nanos:x}")
}

/// The active team's storage, with its secret from the keychain.
fn team_store<R: TauriRuntime>(app: &AppHandle<R>) -> Result<team::Store> {
    let teams = read_teams(app)?;
    let team = teams.active_team().ok_or_else(|| Error::msg("No team storage is chosen."))?;
    let secret = || -> Result<String> {
        team_secret(&team.id)?
            .get_password()
            .map_err(|_| Error::msg("The team storage's password or key is missing. Set it up again under Team."))
    };
    team::Store::open(&team.location, secret)
}

#[tauri::command]
fn teams<R: TauriRuntime>(app: AppHandle<R>) -> Result<team::Teams> {
    read_teams(&app)
}

#[tauri::command]
fn team_location<R: TauriRuntime>(app: AppHandle<R>) -> Result<Option<team::Location>> {
    Ok(read_teams(&app)?.active_team().map(|team| team.location.clone()))
}

/// Adds a team kept in a folder the person picks, and makes it the active one.
#[tauri::command]
async fn team_folder_choose<R: TauriRuntime>(app: AppHandle<R>) -> Result<Option<String>> {
    let picked = app.dialog().file().set_title("The team's shared folder").blocking_pick_folder();
    let Some(path) = picked.and_then(|folder| folder.into_path().ok()) else { return Ok(None) };
    let path = path.to_string_lossy().into_owned();
    let mut teams = read_teams(&app)?;
    teams.add(team::Location::Folder { path: path.clone() }, new_team_id(), true);
    keep_teams(&app, &teams)?;
    Ok(Some(path))
}

/// Whether this run was started by the helper for jobs, and whether the person has opened the window since.
#[derive(Default)]
struct StartedForJobs {
    started: std::sync::atomic::AtomicBool,
    opened: std::sync::atomic::AtomicBool,
}

impl StartedForJobs {
    fn hidden(&self) -> bool {
        use std::sync::atomic::Ordering::SeqCst;
        self.started.load(SeqCst) && !self.opened.load(SeqCst)
    }
}

/// Sets the times the helper starts NGOmate at for jobs, replacing those before. None removes it.
#[tauri::command]
async fn wake_set<R: TauriRuntime>(app: AppHandle<R>, times: Vec<wake::WakeTime>) -> Result<()> {
    let exe = std::env::current_exe()?;
    let home = app.path().home_dir().map_err(|err| Error::msg(err.to_string()))?;
    tokio::task::spawn_blocking(move || wake::set(&exe, &home, &times))
        .await
        .map_err(|err| Error::msg(err.to_string()))?
}

/// True when this run was started for jobs and its window has not been opened: it closes when done.
#[tauri::command]
fn wake_started_for_jobs(started: State<'_, StartedForJobs>) -> bool {
    started.hidden()
}

/// The jobs of a run started for them are done: the app closes, unless someone opened its window.
#[tauri::command]
fn wake_done_with_jobs<R: TauriRuntime>(app: AppHandle<R>, started: State<'_, StartedForJobs>) {
    if started.hidden() {
        app.exit(0);
    }
}

/// A folder for a job's results, chosen by the person. Only its path is kept, in the job's file.
#[tauri::command]
async fn folder_choose<R: TauriRuntime>(app: AppHandle<R>) -> Result<Option<String>> {
    let picked = app.dialog().file().set_title("Where the job's results go").blocking_pick_folder();
    Ok(picked.and_then(|folder| folder.into_path().ok()).map(|path| path.to_string_lossy().into_owned()))
}

/// Writes a job's result as a new file in its folder, never over one there. Returns the name it got.
#[tauri::command]
async fn file_write_new(folder: String, name: String, text: String) -> Result<String> {
    tokio::task::spawn_blocking(move || files::write_new(Path::new(&folder), &name, &text))
        .await
        .map_err(|err| Error::msg(err.to_string()))?
}

/// Adds a team reached over the network or through a connector, and makes it the active one. With a
/// secret it is checked first: the notes are listed, so a wrong address or key is found here, and a
/// small test file tells whether the storage refuses to overwrite a change.
#[tauri::command]
async fn team_use<R: TauriRuntime>(app: AppHandle<R>, location: team::Location, secret: Option<String>) -> Result<()> {
    location.check()?;
    let mut refuses = true;
    if let Some(secret) = &secret {
        let store = team::Store::open(&location, || Ok(secret.clone()))?;
        store.list(team::Area::Notes).await?;
        refuses = store.refuses_overwrites().await?;
    }
    let mut teams = read_teams(&app)?;
    let id = teams.add(location, new_team_id(), refuses);
    match &secret {
        Some(secret) => team_secret(&id)?.set_password(secret).map_err(|err| Error::msg(err.to_string()))?,
        None => {
            let _ = team_secret(&id)?.delete_credential();
        }
    }
    keep_teams(&app, &teams)
}

#[tauri::command]
fn team_switch<R: TauriRuntime>(app: AppHandle<R>, id: String) -> Result<()> {
    let mut teams = read_teams(&app)?;
    teams.switch(&id)?;
    keep_teams(&app, &teams)
}

/// Remembers the active team's name, read from its team file, for the switcher.
#[tauri::command]
fn team_label<R: TauriRuntime>(app: AppHandle<R>, name: String) -> Result<()> {
    let mut teams = read_teams(&app)?;
    if teams.active_team().and_then(|team| team.name.as_deref()) == Some(name.as_str()) {
        return Ok(());
    }
    teams.label_active(&name);
    keep_teams(&app, &teams)
}

/// Nextcloud's own sign-in: the address to open in the person's browser, and what to wait on.
#[tauri::command]
async fn nextcloud_login_start(server: String) -> Result<team_webdav::LoginStart> {
    team_webdav::nextcloud_login_start(&server).await
}

/// Returns once the person has signed in, with the app password Nextcloud made for NGOmate.
#[tauri::command]
async fn nextcloud_login_wait(poll_url: String, token: String) -> Result<team_webdav::LoginDone> {
    team_webdav::nextcloud_login_wait(&poll_url, &token, std::time::Duration::from_secs(15 * 60)).await
}

/// Leaves the active team on this computer and forgets its secret, going back to the team before. The
/// team's notes stay where they are.
#[tauri::command]
fn team_forget<R: TauriRuntime>(app: AppHandle<R>) -> Result<()> {
    let mut teams = read_teams(&app)?;
    if let Some(removed) = teams.forget_active() {
        let _ = team_secret(&removed.id)?.delete_credential();
        if let Ok(path) = note_copies_path(&app, &removed.id) {
            let _ = std::fs::remove_file(path);
        }
    }
    keep_teams(&app, &teams)
}

/// One note's copy: the version it was read at and its text.
#[derive(serde::Serialize, serde::Deserialize)]
struct NoteCopy {
    version: String,
    text: String,
}

/// A team's notes as last read, by version, so a new start fetches only the notes that changed. One
/// file per team, named by its id, so one team's notes are never read as another's.
fn note_copies_path<R: TauriRuntime>(app: &AppHandle<R>, id: &str) -> Result<PathBuf> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(Error::msg("Not a team on this computer."));
    }
    Ok(data_root(app)?.join("team-notes").join(format!("{id}.json")))
}

/// A team in a synced folder already has every note on this computer, so no copies are kept for it.
fn keeps_note_copies<R: TauriRuntime>(app: &AppHandle<R>, id: &str) -> Result<bool> {
    let teams = read_teams(app)?;
    let team = teams.teams.iter().find(|team| team.id == id).ok_or_else(|| Error::msg("Not a team on this computer."))?;
    Ok(!matches!(team.location, team::Location::Folder { .. }))
}

#[tauri::command]
fn team_note_copies_load<R: TauriRuntime>(app: AppHandle<R>, id: String) -> Result<HashMap<String, NoteCopy>> {
    if !keeps_note_copies(&app, &id)? {
        return Ok(HashMap::new());
    }
    match std::fs::read_to_string(note_copies_path(&app, &id)?) {
        Ok(text) => Ok(serde_json::from_str(&text).unwrap_or_default()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(err) => Err(err.into()),
    }
}

#[tauri::command]
fn team_note_copies_save<R: TauriRuntime>(app: AppHandle<R>, id: String, notes: HashMap<String, NoteCopy>) -> Result<()> {
    if !keeps_note_copies(&app, &id)? {
        return Ok(());
    }
    let path = note_copies_path(&app, &id)?;
    if let Some(folder) = path.parent() {
        std::fs::create_dir_all(folder)?;
    }
    let text = serde_json::to_string(&notes).map_err(|err| Error::msg(err.to_string()))?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, text)?;
    std::fs::rename(temp, path)?;
    Ok(())
}

#[tauri::command]
async fn team_list<R: TauriRuntime>(app: AppHandle<R>, area: String) -> Result<Vec<team::Entry>> {
    team_store(&app)?.list(team::Area::parse(&area)?).await
}

#[tauri::command]
async fn team_read<R: TauriRuntime>(app: AppHandle<R>, area: String, name: String) -> Result<Option<team::Read>> {
    team_store(&app)?.read(team::Area::parse(&area)?, &name).await
}

#[tauri::command]
async fn team_write<R: TauriRuntime>(
    app: AppHandle<R>,
    area: String,
    name: String,
    text: String,
    expected: Option<String>,
) -> Result<team::Written> {
    team_store(&app)?.write(team::Area::parse(&area)?, &name, &text, expected.as_deref()).await
}

#[tauri::command]
async fn team_remove<R: TauriRuntime>(
    app: AppHandle<R>,
    area: String,
    name: String,
    expected: Option<String>,
) -> Result<team::Written> {
    team_store(&app)?.remove(team::Area::parse(&area)?, &name, expected.as_deref()).await
}

#[tauri::command]
async fn team_file_read<R: TauriRuntime>(app: AppHandle<R>) -> Result<Option<team::Read>> {
    team_store(&app)?.read_team_file().await
}

#[tauri::command]
async fn team_file_write<R: TauriRuntime>(
    app: AppHandle<R>,
    text: String,
    expected: Option<String>,
) -> Result<team::Written> {
    team_store(&app)?.write_team_file(&text, expected.as_deref()).await
}

fn keychain_entry(name: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, name).map_err(|err| Error::msg(err.to_string()))
}

/// The secrets the interface may handle: the model server's key and each connector's token. Anything
/// else, such as a team's storage key, stays with this plugin, so a page that has been tricked into
/// running script cannot read, replace or remove it.
fn page_may_use(name: &str) -> bool {
    name == "model-server" || name.strip_prefix("addon:").is_some_and(|id| !id.is_empty())
}

fn page_secret(name: &str) -> Result<keyring::Entry> {
    if !page_may_use(name) {
        return Err(Error::msg("This secret is not available to the interface."));
    }
    keychain_entry(name)
}

#[tauri::command]
fn secret_get(name: String) -> Result<Option<String>> {
    match page_secret(&name)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(Error::msg(err.to_string())),
    }
}

#[tauri::command]
fn secret_set(name: String, value: String) -> Result<()> {
    page_secret(&name)?.set_password(&value).map_err(|err| Error::msg(err.to_string()))
}

#[tauri::command]
fn secret_delete(name: String) -> Result<()> {
    match page_secret(&name)?.delete_credential() {
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
fn model_info<R: TauriRuntime>(
    app: AppHandle<R>,
    runtime: State<'_, Runtime>,
    downloads: State<'_, Downloads>,
) -> Result<ModelInfo> {
    let dir = models_dir(&app)?;
    let folder_available = usable_models_dir(&app).is_ok();
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    Ok(ModelInfo {
        models: models::entries(&dir, &downloads),
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
    let entry = any_model(&id)?;
    app.state::<FolderChange>().check()?;
    let dir = usable_models_dir(&app)?;
    models::download(&dir, &downloads, entry, entry.url, move |progress| {
        let _ = on_progress.send(progress);
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceInfo {
    models: Vec<models::ModelEntry>,
    /// The size that suits this computer, offered first and fetched on the first press of the mic.
    recommended: &'static str,
    free_disk_bytes: u64,
}

#[tauri::command]
fn voice_info<R: TauriRuntime>(app: AppHandle<R>, downloads: State<'_, Downloads>) -> Result<VoiceInfo> {
    let dir = models_dir(&app)?;
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    Ok(VoiceInfo {
        models: models::entries_of(catalog::VOICE_MODELS, &dir, &downloads),
        recommended: voice::recommended(total_ram_gb(&system)),
        free_disk_bytes: models::free_disk_bytes(&dir),
    })
}

/// Loads the voice model when the microphone starts listening, so it is ready when the person stops.
#[tauri::command]
async fn voice_prepare<R: TauriRuntime>(
    app: AppHandle<R>,
    voice: State<'_, std::sync::Arc<voice::Voice>>,
    id: String,
) -> Result<()> {
    let entry = catalog::find_voice(&id).ok_or_else(|| Error::msg(format!("Unknown voice model {id}")))?;
    let path = models::installed_path(&usable_models_dir(&app)?, entry);
    voice::prepare(std::sync::Arc::clone(&voice), id, path).await
}

/// Turns a recording into text with a voice model on this computer. The recording is not kept. It
/// arrives as raw bytes (32-bit float samples), not as JSON: a minute of speech is a million numbers.
#[tauri::command]
async fn voice_transcribe<R: TauriRuntime>(
    app: AppHandle<R>,
    voice: State<'_, std::sync::Arc<voice::Voice>>,
    request: tauri::ipc::Request<'_>,
) -> Result<String> {
    let id = request
        .headers()
        .get("x-voice-model")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| Error::msg("No voice model was named."))?
        .to_string();
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(Error::msg("The recording did not arrive as sound."));
    };
    let samples = voice::samples_from_bytes(bytes)?;
    let entry = catalog::find_voice(&id).ok_or_else(|| Error::msg(format!("Unknown voice model {id}")))?;
    let path = models::installed_path(&usable_models_dir(&app)?, entry);
    if !path.exists() {
        return Err(Error::msg("The voice model is not downloaded yet."));
    }
    voice::transcribe(std::sync::Arc::clone(&voice), id, path, samples).await
}

#[tauri::command]
fn model_cancel_download(downloads: State<'_, Downloads>, id: String) {
    downloads.cancel(&id);
}

#[tauri::command]
async fn model_remove<R: TauriRuntime>(app: AppHandle<R>, runtime: State<'_, Runtime>, id: String) -> Result<()> {
    let entry = any_model(&id)?;
    // A voice model in use is let go first, so its file can be removed.
    app.state::<std::sync::Arc<voice::Voice>>().forget(&id);
    app.state::<FolderChange>().check()?;
    // Held to the end, so a save under way cannot write the file back and a start cannot load the model.
    let _settled = runtime.settled().await;
    if runtime.running_id().as_deref() == Some(id.as_str()) {
        runtime.stop();
    }
    // The model's read of a conversation is no use without the model.
    let _ = std::fs::remove_file(runtime::cache_file(&prompt_cache_dir(&app)?, entry.file));
    models::remove(&models_dir(&app)?, entry).await
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
    // A save under way still holds the model's file, and would keep it open through the move.
    let _settled = runtime.settled().await;
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Started {
    #[serde(flatten)]
    running: Running,
    search_knowledge_first: bool,
}

#[tauri::command]
async fn runtime_start<R: TauriRuntime>(app: AppHandle<R>, runtime: State<'_, Runtime>, id: String) -> Result<Started> {
    app.state::<FolderChange>().check()?;
    let entry = model(&id)?;
    let server = runtime::find_server(app.path().resource_dir().ok())?;
    let path = models::installed_path(&usable_models_dir(&app)?, entry);
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    let folder = prompt_cache_dir(&app)?;
    // Without the folder the model still runs; it only reads each conversation again after a stop.
    let cache = std::fs::create_dir_all(&folder).ok().map(|_| runtime::cache_file(&folder, entry.file));
    let in_use: Vec<PathBuf> = catalog::MODELS.iter().map(|model| runtime::cache_file(&folder, model.file)).collect();
    runtime::prune_kept(&folder, &in_use);
    let running = runtime.start(&server, &id, &path, runtime::context_for_ram(total_ram_gb(&system)), cache).await?;
    Ok(Started { running, search_knowledge_first: entry.search_knowledge_first })
}

#[tauri::command]
async fn runtime_stop(runtime: State<'_, Runtime>) -> Result<()> {
    runtime.stop_and_keep().await;
    Ok(())
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
            folder_choose,
            file_write_new,
            wake_set,
            wake_started_for_jobs,
            wake_done_with_jobs,
            voice_info,
            voice_prepare,
            voice_transcribe,
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
            teams,
            team_location,
            team_switch,
            team_label,
            team_folder_choose,
            team_use,
            team_forget,
            team_note_copies_load,
            team_note_copies_save,
            nextcloud_login_start,
            nextcloud_login_wait,
            team_list,
            team_read,
            team_write,
            team_remove,
            team_file_read,
            team_file_write,
        ])
        .setup(|app, _api| {
            let started = StartedForJobs::default();
            if std::env::args().any(|argument| argument == wake::RUN_JOBS_ARG) {
                started.started.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            app.manage(started);
            app.manage(Runtime::default());
            app.manage(Downloads::default());
            app.manage(FolderChange::default());
            app.manage(Addons::default());
            app.manage(std::sync::Arc::new(voice::Voice::default()));
            Ok(())
        })
        .on_window_ready(|window| {
            // Started for jobs: they run without a window, until the person opens it.
            if window.state::<StartedForJobs>().hidden() {
                let _ = window.hide();
            }
        })
        .on_event(|app, event| {
            // Opened from the Dock while running for jobs: the window shows, and the app stays open.
            #[cfg(target_os = "macos")]
            if let RunEvent::Reopen { .. } = event {
                let started = app.state::<StartedForJobs>();
                if started.hidden() {
                    started.opened.store(true, std::sync::atomic::Ordering::SeqCst);
                    for window in app.webview_windows().values() {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
            // A model left running would hold gigabytes of memory after the window closed.
            if let RunEvent::Exit = event {
                let runtime = app.state::<Runtime>();
                // Keeps what the model read, so the first answer after a relaunch is quick. A quit waits
                // this long at most; a save cut short is dropped at the next start.
                // The timer is made inside the async runtime: made outside it, Tokio panics and the quit crashes.
                tauri::async_runtime::block_on(async {
                    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), runtime.stop_and_keep()).await;
                });
                runtime.stop();
                app.state::<Addons>().stop_all();
            }
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The interface reads these names, so a model's choice silently stops reaching chat if they change.
    #[test]
    fn a_started_model_reports_whether_to_search_first() {
        let running = Running { base_url: "http://127.0.0.1:1/v1".into(), api_key: "k".into(), id: "m".into(), context_tokens: 4096 };
        let json = serde_json::to_value(Started { running, search_knowledge_first: true }).unwrap();
        assert_eq!(json["baseUrl"], "http://127.0.0.1:1/v1");
        assert_eq!(json["contextTokens"], 4096);
        assert_eq!(json["searchKnowledgeFirst"], true);
    }

    #[test]
    fn the_interface_cannot_reach_a_teams_secret() {
        for name in ["model-server", "addon:addon-mf3k2-x7q9a1"] {
            assert!(page_may_use(name), "{name:?} should be allowed");
        }
        for name in ["team:t1", "team:", "", "addon:", "model-server-2", "Addon:x", "other"] {
            assert!(!page_may_use(name), "{name:?} should be refused");
        }
    }

    #[test]
    fn only_the_smallest_catalog_model_searches_first() {
        let first: Vec<_> = catalog::MODELS.iter().filter(|model| model.search_knowledge_first).map(|model| model.id).collect();
        assert_eq!(first, ["granite-4.2-3b-q4"]);
    }
}
