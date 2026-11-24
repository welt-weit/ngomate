//! The macOS menu bar: the app's own commands where a Mac user looks for them, with the usual
//! shortcuts. Each command is sent to the window as a `menu` event; the interface carries it out.
//! Windows and Linux keep the app's own buttons, where a menu bar inside the window looks out of place.

use serde::Deserialize;
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Runtime};

const WEBSITE: &str = "https://ngomate.org";

/// What the Team menu shows, as the interface knows it.
#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MenuState {
    pub teams: Vec<MenuTeam>,
    pub active_id: Option<String>,
    pub can_invite: bool,
    /// The View menu names what the item will do: Show Sidebar or Hide Sidebar.
    #[serde(default)]
    pub sidebar_collapsed: bool,
    /// The same for the panel of chats, tasks and jobs on the right.
    #[serde(default)]
    pub work_collapsed: bool,
}

#[derive(Deserialize, Clone)]
pub struct MenuTeam {
    pub id: String,
    pub name: Option<String>,
}

fn item<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    text: &str,
    shortcut: Option<&str>,
) -> tauri::Result<MenuItem<R>> {
    MenuItem::with_id(app, id, text, true, shortcut)
}

pub fn build<R: Runtime>(app: &AppHandle<R>, state: &MenuState) -> tauri::Result<Menu<R>> {
    let separator = || PredefinedMenuItem::separator(app);
    let about = AboutMetadata {
        website: Some(WEBSITE.into()),
        ..Default::default()
    };

    let app_menu = Submenu::with_items(
        app,
        "NGOmate",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About NGOmate"), Some(about))?,
            &item(app, "check-updates", "Check for Updates…", None)?,
            &separator()?,
            &item(app, "show:model", "Settings…", Some("CmdOrCtrl+,"))?,
            &separator()?,
            &PredefinedMenuItem::services(app, None)?,
            &separator()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &separator()?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &item(
                app,
                "new-conversation",
                "New Conversation",
                Some("CmdOrCtrl+N"),
            )?,
            &item(
                app,
                "new-beside",
                "New Conversation Beside",
                Some("CmdOrCtrl+Shift+N"),
            )?,
            &separator()?,
            &item(app, "attach", "Attach a Document…", Some("CmdOrCtrl+O"))?,
            &separator()?,
            &item(app, "close-tab", "Close Tab", Some("CmdOrCtrl+W"))?,
        ],
    )?;

    // The system's own items, so text fields and the conversation behave as in every Mac app.
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &separator()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &item(
                app,
                "toggle-sidebar",
                if state.sidebar_collapsed {
                    "Show Sidebar"
                } else {
                    "Hide Sidebar"
                },
                Some("CmdOrCtrl+Backslash"),
            )?,
            &item(
                app,
                "toggle-work",
                if state.work_collapsed {
                    "Show Your Work"
                } else {
                    "Hide Your Work"
                },
                Some("CmdOrCtrl+Shift+Backslash"),
            )?,
            &item(app, "find", "Find…", Some("CmdOrCtrl+K"))?,
            &separator()?,
            &item(app, "show:chat", "Conversations", None)?,
            &separator()?,
            &item(app, "show:model", "Model", None)?,
            &item(app, "show:addons", "Connectors", None)?,
            &item(app, "show:memory", "Notes", None)?,
            &item(app, "show:team", "Teams", None)?,
            &separator()?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    let team = Submenu::with_id(app, "team-menu", "Team", true)?;
    if state.teams.is_empty() {
        team.append(&MenuItem::with_id(
            app,
            "no-team",
            "Not in a Team",
            false,
            None::<&str>,
        )?)?;
    }
    for (index, member) in state.teams.iter().enumerate() {
        let active = state.active_id.as_deref() == Some(member.id.as_str());
        let name = member
            .name
            .clone()
            .unwrap_or_else(|| "A team not read yet".to_string());
        let label = if active { format!("✓ {name}") } else { name };
        // The first nine get ⌘1 to ⌘9, as tabs and accounts do in other Mac apps.
        let shortcut = (index < 9).then(|| format!("CmdOrCtrl+{}", index + 1));
        team.append(&MenuItem::with_id(
            app,
            format!("team:{}", member.id),
            label,
            true,
            shortcut.as_deref(),
        )?)?;
    }
    team.append(&separator()?)?;
    team.append(&item(
        app,
        "add-team",
        "Join or Set Up Another Team…",
        None,
    )?)?;
    team.append(&MenuItem::with_id(
        app,
        "copy-invite",
        "Copy Invite Link",
        state.can_invite,
        None::<&str>,
    )?)?;

    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
        ],
    )?;
    let help = Submenu::with_items(
        app,
        "Help",
        true,
        &[&item(app, "website", "NGOmate Website", None)?],
    )?;

    let menu = Menu::with_items(
        app,
        &[&app_menu, &file, &edit, &view, &team, &window, &help],
    )?;
    #[cfg(target_os = "macos")]
    {
        window.set_as_windows_menu_for_nsapp()?;
        help.set_as_help_menu_for_nsapp()?;
    }
    Ok(menu)
}

/// A menu choice: the website opens here; everything else is the interface's to carry out.
pub fn handle<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if id == "website" {
        use tauri_plugin_opener::OpenerExt;
        let _ = app.opener().open_url(WEBSITE, None::<&str>);
        return;
    }
    let _ = app.emit("menu", id.to_string());
}

/// Called by the interface when the teams change, so the Team menu lists them.
#[tauri::command]
pub fn menu_update<R: Runtime>(app: AppHandle<R>, state: MenuState) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Ok(());
    }
    let menu = build(&app, &state).map_err(|err| err.to_string())?;
    app.set_menu(menu).map_err(|err| err.to_string())?;
    Ok(())
}
