use rune::{Cx, El, FileDialogOptions, TextEdit, TextStyle, Tx, col, el, row, text, text_input};
use serde_json::{Value, json};
use crate::{state::AppState, theme::Palette};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum LauncherMode { Create, Clone }

pub struct LauncherState {
    pub mode: Option<LauncherMode>,
    pub name: TextEdit,
    pub url: TextEdit,
    pub parent: String,
    pub error: Option<String>,
    pub busy: bool,
    pub request_id: Option<u64>,
    pub use_git: bool,
    pub readme: bool,
}

impl Default for LauncherState {
    fn default() -> Self {
        Self { mode: None, name: TextEdit::default(), url: TextEdit::default(), parent: std::env::var("HOME").unwrap_or_default(), error: None, busy: false, request_id: None, use_git: false, readme: false }
    }
}

impl LauncherState {
    pub fn open(&mut self, mode: LauncherMode) { self.mode = Some(mode); self.error = None; }
    pub fn close(&mut self) { if !self.busy { self.mode = None; self.error = None; } }
}

pub fn remember(s: &mut AppState, path: String, name: String) {
    s.pending_project_path = Some(path.clone());
    s.project_remember_request = s.request("projects.remember", json!({"path":path,"name":name}));
}

pub fn open_folder(_s: &mut AppState, tx: &mut Tx) {
    tx.open_folder(FileDialogOptions { title: "Open project".into(), ..Default::default() }, |s: &mut AppState, result, _| {
        match result {
            Ok(Some(path)) => {
                let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string());
                remember(s, path.display().to_string(), name);
            }
            Ok(None) => {}
            Err(error) => { s.launcher.error = Some(error.to_string()); }
        }
    });
}

pub fn completed(s: &mut AppState, result: &Value) {
    s.launcher.busy = false;
    s.launcher.request_id = None;
    if let (Some(path), Some(name)) = (result["path"].as_str(), result["name"].as_str()) {
        s.launcher.mode = None;
        remember(s, path.to_owned(), name.to_owned());
    } else { s.launcher.error = Some("The project could not be opened.".into()); }
}

pub fn failed(s: &mut AppState, message: &str) {
    s.launcher.busy = false;
    s.launcher.request_id = None;
    s.launcher.error = Some(message.to_owned());
}

fn submit(s: &mut AppState) {
    if s.launcher.busy { return; }
    let Some(mode) = s.launcher.mode else { return; };
    let name = s.launcher.name.text.trim().to_owned();
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', '\0']) {
        s.launcher.error = Some("That isn’t a valid folder name".into()); return;
    }
    let method = match mode { LauncherMode::Create => "projects.create", LauncherMode::Clone => "projects.clone" };
    let mut params = json!({"name":name,"parent":s.launcher.parent,"git":s.launcher.use_git,"readme":s.launcher.readme});
    if mode == LauncherMode::Clone {
        let url = s.launcher.url.text.trim();
        if url.is_empty() { s.launcher.error = Some("Enter a repository URL".into()); return; }
        params["url"] = json!(url);
    }
    s.launcher.error = None;
    s.launcher.request_id = s.request(method, params);
    s.launcher.busy = s.launcher.request_id.is_some();
    if !s.launcher.busy { s.launcher.error = Some("The project service is unavailable.".into()); }
}

fn label(value: impl Into<String>, size: f32, weight: f32, color: rune::Color) -> El {
    text(value).font(TextStyle::new(size, weight)).color(color)
}

pub fn view(s: &AppState, cx: &mut Cx<AppState>) -> El {
    let t = Palette::new(cx.system_dark());
    let mode = s.launcher.mode.unwrap_or(LauncherMode::Create);
    let cloning = mode == LauncherMode::Clone;
    let busy = s.launcher.busy;
    let header = row().w_full().h(40.0).px(16.0).center_y().justify_end().fill(t.hover)
        .child(el().key("launcher-cancel").focusable(true).role("button").px(4.0).h(24.0).center()
            .child(label("Cancel", 12.0, 500.0, t.muted)).on_press(|s: &mut AppState| s.launcher.close()));
    let name = text_input(&s.launcher.name, TextStyle::new(16.0, 450.0)).key("launcher-name").label("Project name")
        .single_line().w_full().h(32.0).placeholder("project-name", t.placeholder).color(t.ink)
        .on_edit(|s: &mut AppState| &mut s.launcher.name).on_submit(|s: &mut AppState, _| submit(s));
    let mut body = col().w_full().padding(16.0).gap(14.0);
    if cloning {
        body = body.child(text_input(&s.launcher.url, TextStyle::new(16.0, 450.0)).key("launcher-url").label("Repository URL")
            .single_line().w_full().h(32.0).placeholder("Repository URL", t.placeholder).color(t.ink)
            .on_edit(|s: &mut AppState| &mut s.launcher.url));
    }
    body = body.child(name).child(row().key("launcher-destination").h(30.0).gap(8.0).center_y().focusable(true).role("button")
        .child(label("Location", 12.0, 500.0, t.muted))
        .child(label(s.launcher.parent.clone(), 12.0, 450.0, t.ink_soft).grow(1.0))
        .on_press_tx(|s: &mut AppState, tx| {
            if s.launcher.busy { return; }
            tx.open_folder(FileDialogOptions { title: "Choose location".into(), directory: Some(s.launcher.parent.clone().into()), ..Default::default() }, |s: &mut AppState, result, _| match result {
                Ok(Some(path)) => s.launcher.parent = path.display().to_string(),
                Ok(None) => {},
                Err(error) => s.launcher.error = Some(error.to_string()),
            });
        }));
    if !cloning {
        body = body.child(row().gap(16.0).child(el().key("launcher-git").focusable(true).role("checkbox").checked(s.launcher.use_git)
            .child(label(if s.launcher.use_git { "✓ Initialize git" } else { "Initialize git" }, 12.0, 450.0, t.muted))
            .on_press(|s: &mut AppState| s.launcher.use_git = !s.launcher.use_git))
            .child(el().key("launcher-readme").focusable(true).role("checkbox").checked(s.launcher.readme)
                .child(label(if s.launcher.readme { "✓ README" } else { "README" }, 12.0, 450.0, t.muted))
                .on_press(|s: &mut AppState| s.launcher.readme = !s.launcher.readme)));
    }
    if let Some(error) = &s.launcher.error { body = body.child(label(error, 12.0, 450.0, t.accent).wrap()); }
    let footer = row().w_full().h(44.0).px(16.0).center_y().justify_end().fill(t.hover)
        .child(el().key("launcher-submit").focusable(true).role("button").default_button().h(28.0).px(10.0).radius(8.0).hover(t.hover)
            .child(label(if busy { if cloning { "Cloning…" } else { "Creating…" } } else if cloning { "Clone repository" } else { "Create project" }, 12.0, 550.0, t.ink))
            .on_press(|s: &mut AppState| submit(s)));
    let card = col().key("launcher-card").w(448.0).max_w(448.0).radius(18.0).fill(t.raised_high).border(1.0,t.line)
        .clip_rounded(18.0).child(header).child(body).child(footer).modal(true, |s: &mut AppState| s.launcher.close());
    col().key("launcher-overlay").pin(Some(0.0),Some(0.0),Some(0.0),Some(0.0)).padding(24.0).items_end().justify_end()
        .fill(t.ground.alpha(0.62)).child(card)
}
