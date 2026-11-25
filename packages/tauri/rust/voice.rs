//! Voice input: speech turned into text on this computer with Whisper (whisper.cpp, built into the app).
//! The recording arrives as 16 kHz mono samples, is turned into text, and is not kept.

use crate::error::{Error, Result};
use std::path::Path;
use std::sync::{Arc, Mutex};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// The sample rate Whisper reads.
pub const SAMPLE_RATE: usize = 16_000;

/// Longest recording turned into text at once: two minutes, which a message needs at most.
pub const MAX_SECONDS: usize = 120;

/// The voice model loaded now, kept between recordings so the next one starts at once.
#[derive(Default)]
pub struct Voice {
    loaded: Mutex<Option<(String, Arc<WhisperContext>)>>,
}

impl Voice {
    /// Lets go of a model, so its file can be removed or replaced.
    pub fn forget(&self, id: &str) {
        let mut loaded = self.loaded.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if loaded.as_ref().is_some_and(|(held, _)| held == id) {
            *loaded = None;
        }
    }

    fn context(&self, id: &str, path: &Path) -> Result<Arc<WhisperContext>> {
        let mut loaded = self.loaded.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((held, context)) = loaded.as_ref() {
            if held == id {
                return Ok(Arc::clone(context));
            }
        }
        let path = path.to_str().ok_or_else(|| Error::msg("The voice model's folder has a name this computer cannot pass on."))?;
        let context = WhisperContext::new_with_params(path, WhisperContextParameters::default())
            .map_err(|err| Error::msg(format!("The voice model could not be loaded: {err}")))?;
        let context = Arc::new(context);
        *loaded = Some((id.to_string(), Arc::clone(&context)));
        Ok(context)
    }
}

/// The size of voice model that suits a computer with this much memory: the small one below 6 GB.
pub fn recommended(ram_gb: u64) -> &'static str {
    if ram_gb < 6 {
        "whisper-tiny-q5"
    } else {
        "whisper-base-q5"
    }
}

/// Whether a recording can be turned into text: not empty, and not longer than the limit.
pub fn check_length(samples: usize) -> Result<()> {
    if samples == 0 {
        return Err(Error::msg("Nothing was recorded. Check that the right microphone is chosen."));
    }
    if samples > SAMPLE_RATE * MAX_SECONDS {
        return Err(Error::msg(format!("A recording can be at most {} minutes. Say it in parts.", MAX_SECONDS / 60)));
    }
    Ok(())
}

/// Turns a recording into text, in the language spoken. Runs off the async threads: it takes seconds.
pub async fn transcribe(voice: &Voice, id: &str, path: &Path, samples: Vec<f32>) -> Result<String> {
    check_length(samples.len())?;
    let context = voice.context(id, path)?;
    tokio::task::spawn_blocking(move || {
        let mut state = context.create_state().map_err(|err| Error::msg(format!("Voice could not start: {err}")))?;
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some("auto"));
        params.set_n_threads(std::thread::available_parallelism().map(|n| n.get().min(8) as i32).unwrap_or(4));
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_special(false);
        params.set_print_timestamps(false);
        params.set_suppress_blank(true);
        state.full(params, &samples).map_err(|err| Error::msg(format!("The recording could not be turned into text: {err}")))?;
        let mut text = String::new();
        for segment in state.as_iter() {
            text.push_str(&segment.to_string());
        }
        Ok(text.trim().to_string())
    })
    .await
    .map_err(|err| Error::msg(format!("Voice stopped unexpectedly: {err}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_small_model_for_a_small_computer() {
        assert_eq!(recommended(4), "whisper-tiny-q5");
        assert_eq!(recommended(8), "whisper-base-q5");
    }

    #[test]
    fn refuses_an_empty_or_too_long_recording() {
        assert!(check_length(0).is_err());
        assert!(check_length(SAMPLE_RATE).is_ok());
        assert!(check_length(SAMPLE_RATE * MAX_SECONDS + 1).is_err());
    }

    /// Samples of a 32-bit float mono WAV file, as `afconvert -f WAVE -d LEF32@16000 -c 1` writes it.
    fn wav_samples(bytes: &[u8]) -> Vec<f32> {
        let at = bytes.windows(4).position(|chunk| chunk == b"data").expect("a data chunk") + 8;
        bytes[at..].chunks_exact(4).map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])).collect()
    }

    /// Against a real model and a real recording, given as `NGOMATE_VOICE_TEST="<model> <wav>"`.
    #[tokio::test]
    #[ignore = "needs a voice model and a recording"]
    async fn turns_a_real_recording_into_text() {
        let given = std::env::var("NGOMATE_VOICE_TEST").expect("NGOMATE_VOICE_TEST");
        let (model, wav) = given.split_once(' ').expect("<model> <wav>");
        let samples = wav_samples(&std::fs::read(wav).unwrap());
        let started = std::time::Instant::now();
        let text = transcribe(&Voice::default(), "whisper-base-q5", Path::new(model), samples).await.unwrap();
        eprintln!("{:.1} s: {text}", started.elapsed().as_secs_f32());
        assert!(text.to_lowercase().contains("funding"), "{text}");
    }

    #[test]
    fn every_recommended_model_is_in_the_catalog() {
        for ram in [2, 4, 8, 32] {
            assert!(crate::catalog::find_voice(recommended(ram)).is_some());
        }
    }
}
