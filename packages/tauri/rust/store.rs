use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// The only folders the interface can write to. Memory is Markdown so people can open it themselves.
#[derive(Clone, Copy)]
pub enum Area {
    Memory,
    Conversations,
    Settings,
}

impl Area {
    pub fn parse(name: &str) -> Result<Area> {
        match name {
            "memory" => Ok(Area::Memory),
            "conversations" => Ok(Area::Conversations),
            "settings" => Ok(Area::Settings),
            _ => Err(Error::msg(format!("Unknown storage area {name}"))),
        }
    }

    fn folder(self) -> &'static str {
        match self {
            Area::Memory => "memory",
            Area::Conversations => "conversations",
            Area::Settings => "settings",
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Area::Memory => "md",
            _ => "json",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub updated_at: Option<u64>,
    pub bytes: u64,
}

/// A name is one path segment. Beyond that it stays permissive, because people can drop their own
/// Markdown files into the memory folder and those have to stay readable.
fn check_name(name: &str) -> Result<()> {
    let valid = !name.is_empty()
        && name.len() <= 200
        && !name.starts_with('.')
        && !name.contains("..")
        && !name.chars().any(|c| c.is_control() || "/\\<>:\"|?*".contains(c));
    if valid {
        Ok(())
    } else {
        Err(Error::msg(format!("Not a valid name: {name}")))
    }
}

fn file_path(root: &Path, area: Area, name: &str) -> Result<PathBuf> {
    check_name(name)?;
    Ok(root.join(area.folder()).join(format!("{name}.{}", area.extension())))
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
        let meta = item.metadata()?;
        let updated_at = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|elapsed| elapsed.as_millis() as u64);
        entries.push(Entry { name: name.to_string(), updated_at, bytes: meta.len() });
    }
    Ok(entries)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    pub updated_at: String,
}

/// Only the fields a list shows. A conversation's messages are skipped while reading, never held in
/// memory or sent to the page, because this runs after every message and one can hold whole documents.
pub fn conversation_summaries(root: &Path) -> Result<Vec<ConversationSummary>> {
    let mut summaries = vec![];
    for entry in list(root, Area::Conversations)? {
        let path = file_path(root, Area::Conversations, &entry.name)?;
        let Ok(file) = std::fs::File::open(path) else { continue };
        // One damaged file should not cost the person the whole list.
        if let Ok(summary) = serde_json::from_reader(std::io::BufReader::new(file)) {
            summaries.push(summary);
        }
    }
    Ok(summaries)
}

pub fn read(root: &Path, area: Area, name: &str) -> Result<Option<String>> {
    let path = file_path(root, area, name)?;
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.into()),
    }
}

/// Written to a side file and renamed, so a crash mid-save cannot leave half a note.
pub fn write(root: &Path, area: Area, name: &str, text: &str) -> Result<()> {
    let path = file_path(root, area, name)?;
    let folder = root.join(area.folder());
    std::fs::create_dir_all(&folder)?;
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    let temp = folder.join(format!(".{name}.{nanos}.tmp"));
    std::fs::write(&temp, text)?;
    std::fs::rename(&temp, path)?;
    Ok(())
}

pub fn remove(root: &Path, area: Area, name: &str) -> Result<()> {
    let path = file_path(root, area, name)?;
    match std::fs::remove_file(path) {
        Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(err.into()),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_notes_as_markdown_files() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), Area::Memory, "funders", "Fund A.").unwrap();
        assert_eq!(std::fs::read_to_string(dir.path().join("memory/funders.md")).unwrap(), "Fund A.");
        assert_eq!(read(dir.path(), Area::Memory, "funders").unwrap().unwrap(), "Fund A.");
        let listed = list(dir.path(), Area::Memory).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "funders");
        remove(dir.path(), Area::Memory, "funders").unwrap();
        assert!(read(dir.path(), Area::Memory, "funders").unwrap().is_none());
        remove(dir.path(), Area::Memory, "funders").unwrap();
    }

    #[test]
    fn refuses_anything_that_leaves_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["../secret", "a/b", "a\\b", "..", ".hidden", "", "a..b"] {
            assert!(write(dir.path(), Area::Memory, name, "x").is_err(), "{name}");
            assert!(read(dir.path(), Area::Memory, name).is_err(), "{name}");
            assert!(remove(dir.path(), Area::Memory, name).is_err(), "{name}");
        }
    }

    #[test]
    fn accepts_a_name_someone_would_give_their_own_file() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["förderer-2027", "Our funders (2027)"] {
            write(dir.path(), Area::Memory, name, "x").unwrap();
            assert_eq!(read(dir.path(), Area::Memory, name).unwrap().unwrap(), "x");
        }
    }

    #[test]
    fn summarizes_conversations_and_skips_a_damaged_one() {
        let dir = tempfile::tempdir().unwrap();
        let long = "x".repeat(100_000);
        let conversation = format!(
            r#"{{"id":"a","title":"Water","updatedAt":"2027-01-01","messages":[{{"role":"user","content":"{long}"}}],"notices":{{}}}}"#
        );
        write(dir.path(), Area::Conversations, "a", &conversation).unwrap();
        write(dir.path(), Area::Conversations, "broken", "{not json").unwrap();
        let summaries = conversation_summaries(dir.path()).unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!((summaries[0].id.as_str(), summaries[0].title.as_str()), ("a", "Water"));
        assert_eq!(summaries[0].updated_at, "2027-01-01");
    }

    #[test]
    fn leaves_other_files_out_of_the_list() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), Area::Conversations, "a", "{}").unwrap();
        std::fs::write(dir.path().join("conversations/notes.txt"), "x").unwrap();
        assert_eq!(list(dir.path(), Area::Conversations).unwrap().len(), 1);
    }
}
