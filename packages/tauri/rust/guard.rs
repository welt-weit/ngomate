//! A crash skips every cleanup, and a model left behind holds gigabytes until the computer restarts.
//! On Windows the programs the app starts go into one job object that closes with the app, so the
//! system ends them however the app ends. macOS and Linux use the watchdog in `runtime.rs` instead.

#[cfg(windows)]
mod job {
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct Job(pub HANDLE);
    // The handle is only ever passed to the system, which allows that from any thread.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    /// The app's one job. Never closed: the system closes it when the app's process ends, which is
    /// the point.
    pub fn app_job() -> Option<&'static Job> {
        static JOB: OnceLock<Option<Job>> = OnceLock::new();
        JOB.get_or_init(|| unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return None;
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let set = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if set == 0 {
                CloseHandle(handle);
                return None;
            }
            Some(Job(handle))
        })
        .as_ref()
    }
}

#[cfg(windows)]
pub fn end_with_app(child: &tokio::process::Child) {
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
    // The program still works without it, so a failure here is no reason to stop.
    if let (Some(job), Some(process)) = (job::app_job(), child.raw_handle()) {
        unsafe {
            AssignProcessToJobObject(job.0, process as HANDLE);
        }
    }
}

#[cfg(not(windows))]
pub fn end_with_app(_child: &tokio::process::Child) {}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::process::Stdio;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::IsProcessInJob;

    #[tokio::test]
    async fn a_started_program_joins_the_job_that_closes_with_the_app() {
        // Waits on its input, so it is still running when checked.
        let mut child = tokio::process::Command::new("cmd")
            .args(["/C", "pause"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        end_with_app(&child);
        let job = job::app_job().expect("the job could not be created");
        let mut inside = 0;
        let asked = unsafe { IsProcessInJob(child.raw_handle().unwrap() as HANDLE, job.0, &mut inside) };
        assert_ne!(asked, 0, "could not ask whether the program is in the job");
        assert_ne!(inside, 0, "the program is not in the app's job");
        child.kill().await.unwrap();
    }
}
