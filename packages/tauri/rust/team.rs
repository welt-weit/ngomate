//! A team's notes, tasks and jobs in a folder the team's own sync app shares: Google Drive, OneDrive,
//! Dropbox, Nextcloud, Syncthing. The app only reads and writes files; moving them is the sync app's job.
//!
//! Only the folder the person picked in a native dialog is ever touched, and inside it only `notes/`,
//! `tasks/`, `jobs/`, `job-states/` and the team file, so the interface cannot point this anywhere else.

use crate::error::{Error, Result};
use crate::store::check_name;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const TEAM_FILE: &str = "ngomate-team.json";

/// Where a team keeps its notes. Only addresses and names: secrets live in the keychain.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Location {
    /// Chosen in a native dialog only, never handed in by the interface.
    Folder { path: String },
    /// A connector offering the team memory tools; the app talks to it, not this plugin.
    Connector { addon_id: String },
    S3 { endpoint: String, region: String, bucket: String, access_key_id: String },
    Webdav { url: String, user: String },
}

/// https, or http on this computer only, with no user name or password in the address.
pub fn allowed_address(raw: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(raw) else { return false };
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    match url.scheme() {
        "https" => true,
        "http" => matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")),
        _ => false,
    }
}

impl Location {
    /// For a location the interface hands in. A folder never comes that way.
    pub fn check(&self) -> Result<()> {
        let fine = match self {
            Location::Folder { .. } => false,
            Location::Connector { addon_id } => !addon_id.trim().is_empty(),
            Location::S3 { endpoint, bucket, access_key_id, .. } => {
                allowed_address(endpoint) && !bucket.trim().is_empty() && !access_key_id.trim().is_empty()
            }
            Location::Webdav { url, user } => allowed_address(url) && !user.trim().is_empty(),
        };
        if fine {
            Ok(())
        } else {
            Err(Error::msg("That team storage address is not one the app can use: it needs https."))
        }
    }
}

impl Location {
    /// The same place, whatever key or account reaches it: joining it again replaces, never duplicates.
    fn same_place(&self, other: &Location) -> bool {
        match (self, other) {
            (Location::Folder { path: a }, Location::Folder { path: b }) => a == b,
            (Location::Connector { addon_id: a }, Location::Connector { addon_id: b }) => a == b,
            (Location::S3 { endpoint: a, bucket: x, .. }, Location::S3 { endpoint: b, bucket: y, .. }) => {
                a.trim_end_matches('/') == b.trim_end_matches('/') && x == y
            }
            (Location::Webdav { url: a, .. }, Location::Webdav { url: b, .. }) => a.trim_end_matches('/') == b.trim_end_matches('/'),
            _ => false,
        }
    }
}

/// One team this person is in.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Team {
    pub id: String,
    /// From the team file, kept for the switcher so it can name a team it cannot reach right now.
    pub name: Option<String>,
    pub location: Location,
    /// False when the storage did not refuse a write over a changed file when tested.
    #[serde(default = "refuses_by_default")]
    pub refuses_overwrites: bool,
}

fn refuses_by_default() -> bool {
    true
}

/// Every team this person is in, one of them active.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Teams {
    pub active: Option<String>,
    /// The team active before the last one was added, to go back to if joining fails.
    #[serde(default)]
    pub previous: Option<String>,
    #[serde(default)]
    pub teams: Vec<Team>,
}

impl Teams {
    pub fn active_team(&self) -> Option<&Team> {
        let id = self.active.as_ref()?;
        self.teams.iter().find(|team| &team.id == id)
    }

    /// Adds a team and makes it active. A place already listed is updated and made active instead,
    /// so the same team never appears twice. Returns the team's id.
    pub fn add(&mut self, location: Location, new_id: String, refuses_overwrites: bool) -> String {
        let previous = self.active.clone();
        let id = match self.teams.iter_mut().find(|team| team.location.same_place(&location)) {
            Some(team) => {
                team.location = location;
                team.refuses_overwrites = refuses_overwrites;
                team.id.clone()
            }
            None => {
                self.teams.push(Team { id: new_id.clone(), name: None, location, refuses_overwrites });
                new_id
            }
        };
        if previous.as_deref() != Some(id.as_str()) {
            self.previous = previous;
        }
        self.active = Some(id.clone());
        id
    }

    pub fn switch(&mut self, id: &str) -> Result<()> {
        if !self.teams.iter().any(|team| team.id == id) {
            return Err(Error::msg("That team is not on this computer."));
        }
        if self.active.as_deref() != Some(id) {
            self.previous = self.active.take();
            self.active = Some(id.to_string());
        }
        Ok(())
    }

    /// Removes the active team and goes back to the one before, or another. Returns the removed one.
    pub fn forget_active(&mut self) -> Option<Team> {
        let id = self.active.take()?;
        let at = self.teams.iter().position(|team| team.id == id)?;
        let removed = self.teams.remove(at);
        let back = self.previous.take().filter(|previous| self.teams.iter().any(|team| &team.id == previous));
        self.active = back.or_else(|| self.teams.first().map(|team| team.id.clone()));
        Some(removed)
    }

    pub fn label_active(&mut self, name: &str) {
        let Some(id) = self.active.clone() else { return };
        if let Some(team) = self.teams.iter_mut().find(|team| team.id == id) {
            team.name = Some(name.chars().take(80).collect());
        }
    }
}

/// The storage behind a location, ready to read and write.
pub enum Store {
    Folder(PathBuf),
    S3(crate::team_s3::S3),
    Webdav(crate::team_webdav::Dav),
}

impl Store {
    pub fn open(location: &Location, secret: impl FnOnce() -> Result<String>) -> Result<Store> {
        match location {
            Location::Folder { path } => {
                let folder = PathBuf::from(path);
                if !folder.is_absolute() {
                    return Err(Error::msg("No team folder is chosen."));
                }
                if !folder.is_dir() {
                    return Err(Error::msg("The team folder cannot be reached. Is the drive or sync app there?"));
                }
                Ok(Store::Folder(folder))
            }
            Location::Connector { .. } => Err(Error::msg("This team is kept by a connector, which the app reaches itself.")),
            Location::S3 { endpoint, region, bucket, access_key_id } => {
                Ok(Store::S3(crate::team_s3::S3::new(endpoint, region, bucket, access_key_id, secret()?)?))
            }
            Location::Webdav { url, user } => Ok(Store::Webdav(crate::team_webdav::Dav::new(url, user, secret()?)?)),
        }
    }

    pub async fn list(&self, area: Area) -> Result<Vec<Entry>> {
        match self {
            Store::Folder(root) => list(root, area),
            Store::S3(s) => s.list(area).await,
            Store::Webdav(d) => d.list(area).await,
        }
    }

    pub async fn read(&self, area: Area, name: &str) -> Result<Option<Read>> {
        match self {
            Store::Folder(root) => read(root, area, name),
            Store::S3(s) => s.read(area, name).await,
            Store::Webdav(d) => d.read(area, name).await,
        }
    }

    pub async fn write(&self, area: Area, name: &str, text: &str, expected: Option<&str>) -> Result<Written> {
        match self {
            Store::Folder(root) => write(root, area, name, text, expected),
            Store::S3(s) => s.write(area, name, text, expected).await,
            Store::Webdav(d) => d.write(area, name, text, expected).await,
        }
    }

    pub async fn remove(&self, area: Area, name: &str, expected: Option<&str>) -> Result<Written> {
        match self {
            Store::Folder(root) => remove(root, area, name, expected),
            Store::S3(s) => s.remove(area, name, expected).await,
            Store::Webdav(d) => d.remove(area, name, expected).await,
        }
    }

    pub async fn read_team_file(&self) -> Result<Option<Read>> {
        match self {
            Store::Folder(root) => read_team_file(root),
            Store::S3(s) => s.read_team_file().await,
            Store::Webdav(d) => d.read_team_file().await,
        }
    }

    /// Whether the storage refuses to write over something that changed, tested with a small file of
    /// its own that is removed again. A shared folder is checked on this computer, so always.
    pub async fn refuses_overwrites(&self) -> Result<bool> {
        match self {
            Store::Folder(_) => Ok(true),
            Store::S3(s) => s.refuses_overwrites().await,
            Store::Webdav(d) => d.refuses_overwrites().await,
        }
    }

    pub async fn write_team_file(&self, text: &str, expected: Option<&str>) -> Result<Written> {
        match self {
            Store::Folder(root) => write_team_file(root, text, expected),
            Store::S3(s) => s.write_team_file(text, expected).await,
            Store::Webdav(d) => d.write_team_file(text, expected).await,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Area {
    Notes,
    Tasks,
    /// Jobs the team shares, as Markdown beside its tasks, and their state as JSON in its own folder.
    Jobs,
    JobStates,
}

impl Area {
    pub fn parse(name: &str) -> Result<Area> {
        match name {
            "notes" => Ok(Area::Notes),
            "tasks" => Ok(Area::Tasks),
            "jobs" => Ok(Area::Jobs),
            "job-states" => Ok(Area::JobStates),
            _ => Err(Error::msg(format!("Unknown team area {name}"))),
        }
    }

    pub fn folder(self) -> &'static str {
        match self {
            Area::Notes => "notes",
            Area::Tasks => "tasks",
            Area::Jobs => "jobs",
            Area::JobStates => "job-states",
        }
    }

    /// The ending of each file's name, without its dot.
    pub fn extension(self) -> &'static str {
        match self {
            Area::JobStates => "json",
            _ => "md",
        }
    }

    /// What a file in this area is, for storage that keeps a content type.
    pub fn content_type(self) -> &'static str {
        match self {
            Area::JobStates => "application/json; charset=utf-8",
            _ => "text/markdown; charset=utf-8",
        }
    }

    /// A file's name in this area, ending included.
    pub fn file_name(self, name: &str) -> String {
        format!("{name}.{}", self.extension())
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub version: String,
    pub updated_at: Option<u64>,
    pub bytes: u64,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Read {
    pub text: String,
    pub version: String,
}

/// `conflict` when the file was not the version the write expected; then nothing was written.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Written {
    pub version: Option<String>,
    pub conflict: bool,
}

/// The content decides the version: a sync app may change a file's time without changing it.
fn version_of(bytes: &[u8]) -> String {
    hex::encode(&Sha256::digest(bytes)[..16])
}

fn note_path(root: &Path, area: Area, name: &str) -> Result<PathBuf> {
    check_name(name)?;
    Ok(root.join(area.folder()).join(area.file_name(name)))
}

fn current_version(path: &Path) -> Result<Option<String>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(version_of(&bytes))),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.into()),
    }
}

/// Written beside the file and renamed, so a sync app never picks up half a note.
fn replace(path: &Path, text: &str) -> Result<()> {
    let folder = path.parent().ok_or_else(|| Error::msg("No folder"))?;
    std::fs::create_dir_all(folder)?;
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    let temp = folder.join(format!(".ngomate-{nanos}.tmp"));
    std::fs::write(&temp, text)?;
    std::fs::rename(&temp, path)?;
    Ok(())
}

fn write_checked(path: &Path, text: &str, expected: Option<&str>) -> Result<Written> {
    if current_version(path)?.as_deref() != expected {
        return Ok(Written { version: None, conflict: true });
    }
    replace(path, text)?;
    Ok(Written { version: Some(version_of(text.as_bytes())), conflict: false })
}

pub fn list(root: &Path, area: Area) -> Result<Vec<Entry>> {
    let folder = root.join(area.folder());
    if !folder.exists() {
        return Ok(vec![]);
    }
    let mut entries = vec![];
    for item in std::fs::read_dir(folder)? {
        let item = item?;
        let path = item.path();
        if path.extension().and_then(|e| e.to_str()) != Some(area.extension()) {
            continue;
        }
        let Some(name) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        if check_name(name).is_err() {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let updated_at = item
            .metadata()
            .ok()
            .and_then(|meta| meta.modified().ok())
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|elapsed| elapsed.as_millis() as u64);
        entries.push(Entry {
            name: name.to_string(),
            version: version_of(&bytes),
            updated_at,
            bytes: bytes.len() as u64,
        });
    }
    Ok(entries)
}

pub fn read(root: &Path, area: Area, name: &str) -> Result<Option<Read>> {
    let path = note_path(root, area, name)?;
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(Read { version: version_of(&bytes), text: String::from_utf8_lossy(&bytes).into_owned() })),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.into()),
    }
}

pub fn write(root: &Path, area: Area, name: &str, text: &str, expected: Option<&str>) -> Result<Written> {
    write_checked(&note_path(root, area, name)?, text, expected)
}

pub fn remove(root: &Path, area: Area, name: &str, expected: Option<&str>) -> Result<Written> {
    let path = note_path(root, area, name)?;
    let current = current_version(&path)?;
    if current.is_none() {
        return Ok(Written { version: None, conflict: false });
    }
    if current.as_deref() != expected {
        return Ok(Written { version: None, conflict: true });
    }
    std::fs::remove_file(path)?;
    Ok(Written { version: None, conflict: false })
}

pub fn read_team_file(root: &Path) -> Result<Option<Read>> {
    match std::fs::read(root.join(TEAM_FILE)) {
        Ok(bytes) => Ok(Some(Read { version: version_of(&bytes), text: String::from_utf8_lossy(&bytes).into_owned() })),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.into()),
    }
}

pub fn write_team_file(root: &Path, text: &str, expected: Option<&str>) -> Result<Written> {
    write_checked(&root.join(TEAM_FILE), text, expected)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_team_notes_as_markdown_with_a_version_from_their_content() {
        let dir = tempfile::tempdir().unwrap();
        let written = write(dir.path(), Area::Notes, "plan", "Meet on Monday.", None).unwrap();
        assert!(!written.conflict);
        assert_eq!(std::fs::read_to_string(dir.path().join("notes/plan.md")).unwrap(), "Meet on Monday.");
        let read_back = read(dir.path(), Area::Notes, "plan").unwrap().unwrap();
        assert_eq!(Some(read_back.version.clone()), written.version);
        let listed = list(dir.path(), Area::Notes).unwrap();
        assert_eq!((listed[0].name.as_str(), listed[0].bytes), ("plan", 15));
        assert_eq!(listed[0].version, read_back.version);
    }

    #[test]
    fn refuses_to_overwrite_what_changed_since_it_was_read() {
        let dir = tempfile::tempdir().unwrap();
        let first = write(dir.path(), Area::Notes, "plan", "first", None).unwrap().version.unwrap();
        // Someone else's sync app brings in their change.
        std::fs::write(dir.path().join("notes/plan.md"), "theirs").unwrap();
        let mine = write(dir.path(), Area::Notes, "plan", "mine", Some(&first)).unwrap();
        assert_eq!(mine, Written { version: None, conflict: true });
        assert_eq!(std::fs::read_to_string(dir.path().join("notes/plan.md")).unwrap(), "theirs");
        // A new note must not replace one that appeared meanwhile.
        assert!(write(dir.path(), Area::Notes, "plan", "new", None).unwrap().conflict);
        assert!(remove(dir.path(), Area::Notes, "plan", Some(&first)).unwrap().conflict);
        assert!(dir.path().join("notes/plan.md").exists());
    }

    #[test]
    fn touches_nothing_outside_its_two_folders() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["../ngomate-team", "a/b", "..", ".hidden", ""] {
            assert!(write(dir.path(), Area::Notes, name, "x", None).is_err(), "{name}");
            assert!(read(dir.path(), Area::Tasks, name).is_err(), "{name}");
        }
        assert!(!dir.path().join(TEAM_FILE).exists());
    }

    #[test]
    fn lists_a_sync_apps_conflict_copy_for_the_person_to_see() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), Area::Notes, "plan", "mine", None).unwrap();
        std::fs::write(dir.path().join("notes/plan (conflicted copy 2026-11-23).md"), "theirs").unwrap();
        std::fs::write(dir.path().join("notes/.ngomate-1.tmp"), "half").unwrap();
        let mut names: Vec<String> = list(dir.path(), Area::Notes).unwrap().into_iter().map(|entry| entry.name).collect();
        names.sort();
        assert_eq!(names, ["plan", "plan (conflicted copy 2026-11-23)"]);
    }

    #[test]
    fn keeps_a_team_job_as_markdown_and_its_state_as_json() {
        let dir = tempfile::tempdir().unwrap();
        let job = write(dir.path(), Area::Jobs, "funding", "---\nid: funding\n---\n", None).unwrap();
        write(dir.path(), Area::JobStates, "funding", "{}", None).unwrap();
        assert!(dir.path().join("jobs/funding.md").exists());
        assert!(dir.path().join("job-states/funding.json").exists());
        assert_eq!(list(dir.path(), Area::JobStates).unwrap()[0].name, "funding");
        // A second computer writing over the version it read is refused once the first has written.
        assert!(write(dir.path(), Area::JobStates, "funding", "{\"claim\":1}", None).unwrap().conflict);
        assert!(!job.conflict);
    }

    #[test]
    fn reads_a_location_as_the_interface_sends_it_and_refuses_unsafe_ones() {
        let s3: Location = serde_json::from_str(
            r#"{"type":"s3","endpoint":"https://s3.example.org","region":"eu","bucket":"team","accessKeyId":"K"}"#,
        )
        .unwrap();
        assert!(s3.check().is_ok());
        let dav: Location = serde_json::from_str(r#"{"type":"webdav","url":"https://dav.example.org/t","user":"a"}"#).unwrap();
        assert!(dav.check().is_ok());
        let connector: Location = serde_json::from_str(r#"{"type":"connector","addonId":"x"}"#).unwrap();
        assert_eq!(serde_json::to_string(&connector).unwrap(), r#"{"type":"connector","addonId":"x"}"#);
        // A folder comes only from the native dialog, and an address must not be plain http elsewhere.
        assert!(Location::Folder { path: "/".into() }.check().is_err());
        assert!(Location::Webdav { url: "http://dav.example.org".into(), user: "a".into() }.check().is_err());
        assert!(Location::Webdav { url: "https://a:b@dav.example.org".into(), user: "a".into() }.check().is_err());
        assert!(Location::Webdav { url: "http://localhost:8080".into(), user: "a".into() }.check().is_ok());
    }

    #[test]
    fn keeps_several_teams_with_one_active_and_goes_back_when_one_is_left() {
        let folder = |path: &str| Location::Folder { path: path.into() };
        let mut teams = Teams::default();
        let ours = teams.add(folder("/a"), "a".into(), true);
        let coalition = teams.add(folder("/b"), "b".into(), true);
        assert_eq!(teams.active.as_deref(), Some("b"));
        // The same place again switches to it rather than listing it twice.
        assert_eq!(teams.add(folder("/a"), "c".into(), true), ours);
        assert_eq!((teams.teams.len(), teams.active.as_deref()), (2, Some("a")));
        teams.switch(&coalition).unwrap();
        assert!(teams.switch("nope").is_err());
        teams.label_active("Coalition");
        assert_eq!(teams.active_team().unwrap().name.as_deref(), Some("Coalition"));
        // A failed join is forgotten, and the team before is active again.
        teams.add(folder("/c"), "c".into(), true);
        assert_eq!(teams.forget_active().unwrap().id, "c");
        assert_eq!(teams.active.as_deref(), Some("b"));
        teams.forget_active();
        teams.forget_active();
        assert_eq!((teams.teams.len(), teams.active), (0, None));
        let read: Teams = serde_json::from_str(r#"{"active":null,"teams":[{"id":"x","name":null,"location":{"type":"connector","addonId":"y"}}]}"#).unwrap();
        assert!(read.teams[0].refuses_overwrites);
    }

    #[test]
    fn writes_the_team_file_only_over_the_version_read() {
        let dir = tempfile::tempdir().unwrap();
        let made = write_team_file(dir.path(), "{}", None).unwrap().version.unwrap();
        assert!(write_team_file(dir.path(), "{\"a\":1}", None).unwrap().conflict);
        assert!(!write_team_file(dir.path(), "{\"a\":1}", Some(&made)).unwrap().conflict);
        assert_eq!(read_team_file(dir.path()).unwrap().unwrap().text, "{\"a\":1}");
    }
}
