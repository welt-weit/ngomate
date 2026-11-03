use crate::catalog::{self, Model};
use crate::error::{Error, Result};
use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Download and verification steps the interface shows.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub id: String,
    pub received_bytes: u64,
    pub total_bytes: u64,
    pub phase: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub id: &'static str,
    pub name: &'static str,
    pub vendor: &'static str,
    pub license: &'static str,
    pub size_bytes: u64,
    pub min_ram_gb: u64,
    pub installed: bool,
    pub partial_bytes: u64,
}

#[derive(Default)]
pub struct Downloads(Mutex<HashMap<String, Arc<AtomicBool>>>);

impl Downloads {
    fn begin(&self, id: &str) -> Result<Arc<AtomicBool>> {
        let mut active = self.0.lock().unwrap();
        if active.contains_key(id) {
            return Err(Error::msg("This model is already downloading."));
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        active.insert(id.to_string(), cancelled.clone());
        Ok(cancelled)
    }

    fn end(&self, id: &str) {
        self.0.lock().unwrap().remove(id);
    }

    pub fn cancel(&self, id: &str) {
        if let Some(flag) = self.0.lock().unwrap().get(id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

pub fn installed_path(dir: &Path, model: &Model) -> PathBuf {
    dir.join(model.file)
}

fn partial_path(dir: &Path, model: &Model) -> PathBuf {
    dir.join(format!("{}.part", model.file))
}

pub fn entries(dir: &Path) -> Vec<ModelEntry> {
    catalog::MODELS
        .iter()
        .map(|model| ModelEntry {
            id: model.id,
            name: model.name,
            vendor: model.vendor,
            license: model.license,
            size_bytes: model.size_bytes,
            min_ram_gb: model.min_ram_gb,
            installed: installed_path(dir, model).exists(),
            partial_bytes: std::fs::metadata(partial_path(dir, model)).map(|m| m.len()).unwrap_or(0),
        })
        .collect()
}

pub fn free_disk_bytes(dir: &Path) -> u64 {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let target = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
    disks
        .iter()
        .filter(|disk| target.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().as_os_str().len())
        .map(|disk| disk.available_space())
        .unwrap_or(0)
}

async fn hash_file(path: &Path, on_read: impl Fn(u64)) -> Result<String> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    let mut total = 0u64;
    loop {
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        total += read as u64;
        on_read(total);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// A checksum failure deletes the file: resuming a corrupt download only keeps it corrupt.
async fn verify_and_install(
    partial: &Path,
    target: &Path,
    expected: &str,
    on_read: impl Fn(u64),
) -> Result<()> {
    let actual = hash_file(partial, on_read).await?;
    if actual != expected {
        tokio::fs::remove_file(partial).await?;
        return Err(Error::msg(
            "The downloaded file did not match its checksum, so it was deleted. Please try again.",
        ));
    }
    tokio::fs::rename(partial, target).await?;
    Ok(())
}

/// What a download has to do once the server has answered a request that asked to resume at `offset`.
fn resume_offset(status: u16, offset: u64) -> Result<u64> {
    match status {
        206 => Ok(offset),
        200 => Ok(0),
        // Asked to resume past the end: the partial file is complete, or wrong, and the checksum decides.
        416 => Ok(offset),
        other => Err(Error::msg(format!("The download server answered with status {other}."))),
    }
}

pub async fn download(
    dir: &Path,
    downloads: &Downloads,
    model: &Model,
    url: &str,
    on_progress: impl Fn(Progress),
) -> Result<()> {
    let cancelled = downloads.begin(model.id)?;
    let result = run_download(dir, &cancelled, model, url, &on_progress).await;
    downloads.end(model.id);
    result
}

async fn run_download(
    dir: &Path,
    cancelled: &AtomicBool,
    model: &Model,
    url: &str,
    on_progress: &impl Fn(Progress),
) -> Result<()> {
    tokio::fs::create_dir_all(dir).await?;
    let partial = partial_path(dir, model);
    let target = installed_path(dir, model);
    let mut offset = tokio::fs::metadata(&partial).await.map(|m| m.len()).unwrap_or(0);

    let needed = model.size_bytes.saturating_sub(offset);
    let free = free_disk_bytes(dir);
    if free != 0 && free < needed {
        return Err(Error::msg(format!(
            "Not enough disk space: this needs {} GB and {} GB is free.",
            needed / 1_000_000_000 + 1,
            free / 1_000_000_000
        )));
    }

    let report = |received: u64, phase: &'static str| {
        on_progress(Progress {
            id: model.id.to_string(),
            received_bytes: received,
            total_bytes: model.size_bytes,
            phase,
        })
    };

    let client = reqwest::Client::builder().user_agent("ngomate").build()?;
    let mut request = client.get(url);
    if offset > 0 {
        request = request.header("range", format!("bytes={offset}-"));
    }
    let response = request.send().await?;
    let status = response.status().as_u16();
    offset = resume_offset(status, offset)?;

    if status != 416 {
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(offset > 0)
            .write(true)
            .truncate(offset == 0)
            .open(&partial)
            .await?;
        let mut received = offset;
        let mut stream = response.bytes_stream();
        let mut last_report = 0u64;
        while let Some(chunk) = stream.next().await {
            if cancelled.load(Ordering::SeqCst) {
                file.flush().await?;
                return Err(Error::msg("Download paused."));
            }
            let chunk = chunk?;
            file.write_all(&chunk).await?;
            received += chunk.len() as u64;
            if received - last_report >= 4 * 1024 * 1024 {
                last_report = received;
                report(received, "downloading");
            }
        }
        file.flush().await?;
    }

    report(0, "verifying");
    verify_and_install(&partial, &target, model.sha256, |read| {
        if read % (256 * 1024 * 1024) < 1024 * 1024 {
            report(read, "verifying");
        }
    })
    .await
}

/// A file from a USB stick or a colleague: accepted only if it is the exact file the catalog names.
pub async fn import(dir: &Path, model: &Model, source: &Path) -> Result<()> {
    tokio::fs::create_dir_all(dir).await?;
    let size = tokio::fs::metadata(source).await?.len();
    if size != model.size_bytes {
        return Err(Error::msg(format!("That file is not {}: its size is different.", model.name)));
    }
    if hash_file(source, |_| {}).await? != model.sha256 {
        return Err(Error::msg(format!("That file is not {}: its checksum is different.", model.name)));
    }
    let partial = partial_path(dir, model);
    tokio::fs::copy(source, &partial).await?;
    tokio::fs::rename(&partial, installed_path(dir, model)).await?;
    Ok(())
}

pub async fn remove(dir: &Path, model: &Model) -> Result<()> {
    for path in [installed_path(dir, model), partial_path(dir, model)] {
        match tokio::fs::remove_file(path).await {
            Err(err) if err.kind() != std::io::ErrorKind::NotFound => return Err(err.into()),
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use tokio::net::TcpListener;

    const BODY: &[u8] = b"pretend this is a model file of some size";

    fn sha(bytes: &[u8]) -> &'static str {
        Box::leak(hex::encode(Sha256::digest(bytes)).into_boxed_str())
    }

    fn model(body: &[u8]) -> Model {
        Model {
            id: "test",
            name: "Test",
            vendor: "",
            license: "",
            url: "",
            file: "test.gguf",
            sha256: sha(body),
            size_bytes: body.len() as u64,
            min_ram_gb: 1,
        }
    }

    /// Serves BODY over HTTP, honouring a Range header when `ranges` is set, and counts requests.
    async fn serve(ranges: bool) -> (String, Arc<AtomicUsize>, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let seen = Arc::new(Mutex::new(vec![]));
        let (count_in, seen_in) = (count.clone(), seen.clone());
        tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buffer = [0u8; 2048];
                let read = socket.read(&mut buffer).await.unwrap();
                let request = String::from_utf8_lossy(&buffer[..read]).to_lowercase();
                count_in.fetch_add(1, Ordering::SeqCst);
                let range = request
                    .lines()
                    .find_map(|line| line.strip_prefix("range: bytes="))
                    .and_then(|value| value.trim_end_matches('-').parse::<usize>().ok());
                seen_in.lock().unwrap().push(format!("{range:?}"));
                let (head, body) = match range.filter(|_| ranges) {
                    Some(from) => ("206 Partial Content", &BODY[from..]),
                    None => ("200 OK", BODY),
                };
                let response = format!(
                    "HTTP/1.1 {head}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
                socket.write_all(body).await.unwrap();
            }
        });
        (format!("http://{address}/file"), count, seen)
    }

    #[tokio::test]
    async fn downloads_verifies_and_installs() {
        let dir = tempfile::tempdir().unwrap();
        let (url, _, _) = serve(true).await;
        let target = model(BODY);
        download(dir.path(), &Downloads::default(), &target, &url, |_| {}).await.unwrap();
        assert_eq!(std::fs::read(installed_path(dir.path(), &target)).unwrap(), BODY);
        assert!(!partial_path(dir.path(), &target).exists());
    }

    #[tokio::test]
    async fn resumes_from_a_partial_file() {
        let dir = tempfile::tempdir().unwrap();
        let (url, _, seen) = serve(true).await;
        let target = model(BODY);
        std::fs::write(partial_path(dir.path(), &target), &BODY[..10]).unwrap();
        download(dir.path(), &Downloads::default(), &target, &url, |_| {}).await.unwrap();
        assert_eq!(seen.lock().unwrap().as_slice(), ["Some(10)"]);
        assert_eq!(std::fs::read(installed_path(dir.path(), &target)).unwrap(), BODY);
    }

    #[tokio::test]
    async fn starts_over_when_the_server_cannot_resume() {
        let dir = tempfile::tempdir().unwrap();
        let (url, _, _) = serve(false).await;
        let target = model(BODY);
        std::fs::write(partial_path(dir.path(), &target), &BODY[..10]).unwrap();
        download(dir.path(), &Downloads::default(), &target, &url, |_| {}).await.unwrap();
        assert_eq!(std::fs::read(installed_path(dir.path(), &target)).unwrap(), BODY);
    }

    #[tokio::test]
    async fn deletes_a_file_that_fails_its_checksum() {
        let dir = tempfile::tempdir().unwrap();
        let (url, _, _) = serve(true).await;
        let target = model(b"something else entirely");
        let result = download(dir.path(), &Downloads::default(), &target, &url, |_| {}).await;
        assert!(result.unwrap_err().to_string().contains("checksum"));
        assert!(!partial_path(dir.path(), &target).exists());
        assert!(!installed_path(dir.path(), &target).exists());
    }

    #[tokio::test]
    async fn refuses_a_second_download_of_the_same_model() {
        let downloads = Downloads::default();
        let _first = downloads.begin("a").unwrap();
        assert!(downloads.begin("a").is_err());
        downloads.end("a");
        assert!(downloads.begin("a").is_ok());
    }

    #[tokio::test]
    async fn imports_only_the_exact_file() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("from-usb.gguf");
        std::fs::write(&source, BODY).unwrap();
        let models = dir.path().join("models");
        let target = model(BODY);
        import(&models, &target, &source).await.unwrap();
        assert!(installed_path(&models, &target).exists());
        assert!(source.exists());

        let same_size = model(&vec![b'x'; BODY.len()]);
        let wrong = Model { file: "other.gguf", ..same_size };
        assert!(import(&models, &wrong, &source).await.unwrap_err().to_string().contains("checksum"));
        let other_size = Model { file: "other.gguf", ..model(b"short") };
        assert!(import(&models, &other_size, &source).await.unwrap_err().to_string().contains("size"));
    }

    #[test]
    fn pins_every_catalog_entry_to_a_revision_and_checksum() {
        for entry in catalog::MODELS {
            assert_eq!(entry.sha256.len(), 64, "{}", entry.id);
            assert!(entry.url.contains("/resolve/") && entry.url.ends_with(entry.file), "{}", entry.id);
            let revision = entry.url.split("/resolve/").nth(1).unwrap().split('/').next().unwrap();
            assert_eq!(revision.len(), 40, "{} is not pinned", entry.id);
        }
    }
}
