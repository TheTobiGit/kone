use crate::{state::AppState, theme::Palette};
use rune::{
    Curve, Cx, Easing, El, Family, Icon, Key, ScrollFade, ScrollSpec, Shadow, Span, Spring,
    TextEdit, TextStyle, Transition, Tx, col, el, icon, row, text, text_input,
};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

// Hugeicons (`@hugeicons/core-free-icons`) at the stroke widths Electron passes
// to `HugeiconsIcon`; joins and caps as each path declares them.
static FOLDER_ADD: Icon = Icon {
    name: "launcher-folder-add-1.7",
    view: 24.0,
    body: r#"<path d="M13 21H12C7.28595 21 4.92893 21 3.46447 19.5355C2 18.0711 2 15.714 2 11V7.94427C2 6.1278 2 5.21956 2.38032 4.53806C2.65142 4.05227 3.05227 3.65142 3.53806 3.38032C4.21956 3 5.1278 3 6.94427 3C8.10802 3 8.6899 3 9.19926 3.19101C10.3622 3.62712 10.8418 4.68358 11.3666 5.73313L12 7M8 7H16.75C18.8567 7 19.91 7 20.6667 7.50559C20.9943 7.72447 21.2755 8.00572 21.4944 8.33329C21.9796 9.05942 21.9992 10.0588 22 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M18 13V21M22 17H14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static FOLDER_DEST: Icon = Icon {
    name: "launcher-folder-1.6",
    view: 24.0,
    body: concat!(
        r#"<path d=""#,
        "M8 7H16.75C18.8567 7 19.91 7 20.6667 7.50559C20.9943 7.72447 21.2755 8.00572 21.4944 8.33329C22 9.08996 22 10.1433 22 12.25C22 15.7612 22 17.5167 21.1573 18.7779C20.7926 19.3238 20.3238 19.7926 19.7779 20.1573C18.5167 21 16.7612 21 13.25 21H12C7.28595 21 4.92893 21 3.46447 19.5355C2 18.0711 2 15.714 2 11V7.94427C2 6.1278 2 5.21956 2.38032 4.53806C2.65142 4.05227 3.05227 3.65142 3.53806 3.38032C4.21956 3 5.1278 3 6.94427 3C8.10802 3 8.6899 3 9.19926 3.19101C10.3622 3.62712 10.8418 4.68358 11.3666 5.73313L12 7",
        r#"" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>"#
    ),
};
static FOLDER_ROW: Icon = Icon {
    name: "launcher-folder-1.5",
    view: 24.0,
    body: concat!(
        r#"<path d=""#,
        "M8 7H16.75C18.8567 7 19.91 7 20.6667 7.50559C20.9943 7.72447 21.2755 8.00572 21.4944 8.33329C22 9.08996 22 10.1433 22 12.25C22 15.7612 22 17.5167 21.1573 18.7779C20.7926 19.3238 20.3238 19.7926 19.7779 20.1573C18.5167 21 16.7612 21 13.25 21H12C7.28595 21 4.92893 21 3.46447 19.5355C2 18.0711 2 15.714 2 11V7.94427C2 6.1278 2 5.21956 2.38032 4.53806C2.65142 4.05227 3.05227 3.65142 3.53806 3.38032C4.21956 3 5.1278 3 6.94427 3C8.10802 3 8.6899 3 9.19926 3.19101C10.3622 3.62712 10.8418 4.68358 11.3666 5.73313L12 7",
        r#"" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>"#
    ),
};
static GITHUB: Icon = Icon {
    name: "launcher-github-1.7",
    view: 24.0,
    body: r#"<path d="M10 20.5675C6.57143 21.7248 3.71429 20.5675 2 17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 22V18.7579C10 18.1596 10.1839 17.6396 10.4804 17.1699C10.6838 16.8476 10.5445 16.3904 10.1771 16.2894C7.13394 15.4528 5 14.1077 5 9.64606C5 8.48611 5.38005 7.39556 6.04811 6.4464C6.21437 6.21018 6.29749 6.09208 6.31748 5.9851C6.33746 5.87813 6.30272 5.73852 6.23322 5.45932C5.95038 4.32292 5.96871 3.11619 6.39322 2.02823C6.39322 2.02823 7.27042 1.74242 9.26698 2.98969C9.72282 3.27447 9.95075 3.41686 10.1515 3.44871C10.3522 3.48056 10.6206 3.41384 11.1573 3.28041C11.8913 3.09795 12.6476 3 13.5 3C14.3524 3 15.1087 3.09795 15.8427 3.28041C16.3794 3.41384 16.6478 3.48056 16.8485 3.44871C17.0493 3.41686 17.2772 3.27447 17.733 2.98969C19.7296 1.74242 20.6068 2.02823 20.6068 2.02823C21.0313 3.11619 21.0496 4.32292 20.7668 5.45932C20.6973 5.73852 20.6625 5.87813 20.6825 5.9851C20.7025 6.09207 20.7856 6.21019 20.9519 6.4464C21.6199 7.39556 22 8.48611 22 9.64606C22 14.1077 19.8661 15.4528 16.8229 16.2894C16.4555 16.3904 16.3162 16.8476 16.5196 17.1699C16.8161 17.6396 17 18.1596 17 18.7579V22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static ARROW_UP: Icon = Icon {
    name: "launcher-arrow-up-2",
    view: 24.0,
    body: r#"<path d="M17.9998 15C17.9998 15 13.5809 9.00001 11.9998 9C10.4187 8.99999 5.99985 15 5.99985 15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static ARROW_BACK: Icon = Icon {
    name: "launcher-arrow-turn-back-2",
    view: 24.0,
    body: r#"<path d="M11 6H15.5C17.9853 6 20 8.01472 20 10.5C20 12.9853 17.9853 15 15.5 15H4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.99998 12C6.99998 12 4.00001 14.2095 4 15C3.99999 15.7906 7 18 7 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LauncherMode {
    Create,
    Clone,
    Open,
}
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum View {
    Form,
    Browser,
    More,
}
/// What the pointer rests on, for hover styles a group track can't carry
/// (a nudge, an underline's colour).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
enum Hover {
    #[default]
    None,
    Dest,
    Submit,
    Choose,
}
/// How a finished navigation re-roots the browser's trail.
#[derive(Clone, Debug)]
enum Root {
    /// Keep the trail's anchor (descending, or climbing to a crumb).
    Keep,
    /// A jump (`goToPath`): home when the path lives under it, else `/`.
    Jump,
}

/// Electron's `useModalExit`: the card's exit runs this long before the modal unmounts.
const EXIT: f64 = 0.24;
/// A start time a handler set before it could read the poll clock.
const PENDING: f64 = f64::INFINITY;

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
    read_error: bool,
    pub browser_request_id: Option<u64>,
    pub completion_request_id: Option<u64>,
    completion_draft: String,
    recent_descend: Option<(String, Instant)>,
    current_path: String,
    /// The browser trail's root: home, or `/` after a jump above it.
    anchor: String,
    root: Root,
    /// The last navigation was typed into the address bar (a failure shakes it).
    typed: bool,
    remote: bool,
    repo_name: TextEdit,
    command: TextEdit,
    public: bool,
    cancelling: bool,
    progress: f64,
    stage: String,
    home: String,
    /// The card's shown pose (Electron's `shown`), set a frame after it mounts.
    shown: bool,
    frames: u8,
    /// When the exit began, on the poll clock.
    closing: Option<f64>,
    /// A project to open once the exit finishes.
    after: Option<(String, String)>,
    /// When the address bar's shake began.
    path_error: Option<f64>,
    clock: f64,
    hover: Hover,
    /// Laid-out rects of the browser rows, for their magnet.
    row_bounds: HashMap<String, [f32; 4]>,
    pull: HashMap<String, [f32; 2]>,
    viewport_h: f32,
}
impl Default for LauncherState {
    fn default() -> Self {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
        Self {
            mode: None,
            name: TextEdit::default(),
            url: TextEdit::default(),
            parent: home.clone(),
            error: None,
            busy: false,
            request_id: None,
            use_git: false,
            readme: false,
            view: View::Form,
            path: TextEdit::default(),
            entries: Vec::new(),
            read_error: false,
            browser_request_id: None,
            completion_request_id: None,
            completion_draft: String::new(),
            recent_descend: None,
            current_path: String::new(),
            anchor: home.clone(),
            root: Root::Keep,
            typed: false,
            remote: false,
            repo_name: TextEdit::default(),
            command: TextEdit::default(),
            public: false,
            cancelling: false,
            progress: 0.0,
            stage: String::new(),
            home,
            shown: false,
            frames: 0,
            closing: None,
            after: None,
            path_error: None,
            clock: 0.0,
            hover: Hover::None,
            row_bounds: HashMap::new(),
            pull: HashMap::new(),
            viewport_h: 840.0,
        }
    }
}
impl LauncherState {
    pub fn open(&mut self, mode: LauncherMode) {
        self.mode = Some(mode);
        self.error = None;
        self.view = View::Form;
        self.shown = false;
        self.frames = 0;
        self.closing = None;
        self.after = None;
        self.hover = Hover::None;
        match mode {
            LauncherMode::Create => self.name.focused = true,
            LauncherMode::Clone => self.url.focused = true,
            LauncherMode::Open => self.path.focused = true,
        }
    }
    /// Cancel, Escape or the scrim: back to the form from an embedded browser or
    /// the More panel, else play the exit.
    pub fn close(&mut self) {
        if self.busy {
            return;
        }
        self.browser_request_id = None;
        self.completion_request_id = None;
        if self.view != View::Form && self.mode != Some(LauncherMode::Open) {
            self.view = View::Form;
            self.focus_form();
        } else {
            self.exit(None);
        }
    }
    fn focus_form(&mut self) {
        match self.mode {
            Some(LauncherMode::Clone) => self.url.focused = true,
            Some(LauncherMode::Create) => self.name.focused = true,
            _ => {}
        }
    }
    /// Play the card's exit, then unmount (and open `after`, if any).
    fn exit(&mut self, after: Option<(String, String)>) {
        if self.closing.is_some() {
            return;
        }
        self.closing = Some(PENDING);
        self.shown = false;
        self.after = after;
        self.hover = Hover::None;
    }
    fn collapse(&self, path: &str) -> String {
        let home = &self.home;
        if !home.is_empty()
            && home != "/"
            && (path == home || path.starts_with(&format!("{home}/")))
        {
            format!("~{}", &path[home.len()..])
        } else {
            path.to_owned()
        }
    }
    /// The address bar's form of a path: home keeps its trailing slash.
    fn address(&self, path: &str) -> String {
        if path == self.home {
            "~/".into()
        } else {
            self.collapse(path)
        }
    }
    fn expand(&self, path: &str) -> PathBuf {
        if path == "~" {
            PathBuf::from(&self.home)
        } else if let Some(rest) = path.strip_prefix("~/") {
            PathBuf::from(&self.home).join(rest)
        } else {
            PathBuf::from(path)
        }
    }
    fn under_home(&self, path: &str) -> bool {
        path == self.home || path.starts_with(&format!("{}/", self.home.trim_end_matches('/')))
    }
    /// Trail nodes below the anchor down to the folder in focus: `(name, path)`.
    fn crumbs(&self) -> Vec<(String, String)> {
        let anchor = self.anchor.trim_end_matches('/');
        let Some(rest) = self.current_path.strip_prefix(anchor) else {
            return Vec::new();
        };
        let mut at = if anchor.is_empty() {
            String::new()
        } else {
            anchor.to_owned()
        };
        rest.split('/')
            .filter(|p| !p.is_empty())
            .map(|part| {
                at = format!("{at}/{part}");
                (part.to_owned(), at.clone())
            })
            .collect()
    }
    fn parent_of_anchor(&self) -> Option<String> {
        if self.anchor == "/" || self.anchor.is_empty() {
            return None;
        }
        Some(
            Path::new(&self.anchor)
                .parent()
                .map_or("/".into(), |p| p.to_string_lossy().into_owned()),
        )
    }
    fn submittable(&self) -> bool {
        match self.mode {
            Some(LauncherMode::Clone) => repository(&self.url.text).is_some(),
            _ => valid_name(self.name.text.trim()),
        }
    }
    /// Fixture state for `--scene launcher-*`: Electron's dev mock home and listing.
    pub fn fixture(&mut self, mode: LauncherMode) {
        self.home = "/Users/you".into();
        self.parent = self.home.clone();
        self.anchor = self.home.clone();
        self.open(mode);
        if mode == LauncherMode::Open {
            self.view = View::Browser;
            self.current_path = self.home.clone();
            self.path.text = self.address(&self.home.clone());
            self.path.anchor = self.path.text.len();
            self.path.focus = self.path.text.len();
            self.entries = [
                "Applications",
                "Desktop",
                "Developer",
                "Documents",
                "Downloads",
                "Library",
                "Movies",
                "Music",
                "Pictures",
                "Projects",
                "Public",
                "Sites",
                "Workspace",
            ]
            .iter()
            .map(|n| (n.to_string(), format!("/Users/you/{n}")))
            .collect();
        }
    }
}
impl LauncherState {
    /// The Create card on its More panel, for snapshot scenes.
    pub fn fixture_more(&mut self) {
        self.fixture(LauncherMode::Create);
        self.view = View::More;
        self.name.focused = false;
    }
    pub fn fixture_more_remote(&mut self) {
        self.fixture_more();
        self.remote = true;
        self.use_git = true;
    }
    /// A clone caught mid-transfer, for snapshot scenes.
    pub fn fixture_clone_progress(&mut self, progress: f64, stage: &str) {
        self.fixture(LauncherMode::Clone);
        self.url = TextEdit::new("vercel/next.js");
        self.busy = true;
        self.progress = progress;
        self.stage = stage.into();
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
/// `owner/repo` from any GitHub reference form.
fn repo_parts(input: &str) -> Option<(String, String)> {
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
    Some((owner.into(), repo.into()))
}
fn repository(input: &str) -> Option<(String, String)> {
    repo_parts(input).map(|(owner, repo)| {
        let url = format!("https://github.com/{owner}/{repo}.git");
        (repo, url)
    })
}

pub fn remember(s: &mut AppState, path: String, name: String) {
    s.pending_project_path = Some(path.clone());
    s.project_remember_request = s.request("projects.remember", json!({"path":path,"name":name}));
}
pub fn open_folder(s: &mut AppState, _tx: &mut Tx) {
    s.launcher.open(LauncherMode::Open);
    s.launcher.anchor = s.launcher.home.clone();
    browse(s, s.launcher.parent.clone(), Root::Jump);
}
fn browse(s: &mut AppState, path: String, root: Root) {
    let path = s.launcher.expand(&path).to_string_lossy().into_owned();
    s.launcher.view = View::Browser;
    s.launcher.completion_request_id = None;
    s.launcher.root = root;
    s.launcher.browser_request_id = s.request("projects.listDirectories", json!({"path": path}));
    if s.launcher.browser_request_id.is_none() {
        s.launcher.read_error = true;
    }
}
fn complete_path(s: &mut AppState, draft: String) {
    let expanded = s.launcher.expand(&draft);
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
        let name = folder_name(&path);
        s.launcher.exit(Some((path, name)));
    } else {
        s.launcher.parent = path;
        s.launcher.view = View::Form;
        s.launcher.focus_form();
    }
}
fn descend(s: &mut AppState, path: String) {
    if s.launcher
        .recent_descend
        .as_ref()
        .is_some_and(|(last, at)| *last == path && at.elapsed() < Duration::from_millis(260))
    {
        s.launcher.recent_descend = None;
        choose(s, path);
    } else {
        s.launcher.recent_descend = Some((path.clone(), Instant::now()));
        s.launcher.typed = false;
        browse(s, path, Root::Keep);
    }
}
pub fn browser_completed(s: &mut AppState, result: &Value) {
    let Some(path) = result["path"].as_str() else {
        return;
    };
    let l = &mut s.launcher;
    if matches!(l.root, Root::Jump) {
        l.anchor = if l.under_home(path) {
            l.home.clone()
        } else {
            "/".into()
        };
    }
    l.current_path = path.to_owned();
    l.path.text = l.address(path);
    l.path.anchor = l.path.text.len();
    l.path.focus = l.path.text.len();
    l.entries = result["entries"]
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
    l.read_error = false;
    l.typed = false;
    l.pull.clear();
}
pub fn browser_failed(s: &mut AppState, _message: &str) {
    let l = &mut s.launcher;
    if l.typed {
        // A bad typed path restores the field and shakes it (Electron's `pathShake`).
        l.path.text = l.address(&l.current_path.clone());
        l.path.anchor = l.path.text.len();
        l.path.focus = l.path.text.len();
        l.path_error = Some(PENDING);
        l.typed = false;
    } else {
        l.read_error = true;
        l.entries.clear();
    }
}
pub fn completed(s: &mut AppState, result: &Value) {
    s.launcher.busy = false;
    s.launcher.request_id = None;
    if s.launcher.cancelling {
        s.launcher.cancelling = false;
        s.launcher.exit(None);
        return;
    }
    if let (Some(path), Some(name)) = (result["path"].as_str(), result["name"].as_str()) {
        s.launcher.progress = 1.0;
        s.launcher.exit(Some((path.to_owned(), name.to_owned())));
    } else {
        s.launcher.error = Some("The project could not be opened.".into());
    }
}
pub fn failed(s: &mut AppState, message: &str) {
    s.launcher.busy = false;
    s.launcher.request_id = None;
    if s.launcher.cancelling {
        s.launcher.cancelling = false;
        s.launcher.exit(None);
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
    if s.launcher.busy || s.launcher.closing.is_some() || !s.launcher.submittable() {
        return;
    }
    let Some(mode) = s.launcher.mode else {
        return;
    };
    let (name, url) = if mode == LauncherMode::Clone {
        let Some((name, url)) = repository(&s.launcher.url.text) else {
            return;
        };
        (name, Some(url))
    } else {
        (s.launcher.name.text.trim().to_owned(), None)
    };
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

/// Steps the modal's lifecycle from the app's poll: reveals the card a frame after
/// it mounts (once the open browser's first listing lands), stamps the exit and
/// the address bar's shake, and unmounts when the exit has run. Returns whether
/// the view should run again.
pub fn tick(s: &mut AppState, clock: f64, tx: &mut Tx) -> bool {
    let l = &mut s.launcher;
    l.clock = clock;
    let Some(mode) = l.mode else {
        return false;
    };
    let mut changed = false;
    if l.path_error == Some(PENDING) {
        l.path_error = Some(clock);
        changed = true;
    }
    if l.path_error.is_some_and(|at| clock - at >= 0.6) {
        l.path_error = None;
        changed = true;
    } else if l.path_error.is_some() {
        // The shake is drawn from the clock: every frame is a new pose.
        tx.wake_after(Duration::ZERO);
        changed = true;
    }
    if l.busy && mode == LauncherMode::Create && l.closing.is_none() {
        // So is the indeterminate sweep.
        tx.wake_after(Duration::ZERO);
        changed = true;
    }
    match l.closing {
        Some(PENDING) => {
            l.closing = Some(clock);
            tx.wake_after(Duration::from_secs_f64(EXIT));
            return true;
        }
        Some(at) if clock - at >= EXIT => {
            l.closing = None;
            l.mode = None;
            l.shown = false;
            l.view = View::Form;
            l.error = None;
            l.busy = false;
            if let Some((path, name)) = l.after.take() {
                remember(s, path, name);
            }
            return true;
        }
        Some(at) => {
            tx.wake_after(Duration::from_secs_f64((EXIT - (clock - at)).max(0.0)));
            return changed;
        }
        None => {}
    }
    if !l.shown {
        let ready = mode != LauncherMode::Open || l.browser_request_id.is_none();
        l.frames = l.frames.saturating_add(1);
        if ready && l.frames >= 2 {
            l.shown = true;
            // A transparent card is inert, which dropped the open's focus request: ask again
            // as it shows, as Electron's `autofocus` lands on mount.
            match (mode, l.view) {
                (LauncherMode::Create, View::Form) => l.name.focused = true,
                (LauncherMode::Clone, View::Form) => l.url.focused = true,
                _ => l.path.focused = true,
            }
            return true;
        }
        tx.wake_after(Duration::ZERO);
    }
    changed
}

// ── look ───────────────────────────────────────────────────────────────────────
// Every value below is read from the Electron source (`FolderPickerModal.vue`,
// `FolderBrowser.vue`, `GitHubCloneModal.vue`, `CreateProjectModal.vue`,
// `ToggleSwitch.vue`) and checked against its computed styles.

const EASE: Easing = Easing::cubic(0.22, 1.0, 0.36, 1.0);
/// CSS `ease`.
const CSS_EASE: Easing = Easing::cubic(0.25, 0.1, 0.25, 1.0);
/// The app's global `line-height`.
const LH: f32 = 1.55;
/// Electron loads Geist at 400 only with `font-synthesis: none`: every weight is Regular.
const REGULAR: f32 = 400.0;
/// Lands a per-frame value at once: the poll clock already moved it.
const NOW: Curve = Curve::tween(0.0001, Easing::cubic(0.0, 0.0, 1.0, 1.0));

fn card_spring() -> Spring {
    Spring::from_stiffness_damping(300.0, 22.0, 0.9)
}
fn morph_spring() -> Spring {
    Spring::from_stiffness_damping(360.0, 34.0, 0.8)
}
fn sans(size: f32) -> TextStyle {
    TextStyle::new(size, REGULAR)
        .lh(size * LH)
        .tracking(-0.01 * size)
}
/// `ui-monospace, "SF Mono", …, Menlo, Consolas, "Liberation Mono"`: SF Mono on macOS,
/// the first installed of the rest elsewhere.
fn mono_family() -> Family {
    if cfg!(target_os = "macos") {
        Family::SystemMono
    } else {
        Family::Named("Menlo, Consolas, Liberation Mono")
    }
}
/// Chrome sets Liberation Mono's glyphs higher in their line box than Rune does: 1 pt in
/// the tight small lines, half a point in 1.55 ones (measured against Electron on Linux;
/// SF Mono on macOS is drawn as is).
fn mono_nudge(size: f32, line_height: f32) -> f32 {
    if cfg!(target_os = "macos") {
        0.0
    } else if size <= 11.0 || line_height < size * 1.5 {
        -1.0
    } else {
        -0.5
    }
}
fn mono(size: f32, weight: f32) -> TextStyle {
    TextStyle::new(size, weight)
        .family(mono_family())
        .lh(size * LH)
        .tracking(-0.01 * size)
}
/// Geist's webfont subset has no `→`, so Chrome draws it from `@nuxt/fonts`' size-adjusted
/// local fallback: BlinkMacSystemFont at 112.124 % on macOS, Arial (Arimo) at 104.755 %
/// elsewhere.
fn arrow(size: f32, color: rune::Color) -> El {
    let (family, adjust) = if cfg!(target_os = "macos") {
        (
            Family::Named(".AppleSystemUIFont, Helvetica Neue"),
            1.121_24,
        )
    } else {
        (Family::Named("Arimo, Arial, Liberation Sans"), 1.047_55)
    };
    text("→")
        .font(
            TextStyle::new(size * adjust, REGULAR)
                .family(family)
                .lh(size * LH)
                .tracking(-0.01 * size),
        )
        .color(color)
}
/// Chrome sets the fallback arrow on Geist's baseline; alone in its own line box Rune's
/// sits 1 pt lower (measured on Linux, where the fallback is Arimo).
const ARROW_RISE: f32 = if cfg!(target_os = "macos") { 0.0 } else { -1.0 };
fn band(t: Palette) -> rune::Color {
    crate::theme::mix_srgb(t.ground, t.ink, 0.02)
}
/// `color-mix(in srgb, var(--diff-del) pct, var(--ink))`.
fn del(t: Palette, pct: f32) -> rune::Color {
    crate::theme::mix_srgb(t.ink, rune::color::hex("#e11d48").unwrap(), pct)
}
fn del_soft(t: Palette) -> rune::Color {
    rune::color::hex(if t.dark { "#dc8a6f" } else { "#c2745c" }).unwrap()
}

/// A band action (`.clone-action`, `.picker-action`, `.cp-action`): 14 px, 0.7 opacity on
/// hover, 0.4 disabled, gap 0.4 rem.
fn band_action(key: impl Into<String>, enabled: bool, children: Vec<El>) -> El {
    let fade = Curve::tween(0.18, CSS_EASE);
    row()
        .key(key.into())
        .role("button")
        .focusable(enabled)
        .disabled(!enabled)
        .h(14.0 * LH)
        .center_y()
        .cursor(if enabled {
            rune::Cursor::Pointer
        } else {
            rune::Cursor::Default
        })
        .hover_group()
        .hover_motion(fade, fade)
        .opacity(if enabled { 1.0 } else { 0.4 })
        .opacity_motion(fade)
        .child(
            row()
                .gap(5.6)
                .center_y()
                .group_opacity(1.0, if enabled { 0.7 } else { 1.0 })
                .children(children),
        )
}
fn word(value: impl Into<String>, size: f32, color: rune::Color) -> El {
    text(value).font(sans(size)).color(color)
}
/// The forward cue: the accent arrow eases 3 pt right while its action is hovered.
fn nudge_arrow(t: Palette, on: bool) -> El {
    arrow(14.0, t.accent)
        .offset(if on { 3.0 } else { 0.0 }, ARROW_RISE)
        .offset_motion(Curve::tween(0.2, EASE))
}

/// The borderless field with its leading glyph (`.clone-field`, `.cp-field`).
fn field(
    t: Palette,
    glyph: &'static Icon,
    edit: &TextEdit,
    key: &'static str,
    label: &'static str,
    placeholder: &'static str,
    get: fn(&mut AppState) -> &mut TextEdit,
) -> El {
    let focused = edit.focused;
    let fade = Curve::tween(0.18, CSS_EASE);
    row()
        .w_full()
        .py(4.0)
        .gap(10.0)
        .center_y()
        .child(
            icon(glyph, 18.0)
                .color(if focused { t.ink_soft } else { t.muted })
                .opacity(if focused { 1.0 } else { 0.7 })
                .opacity_motion(fade),
        )
        .child(
            text_input(edit, mono(15.0, REGULAR))
                .key(key)
                .label(label)
                .single_line()
                .spellcheck(false)
                .grow(1.0)
                .shrink()
                .h(15.0 * LH)
                .offset(0.0, mono_nudge(15.0, 15.0 * LH))
                .placeholder(placeholder, t.muted)
                .caret(t.ink, t.accent.alpha(0.24))
                .color(t.ink)
                .on_edit(get)
                .on_submit(|s: &mut AppState, _| submit(s)),
        )
}

/// The one-line destination (`.clone-dest`, `.cp-dest`): glyph · label · path · Change.
fn destination(s: &AppState, t: Palette, verb: &'static str) -> El {
    let l = &s.launcher;
    let on = l.hover == Hover::Dest;
    let fade = Curve::tween(0.18, CSS_EASE);
    let path = l.collapse(&l.parent);
    // Liberation Mono's baseline sits 1 pt under Geist's at 13 px in a 20.15 pt line.
    let underline_y = 13.0 * LH / 2.0 + 13.0 * 0.4 + 1.0;
    row()
        .key("launcher-destination")
        .role("button")
        .label(verb)
        .focusable(true)
        .hover_group_focus()
        .hover_motion(fade, fade)
        .w_full()
        .mt(16.0)
        .h(13.0 * LH + 1.0)
        .gap(8.0)
        .items_start()
        .cursor(rune::Cursor::Pointer)
        .on_hover_change(|s: &mut AppState, over, _| {
            s.launcher.hover = if over { Hover::Dest } else { Hover::None };
        })
        .on_press(|s: &mut AppState| {
            if s.launcher.busy {
                return;
            }
            let path = s.launcher.parent.clone();
            s.launcher.anchor = s.launcher.home.clone();
            s.launcher.typed = false;
            s.launcher.path.focused = true;
            browse(s, path, Root::Jump);
        })
        .child(
            icon(&FOLDER_DEST, 15.0)
                .self_center()
                .color(if on { t.ink_soft } else { t.muted })
                .opacity(if on { 1.0 } else { 0.8 })
                .opacity_motion(fade),
        )
        .child(word(verb, 13.0, t.muted))
        .child(
            el().mt(1.0)
                .shrink()
                .child(text(path).font(mono(13.0, REGULAR)).color(t.ink).truncate())
                .child(
                    el().absolute(0.0, underline_y.round())
                        .w_full()
                        .h(1.0)
                        .fill(t.ink.alpha(if on { 0.42 } else { 0.16 })),
                ),
        )
        .child(el().grow(1.0))
        .child(
            text("Change")
                .font(sans(12.0))
                .color(t.ink_soft)
                .mt(1.0)
                .group_opacity(0.0, 1.0),
        )
}

fn header(children: Vec<El>) -> El {
    row()
        .w_full()
        .h(10.0 + 14.0 * LH + 10.0)
        .px(16.0)
        .gap(16.0)
        .center_y()
        .justify_end()
        .children(children)
}
fn footer(children: Vec<El>) -> El {
    header(children)
}
/// The panel the bands scoop around: `--panel` with 14 pt (`--band-arc`) corners.
fn panel(t: Palette, bottom_band: bool) -> El {
    let r = 14.0;
    col().w_full().fill(t.raised).corners([
        r,
        r,
        if bottom_band { r } else { 0.0 },
        if bottom_band { r } else { 0.0 },
    ])
}

fn create_form(s: &AppState, t: Palette) -> El {
    let l = &s.launcher;
    let cloning = l.mode == Some(LauncherMode::Clone);
    let busy = l.busy || (l.closing.is_some() && l.after.is_some());
    let cancel_button = band_action(
        "launcher-cancel",
        !(busy && !cloning),
        vec![word("Cancel", 14.0, t.muted)],
    )
    .on_press(|s: &mut AppState| cancel(s));
    let mut body = panel(t, !busy).px(16.0).py(16.0);
    if busy {
        body = body.child(progress_view(s, t));
    } else if cloning {
        body = body.child(field(
            t,
            &GITHUB,
            &l.url,
            "launcher-url",
            "GitHub repository — owner/repo or a URL",
            "owner/repo or https://github.com/…",
            |s| &mut s.launcher.url,
        ));
        if !l.url.text.trim().is_empty() {
            let line = match repo_parts(&l.url.text) {
                Some((owner, name)) => {
                    let head = format!("{owner}/");
                    let all = format!("{head}{name}");
                    text(all.clone())
                        .font(mono(11.5, REGULAR).lh(11.5 * 1.2))
                        .offset(0.0, mono_nudge(11.5, 11.5 * 1.2))
                        .color(t.muted)
                        .spans(vec![
                            Span::new(head.len(), all.len()).color(t.ink).weight(600.0),
                        ])
                }
                None => text("That doesn’t look like a GitHub repository")
                    .font(mono(11.5, REGULAR).lh(11.5 * 1.2))
                    .offset(0.0, mono_nudge(11.5, 11.5 * 1.2))
                    .color(t.muted),
            };
            body = body.child(line.truncate().mt(6.0).ml(28.0));
        }
        body = body.child(destination(s, t, "Clone into"));
    } else {
        body = body.child(field(
            t,
            &FOLDER_ADD,
            &l.name,
            "launcher-name",
            "Project name",
            "project-name",
            |s| &mut s.launcher.name,
        ));
        let name = l.name.text.trim();
        if !name.is_empty() && !valid_name(name) {
            body = body.child(
                text("That isn’t a valid folder name")
                    .font(mono(11.5, REGULAR).lh(11.5 * 1.2))
                    .offset(0.0, mono_nudge(11.5, 11.5 * 1.2))
                    .color(del(t, 0.78))
                    .truncate()
                    .mt(6.0)
                    .ml(28.0),
            );
        }
        body = body.child(destination(s, t, "Create in"));
    }
    if !busy && let Some(error) = &l.error {
        body = body.child(
            text(error.clone())
                .font(mono(11.5, REGULAR).lh(11.5 * 1.35))
                .offset(0.0, mono_nudge(11.5, 11.5 * 1.35))
                .color(del(t, 0.82))
                .wrap()
                .mt(14.0)
                .ml(28.0),
        );
    }
    let mut card = col()
        .w_full()
        .child(header(vec![cancel_button]))
        .child(body);
    if !busy {
        let enabled = l.submittable();
        let project = if cloning {
            repository(&l.url.text).map(|(n, _)| n).unwrap_or_default()
        } else {
            l.name.text.trim().to_owned()
        };
        let mut label = vec![word(if cloning { "Clone" } else { "Create" }, 14.0, t.ink)];
        if !project.is_empty() {
            label.push(word(format!("“{project}”"), 14.0, t.ink_soft));
        }
        label.push(nudge_arrow(t, enabled && l.hover == Hover::Submit));
        let submit_button = band_action("launcher-submit", enabled, label)
            .on_hover_change(|s: &mut AppState, over, _| {
                s.launcher.hover = if over { Hover::Submit } else { Hover::None };
            })
            .on_press(|s: &mut AppState| submit(s));
        let mut bar = vec![];
        if !cloning {
            let active = l.use_git || l.remote || !l.command.text.trim().is_empty();
            let mut more = vec![word(
                "More",
                14.0,
                if active { t.ink_soft } else { t.muted },
            )];
            if active {
                more.push(el().size(5.0, 5.0).radius(2.5).fill(t.accent));
            }
            bar.push(
                band_action("launcher-more", true, more).on_press(|s: &mut AppState| {
                    s.launcher.view = View::More;
                }),
            );
            bar.push(el().grow(1.0));
        }
        bar.push(submit_button);
        card = card.child(
            footer(bar).transition(Transition::offset(0.0, 10.0).combined(Transition::opacity())),
        );
    }
    card
}

/// The progress readout that replaces the form while a project is made or cloned.
fn progress_view(s: &AppState, t: Palette) -> El {
    let l = &s.launcher;
    let cloning = l.mode == Some(LauncherMode::Clone);
    let done = l.closing.is_some() && l.after.is_some();
    let name = if cloning {
        repository(&l.url.text).map(|(n, _)| n).unwrap_or_default()
    } else {
        l.name.text.trim().to_owned()
    };
    let into = l.collapse(&format!("{}/{}", l.parent.trim_end_matches('/'), name));
    let head = row()
        .w_full()
        .gap(8.0)
        .items_end()
        .pt(4.0)
        // `align-items: baseline` lets the mono line hang 1 pt below Geist's box.
        .pb(13.0)
        .child(if cloning {
            text(name.clone()).font(sans(16.0)).color(t.ink)
        } else {
            text(name.clone()).font(mono(13.0, 600.0)).color(t.ink)
        })
        .child(
            text(format!("→ {into}"))
                .font(mono(11.5, REGULAR))
                .color(t.muted)
                .truncate()
                .shrink()
                .mb(1.0),
        );
    let track = row()
        .w_full()
        .h(4.0)
        .radius(2.0)
        .fill(t.ink.alpha(0.08))
        .clip_rounded(2.0);
    let track = if cloning || done {
        let p = if done { 1.0 } else { l.progress as f32 };
        track.child(el().h(4.0).w_frac(p.max(0.0)).radius(2.0).fill(t.accent))
    } else {
        // `cp-sweep`: a 38 % bar crossing from -110 % to 370 % of its width every 1.1 s.
        let phase = ((l.clock % 1.1) / 1.1) as f32;
        let eased = Easing::cubic(0.65, 0.0, 0.35, 1.0).eval(phase);
        let x = (-1.1 + eased * 4.8) * 0.38;
        track.child(
            el().h(4.0)
                .w_frac(0.38)
                .radius(2.0)
                .fill(t.accent)
                .offset(x * 416.0, 0.0)
                .offset_motion(NOW),
        )
    };
    let stage = if done {
        if cloning {
            "Done".to_owned()
        } else {
            "Ready".to_owned()
        }
    } else if l.cancelling {
        "Cancelling…".to_owned()
    } else if cloning {
        if l.stage.is_empty() {
            "Cloning…".to_owned()
        } else {
            l.stage.clone()
        }
    } else if !l.command.text.trim().is_empty() {
        "Running setup…".to_owned()
    } else {
        "Creating…".to_owned()
    };
    let mut meta = row().w_full().mt(8.0).justify_between().child(
        text(stage)
            .font(mono(11.5, REGULAR))
            .color(t.ink_soft)
            .offset(0.0, mono_nudge(11.5, 11.5 * LH)),
    );
    if cloning {
        let pct = if done {
            100.0
        } else {
            (l.progress * 100.0).round()
        };
        meta = meta.child(
            text(format!("{pct}%"))
                .font(mono(11.5, REGULAR).features("tnum"))
                .offset(0.0, mono_nudge(11.5, 11.5 * LH))
                .color(t.muted),
        );
    }
    col()
        .w_full()
        .key("launcher-progress")
        .transition(
            Transition::offset(0.0, 10.0)
                .combined(Transition::opacity())
                .combined(Transition::blur(3.0)),
        )
        .child(head)
        .child(track)
        .child(meta)
}

fn toggle(
    t: Palette,
    key: &'static str,
    label: &'static str,
    on: bool,
    press: fn(&mut AppState),
) -> El {
    let ease = Curve::tween(0.24, EASE);
    el().key(key)
        .role("switch")
        .label(label)
        .checked(on)
        .focusable(true)
        .size(40.0, 24.0)
        .radius(12.0)
        .fill(if on { t.accent } else { t.ink.alpha(0.13) })
        .box_shadow(Shadow {
            x: 0.0,
            y: 1.0,
            blur: 2.0,
            spread: 0.0,
            color: rune::Color::BLACK.alpha(if on { 0.14 } else { 0.12 }),
            inset: true,
        })
        .cursor(rune::Cursor::Pointer)
        .on_press(press)
        .child(
            el().absolute(3.0, 3.0)
                .size(18.0, 18.0)
                .radius(9.0)
                .fill(rune::Color::WHITE)
                .shadow(1.0, 3.0, rune::Color::BLACK.alpha(0.3))
                .offset(if on { 16.0 } else { 0.0 }, 0.0)
                .offset_motion(ease),
        )
}

fn more_view(s: &AppState, t: Palette) -> El {
    let l = &s.launcher;
    let section = |label: &'static str| {
        text(label.to_uppercase())
            .font(mono(10.0, 500.0).tracking(1.4))
            .offset(0.0, mono_nudge(10.0, 10.0 * LH))
            .color(t.muted)
            .mb(9.6)
    };
    let line = |label: &'static str, control: El| {
        row()
            .w_full()
            .min_h(34.0)
            .gap(16.0)
            .center_y()
            .justify_between()
            .child(word(label, 13.5, t.ink).grow(1.0).shrink())
            .child(control)
    };
    let sub = |label: &'static str, control: El| {
        row()
            .w_full()
            .min_h(32.0)
            .pl(14.4)
            .gap(16.0)
            .center_y()
            .justify_between()
            .child(word(label, 13.0, t.ink_soft).grow(1.0).shrink())
            .child(control)
    };
    let mut git = col().w_full().child(section("Git")).child(line(
        "Initialize a repository",
        toggle(
            t,
            "launcher-git",
            "Initialize a git repository",
            l.use_git,
            |s| {
                s.launcher.use_git = !s.launcher.use_git;
                if !s.launcher.use_git {
                    s.launcher.remote = false;
                }
            },
        ),
    ));
    if l.use_git {
        git = git.child(
            sub(
                "Add a README",
                toggle(t, "launcher-readme", "Add a README", l.readme, |s| {
                    s.launcher.readme = !s.launcher.readme;
                }),
            )
            .key("launcher-git-opts")
            .transition(Transition::opacity()),
        );
    }
    let mut github = col().w_full().mt(25.6).child(section("GitHub")).child(line(
        "Create a repository",
        toggle(
            t,
            "launcher-remote",
            "Create a GitHub repository",
            l.remote,
            |s| {
                s.launcher.remote = !s.launcher.remote;
                if s.launcher.remote {
                    s.launcher.use_git = true;
                }
            },
        ),
    ));
    if l.remote {
        let name = l.name.text.trim().to_owned();
        let placeholder: &'static str = if name.is_empty() {
            "project-name"
        } else {
            Box::leak(name.into_boxed_str())
        };
        let seg = |key: &'static str, label: &'static str, on: bool, public: bool| {
            row()
                .key(key)
                .role("button")
                .focusable(true)
                .px(12.0)
                .py(3.52)
                .radius(99.0)
                .fill(if on {
                    t.raised
                } else {
                    rune::Color::TRANSPARENT
                })
                .box_shadow(Shadow {
                    x: 0.0,
                    y: 1.0,
                    blur: 2.0,
                    spread: 0.0,
                    color: rune::Color::BLACK.alpha(if on { 0.14 } else { 0.0 }),
                    inset: false,
                })
                .cursor(rune::Cursor::Pointer)
                .child(text(label).font(sans(12.0).lh(12.0 * LH)).color(if on {
                    t.ink
                } else {
                    t.muted
                }))
                .on_press(move |s: &mut AppState| s.launcher.public = public)
        };
        github = github
            .child(sub(
                "Name",
                text_input(&l.repo_name, mono(13.0, REGULAR))
                    .key("launcher-repo-name")
                    .label("Repository name")
                    .single_line()
                    .align(rune::Align::End)
                    .w(144.0)
                    .h(13.0 * LH)
                    .placeholder(placeholder, t.muted)
                    .caret(t.accent, t.accent.alpha(0.24))
                    .color(t.ink)
                    .on_edit(|s: &mut AppState| &mut s.launcher.repo_name),
            ))
            .child(
                sub(
                    "Visibility",
                    row()
                        .gap(2.0)
                        .padding(2.0)
                        .radius(99.0)
                        .fill(t.ink.alpha(0.08))
                        .child(seg("launcher-private", "Private", !l.public, false))
                        .child(seg("launcher-public", "Public", l.public, true)),
                )
                .mt(1.6),
            );
    }
    let focused = l.command.focused;
    let setup = col()
        .w_full()
        .mt(25.6)
        .child(section("Setup"))
        .child(
            row()
                .w_full()
                .gap(8.8)
                .px(12.0)
                .py(9.6)
                .radius(11.0)
                .fill(t.hover)
                .center_y()
                .child(text("$").font(mono(13.5, REGULAR)).color(if focused {
                    t.accent
                } else {
                    t.muted
                }))
                .child(
                    text_input(&l.command, mono(13.5, REGULAR))
                        .key("launcher-command")
                        .label("Setup command to run in the new folder")
                        .single_line()
                        .grow(1.0)
                        .shrink()
                        .h(13.5 * LH)
                        .placeholder("npm create vite@latest .", t.muted)
                        .caret(t.accent, t.accent.alpha(0.24))
                        .color(t.ink)
                        .on_edit(|s: &mut AppState| &mut s.launcher.command),
                ),
        )
        .child(word("Runs in the new folder after it’s created.", 11.5, t.muted).mt(8.0));
    let eyebrow = text("MORE")
        .font(mono(11.0, REGULAR).tracking(0.22))
        .offset(0.0, mono_nudge(11.0, 11.0 * LH))
        .color(t.muted)
        .grow(1.0);
    col()
        .w_full()
        .child(header(vec![
            eyebrow,
            band_action("launcher-done", true, vec![word("Done", 14.0, t.ink)]).on_press(
                |s: &mut AppState| {
                    s.launcher.view = View::Form;
                    s.launcher.name.focused = true;
                },
            ),
        ]))
        .child(
            panel(t, false).px(16.0).py(16.0).child(
                col()
                    .w_full()
                    .max_h((0.58 * l.viewport_h).min(480.0))
                    .scroll(ScrollSpec {
                        stick_bottom: false,
                    })
                    .child(git)
                    .child(github)
                    .child(setup),
            ),
        )
}

const STEP: f32 = 26.0;
fn indent(level: usize) -> f32 {
    level.min(4) as f32 * STEP
}

/// A browser row (`.picker-row`): 8 × 12 pt padding, 10 pt corners, the hover wash, a
/// 20 pt glyph slot whose glyph firms on hover, and a 15 pt label.
fn picker_row(
    t: Palette,
    key: String,
    glyph: &'static Icon,
    rest: f32,
    hover: f32,
    label: String,
    color: rune::Color,
) -> El {
    let wash = Curve::tween(0.18, CSS_EASE);
    row()
        .key(key)
        .role("button")
        .label(label.clone())
        .focusable(true)
        .h(32.5)
        .px(12.0)
        .gap(6.0)
        .center_y()
        .radius(10.0)
        .hover(t.hover)
        .hover_motion(wash, wash)
        .focus_highlight(t.hover)
        .hover_group()
        .cursor(rune::Cursor::Pointer)
        .child(
            el().w(20.0)
                .h(16.0)
                .group_opacity(rest, hover)
                .child(icon(glyph, 16.0).color(color)),
        )
        .child(
            text(label)
                .font(TextStyle::new(15.0, REGULAR).lh(16.5).tracking(-0.15))
                .color(color)
                .truncate()
                .shrink(),
        )
}

fn browser(s: &AppState, t: Palette) -> El {
    let l = &s.launcher;
    let embedded = l.mode != Some(LauncherMode::Open);
    let current = l.current_path.clone();
    let name = folder_name(&current);
    let field_color = if l.path_error.is_some() {
        del_soft(t)
    } else if l.path.focused {
        t.ink
    } else {
        t.muted
    };
    // `pathShake`: ±4 pt at 20/40/60/80 % over 0.4 s, each step eased.
    let shake = l.path_error.filter(|at| *at != PENDING).map_or(0.0, |at| {
        let p = ((l.clock - at) / 0.4).clamp(0.0, 1.0) as f32;
        let keys = [0.0, -4.0, 4.0, -4.0, 4.0, 0.0];
        let seg = ((p * 5.0).floor() as usize).min(4);
        let local = Easing::cubic(0.36, 0.07, 0.19, 0.97).eval(p * 5.0 - seg as f32);
        keys[seg] + (keys[seg + 1] - keys[seg]) * local
    });
    let address = text_input(&l.path, mono(11.5, REGULAR))
        .key("launcher-path")
        .label("Directory path — edit and press Enter to go there")
        .single_line()
        .spellcheck(false)
        .grow(1.0)
        .shrink()
        .h(11.5 * LH)
        .caret(t.ink, t.accent.alpha(0.24))
        .color(field_color)
        .offset(shake, mono_nudge(11.5, 11.5 * LH))
        .offset_motion(NOW)
        .on_edit(|s: &mut AppState| &mut s.launcher.path)
        .on_key(|s: &mut AppState, event, _| {
            if event.key == Key::Escape {
                let l = &mut s.launcher;
                l.path.text = l.address(&l.current_path.clone());
                l.path.anchor = l.path.text.len();
                l.path.focus = l.path.text.len();
                l.path.focused = false;
                true
            } else if matches!(event.key, Key::Tab | Key::Right)
                && s.launcher.path.anchor != s.launcher.path.focus
            {
                s.launcher.path.anchor = s.launcher.path.focus.max(s.launcher.path.anchor);
                s.launcher.path.focus = s.launcher.path.anchor;
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
            s.launcher.typed = true;
            browse(s, p, Root::Jump);
        });
    let back = band_action(
        "launcher-back",
        true,
        vec![word(
            if embedded { "Back" } else { "Cancel" },
            14.0,
            t.muted,
        )],
    )
    .on_press(|s: &mut AppState| s.launcher.close());

    let enter = Transition::offset(0.0, 24.0)
        .combined(Transition::opacity())
        .springs(rune::SpringPair::new(
            Spring::from_stiffness_damping(320.0, 20.0, 0.8),
            Spring::NONE,
        ));
    let pulled = |key: &str, row: El| {
        let [x, y] = l.pull.get(key).copied().unwrap_or([0.0; 2]);
        let active = l.pull.contains_key(key);
        row.offset(x, y)
            .offset_motion(Curve::tween(if active { 0.35 } else { 0.6 }, EASE))
    };
    let mut list = col().w_full().items_start().py(4.0);
    if let Some(parent) = l.parent_of_anchor() {
        let label = if parent == "/" {
            "/".to_owned()
        } else {
            folder_name(&parent)
        };
        list = list.child(
            picker_row(
                t,
                "launcher-ascend".into(),
                &ARROW_UP,
                0.55,
                1.0,
                label,
                t.muted,
            )
            .on_press(move |s: &mut AppState| {
                s.launcher.typed = false;
                browse(s, parent.clone(), Root::Jump);
            }),
        );
    }
    let crumbs = l.crumbs();
    let depth = crumbs.len();
    for (i, (crumb, path)) in crumbs.into_iter().enumerate() {
        let is_current = i + 1 == depth;
        let key = format!("launcher-row:{path}");
        let p = path.clone();
        let row = picker_row(
            t,
            key.clone(),
            &ARROW_BACK,
            0.55,
            1.0,
            crumb,
            if is_current { t.ink_soft } else { t.muted },
        )
        .on_press(move |s: &mut AppState| {
            let l = &mut s.launcher;
            let recent = l
                .recent_descend
                .as_ref()
                .is_some_and(|(last, at)| *last == p && at.elapsed() < Duration::from_millis(260));
            if is_current && recent {
                l.recent_descend = None;
                choose(s, p.clone());
            } else {
                l.typed = false;
                browse(s, p.clone(), Root::Keep);
            }
        });
        list = list.child(
            magnet(pulled(&key, row), key)
                .ml(indent(i))
                .transition(enter),
        );
    }
    for (name, path) in &l.entries {
        let key = format!("launcher-row:{path}");
        let p = path.clone();
        let row = picker_row(t, key.clone(), &FOLDER_ROW, 0.45, 0.8, name.clone(), t.ink)
            .on_press(move |s: &mut AppState| descend(s, p.clone()));
        list = list.child(
            magnet(pulled(&key, row), key)
                .ml(indent(depth))
                .transition(enter),
        );
    }
    if l.entries.is_empty() && l.browser_request_id.is_none() && !current.is_empty() {
        list = list.child(
            text(if l.read_error {
                "Can’t read this folder"
            } else {
                "No subfolders"
            })
            .font(TextStyle::new(15.0, REGULAR).lh(16.5).tracking(-0.15))
            .color(t.muted)
            .px(12.0)
            .py(10.0)
            .ml(indent(depth) + 20.0),
        );
    }
    let verb = match l.mode {
        Some(LauncherMode::Create) => "Create in",
        Some(LauncherMode::Clone) => "Clone into",
        _ => "Open",
    };
    let head = format!("{verb} ");
    let label = format!("{head}“{name}”");
    let ready = !current.is_empty();
    let choose_button = band_action(
        "launcher-choose",
        ready,
        vec![
            text(label.clone())
                .font(sans(14.0))
                .color(t.ink)
                .spans(vec![Span::new(head.len(), label.len()).color(t.ink_soft)]),
            nudge_arrow(t, ready && l.hover == Hover::Choose),
        ],
    )
    .on_hover_change(|s: &mut AppState, over, _| {
        s.launcher.hover = if over { Hover::Choose } else { Hover::None };
    })
    .on_press(|s: &mut AppState| {
        let path = s.launcher.current_path.clone();
        if path.is_empty() {
            return;
        }
        choose(s, path);
    });
    let scroll = col()
        .key("launcher-scroll")
        .w_full()
        .max_h(0.48 * l.viewport_h)
        .scroll(ScrollSpec {
            stick_bottom: false,
        })
        .scroll_fade(ScrollFade::strength(22.0).linear().full_at(1.0))
        .on_pointer_move(|s: &mut AppState, p| pull_rows(s, p.x, p.y))
        .on_hover_change(|s: &mut AppState, over, _| {
            if !over {
                s.launcher.pull.clear();
            }
        })
        .child(list);
    col()
        .w_full()
        .child(header(vec![address, back]))
        .child(panel(t, true).pl(16.0).py(16.0).child(scroll))
        .child(footer(vec![choose_button]))
}

/// Electron's `Magnet` (padding 12, strength 9) around each browser row.
fn magnet(row: El, key: String) -> El {
    el().child(row).on_layout(move |s: &mut AppState, bounds| {
        s.launcher.row_bounds.insert(key.clone(), bounds);
    })
}
fn pull_rows(s: &mut AppState, x: f32, y: f32) {
    if s.launcher.browser_request_id.is_some() {
        s.launcher.pull.clear();
        return;
    }
    let mut pull = HashMap::new();
    for (key, [bx, by, w, h]) in &s.launcher.row_bounds {
        let (dx, dy) = (x - (bx + w / 2.0), y - (by + h / 2.0));
        if dx.abs() < w / 2.0 + 12.0 && dy.abs() < h / 2.0 + 12.0 {
            pull.insert(key.clone(), [dx / 9.0, dy / 9.0]);
        }
    }
    s.launcher.pull = pull;
}

pub fn view(s: &AppState, cx: &mut Cx<AppState>) -> El {
    let t = Palette::new(cx.system_dark());
    let l = &s.launcher;
    let shown = l.shown;
    let content = match l.view {
        View::Browser => browser(s, t),
        View::More => more_view(s, t),
        View::Form => create_form(s, t),
    };
    let morph = morph_spring();
    let content = el()
        .key(match l.view {
            View::Form => "launcher-form",
            View::Browser => "launcher-browser",
            View::More => "launcher-more-view",
        })
        .w_full()
        .transition(
            Transition::asymmetric(
                Transition::offset(0.0, 10.0)
                    .combined(Transition::opacity())
                    .combined(Transition::blur(3.0)),
                Transition::offset(0.0, -10.0)
                    .combined(Transition::opacity())
                    .combined(Transition::blur(3.0)),
            )
            .springs(rune::SpringPair::new(morph, morph)),
        )
        .child(content);
    let spring = card_spring();
    // `box-shadow: 0 0 0 1px ink 8%` is a hairline ring outside the card: a 1 pt wider
    // pill of that tint under the opaque card.
    let card = col()
        .w(448.0)
        .fill(band(t))
        .radius(18.0)
        .clip_rounded(18.0)
        .child(content);
    let card = el()
        .key("launcher-card")
        .padding(1.0)
        .mr(-1.0)
        .mb(-1.0)
        .radius(19.0)
        .fill(t.ink.alpha(0.08))
        .opacity(if shown { 1.0 } else { 0.0 })
        .opacity_motion(spring)
        .offset(0.0, if shown { 0.0 } else { 12.0 })
        .offset_motion(spring)
        .scale(if shown { 1.0 } else { 0.96 })
        .scale_motion(spring)
        .child(card)
        .modal(true, |s: &mut AppState| cancel(s));
    el().key("launcher-overlay")
        .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
        .transition(Transition::none())
        .on_layout(|s: &mut AppState, [_, _, _, h]| s.launcher.viewport_h = h)
        .child(
            el().key("launcher-scrim")
                .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                .fill(t.ground.alpha(0.62))
                .backdrop_blur(4.0)
                .opacity(if shown { 1.0 } else { 0.0 })
                .opacity_motion(Curve::tween(0.24, EASE)),
        )
        .child(
            col()
                .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                .padding(24.0)
                .items_end()
                .justify_end()
                .child(card),
        )
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
        // The card plays its exit before it unmounts.
        assert!(s.launcher.closing.is_some());
        let mut tx = Tx::default();
        tick(&mut s, 10.0, &mut tx);
        assert!(s.launcher.mode.is_some());
        tick(&mut s, 10.0 + EXIT, &mut tx);
        assert!(s.launcher.mode.is_none());
        assert!(s.pending_project_path.is_none());
    }
    #[test]
    fn the_card_shows_on_its_second_frame_and_refocuses_its_field() {
        let mut s = AppState::default();
        s.launcher.open(LauncherMode::Create);
        // A transparent card is inert, which drops the focus request.
        s.launcher.name.focused = false;
        let mut tx = Tx::default();
        tick(&mut s, 0.0, &mut tx);
        assert!(!s.launcher.shown);
        tick(&mut s, 0.016, &mut tx);
        assert!(s.launcher.shown && s.launcher.name.focused);
        s.launcher.close();
        tick(&mut s, 0.1, &mut tx);
        tick(&mut s, 0.1 + EXIT / 2.0, &mut tx);
        assert!(s.launcher.mode.is_some());
        tick(&mut s, 0.1 + EXIT + 1e-6, &mut tx);
        assert!(s.launcher.mode.is_none() && !s.launcher.shown);
    }
}
