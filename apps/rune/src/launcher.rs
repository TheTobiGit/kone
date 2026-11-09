use crate::{state::AppState, theme::Palette};
use rune::{Cx, El, ScrollSpec, TextEdit, TextStyle, Tx, col, el, row, text, text_input};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

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
        if mode == LauncherMode::Open {
            self.browse(self.parent.clone());
        }
    }
    pub fn close(&mut self) {
        if self.busy {
            return;
        }
        if self.view != View::Form && self.mode != Some(LauncherMode::Open) {
            self.view = View::Form;
        } else {
            self.mode = None;
            self.error = None;
        }
    }
    fn browse(&mut self, path: String) {
        let expanded = expand_path(&path);
        match std::fs::read_dir(&expanded) {
            Ok(entries) => {
                let mut folders: Vec<_> = entries
                    .filter_map(Result::ok)
                    .filter_map(|e| {
                        if !e.file_type().ok()?.is_dir() {
                            return None;
                        }
                        let name = e.file_name().to_string_lossy().into_owned();
                        if name.starts_with('.') {
                            return None;
                        }
                        Some((name, e.path().to_string_lossy().into_owned()))
                    })
                    .collect();
                folders.sort_by_key(|(name, _)| name.to_lowercase());
                self.path.text = expanded.to_string_lossy().into_owned();
                self.entries = folders;
                self.browser_error = None;
                self.view = View::Browser;
            }
            Err(error) => {
                self.browser_error = Some(format!("Can’t read this folder: {error}"));
                self.view = View::Browser;
            }
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
}
pub fn completed(s: &mut AppState, result: &Value) {
    s.launcher.busy = false;
    s.launcher.request_id = None;
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
        .child(label(value, 14.0, 600.0, color))
}
fn browser(s: &AppState, t: Palette) -> El {
    let embedded = s.launcher.mode != Some(LauncherMode::Open);
    let current = s.launcher.path.text.clone();
    let name = folder_name(&current);
    let header = row()
        .w_full()
        .h(44.0)
        .px(16.0)
        .gap(16.0)
        .center_y()
        .fill(t.hover)
        .child(
            text_input(&s.launcher.path, TextStyle::new(11.5, 450.0))
                .key("launcher-path")
                .label("Directory path")
                .single_line()
                .grow(1.0)
                .h(24.0)
                .color(t.muted)
                .on_edit(|s: &mut AppState| &mut s.launcher.path)
                .on_submit(|s: &mut AppState, _| {
                    let p = s.launcher.path.text.clone();
                    s.launcher.browse(p);
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
            action(
                "launcher-parent",
                format!("↑  {}", folder_name(&p)),
                t.muted,
            )
            .h(34.0)
            .px(12.0)
            .on_press(move |s: &mut AppState| s.launcher.browse(p.clone())),
        );
    }
    list = list.child(label(format!("↳  {name}"), 15.0, 600.0, t.ink_soft));
    for (i, (name, path)) in s.launcher.entries.iter().enumerate() {
        let path = path.clone();
        list = list.child(
            action(format!("launcher-folder-{i}"), format!("▱  {name}"), t.ink)
                .h(34.0)
                .px(24.0)
                .hover(t.hover)
                .on_press(move |s: &mut AppState| s.launcher.browse(path.clone())),
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
                    let path = s.launcher.path.text.clone();
                    if !Path::new(&path).is_dir() {
                        s.launcher.browser_error = Some("Choose a valid folder".into());
                        return;
                    }
                    if s.launcher.mode == Some(LauncherMode::Open) {
                        s.launcher.mode = None;
                        remember(s, path.clone(), folder_name(&path));
                    } else {
                        s.launcher.parent = path;
                        s.launcher.view = View::Form;
                    }
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
            .gap(16.0)
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
                .child(el().w_full().h(4.0).radius(2.0).fill(t.accent))
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
                text_input(&s.launcher.url, TextStyle::new(15.0, 450.0))
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
                text_input(&s.launcher.name, TextStyle::new(15.0, 450.0))
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
            body = body.child(field).child(
                row()
                    .key("launcher-destination")
                    .focusable(true)
                    .role("button")
                    .h(30.0)
                    .gap(8.0)
                    .center_y()
                    .child(label("▱", 15.0, 500.0, t.muted))
                    .child(label(
                        if cloning { "Clone into" } else { "Create in" },
                        12.0,
                        500.0,
                        t.muted,
                    ))
                    .child(
                        label(display_path(&s.launcher.parent), 12.0, 500.0, t.ink_soft).grow(1.0),
                    )
                    .child(label("Change", 12.0, 500.0, t.muted))
                    .on_press(|s: &mut AppState| {
                        let path = s.launcher.parent.clone();
                        s.launcher.browse(path);
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
                            "Clone".into()
                        } else {
                            "Create".into()
                        }
                    } else {
                        format!(
                            "{} “{}”  →",
                            if cloning { "Clone" } else { "Create" },
                            project
                        )
                    },
                    t.ink,
                )
                .on_press(|s: &mut AppState| submit(s)),
            );
            card = card.child(footer);
        }
        card
    };
    let card = col()
        .key("launcher-card")
        .w(448.0)
        .max_w(448.0)
        .radius(18.0)
        .fill(t.ground)
        .border(1.0, t.line)
        .clip_rounded(18.0)
        .child(content)
        .modal(true, |s: &mut AppState| s.launcher.close());
    col()
        .key("launcher-overlay")
        .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
        .padding(24.0)
        .items_end()
        .justify_end()
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
}
