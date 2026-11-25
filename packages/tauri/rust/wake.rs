//! Starting NGOmate without a window at the times of the jobs that ask for it, while the app is closed:
//! a launchd agent on macOS, scheduled tasks on Windows, a systemd user timer on Linux. The app started
//! that way runs what is due and closes again.

use crate::error::{Error, Result};
use serde::Deserialize;
use std::path::{Path, PathBuf};

/// The argument the helper starts the app with.
pub const RUN_JOBS_ARG: &str = "--run-jobs";

/// One time, on this computer's clock: daily, or on a weekday (0 is Sunday), or on a day of the month.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WakeTime {
    pub hour: u8,
    pub minute: u8,
    pub weekday: Option<u8>,
    pub day: Option<u8>,
}

impl WakeTime {
    fn check(&self) -> Result<()> {
        let ok = self.hour < 24
            && self.minute < 60
            && self.weekday.map_or(true, |weekday| weekday < 7)
            && self.day.map_or(true, |day| (1..=28).contains(&day));
        if ok {
            Ok(())
        } else {
            Err(Error::msg("Not a time a job can start at."))
        }
    }
}

const LABEL: &str = "org.ngomate.jobs";

/// The app to open: on macOS its bundle, so a running app is reused rather than started twice.
fn app_bundle(exe: &Path) -> Option<PathBuf> {
    exe.ancestors().find(|path| path.extension().is_some_and(|extension| extension == "app")).map(Path::to_path_buf)
}

fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// The launchd agent: one calendar entry per time. `open -g` starts the app behind the others, or wakes
/// the one already running, which runs its jobs anyway.
pub fn launchd_plist(exe: &Path, times: &[WakeTime]) -> String {
    let program: Vec<String> = match app_bundle(exe) {
        Some(bundle) => vec![
            "/usr/bin/open".into(),
            "-g".into(),
            "-a".into(),
            bundle.to_string_lossy().into_owned(),
            "--args".into(),
            RUN_JOBS_ARG.into(),
        ],
        None => vec![exe.to_string_lossy().into_owned(), RUN_JOBS_ARG.into()],
    };
    let arguments: String =
        program.iter().map(|argument| format!("\t\t<string>{}</string>\n", escape_xml(argument))).collect();
    let intervals: String = times
        .iter()
        .map(|time| {
            let mut entry = format!(
                "\t\t<dict>\n\t\t\t<key>Hour</key><integer>{}</integer>\n\t\t\t<key>Minute</key><integer>{}</integer>\n",
                time.hour, time.minute
            );
            if let Some(weekday) = time.weekday {
                entry.push_str(&format!("\t\t\t<key>Weekday</key><integer>{weekday}</integer>\n"));
            }
            if let Some(day) = time.day {
                entry.push_str(&format!("\t\t\t<key>Day</key><integer>{day}</integer>\n"));
            }
            entry.push_str("\t\t</dict>\n");
            entry
        })
        .collect();
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n\t<key>Label</key><string>{LABEL}</string>\n\t<key>ProgramArguments</key>\n\t<array>\n{arguments}\t</array>\n\t<key>StartCalendarInterval</key>\n\t<array>\n{intervals}\t</array>\n</dict>\n</plist>\n"
    )
}

const WEEKDAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/// systemd's calendar line for a time: "*-*-* 09:00:00", "Mon *-*-* 09:00:00", "*-*-05 09:00:00".
pub fn systemd_calendar(time: &WakeTime) -> String {
    let clock = format!("{:02}:{:02}:00", time.hour, time.minute);
    match (time.weekday, time.day) {
        (Some(weekday), _) => format!("{} *-*-* {clock}", WEEKDAYS[weekday as usize]),
        (None, Some(day)) => format!("*-*-{day:02} {clock}"),
        _ => format!("*-*-* {clock}"),
    }
}

/// The arguments for one scheduled task on Windows, after `/Create /F /TN <name> /TR <command>`.
pub fn schtasks_schedule(time: &WakeTime) -> Vec<String> {
    let clock = format!("{:02}:{:02}", time.hour, time.minute);
    let mut args: Vec<String> = match (time.weekday, time.day) {
        (Some(weekday), _) => {
            vec!["/SC".into(), "WEEKLY".into(), "/D".into(), WEEKDAYS[weekday as usize].to_uppercase()]
        }
        (None, Some(day)) => vec!["/SC".into(), "MONTHLY".into(), "/D".into(), day.to_string()],
        _ => vec!["/SC".into(), "DAILY".into()],
    };
    args.extend(["/ST".into(), clock]);
    args
}

fn run(program: &str, args: &[String]) -> Result<()> {
    let output = std::process::Command::new(program).args(args).output()?;
    if output.status.success() {
        Ok(())
    } else {
        Err(Error::msg(format!(
            "{program} did not take the times: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )))
    }
}

/// Replaces the times the helper starts the app at. None removes it.
pub fn set(exe: &Path, home: &Path, times: &[WakeTime]) -> Result<()> {
    for time in times {
        time.check()?;
    }
    if cfg!(target_os = "macos") {
        let uid = String::from_utf8_lossy(&std::process::Command::new("id").arg("-u").output()?.stdout).trim().to_string();
        let domain = format!("gui/{uid}");
        let path = home.join("Library/LaunchAgents").join(format!("{LABEL}.plist"));
        // Unloaded first: launchd keeps the old times until the agent is loaded again.
        let _ = run("launchctl", &["bootout".into(), domain.clone(), path.to_string_lossy().into_owned()]);
        if times.is_empty() {
            let _ = std::fs::remove_file(&path);
            return Ok(());
        }
        std::fs::create_dir_all(path.parent().unwrap_or(home))?;
        std::fs::write(&path, launchd_plist(exe, times))?;
        run("launchctl", &["bootstrap".into(), domain, path.to_string_lossy().into_owned()])
    } else if cfg!(target_os = "windows") {
        // Each time is a task of its own, numbered; the old ones are removed first.
        for n in 1..=50 {
            let _ = run("schtasks", &["/Delete".into(), "/F".into(), "/TN".into(), format!("NGOmate\\Jobs {n}")]);
        }
        for (n, time) in times.iter().enumerate() {
            let mut args = vec![
                "/Create".into(),
                "/F".into(),
                "/TN".into(),
                format!("NGOmate\\Jobs {}", n + 1),
                "/TR".into(),
                format!("\"{}\" {RUN_JOBS_ARG}", exe.display()),
            ];
            args.extend(schtasks_schedule(time));
            run("schtasks", &args)?;
        }
        Ok(())
    } else {
        let folder = home.join(".config/systemd/user");
        let timer = folder.join("ngomate-jobs.timer");
        let service = folder.join("ngomate-jobs.service");
        if times.is_empty() {
            let _ = run("systemctl", &["--user".into(), "disable".into(), "--now".into(), "ngomate-jobs.timer".into()]);
            let _ = std::fs::remove_file(&timer);
            let _ = std::fs::remove_file(&service);
            return Ok(());
        }
        std::fs::create_dir_all(&folder)?;
        std::fs::write(
            &service,
            format!("[Unit]\nDescription=NGOmate jobs\n\n[Service]\nType=oneshot\nExecStart=\"{}\" {RUN_JOBS_ARG}\n", exe.display()),
        )?;
        let calendars: String = times.iter().map(|time| format!("OnCalendar={}\n", systemd_calendar(time))).collect();
        std::fs::write(&timer, format!("[Unit]\nDescription=Start NGOmate for its jobs\n\n[Timer]\n{calendars}Persistent=true\n\n[Install]\nWantedBy=timers.target\n"))?;
        run("systemctl", &["--user".into(), "daemon-reload".into()])?;
        run("systemctl", &["--user".into(), "enable".into(), "--now".into(), "ngomate-jobs.timer".into()])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(hour: u8, minute: u8, weekday: Option<u8>, day: Option<u8>) -> WakeTime {
        WakeTime { hour, minute, weekday, day }
    }

    #[test]
    fn opens_the_bundle_on_macos_so_a_running_app_is_reused() {
        let plist = launchd_plist(Path::new("/Applications/NGOmate.app/Contents/MacOS/ngomate-desktop"), &[at(9, 0, Some(1), None)]);
        assert!(plist.contains("<string>/usr/bin/open</string>"));
        assert!(plist.contains("<string>/Applications/NGOmate.app</string>"));
        assert!(plist.contains("<string>--run-jobs</string>"));
        assert!(plist.contains("<key>Weekday</key><integer>1</integer>"));
        let dev = launchd_plist(Path::new("/tmp/target/debug/ngomate-desktop"), &[at(9, 0, None, None)]);
        assert!(dev.contains("<string>/tmp/target/debug/ngomate-desktop</string>"));
    }

    #[test]
    fn writes_each_kind_of_time_for_systemd_and_task_scheduler() {
        assert_eq!(systemd_calendar(&at(9, 5, None, None)), "*-*-* 09:05:00");
        assert_eq!(systemd_calendar(&at(18, 30, Some(1), None)), "Mon *-*-* 18:30:00");
        assert_eq!(systemd_calendar(&at(7, 0, None, Some(5))), "*-*-05 07:00:00");
        assert_eq!(schtasks_schedule(&at(9, 5, Some(0), None)), ["/SC", "WEEKLY", "/D", "SUN", "/ST", "09:05"]);
        assert_eq!(schtasks_schedule(&at(9, 5, None, Some(28))), ["/SC", "MONTHLY", "/D", "28", "/ST", "09:05"]);
    }

    #[test]
    fn refuses_a_time_that_is_not_one() {
        assert!(at(24, 0, None, None).check().is_err());
        assert!(at(9, 0, Some(7), None).check().is_err());
        assert!(at(9, 0, None, Some(29)).check().is_err());
        assert!(at(23, 59, Some(6), None).check().is_ok());
    }

    #[test]
    fn escapes_a_path_with_markup_in_it() {
        let plist = launchd_plist(Path::new("/Users/a&b/NGOmate.app/Contents/MacOS/x"), &[]);
        assert!(plist.contains("/Users/a&amp;b/NGOmate.app"));
    }
}
