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
    /// The file the model's read of the conversation is kept in between runs; none when it cannot be.
    cache: Option<PathBuf>,
}

/// The file a model's read of the last conversation is kept in, replaced each time. Named after the
/// model's file rather than its id, so a newer version of a model never loads what an older one read.
pub fn cache_file(folder: &Path, model_file: &str) -> PathBuf {
    let safe: String = model_file.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect();
    folder.join(format!("{safe}.bin"))
}

/// Deletes kept files no model uses any more, such as one left by a model's older version.
pub fn prune_kept(folder: &Path, in_use: &[PathBuf]) {
    let Ok(files) = std::fs::read_dir(folder) else { return };
    for file in files.flatten() {
        let path = file.path();
        if path.extension().is_some_and(|extension| extension == "bin") && !in_use.contains(&path) {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Asks the server to save, load or erase its read of the conversation. Reading it again from the
/// start takes a laptop a minute or more; loading it back takes seconds.
async fn slot(info: &Running, action: &str, file: Option<&Path>) -> Result<()> {
    let body = match file {
        Some(file) => {
            let name = file.file_name().and_then(|name| name.to_str()).ok_or_else(|| Error::msg("No file name"))?;
            serde_json::json!({ "filename": name })
        }
        None => serde_json::json!({}),
    };
    let base = info.base_url.trim_end_matches("/v1");
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()?
        .post(format!("{base}/slots/0?action={action}"))
        .bearer_auth(&info.api_key)
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(Error::msg(format!("The model could not {action} its read: {}", response.status())));
    }
    Ok(())
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

fn server_args(model: &Path, port: u16, context_tokens: u32, cache: Option<&Path>) -> Vec<String> {
    let mut args: Vec<String> = [
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
    .collect();
    if let Some(folder) = cache {
        args.extend(["--slot-save-path".to_string(), folder.to_string_lossy().to_string()]);
    }
    args
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

    /// For a stop asked from outside: a start waits until the read is saved and the memory is free,
    /// so a message sent meanwhile neither loads a second model nor misses what was just kept.
    pub async fn stop_and_keep(&self) {
        let _starting = self.starting.lock().await;
        self.stop_and_wait().await;
    }

    /// Waits out a start or a save under way; while the guard is held, neither can begin. For removing
    /// or moving a model file, which a save finishing afterwards would otherwise write back beside.
    pub async fn settled(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.starting.lock().await
    }

    /// After a conversation is deleted, nothing the model kept may still hold it: the running model
    /// lets go of what it read, and every kept file goes, since a file does not say what it holds.
    /// The next answer reads its conversation again.
    pub async fn forget(&self, folder: &Path) {
        let _starting = self.starting.lock().await;
        let running = self.process.lock().unwrap().as_ref().map(|process| process.info.clone());
        if let Some(info) = running {
            // The kept files below go either way, and a model left holding it is stopped instead.
            if slot(&info, "erase", None).await.is_err() {
                self.stop();
            }
        }
        prune_kept(folder, &[]);
    }

    /// Returns once the memory is free, so the next model does not load on top of this one. Keeps the
    /// model's read of the conversation first, so the next start does not read it all again.
    async fn stop_and_wait(&self) {
        let process = self.process.lock().unwrap().take();
        if let Some(mut process) = process {
            if let (Some(file), Ok(None)) = (&process.cache, process.child.try_wait()) {
                // Without it the next answer is only slower, so a failure is no reason to keep running.
                if slot(&process.info, "save", Some(file)).await.is_err() {
                    let _ = std::fs::remove_file(file);
                }
            }
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

    pub async fn start(
        &self,
        server: &Path,
        id: &str,
        model: &Path,
        context_tokens: u32,
        cache: Option<PathBuf>,
    ) -> Result<Running> {
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
            .args(server_args(model, port, context_tokens, cache.as_deref().and_then(Path::parent)))
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
        if let Some(file) = &cache {
            // A file that does not load, say one cut short or from a larger context, would fail the same
            // way at every start.
            if file.exists() && slot(&info, "restore", Some(file)).await.is_err() {
                let _ = std::fs::remove_file(file);
            }
        }
        *self.process.lock().unwrap() = Some(Process { child, info: info.clone(), cache });
        Ok(info)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listens_only_on_this_computer_with_no_page_of_its_own() {
        let args = server_args(Path::new("/m.gguf"), 1234, 8192, None);
        let after = |flag: &str| args[args.iter().position(|arg| arg == flag).unwrap() + 1].clone();
        assert_eq!(after("--host"), "127.0.0.1");
        assert!(args.iter().any(|arg| arg == "--no-webui"));
        assert!(!args.iter().any(|arg| arg.contains("api-key")));
    }

    #[test]
    fn keeps_no_prompt_cache_a_small_computer_cannot_spare() {
        let args = server_args(Path::new("/m.gguf"), 1234, 4096, None);
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
        let running = runtime.start(Path::new(&server), "smoke", Path::new(&model), 256, None).await.unwrap();
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

    /// The same real server: a model stopped and started again carries on from what it had read,
    /// instead of reading the whole conversation again.
    #[tokio::test]
    async fn the_bundled_server_keeps_what_it_read_across_a_stop() {
        let (Ok(server), Ok(model)) = (std::env::var("NGOMATE_SMOKE_SERVER"), std::env::var("NGOMATE_SMOKE_MODEL"))
        else {
            return;
        };
        let folder = tempfile::tempdir().unwrap();
        let runtime = Runtime::default();
        let prompt = "Once upon a time there was a small organisation that planted trees along a river. ".repeat(12);
        let body = serde_json::json!({ "prompt": prompt, "n_predict": 4, "cache_prompt": true });
        let ask = |running: Running| {
            let body = body.clone();
            async move {
                let completion = format!("{}/completion", running.base_url.trim_end_matches("/v1"));
                let answer = reqwest::Client::new()
                    .post(completion)
                    .bearer_auth(&running.api_key)
                    .header("content-type", "application/json")
                    .body(body.to_string())
                    .send()
                    .await
                    .unwrap();
                let answer: serde_json::Value = serde_json::from_str(&answer.text().await.unwrap()).unwrap();
                answer["timings"]["prompt_n"].as_u64().unwrap()
            }
        };

        let kept = cache_file(folder.path(), "smoke.gguf");
        let start = || runtime.start(Path::new(&server), "smoke", Path::new(&model), 512, Some(kept.clone()));

        // A file cut short, as a quit during a save leaves it, is dropped and the model still answers.
        std::fs::write(&kept, b"cut short").unwrap();
        let read_at_first = ask(start().await.unwrap()).await;
        runtime.stop_and_wait().await;
        assert!(std::fs::metadata(&kept).unwrap().len() > 1000, "nothing was kept");

        let read_again = ask(start().await.unwrap()).await;
        assert!(read_again < read_at_first / 4, "read {read_again} of {read_at_first} tokens again");

        // A deleted conversation: the kept file goes, and the running model reads it all again.
        runtime.forget(folder.path()).await;
        assert!(!kept.exists(), "the kept file outlived the conversation");
        let read_after_forgetting = ask(runtime.current("smoke").expect("still running")).await;
        assert_eq!(read_after_forgetting, read_at_first);
        runtime.stop_and_wait().await;
    }

    #[test]
    fn names_the_kept_file_after_the_model_and_nothing_else() {
        let folder = Path::new("/kept");
        assert_eq!(cache_file(folder, "Ministral-3-8B-Q4_K_M.gguf"), folder.join("Ministral-3-8B-Q4_K_M_gguf.bin"));
        assert_eq!(cache_file(folder, "../x/y"), folder.join("___x_y.bin"));
    }

    #[test]
    fn deletes_only_the_kept_files_no_model_uses() {
        let folder = tempfile::tempdir().unwrap();
        let used = cache_file(folder.path(), "new.gguf");
        let old = cache_file(folder.path(), "old.gguf");
        let other = folder.path().join("notes.txt");
        for file in [&used, &old, &other] {
            std::fs::write(file, b"x").unwrap();
        }
        prune_kept(folder.path(), std::slice::from_ref(&used));
        assert!(used.exists() && other.exists());
        assert!(!old.exists());
    }

    #[test]
    fn tells_the_server_where_to_keep_its_read_only_when_there_is_a_folder() {
        let with = server_args(Path::new("/m.gguf"), 1234, 4096, Some(Path::new("/kept")));
        let at = with.iter().position(|arg| arg == "--slot-save-path").unwrap();
        assert_eq!(with[at + 1], "/kept");
        assert!(!server_args(Path::new("/m.gguf"), 1234, 4096, None).contains(&"--slot-save-path".to_string()));
    }

    #[test]
    fn says_so_when_the_runtime_is_missing() {
        std::env::remove_var("NGOMATE_LLAMA_SERVER");
        assert!(find_server(None).unwrap_err().to_string().contains("missing"));
    }
}
