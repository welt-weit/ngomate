//! A job's result written as a new file in a folder the person chose. Never over a file that is there:
//! a name already taken gets a number, as a file manager does.

use crate::error::{Error, Result};
use crate::store::check_name;
use std::io::Write;
use std::path::{Path, PathBuf};

/// "Funding.md", "Funding (2).md", "Funding (3).md": the first that is free.
fn candidates(name: &str) -> impl Iterator<Item = String> + '_ {
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, format!(".{extension}")),
        _ => (name, String::new()),
    };
    std::iter::once(name.to_string()).chain((2..=999).map(move |n| format!("{stem} ({n}){extension}")))
}

/// Creates the file, never replacing one. Returns the name it got.
pub fn write_new(folder: &Path, name: &str, text: &str) -> Result<String> {
    check_name(name)?;
    if !folder.is_absolute() {
        return Err(Error::msg("The folder must be a whole path."));
    }
    if !folder.is_dir() {
        return Err(Error::msg(format!(
            "The folder {} is not there. It may be on a drive that is not connected.",
            folder.display()
        )));
    }
    for candidate in candidates(name) {
        let path: PathBuf = folder.join(&candidate);
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                file.write_all(text.as_bytes())?;
                return Ok(candidate);
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err.into()),
        }
    }
    Err(Error::msg(format!("There are too many files named like {name} in that folder.")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_writes_over_a_file_and_numbers_the_next() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(write_new(dir.path(), "Funding.md", "one").unwrap(), "Funding.md");
        assert_eq!(write_new(dir.path(), "Funding.md", "two").unwrap(), "Funding (2).md");
        assert_eq!(std::fs::read_to_string(dir.path().join("Funding.md")).unwrap(), "one");
        assert_eq!(std::fs::read_to_string(dir.path().join("Funding (2).md")).unwrap(), "two");
    }

    #[test]
    fn refuses_a_name_that_leaves_the_folder_or_a_missing_folder() {
        let dir = tempfile::tempdir().unwrap();
        assert!(write_new(dir.path(), "../escape.md", "x").is_err());
        assert!(write_new(&dir.path().join("gone"), "a.md", "x").is_err());
        assert!(write_new(Path::new("relative"), "a.md", "x").is_err());
    }
}
