use crate::{state::AppState, theme::Palette};
use rune::{
    Cx, El, Family, Icon, Key, ScrollSpec, Spring, TextEdit, TextStyle, Transition, Tx, col, el,
    icon, row, text, text_input,
};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

static FOLDER: Icon = Icon {
    name: "launcher-folder",
    view: 24.0,
    body: r#"<path d="M8 7H16.75C18.8567 7 19.91 7 20.6667 7.50559C20.9943 7.72447 21.2755 8.00572 21.4944 8.33329C22 9.08996 22 10.1433 22 12.25C22 15.7612 22 17.5167 21.1573 18.7779C20.7926 19.3238 20.3238 19.7926 19.7779 20.1573C18.5167 21 16.7612 21 13.25 21H12C7.28595 21 4.92893 21 3.46447 19.5355C2 18.0711 2 15.714 2 11V7.94427C2 6.1278 2 5.21956 2.38032 4.53806C2.65142 4.05227 3.05227 3.65142 3.53806 3.38032C4.21956 3 5.1278 3 6.94427 3C8.10802 3 8.6899 3 9.19926 3.19101C10.3622 3.62712 10.8418 4.68358 11.3666 5.73313L12 7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static FOLDER_ADD: Icon = Icon {
    name: "launcher-folder-add",
    view: 24.0,
    body: r#"<path d="M13 21H12C7.28595 21 4.92893 21 3.46447 19.5355C2 18.0711 2 15.714 2 11V7.94427C2 6.1278 2 5.21956 2.38032 4.53806C2.65142 4.05227 3.05227 3.65142 3.53806 3.38032C4.21956 3 5.1278 3 6.94427 3C8.10802 3 8.6899 3 9.19926 3.19101C10.3622 3.62712 10.8418 4.68358 11.3666 5.73313L12 7M8 7H16.75C18.8567 7 19.91 7 20.6667 7.50559C20.9943 7.72447 21.2755 8.00572 21.4944 8.33329C21.9796 9.05942 21.9992 10.0588 22 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 13V21M22 17H14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static GITHUB: Icon = Icon {
    name: "launcher-github",
    view: 24.0,
    body: r#"<path d="M10 20.5675C6.57143 21.7248 3.71429 20.5675 2 17" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 22V18.7579C10 18.1596 10.1839 17.6396 10.4804 17.1699C10.6838 16.8476 10.5445 16.3904 10.1771 16.2894C7.13394 15.4528 5 14.1077 5 9.64606C5 8.48611 5.38005 7.39556 6.04811 6.4464C6.21437 6.21018 6.29749 6.09208 6.31748 5.9851C6.33746 5.87813 6.30272 5.73852 6.23322 5.45932C5.95038 4.32292 5.96871 3.11619 6.39322 2.02823C6.39322 2.02823 7.27042 1.74242 9.26698 2.98969C9.72282 3.27447 9.95075 3.41686 10.1515 3.44871C10.3522 3.48056 10.6206 3.41384 11.1573 3.28041C11.8913 3.09795 12.6476 3 13.5 3C14.3524 3 15.1087 3.09795 15.8427 3.28041C16.3794 3.41384 16.6478 3.48056 16.8485 3.44871C17.0493 3.41686 17.2772 3.27447 17.733 2.98969C19.7296 1.74242 20.6068 2.02823 20.6068 2.02823C21.0313 3.11619 21.0496 4.32292 20.7668 5.45932C20.6973 5.73852 20.6625 5.87813 20.6825 5.9851C20.7025 6.09207 20.7856 6.21019 20.9519 6.4464C21.6199 7.39556 22 8.48611 22 9.64606C22 14.1077 19.8661 15.4528 16.8229 16.2894C16.4555 16.3904 16.3162 16.8476 16.5196 17.1699C16.8161 17.6396 17 18.1596 17 18.7579V22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static ARROW_UP: Icon = Icon {
    name: "launcher-arrow-up",
    view: 24.0,
    body: r#"<path d="M17.9998 15C17.9998 15 13.5809 9.00001 11.9998 9C10.4187 8.99999 5.99985 15 5.99985 15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static ARROW_BACK: Icon = Icon {
    name: "launcher-arrow-back",
    view: 24.0,
    body: r#"<path d="M11 6H15.5C17.9853 6 20 8.01472 20 10.5C20 12.9853 17.9853 15 15.5 15H4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.99998 12C6.99998 12 4.00001 14.2095 4 15C3.99999 15.7906 7 18 7 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum LauncherMode {
    Create,
    Clone,
    Open,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum View {
    Form,
    Browser,
    More,
}

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
    view: View,
    path: TextEdit,
    entries: Vec<(String, String)>,
    browser_error: Option<String>,
    pub browser_request_id: Option<u64>,
    pub completion_request_id: Option<u64>,
    completion_draft: String,
    recent_descend: Option<(String, Instant)>,
    current_path: String,
    remote: bool,
    repo_name: TextEdit,
    command: TextEdit,
    public: bool,
    cancelling: bool,
    progress: f64,
    stage: String,
}
impl Default for LauncherState {
    fn default() -> Self {
        Self {
            mode: None,
            name: TextEdit::default(),
            url: TextEdit::default(),
            parent: std::env::var("HOME").unwrap_or_else(|_| "/".into()),
            error: None,
            busy: false,
            request_id: None,
            use_git: false,
            readme: false,
            view: View::Form,
            path: TextEdit::default(),
            entries: Vec::new(),
            browser_error: None,
            browser_request_id: None,
            completion_request_id: None,
            completion_draft: String::new(),
            recent_descend: None,
            current_path: String::new(),
            remote: false,
            repo_name: TextEdit::default(),
            command: TextEdit::default(),
            public: false,
            cancelling: false,
            progress: 0.0,
            stage: String::new(),
        }
    }
}
impl LauncherState {
    pub fn open(&mut self, mode: LauncherMode) {
        self.mode = Some(mode);
        self.error = None;
        self.view = View::Form;
    }
    pub fn close(&mut self) {
        if self.busy {
            return;
        }
        self.browser_request_id = None;
        self.completion_request_id = None;
        if self.view != View::Form && self.mode != Some(LauncherMode::Open) {
            self.view = View::Form;
        } else {
            self.mode = None;
            self.error = None;
        }
    }
}
fn expand_path(path: &str) -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    if path == "~" {
        PathBuf::from(home)
    } else if let Some(rest) = path.strip_prefix("~/") {
        PathBuf::from(home).join(rest)
    } else {
        PathBuf::from(path)
    }
}
fn display_path(path: &str) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    if !home.is_empty() && (path == home || path.starts_with(&format!("{home}/"))) {
        format!("~{}", &path[home.len()..])
    } else {
        path.to_owned()
    }
}
fn folder_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_owned())
}
fn valid_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\', '\0'])
}
fn repository(input: &str) -> Option<(String, String)> {
    let input = input.trim().trim_end_matches('/');
    let path = input
        .strip_prefix("git@github.com:")
        .or_else(|| input.strip_prefix("https://github.com/"))
        .or_else(|| input.strip_prefix("http://github.com/"))
        .or_else(|| input.strip_prefix("github.com/"))
        .unwrap_or(input);
    let mut parts = path.split(['/', '?', '#']);
    let owner = parts.next()?;
    let repo = parts.next()?.trim_end_matches(".git");
    if owner.is_empty()
        || repo.is_empty()
        || !owner.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        || !repo
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
    {
        return None;
    }
    Some((
        repo.into(),
        format!("https://github.com/{owner}/{repo}.git"),
    ))
}

pub fn remember(s: &mut AppState, path: String, name: String) {
    s.pending_project_path = Some(path.clone());
    s.project_remember_request = s.request("projects.remember", json!({"path":path,"name":name}));
}
pub fn open_folder(s: &mut AppState, _tx: &mut Tx) {
    s.launcher.open(LauncherMode::Open);
    browse(s, s.launcher.parent.clone());
}
fn browse(s: &mut AppState, path: String) {
    let path = expand_path(&path).to_string_lossy().into_owned();
    s.launcher.view = View::Browser;
    s.launcher.completion_request_id = None;
    s.launcher.browser_error = None;
    s.launcher.browser_request_id = s.request("projects.listDirectories", json!({"path": path}));
    if s.launcher.browser_request_id.is_none() {
        s.launcher.browser_error = Some("The project service is unavailable.".into());
    }
}
fn complete_path(s: &mut AppState, draft: String) {
    let expanded = expand_path(&draft);
    let Some(parent) = expanded.parent() else {
        return;
    };
    s.launcher.completion_draft = draft;
    s.launcher.completion_request_id = s.request(
        "projects.listDirectories",
        json!({"path": parent.to_string_lossy()}),
    );
}
pub fn completion_completed(s: &mut AppState, result: &Value) {
    let draft = &s.launcher.completion_draft;
    if s.launcher.path.text != *draft || s.launcher.view != View::Browser {
        return;
    }
    let fragment = draft.rsplit('/').next().unwrap_or("");
    if fragment.is_empty() {
        return;
    }
    if let Some(name) = result["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry["name"].as_str())
        .find(|name| {
            name.len() > fragment.len() && name.to_lowercase().starts_with(&fragment.to_lowercase())
        })
    {
        let Some(suffix) = name.get(fragment.len()..) else {
            return;
        };
        let completed = format!("{}{}", draft, suffix);
        s.launcher.path.text = completed;
        s.launcher.path.anchor = draft.len();
        s.launcher.path.focus = s.launcher.path.text.len();
    }
}
fn choose(s: &mut AppState, path: String) {
    if path.is_empty() {
        return;
    }
    s.launcher.browser_request_id = None;
    s.launcher.completion_request_id = None;
    if s.launcher.mode == Some(LauncherMode::Open) {
        s.launcher.mode = None;
        remember(s, path.clone(), folder_name(&path));
    } else {
        s.launcher.parent = path;
        s.launcher.view = View::Form;
    }
}
fn descend(s: &mut AppState, path: String) {
    if s.launcher
        .recent_descend
        .as_ref()
        .is_some_and(|(last, at)| *last == path && at.elapsed() < Duration::from_millis(500))
    {
        s.launcher.recent_descend = None;
        choose(s, path);
    } else {
        s.launcher.recent_descend = Some((path.clone(), Instant::now()));
        browse(s, path);
    }
}
pub fn browser_completed(s: &mut AppState, result: &Value) {
    let Some(path) = result["path"].as_str() else {
        return;
    };
    s.launcher.current_path = path.to_owned();
    s.launcher.path.text = display_path(path);
    s.launcher.path.anchor = s.launcher.path.text.len();
    s.launcher.path.focus = s.launcher.path.text.len();
    s.launcher.entries = result["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            Some((
                entry["name"].as_str()?.to_owned(),
                entry["path"].as_str()?.to_owned(),
            ))
        })
        .collect();
    s.launcher.browser_error = None;
}
pub fn browser_failed(s: &mut AppState, message: &str) {
    s.launcher.path.text = display_path(&s.launcher.current_path);
    s.launcher.path.anchor = s.launcher.path.text.len();
    s.launcher.path.focus = s.launcher.path.text.len();
    s.launcher.browser_error = Some(format!("Can’t read this folder: {message}"));
}
pub fn completed(s: &mut AppState, result: &Value) {
    s.launcher.busy = false;
    s.launcher.request_id = None;
    if s.launcher.cancelling {
        s.launcher.cancelling = false;
        s.launcher.mode = None;
        return;
    }
    if let (Some(path), Some(name)) = (result["path"].as_str(), result["name"].as_str()) {
        s.launcher.mode = None;
        remember(s, path.to_owned(), name.to_owned());
    } else {
        s.launcher.error = Some("The project could not be opened.".into());
    }
}
pub fn failed(s: &mut AppState, message: &str) {
    s.launcher.busy = false;
    s.launcher.request_id = None;
    if s.launcher.cancelling {
        s.launcher.cancelling = false;
        s.launcher.mode = None;
    } else {
        s.launcher.error = Some(message.to_owned());
    }
}
pub fn progress(s: &mut AppState, params: &Value) {
    if params["requestId"].as_u64() != s.launcher.request_id {
        return;
    }
    s.launcher.progress = params["progress"]["progress"]
        .as_f64()
        .unwrap_or(0.0)
        .clamp(0.0, 1.0);
    s.launcher.stage = params["progress"]["stage"]
        .as_str()
        .unwrap_or("Cloning…")
        .to_owned();
}
fn cancel(s: &mut AppState) {
    if s.launcher.cancelling {
        return;
    }
    if s.launcher.busy && s.launcher.mode == Some(LauncherMode::Clone) {
        if let Some(id) = s.launcher.request_id {
            s.launcher.cancelling = true;
            s.request("projects.cancelClone", json!({"requestId": id}));
        }
    } else {
        s.launcher.close();
    }
}
fn submit(s: &mut AppState) {
    if s.launcher.busy {
        return;
    }
    let Some(mode) = s.launcher.mode else {
        return;
    };
    let (name, url) = if mode == LauncherMode::Clone {
        let Some((name, url)) = repository(&s.launcher.url.text) else {
            s.launcher.error = Some("That doesn’t look like a GitHub repository".into());
            return;
        };
        (name, Some(url))
    } else {
        (s.launcher.name.text.trim().to_owned(), None)
    };
    if !valid_name(&name) {
        s.launcher.error = Some("That isn’t a valid folder name".into());
        return;
    }
    let method = if mode == LauncherMode::Clone {
        "projects.clone"
    } else {
        "projects.create"
    };
    let mut params = json!({"name":name,"parent":s.launcher.parent,"git":s.launcher.use_git,"readme":s.launcher.readme,"remote":s.launcher.remote,"repoName":s.launcher.repo_name.text,"visibility":if s.launcher.public { "public" } else { "private" },"command":s.launcher.command.text});
    if let Some(url) = url {
        params["url"] = json!(url);
    }
    s.launcher.error = None;
    s.launcher.progress = 0.0;
    s.launcher.stage.clear();
    s.launcher.cancelling = false;
    s.launcher.request_id = s.request(method, params);
    s.launcher.busy = s.launcher.request_id.is_some();
    if !s.launcher.busy {
        s.launcher.error = Some("The project service is unavailable.".into());
    }
}
fn label(value: impl Into<String>, size: f32, weight: f32, color: rune::Color) -> El {
    text(value).font(TextStyle::new(size, weight)).color(color)
}
fn action(key: impl Into<String>, value: impl Into<String>, color: rune::Color) -> El {
    el().key(key.into())
        .focusable(true)
        .role("button")
        .h(24.0)
        .center_y()
        .child(label(value, 14.0, 500.0, color))
}
fn browser(s: &AppState, t: Palette) -> El {
    let embedded = s.launcher.mode != Some(LauncherMode::Open);
    let current = s.launcher.current_path.clone();
    let name = folder_name(&current);
    let header = row()
        .w_full()
        .h(44.0)
        .px(16.0)
        .gap(16.0)
        .center_y()
        .fill(t.hover)
        .child(
            text_input(
                &s.launcher.path,
                TextStyle::new(11.5, 450.0).family(Family::Mono),
            )
            .key("launcher-path")
            .label("Directory path")
            .single_line()
            .grow(1.0)
            .h(24.0)
            .color(t.muted)
            .on_edit(|s: &mut AppState| &mut s.launcher.path)
            .on_key(|s: &mut AppState, event, _| {
                if event.key == Key::Tab {
                    if s.launcher.path.anchor != s.launcher.path.focus {
                        s.launcher.path.anchor = s.launcher.path.focus;
                    } else {
                        complete_path(s, s.launcher.path.text.clone());
                    }
                    true
                } else if let Key::Text(inserted) = &event.key {
                    if s.launcher.path.anchor == s.launcher.path.focus
                        && s.launcher.path.focus == s.launcher.path.text.len()
                        && !inserted.contains('/')
                    {
                        complete_path(s, format!("{}{}", s.launcher.path.text, inserted));
                    }
                    false
                } else {
                    false
                }
            })
            .on_submit(|s: &mut AppState, _| {
                let p = s.launcher.path.text.clone();
                browse(s, p);
            }),
        )
        .child(
            action(
                "launcher-back",
                if embedded { "Back" } else { "Cancel" },
                t.muted,
            )
            .on_press(|s: &mut AppState| s.launcher.close()),
        );
    let mut list = col().w_full().gap(2.0);
    if let Some(parent) = Path::new(&current).parent() {
        let p = parent.to_string_lossy().into_owned();
        list = list.child(
            row()
                .key("launcher-parent")
                .focusable(true)
                .role("button")
                .h(34.0)
                .px(12.0)
                .gap(6.0)
                .center_y()
                .hover(t.hover)
                .child(icon(&ARROW_UP, 16.0).color(t.muted))
                .child(label(folder_name(&p), 15.0, 600.0, t.muted))
                .on_press(move |s: &mut AppState| browse(s, p.clone())),
        );
    }
    list = list.child(
        row()
            .h(34.0)
            .px(12.0)
            .gap(6.0)
            .center_y()
            .child(icon(&ARROW_BACK, 16.0).color(t.muted))
            .child(label(name.clone(), 15.0, 600.0, t.ink_soft))
            .key("launcher-current")
            .focusable(true)
            .role("button")
            .on_press(|s: &mut AppState| {
                let path = s.launcher.current_path.clone();
                descend(s, path);
            }),
    );
    for (i, (name, path)) in s.launcher.entries.iter().enumerate() {
        let path = path.clone();
        list = list.child(
            row()
                .key(format!("launcher-folder-{i}"))
                .focusable(true)
                .role("button")
                .h(34.0)
                .px(24.0)
                .gap(6.0)
                .center_y()
                .hover(t.hover)
                .child(icon(&FOLDER, 16.0).color(t.muted))
                .child(label(name.clone(), 15.0, 600.0, t.ink))
                .on_press(move |s: &mut AppState| descend(s, path.clone())),
        );
    }
    if s.launcher.entries.is_empty() {
        list = list.child(label("No subfolders", 15.0, 500.0, t.muted));
    }
    if let Some(error) = &s.launcher.browser_error {
        list = list.child(label(error, 12.0, 450.0, t.accent).wrap());
    }
    let verb = match s.launcher.mode {
        Some(LauncherMode::Create) => "Create in",
        Some(LauncherMode::Clone) => "Clone into",
        _ => "Open",
    };
    let footer = row()
        .w_full()
        .h(44.0)
        .px(16.0)
        .center_y()
        .justify_end()
        .fill(t.hover)
        .child(
            action("launcher-choose", format!("{verb} “{name}”  →"), t.ink).on_press(
                |s: &mut AppState| {
                    let path = s.launcher.current_path.clone();
                    if path.is_empty() || s.launcher.browser_request_id.is_some() {
                        s.launcher.browser_error = Some("Choose a valid folder".into());
                        return;
                    }
                    choose(s, path);
                },
            ),
        );
    col()
        .w_full()
        .child(header)
        .child(
            col()
                .w_full()
                .padding(16.0)
                .radius(14.0)
                .fill(t.raised_high)
                .max_h(360.0)
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .child(list),
        )
        .child(footer)
}
fn more(s: &AppState, t: Palette) -> El {
    let header = row()
        .w_full()
        .h(44.0)
        .px(16.0)
        .center_y()
        .fill(t.hover)
        .child(label("More", 12.0, 600.0, t.muted).grow(1.0))
        .child(
            action("launcher-done", "Done", t.ink)
                .on_press(|s: &mut AppState| s.launcher.view = View::Form),
        );
    let toggle = |key: &'static str, title: &'static str, on: bool| {
        row()
            .key(key)
            .focusable(true)
            .role("checkbox")
            .checked(on)
            .w_full()
            .h(34.0)
            .center_y()
            .child(label(title, 13.0, 500.0, t.ink).grow(1.0))
            .child(label(
                if on { "●" } else { "○" },
                18.0,
                500.0,
                if on { t.accent } else { t.muted },
            ))
    };
    let mut body = col()
        .w_full()
        .padding(16.0)
        .gap(8.0)
        .child(label("GIT", 10.0, 600.0, t.muted))
        .child(
            toggle(
                "launcher-git",
                "Initialize a repository",
                s.launcher.use_git,
            )
            .on_press(|s: &mut AppState| {
                s.launcher.use_git = !s.launcher.use_git;
                if !s.launcher.use_git {
                    s.launcher.remote = false;
                }
            }),
        );
    if s.launcher.use_git {
        body = body.child(
            toggle("launcher-readme", "Add a README", s.launcher.readme)
                .on_press(|s: &mut AppState| s.launcher.readme = !s.launcher.readme),
        );
    }
    body = body.child(label("GITHUB", 10.0, 600.0, t.muted)).child(
        toggle("launcher-remote", "Create a repository", s.launcher.remote).on_press(
            |s: &mut AppState| {
                s.launcher.remote = !s.launcher.remote;
                if s.launcher.remote {
                    s.launcher.use_git = true;
                }
            },
        ),
    );
    if s.launcher.remote {
        body = body
            .child(
                text_input(&s.launcher.repo_name, TextStyle::new(13.0, 450.0))
                    .key("launcher-repo-name")
                    .label("Repository name")
                    .single_line()
                    .h(32.0)
                    .w_full()
                    .placeholder("Repository name", t.placeholder)
                    .color(t.ink)
                    .on_edit(|s: &mut AppState| &mut s.launcher.repo_name),
            )
            .child(
                toggle("launcher-public", "Public repository", s.launcher.public)
                    .on_press(|s: &mut AppState| s.launcher.public = !s.launcher.public),
            );
    }
    body = body
        .child(label("SETUP", 10.0, 600.0, t.muted))
        .child(
            text_input(&s.launcher.command, TextStyle::new(13.0, 450.0))
                .key("launcher-command")
                .label("Setup command")
                .single_line()
                .h(32.0)
                .w_full()
                .placeholder("npm create vite@latest .", t.placeholder)
                .color(t.ink)
                .on_edit(|s: &mut AppState| &mut s.launcher.command),
        )
        .child(
            label(
                "Runs in the new folder after it’s created.",
                12.0,
                450.0,
                t.muted,
            )
            .wrap(),
        );
    col().w_full().child(header).child(body)
}
pub fn view(s: &AppState, cx: &mut Cx<AppState>) -> El {
    let t = Palette::new(cx.system_dark());
    let mode = s.launcher.mode.unwrap_or(LauncherMode::Create);
    let cloning = mode == LauncherMode::Clone;
    let content = if s.launcher.view == View::Browser {
        browser(s, t)
    } else if s.launcher.view == View::More {
        more(s, t)
    } else {
        let header = row()
            .w_full()
            .h(44.0)
            .px(16.0)
            .center_y()
            .justify_end()
            .fill(t.hover)
            .child(
                action("launcher-cancel", "Cancel", t.muted).on_press(|s: &mut AppState| cancel(s)),
            );
        let mut body = col()
            .w_full()
            .padding(16.0)
            .gap(4.0)
            .radius(14.0)
            .fill(t.raised_high);
        let project = if cloning {
            repository(&s.launcher.url.text)
                .map(|(name, _)| name)
                .unwrap_or_default()
        } else {
            s.launcher.name.text.trim().to_owned()
        };
        if s.launcher.busy {
            body = body
                .child(label(
                    format!(
                        "{}  →  {}",
                        project,
                        display_path(&format!("{}/{}", s.launcher.parent, project))
                    ),
                    14.0,
                    550.0,
                    t.ink,
                ))
                .child(
                    row()
                        .w_full()
                        .h(4.0)
                        .radius(2.0)
                        .fill(t.hover)
                        .child(
                            el().h(4.0)
                                .grow((s.launcher.progress as f32).max(0.001))
                                .radius(2.0)
                                .fill(t.accent),
                        )
                        .child(el().grow((1.0 - s.launcher.progress as f32).max(0.001))),
                )
                .child(label(
                    if s.launcher.cancelling {
                        "Cancelling…".to_owned()
                    } else if cloning && !s.launcher.stage.is_empty() {
                        format!(
                            "{}  {}%",
                            s.launcher.stage,
                            (s.launcher.progress * 100.0).round()
                        )
                    } else if cloning {
                        "Cloning…".to_owned()
                    } else if !s.launcher.command.text.trim().is_empty() {
                        "Running setup…".to_owned()
                    } else {
                        "Creating…".to_owned()
                    },
                    12.0,
                    500.0,
                    t.muted,
                ));
        } else {
            let field = if cloning {
                text_input(
                    &s.launcher.url,
                    TextStyle::new(15.0, 450.0).family(Family::Mono),
                )
                .key("launcher-url")
                .label("Repository URL")
                .single_line()
                .w_full()
                .h(32.0)
                .placeholder("owner/repo or https://github.com/…", t.placeholder)
                .color(t.ink)
                .on_edit(|s: &mut AppState| &mut s.launcher.url)
                .on_submit(|s: &mut AppState, _| submit(s))
            } else {
                text_input(
                    &s.launcher.name,
                    TextStyle::new(15.0, 450.0).family(Family::Mono),
                )
                .key("launcher-name")
                .label("Project name")
                .single_line()
                .w_full()
                .h(32.0)
                .placeholder("project-name", t.placeholder)
                .color(t.ink)
                .on_edit(|s: &mut AppState| &mut s.launcher.name)
                .on_submit(|s: &mut AppState, _| submit(s))
            };
            body = body
                .child(
                    row()
                        .w_full()
                        .gap(10.0)
                        .center_y()
                        .child(
                            icon(if cloning { &GITHUB } else { &FOLDER_ADD }, 18.0)
                                .color(t.ink_soft),
                        )
                        .child(field.grow(1.0)),
                )
                .child(
                    row()
                        .key("launcher-destination")
                        .focusable(true)
                        .role("button")
                        .h(30.0)
                        .gap(8.0)
                        .center_y()
                        .child(icon(&FOLDER, 15.0).color(t.muted))
                        .child(label(
                            if cloning { "Clone into" } else { "Create in" },
                            12.0,
                            500.0,
                            t.muted,
                        ))
                        .child(
                            label(display_path(&s.launcher.parent), 12.0, 500.0, t.ink_soft)
                                .grow(1.0),
                        )
                        .on_press(|s: &mut AppState| {
                            let path = s.launcher.parent.clone();
                            browse(s, path);
                        }),
                );
            if let Some(error) = &s.launcher.error {
                body = body.child(label(error, 12.0, 450.0, t.accent).wrap());
            }
        }
        let mut card = col().w_full().child(header).child(body);
        if !s.launcher.busy {
            let mut footer = row().w_full().h(44.0).px(16.0).center_y().fill(t.hover);
            if !cloning {
                footer = footer.child(
                    action("launcher-more", "More", t.muted)
                        .on_press(|s: &mut AppState| s.launcher.view = View::More),
                );
            }
            footer = footer.child(el().grow(1.0)).child(
                action(
                    "launcher-submit",
                    if project.is_empty() {
                        if cloning {
                            "Clone  →".into()
                        } else {
                            "Create  →".into()
                        }
                    } else {
                        format!(
                            "{} “{}”  →",
                            if cloning { "Clone" } else { "Create" },
                            project
                        )
                    },
                    if project.is_empty() { t.muted } else { t.ink },
                )
                .on_press(|s: &mut AppState| submit(s)),
            );
            card = card.child(footer);
        }
        card
    };
    let content = el()
        .key(match s.launcher.view {
            View::Form => "launcher-form",
            View::Browser => "launcher-browser",
            View::More => "launcher-more-view",
        })
        .w_full()
        .transition(Transition::offset(0.0, 8.0).combined(Transition::opacity()))
        .child(content);
    let card = col()
        .key("launcher-card")
        .animate_layout()
        .motion(Spring::from_stiffness_damping(360.0, 34.0, 0.8))
        .w(448.0)
        .max_w(448.0)
        .radius(18.0)
        .fill(t.ground)
        .border(1.0, t.line)
        .clip_rounded(18.0)
        .child(content)
        .modal(true, |s: &mut AppState| cancel(s));
    col()
        .key("launcher-overlay")
        .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
        .padding(24.0)
        .items_end()
        .justify_end()
        .backdrop_blur(4.0)
        .fill(t.ground.alpha(0.62))
        .child(card)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_names_and_github_repositories() {
        assert!(!valid_name("../bad"));
        assert!(valid_name("good name"));
        assert_eq!(
            repository("git@github.com:owner/repo.git").unwrap(),
            ("repo".into(), "https://github.com/owner/repo.git".into())
        );
        assert_eq!(
            repository("https://github.com/owner/repo/tree/main")
                .unwrap()
                .0,
            "repo"
        );
        assert!(repository("https://example.com/owner/repo").is_none());
    }
    #[test]
    fn stale_browser_results_and_cancelled_clone_do_not_open() {
        let mut s = AppState::default();
        s.launcher.open(LauncherMode::Open);
        s.launcher.browser_request_id = Some(2);
        s.studio_message(json!({"id": 1, "result": {"path": "/old", "entries": []}}));
        assert!(s.launcher.current_path.is_empty());
        s.studio_message(json!({"id": 2, "result": {"path": "/new", "entries": []}}));
        assert_eq!(s.launcher.current_path, "/new");
        s.launcher.close();
        s.studio_message(json!({"id": 2, "result": {"path": "/late", "entries": []}}));
        assert_eq!(s.launcher.current_path, "/new");
        s.launcher.open(LauncherMode::Clone);
        s.launcher.busy = true;
        s.launcher.cancelling = true;
        s.launcher.request_id = Some(3);
        s.studio_message(json!({"id": 3, "result": {"path": "/cloned", "name": "cloned"}}));
        assert!(s.launcher.mode.is_none());
        assert!(s.pending_project_path.is_none());
    }
}
