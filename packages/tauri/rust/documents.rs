use crate::error::{Error, Result};
use quick_xml::events::Event;
use quick_xml::Reader;
use serde::Serialize;
use std::io::Read;
use std::path::Path;

/// More than any local model can read, kept low so a huge file cannot fill the interface's memory.
const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
const MAX_TEXT_CHARS: usize = 100_000;

#[derive(Serialize, Debug)]
pub struct Document {
    pub name: String,
    pub text: String,
    pub truncated: bool,
}

fn docx_text(bytes: &[u8]) -> Result<String> {
    let unreadable = |_| Error::msg("This Word file could not be read.");
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|_| Error::msg("This Word file could not be read."))?;
    let entry = archive.by_name("word/document.xml").map_err(|_| Error::msg("This Word file could not be read."))?;
    // A small zip can unpack to something enormous, so the read is capped.
    let mut xml = String::new();
    entry.take(64 * 1024 * 1024).read_to_string(&mut xml).map_err(unreadable)?;

    let mut reader = Reader::from_str(&xml);
    let mut text = String::new();
    let mut in_text = false;
    loop {
        match reader.read_event().map_err(|_| Error::msg("This Word file could not be read."))? {
            Event::Start(tag) if tag.name().as_ref() == b"w:t" => in_text = true,
            Event::End(tag) => match tag.name().as_ref() {
                b"w:t" => in_text = false,
                b"w:p" => text.push('\n'),
                _ => {}
            },
            Event::Empty(tag) => match tag.name().as_ref() {
                b"w:tab" => text.push('\t'),
                b"w:br" => text.push('\n'),
                _ => {}
            },
            Event::Text(content) if in_text => {
                text.push_str(&content.decode().map_err(|_| Error::msg("This Word file could not be read."))?);
            }
            // An entity such as &amp; arrives on its own, between two pieces of text.
            Event::GeneralRef(entity) if in_text => {
                let name = entity.decode().map_err(|_| Error::msg("This Word file could not be read."))?;
                let reference = format!("&{name};");
                text.push_str(&quick_xml::escape::unescape(&reference).map_err(|_| Error::msg("This Word file could not be read."))?);
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(text)
}

fn pdf_text(bytes: &[u8]) -> Result<String> {
    // The PDF library panics on some malformed files. That must not take the app down.
    let owned = bytes.to_vec();
    let result = std::panic::catch_unwind(move || pdf_extract::extract_text_from_mem(&owned));
    match result {
        Ok(Ok(text)) if !text.trim().is_empty() => Ok(text),
        Ok(Ok(_)) => Err(Error::msg("This PDF has no text to read. It may be a scan.")),
        _ => Err(Error::msg("This PDF could not be read.")),
    }
}

pub fn read_document(path: &Path) -> Result<Document> {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("document").to_string();
    if std::fs::metadata(path)?.len() > MAX_FILE_BYTES {
        return Err(Error::msg("This file is too large to read."));
    }
    let bytes = std::fs::read(path)?;
    let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let text = match extension.as_str() {
        "pdf" => pdf_text(&bytes)?,
        "docx" => docx_text(&bytes)?,
        "txt" | "md" | "markdown" | "csv" | "tsv" | "html" | "htm" | "json" | "xml" => {
            String::from_utf8_lossy(&bytes).into_owned()
        }
        _ => return Err(Error::msg("This kind of file cannot be read yet. Try PDF, Word (.docx) or a text file.")),
    };
    let truncated = text.chars().count() > MAX_TEXT_CHARS;
    let text = if truncated { text.chars().take(MAX_TEXT_CHARS).collect() } else { text };
    Ok(Document { name, text, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn docx(xml: &str) -> Vec<u8> {
        let mut bytes = vec![];
        {
            let mut archive = zip::ZipWriter::new(std::io::Cursor::new(&mut bytes));
            archive.start_file("word/document.xml", zip::write::SimpleFileOptions::default()).unwrap();
            archive.write_all(xml.as_bytes()).unwrap();
            archive.finish().unwrap();
        }
        bytes
    }

    #[test]
    fn reads_word_text_with_paragraphs_and_entities() {
        let xml = r#"<w:document><w:body><w:p><w:r><w:t>Fish &amp; water</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p></w:body></w:document>"#;
        assert_eq!(docx_text(&docx(xml)).unwrap(), "Fish & water\nSecond\n");
    }

    #[test]
    fn says_so_when_a_file_is_not_really_word() {
        assert!(docx_text(b"not a zip").is_err());
    }

    #[test]
    fn survives_a_broken_pdf() {
        assert!(pdf_text(b"%PDF-1.4 nonsense").is_err());
    }

    #[test]
    fn reads_a_text_file_and_refuses_an_unknown_kind() {
        let dir = tempfile::tempdir().unwrap();
        let text = dir.path().join("notes.txt");
        std::fs::write(&text, "Our notes.").unwrap();
        let document = read_document(&text).unwrap();
        assert_eq!((document.name.as_str(), document.text.as_str(), document.truncated), ("notes.txt", "Our notes.", false));
        let other = dir.path().join("a.exe");
        std::fs::write(&other, "x").unwrap();
        assert!(read_document(&other).is_err());
    }

    #[test]
    fn marks_a_very_long_text_as_cut() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("long.txt");
        std::fs::write(&path, "x".repeat(MAX_TEXT_CHARS + 5)).unwrap();
        let document = read_document(&path).unwrap();
        assert!(document.truncated);
        assert_eq!(document.text.len(), MAX_TEXT_CHARS);
    }
}
