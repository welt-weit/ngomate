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
    pub context_tokens: u32,
}

struct Process {
    child: Child,
    info: Running,
}

/// At most one model runs, because one is what a laptop can hold in memory.
#[derive(Default)]
pub struct Runtime {
    process: Mutex<Option<Process>>,
    /// Held through a start, so two requests at once cannot load a model each.
    starting: tokio::sync::Mutex<()>,
}

/// Room for the instructions, a document and the answer. The rest of the memory stays with the person.
pub fn context_for_ram(total_ram_gb: u64) -> u32 {
    match total_ram_gb {
        0..=6 => 4096,
        7..=12 => 8192,
        _ => 16384,
    }
}

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

fn server_args(model: &Path, port: u16, context_tokens: u32) -> Vec<String> {
    [
        "--model",
        &model.to_string_lossy(),
        "--host",
        "127.0.0.1",
        "--port",
        &port.to_string(),
        "--ctx-size",
        &context_tokens.to_string(),
        // By default the server keeps up to 8 GB of old prompts and 32 checkpoints of each conversation.
        // That saves little for one person's single conversation, and a small computer cannot spare it.
        "--cache-ram",
        "0",
        "--ctx-checkpoints",
        "1",
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

/// A crash skips every cleanup, and a model left behind holds gigabytes until the computer restarts. So
/// a small shell loop stops the server when the app is gone, and ends by itself when the server is.
/// Windows uses a job object instead, in `guard.rs`.
#[cfg(unix)]
const WATCHDOG: &str = r#"while kill -0 "$1" 2>/dev/null && kill -0 "$2" 2>/dev/null; do sleep "$3"; done; kill -0 "$1" 2>/dev/null || kill -9 "$2" 2>/dev/null"#;

#[cfg(unix)]
fn watch_for_app_exit(app_pid: u32, server_pid: u32, poll_seconds: u32) -> Result<()> {
    // Only numbers reach the script, as arguments, and the script itself is fixed.
    Command::new("sh")
        .args(["-c", WATCHDOG, "ngomate-watchdog"])
        .args([app_pid.to_string(), server_pid.to_string(), poll_seconds.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    Ok(())
}

/// A computer short of memory is the likely cause, so it gets words a person can act on.
fn startup_failure(status: &str, tail: &[String]) -> String {
    let lines = tail.join(" ").to_lowercase();
    let killed = status.contains("signal: 9") || status.contains("SIGKILL");
    if killed || ["memory", "alloc", "mmap", "failed to load model"].iter().any(|word| lines.contains(word)) {
        return "There is not enough free memory to run this model. Close other programs, or choose a smaller model under Model.".to_string();
    }
    format!("The model stopped while starting ({status}). {}", tail.last().cloned().unwrap_or_default())
}

async fn wait_until_ready(child: &mut Child, base: &str) -> Result<()> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(2)).build()?;
    let deadline = tokio::time::Instant::now() + STARTUP_LIMIT;
    let mut output = child.stderr.take().map(|stderr| BufReader::new(stderr).lines());
    let mut tail: Vec<String> = vec![];
    loop {
        if let Some(status) = child.try_wait()? {
            return Err(Error::msg(startup_failure(&status.to_string(), &tail)));
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
        if let Some(mut process) = self.process.lock().unwrap().take() {
            let _ = process.child.start_kill();
        }
    }

    /// Returns once the memory is free, so the next model does not load on top of this one.
    async fn stop_and_wait(&self) {
        let process = self.process.lock().unwrap().take();
        if let Some(mut process) = process {
            let _ = process.child.kill().await;
        }
    }

    pub fn running_id(&self) -> Option<String> {
        self.process.lock().unwrap().as_ref().map(|process| process.info.id.clone())
    }

    fn current(&self, id: &str) -> Option<Running> {
        let mut guard = self.process.lock().unwrap();
        let process = guard.as_mut()?;
        let alive = matches!(process.child.try_wait(), Ok(None));
        if alive && process.info.id == id {
            Some(process.info.clone())
        } else {
            None
        }
    }

    pub async fn start(&self, server: &Path, id: &str, model: &Path, context_tokens: u32) -> Result<Running> {
        let _starting = self.starting.lock().await;
        if let Some(running) = self.current(id) {
            return Ok(running);
        }
        self.stop_and_wait().await;
        if !model.exists() {
            return Err(Error::msg("This model is not downloaded yet."));
        }
        let port = free_port()?;
        let api_key = random_key();
        let mut command = Command::new(server);
        command
            .args(server_args(model, port, context_tokens))
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
        // Before loading, because that is when a model holds the most and a crash is most likely.
        crate::guard::end_with_app(&child);
        #[cfg(unix)]
        if let Some(server_pid) = child.id() {
            // The model still works without it, so failing to start it is no reason to stop.
            let _ = watch_for_app_exit(std::process::id(), server_pid, 5);
        }
        let base = format!("http://127.0.0.1:{port}");
        wait_until_ready(&mut child, &base).await?;
        let info = Running { base_url: format!("{base}/v1"), api_key, id: id.to_string(), context_tokens };
        *self.process.lock().unwrap() = Some(Process { child, info: info.clone() });
        Ok(info)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listens_only_on_this_computer_with_no_page_of_its_own() {
        let args = server_args(Path::new("/m.gguf"), 1234, 8192);
        let after = |flag: &str| args[args.iter().position(|arg| arg == flag).unwrap() + 1].clone();
        assert_eq!(after("--host"), "127.0.0.1");
        assert!(args.iter().any(|arg| arg == "--no-webui"));
        assert!(!args.iter().any(|arg| arg.contains("api-key")));
    }

    #[test]
    fn keeps_no_prompt_cache_a_small_computer_cannot_spare() {
        let args = server_args(Path::new("/m.gguf"), 1234, 4096);
        let after = |flag: &str| args[args.iter().position(|arg| arg == flag).unwrap() + 1].clone();
        assert_eq!(after("--cache-ram"), "0");
        assert_eq!(after("--ctx-checkpoints"), "1");
        assert_eq!(after("--ctx-size"), "4096");
    }

    #[test]
    fn gives_a_small_computer_a_smaller_context() {
        assert_eq!(context_for_ram(4), 4096);
        assert_eq!(context_for_ram(8), 8192);
        assert_eq!(context_for_ram(16), 16384);
        assert_eq!(context_for_ram(64), 16384);
    }

    #[test]
    fn says_in_plain_words_when_memory_ran_out() {
        let tail = vec!["ggml_metal: failed to allocate buffer".to_string()];
        assert!(startup_failure("exit status: 1", &tail).contains("not enough free memory"));
        assert!(startup_failure("signal: 9 (SIGKILL)", &[]).contains("not enough free memory"));
        assert!(startup_failure("exit status: 1", &["bad flag".to_string()]).contains("bad flag"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stops_the_server_when_the_app_dies_without_cleaning_up() {
        let mut app = Command::new("sleep").arg("60").spawn().unwrap();
        let mut server = Command::new("sleep").arg("60").spawn().unwrap();
        watch_for_app_exit(app.id().unwrap(), server.id().unwrap(), 1).unwrap();
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert!(server.try_wait().unwrap().is_none(), "stopped while the app was alive");
        app.kill().await.unwrap();
        let stopped = tokio::time::timeout(Duration::from_secs(5), server.wait()).await;
        assert!(stopped.is_ok(), "still running after the app died");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_watchdog_ends_when_the_server_does_and_leaves_the_app_alone() {
        let mut app = Command::new("sleep").arg("60").spawn().unwrap();
        let mut server = Command::new("sleep").arg("60").spawn().unwrap();
        let mut watchdog = Command::new("sh");
        watchdog.args(["-c", WATCHDOG, "ngomate-watchdog"]);
        watchdog.args([app.id().unwrap().to_string(), server.id().unwrap().to_string(), "1".to_string()]);
        let mut watchdog = watchdog.spawn().unwrap();
        server.kill().await.unwrap();
        let ended = tokio::time::timeout(Duration::from_secs(5), watchdog.wait()).await;
        assert!(ended.is_ok(), "the watchdog kept running without a server");
        assert!(app.try_wait().unwrap().is_none(), "the app was touched");
        app.kill().await.unwrap();
    }

    #[test]
    fn makes_a_different_long_key_each_time() {
        assert_eq!(random_key().len(), 64);
        assert_ne!(random_key(), random_key());
    }

    /// The real model server, started the way the app starts it, on a tiny model. Skipped unless both
    /// variables are set: the hand-started native check sets them after `scripts/fetch-runtime.mjs` and
    /// `scripts/fetch-test-model.mjs`. Its own variables, because another test here clears
    /// `NGOMATE_LLAMA_SERVER` while tests run side by side.
    #[tokio::test]
    async fn the_bundled_server_starts_and_answers_only_with_its_key() {
        let (Ok(server), Ok(model)) = (std::env::var("NGOMATE_SMOKE_SERVER"), std::env::var("NGOMATE_SMOKE_MODEL"))
        else {
            return;
        };
        let runtime = Runtime::default();
        let running = runtime.start(Path::new(&server), "smoke", Path::new(&model), 256).await.unwrap();
        let completion = format!("{}/completion", running.base_url.trim_end_matches("/v1"));
        let body = r#"{"prompt":"Once upon a time","n_predict":8}"#;
        let client = reqwest::Client::new();
        let post = || client.post(&completion).header("content-type", "application/json").body(body);

        let refused = post().send().await.unwrap();
        assert_eq!(refused.status(), 401, "answered without the key");

        let answer = post().bearer_auth(&running.api_key).send().await.unwrap();
        assert!(answer.status().is_success(), "status {}", answer.status());
        let answer: serde_json::Value = serde_json::from_str(&answer.text().await.unwrap()).unwrap();
        let text = answer["content"].as_str().unwrap_or_default();
        assert!(!text.trim().is_empty(), "empty answer: {answer}");
        runtime.stop_and_wait().await;
    }

    #[test]
    fn says_so_when_the_runtime_is_missing() {
        std::env::remove_var("NGOMATE_LLAMA_SERVER");
        assert!(find_server(None).unwrap_err().to_string().contains("missing"));
    }
}
