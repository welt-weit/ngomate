use crate::error::{Error, Result};
use rand::RngCore;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Running {
    pub base_url: String,
    pub api_key: String,
    pub id: String,
}

struct Process {
    child: Child,
    info: Running,
}

/// At most one model runs, because one is what a laptop can hold in memory.
#[derive(Default)]
pub struct Runtime(Mutex<Option<Process>>);

/// Room for the instructions, a long document and the answer. Larger costs memory on every computer.
const CONTEXT_TOKENS: &str = "16384";
const STARTUP_LIMIT: Duration = Duration::from_secs(300);

fn server_binary_name() -> &'static str {
    if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    }
}

/// `NGOMATE_LLAMA_SERVER` points at a build of your own. Otherwise the copy the host app bundles.
pub fn find_server(resource_dir: Option<PathBuf>) -> Result<PathBuf> {
    if let Ok(path) = std::env::var("NGOMATE_LLAMA_SERVER") {
        return Ok(PathBuf::from(path));
    }
    // Beside the program when run from source, where there is no bundle yet.
    let beside_program = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf));
    let candidate = [resource_dir, beside_program]
        .into_iter()
        .flatten()
        .map(|dir| dir.join("runtime").join(server_binary_name()))
        .find(|path| path.exists());
    candidate.ok_or_else(|| {
        Error::msg("The model runtime is missing from this app. Run scripts/fetch-runtime.mjs before building it.")
    })
}

fn server_args(model: &Path, port: u16) -> Vec<String> {
    [
        "--model",
        &model.to_string_lossy(),
        "--host",
        "127.0.0.1",
        "--port",
        &port.to_string(),
        "--ctx-size",
        CONTEXT_TOKENS,
        // One conversation at a time, so all of the context goes to it.
        "--parallel",
        "1",
        "--jinja",
        "--no-webui",
        // Thinking can take minutes per turn on a laptop, and its text is not an answer.
        "--reasoning",
        "off",
    ]
    .iter()
    .map(|arg| arg.to_string())
    .collect()
}

fn random_key() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn free_port() -> Result<u16> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

async fn wait_until_ready(child: &mut Child, base: &str) -> Result<()> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(2)).build()?;
    let deadline = tokio::time::Instant::now() + STARTUP_LIMIT;
    let mut output = child.stderr.take().map(|stderr| BufReader::new(stderr).lines());
    let mut tail: Vec<String> = vec![];
    loop {
        if let Some(status) = child.try_wait()? {
            return Err(Error::msg(format!(
                "The model stopped while starting ({status}). {}",
                tail.last().cloned().unwrap_or_default()
            )));
        }
        if tokio::time::Instant::now() > deadline {
            return Err(Error::msg("The model took too long to start."));
        }
        if let Ok(response) = client.get(format!("{base}/health")).send().await {
            if response.status().is_success() {
                // Keep draining, or the server blocks once the pipe is full.
                if let Some(mut lines) = output.take() {
                    tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
                }
                return Ok(());
            }
        }
        if let Some(lines) = output.as_mut() {
            while let Ok(Ok(Some(line))) = tokio::time::timeout(Duration::from_millis(100), lines.next_line()).await {
                tail.push(line);
                if tail.len() > 5 {
                    tail.remove(0);
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

impl Runtime {
    pub fn stop(&self) {
        if let Some(mut process) = self.0.lock().unwrap().take() {
            let _ = process.child.start_kill();
        }
    }

    pub fn running_id(&self) -> Option<String> {
        self.0.lock().unwrap().as_ref().map(|process| process.info.id.clone())
    }

    fn current(&self, id: &str) -> Option<Running> {
        let mut guard = self.0.lock().unwrap();
        let process = guard.as_mut()?;
        let alive = matches!(process.child.try_wait(), Ok(None));
        if alive && process.info.id == id {
            Some(process.info.clone())
        } else {
            None
        }
    }

    pub async fn start(&self, server: &Path, id: &str, model: &Path) -> Result<Running> {
        if let Some(running) = self.current(id) {
            return Ok(running);
        }
        self.stop();
        if !model.exists() {
            return Err(Error::msg("This model is not downloaded yet."));
        }
        let port = free_port()?;
        let api_key = random_key();
        let mut command = Command::new(server);
        command
            .args(server_args(model, port))
            // In the environment, because a command line is visible to every user of the computer.
            .env("LLAMA_API_KEY", &api_key)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(folder) = server.parent() {
            command.current_dir(folder);
        }
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command
            .spawn()
            .map_err(|err| Error::msg(format!("Could not start the model runtime: {err}")))?;
        let base = format!("http://127.0.0.1:{port}");
        wait_until_ready(&mut child, &base).await?;
        let info = Running { base_url: format!("{base}/v1"), api_key, id: id.to_string() };
        *self.0.lock().unwrap() = Some(Process { child, info: info.clone() });
        Ok(info)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listens_only_on_this_computer_with_no_page_of_its_own() {
        let args = server_args(Path::new("/m.gguf"), 1234);
        let after = |flag: &str| args[args.iter().position(|arg| arg == flag).unwrap() + 1].clone();
        assert_eq!(after("--host"), "127.0.0.1");
        assert!(args.iter().any(|arg| arg == "--no-webui"));
        assert!(!args.iter().any(|arg| arg.contains("api-key")));
    }

    #[test]
    fn makes_a_different_long_key_each_time() {
        assert_eq!(random_key().len(), 64);
        assert_ne!(random_key(), random_key());
    }

    #[test]
    fn says_so_when_the_runtime_is_missing() {
        std::env::remove_var("NGOMATE_LLAMA_SERVER");
        assert!(find_server(None).unwrap_err().to_string().contains("missing"));
    }
}
