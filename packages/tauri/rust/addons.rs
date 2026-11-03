use crate::error::{Error, Result};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};

struct AddonProcess {
    // Held so the program is killed when the entry is dropped.
    _child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
pub struct Addons(tokio::sync::Mutex<HashMap<String, AddonProcess>>);

fn fingerprint(command: &str, args: &[String]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(command.as_bytes());
    for arg in args {
        hasher.update([0u8]);
        hasher.update(arg.as_bytes());
    }
    hex::encode(hasher.finalize())
}

fn read_approved(path: &Path) -> HashSet<String> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Whether the person has already confirmed this exact command. The list is outside the interface's
/// storage areas, so a compromised page cannot add to it.
pub fn is_approved(path: &Path, command: &str, args: &[String]) -> bool {
    read_approved(path).contains(&fingerprint(command, args))
}

pub fn approve(path: &Path, command: &str, args: &[String]) -> Result<()> {
    let mut known = read_approved(path);
    known.insert(fingerprint(command, args));
    if let Some(folder) = path.parent() {
        std::fs::create_dir_all(folder)?;
    }
    std::fs::write(path, serde_json::to_string(&known).map_err(|err| Error::msg(err.to_string()))?)?;
    Ok(())
}

impl Addons {
    pub async fn start(
        &self,
        id: &str,
        command: &str,
        args: &[String],
        on_line: impl Fn(String) + Send + 'static,
        on_close: impl Fn() + Send + 'static,
    ) -> Result<()> {
        let mut running = self.0.lock().await;
        running.remove(id);
        let mut process = Command::new(command);
        process.args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            process.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = process
            .spawn()
            .map_err(|err| Error::msg(format!("Could not start {command}: {err}")))?;
        let stdin = child.stdin.take().ok_or_else(|| Error::msg("The program has no input."))?;
        let stdout = child.stdout.take().ok_or_else(|| Error::msg("The program has no output."))?;
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                on_line(line);
            }
            on_close();
        });
        running.insert(id.to_string(), AddonProcess { _child: child, stdin });
        Ok(())
    }

    pub async fn send(&self, id: &str, line: &str) -> Result<()> {
        let mut running = self.0.lock().await;
        let process = running.get_mut(id).ok_or_else(|| Error::msg("This add-on is not running."))?;
        process.stdin.write_all(line.as_bytes()).await?;
        process.stdin.write_all(b"\n").await?;
        process.stdin.flush().await?;
        Ok(())
    }

    pub async fn stop(&self, id: &str) {
        self.0.lock().await.remove(id);
    }

    pub fn stop_all(&self) {
        if let Ok(mut running) = self.0.try_lock() {
            running.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn remembers_only_the_exact_command() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("approved.json");
        let args = vec!["--port".to_string(), "1".to_string()];
        assert!(!is_approved(&path, "tool", &args));
        approve(&path, "tool", &args).unwrap();
        assert!(is_approved(&path, "tool", &args));
        assert!(!is_approved(&path, "tool", &["--port".to_string()]));
        assert!(!is_approved(&path, "other", &args));
        assert!(!is_approved(&path, "tool", &["--port 1".to_string()]));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn relays_lines_to_and_from_a_program() {
        let addons = Addons::default();
        let (seen, done) = (Arc::new(Mutex::new(vec![])), Arc::new(tokio::sync::Notify::new()));
        let (seen_in, done_in) = (seen.clone(), done.clone());
        addons
            .start("a", "cat", &[], move |line| seen_in.lock().unwrap().push(line), move || done_in.notify_one())
            .await
            .unwrap();
        addons.send("a", "{\"hello\":1}").await.unwrap();
        for _ in 0..50 {
            if !seen.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert_eq!(seen.lock().unwrap().as_slice(), ["{\"hello\":1}"]);
        addons.stop("a").await;
        assert!(addons.send("a", "x").await.is_err());
    }
}
