// useIntentMenu — the intent menu's content model.
//
// A right-click anywhere summons one small menu instead of growing another
// surface. Its rows are derived from three signals, in order:
//   1. where — the view the pointer is over (launcher, project overview/git,
//      studio plane, inbox),
//   2. now — what is live there (a portal covering the page, dirty git state),
//   3. before — what happened (recent projects, recent sessions).
//
// The builder below is pure (no Vue, no bridge) so the ranking rules stay
// unit-testable; the page gathers the signals and hands them in. Sections are
// deliberately unlabelled — the divided picker-shell cards carry the grouping,
// the way the project switcher splits list vs. actions without headers.
//
// Location note: this file lives in composables/ beside the stateful menu host,
// but it is a pure model — every export is a total function of its arguments,
// safe to import from tests and non-component modules.

export type IntentView =
  | "launcher"
  | "project-overview"
  | "project-git"
  | "studio"
  | "inbox";

export type IntentIcon =
  | "studio"
  | "inbox"
  | "overview"
  | "git"
  | "launcher"
  | "back"
  | "review"
  | "project"
  | "session"
  | "create"
  | "open"
  | "clone"
  | "pin"
  | "reveal"
  | "forget"
  | "settings"
  | "archive";

export type IntentAction =
  | { kind: "goto"; view: "studio" | "inbox" | "launcher" | "overview" | "git" }
  | { kind: "open-project"; path: string; name: string }
  | { kind: "open-session"; path: string; name: string; threadId: string }
  | { kind: "pin-project"; path: string }
  | { kind: "reveal-project"; path: string }
  | { kind: "forget-project"; path: string }
  | { kind: "pin-session"; threadId: string }
  | { kind: "archive-session"; threadId: string }
  | { kind: "review-changes" }
  | { kind: "start"; key: "create" | "open" | "clone" }
  | { kind: "open-settings" }
  | { kind: "back-to-page" };

/** @deprecated Kept for backwards compat — dispatch on `IntentItem.action` instead. */
export interface IntentPayload {
  /** Target project path for open-project / open-session rows. */
  path?: string;
  /** Target project name for open-project rows. */
  name?: string;
  /** Target thread for open-session rows. */
  threadId?: string;
}

export interface IntentItem {
  /** Dumb stable :key — kept as the same strings so existing keys keep working. */
  id: string;
  label: string;
  hint?: string;
  icon: IntentIcon;
  /** @deprecated Kept for backwards compat — dispatch on `action` instead. */
  payload?: IntentPayload;
  action: IntentAction;
}

export interface IntentSection {
  key: "goto" | "target" | "now" | "recents" | "sessions" | "entry";
  items: IntentItem[];
}

export interface IntentRecentProject {
  path: string;
  name: string;
}

export interface IntentRecentSession {
  threadId: string;
  title: string;
  projectPath: string;
  projectName: string;
}

export interface IntentGitNow {
  repo: boolean;
  dirtyFiles: number;
  branch: string | null;
}

export interface IntentTargetProject {
  path: string;
  name: string;
  pinned?: boolean;
}

export interface IntentTargetSession {
  threadId: string;
  title: string;
  projectPath: string;
  projectName: string;
  pinned?: boolean;
}

/** The launcher pointer target, resolved once per build. A session row under
 *  the pointer beats a tile: rows never sit inside tiles, but the pointer can
 *  only mean one thing. */
export type IntentTarget =
  | { kind: "session"; session: IntentTargetSession }
  | { kind: "project"; project: IntentTargetProject };

export interface IntentContext {
  view: IntentView;
  /** Project path when a project is open, else null. */
  currentPath?: string | null;
  git?: IntentGitNow | null;
  /** Already ranked (pins first, then recency). Includes the current project. */
  recents: IntentRecentProject[];
  /** Already ranked by recency. */
  sessions: IntentRecentSession[];
  /** Whether the studio plane holds any rows to go back to. */
  studioHasRows: boolean;
  /** Whether the settings drawer is already revealed — its go-to hides then,
   *  the way no view names itself. */
  settingsOpen: boolean;
  /** The launcher tile under the pointer, if any. On the all-projects page
   *  there is no open project, so the right-clicked tile — not global state —
   *  is the project context. Null (or absent) means empty space: no project
   *  in mind at all. */
  targetProject?: IntentTargetProject | null;
  /** The launcher session row under the pointer, if any. Beats a tile target:
   *  rows never sit inside tiles, but the pointer can only mean one thing. */
  targetSession?: IntentTargetSession | null;
}

const MAX_RECENTS = 3;
const MAX_SESSIONS = 3;

// Menu rows stay single-line: long conversation titles cut with an ellipsis.
const MENU_TITLE_MAX = 40;
export function shortSessionTitle(title: string): string {
  const t = title.trim();
  if (t.length === 0) return "Untitled session";
  return t.length > MENU_TITLE_MAX ? `${t.slice(0, MENU_TITLE_MAX - 1)}…` : t;
}

// The pointer target, resolved once per build. Launcher-only: on project,
// studio and inbox views the open project (or portal) is the context and any
// tile/session signal is ignored. Within the launcher a session row beats a
// tile — every section below switches on this one value, so the rule is
// stated here and nowhere else.
function resolveTarget(ctx: IntentContext): IntentTarget | null {
  if (ctx.view !== "launcher") return null;
  if (ctx.targetSession) return { kind: "session", session: ctx.targetSession };
  if (ctx.targetProject) return { kind: "project", project: ctx.targetProject };
  return null;
}

// The header names the subject — a session's (possibly shortened) title beats
// a tile's name, which beats the view itself (the open project's name, or the
// portal name, or the app name on empty space).
export function resolveIntentTitle(
  view: IntentView,
  targetSession: IntentTargetSession | null | undefined,
  targetProject: IntentTargetProject | null | undefined,
  projectName: string | null | undefined,
): string {
  const sessionTitle =
    targetSession && targetSession.title.trim().length > 0
      ? shortSessionTitle(targetSession.title)
      : null;
  if (sessionTitle) return sessionTitle;
  if (targetProject) return targetProject.name;
  if (view === "studio") return "Studio";
  if (view === "inbox") return "Inbox";
  return projectName ?? "Kone";
}

// ── go-tos: always first, always view-relative ──────────────────────────────
// Each view names where you can go from it — never where you already are — so
// the top card reads as "from here" rather than a fixed nav dump.
function gotoItems(ctx: IntentContext): IntentItem[] {
  let items: IntentItem[];
  switch (ctx.view) {
    case "studio":
      items = [
        { id: "back-to-page", label: "Back to page", icon: "back", action: { kind: "back-to-page" } },
        { id: "goto-inbox", label: "Go to Inbox", icon: "inbox", action: { kind: "goto", view: "inbox" } },
      ];
      break;
    case "inbox": {
      items = [{ id: "back-to-page", label: "Back to page", icon: "back", action: { kind: "back-to-page" } }];
      if (ctx.studioHasRows) items.push({ id: "goto-studio", label: "Go to Studio", icon: "studio", action: { kind: "goto", view: "studio" } });
      break;
    }
    case "launcher": {
      items = [];
      const target = resolveTarget(ctx);
      // A session row under the pointer beats a tile: resume it first.
      if (target?.kind === "session") {
        const ts = target.session;
        items.push({
          id: `open-session:${ts.projectPath}::${ts.threadId}`,
          label: `Open ${shortSessionTitle(ts.title)}`,
          hint: ts.projectName,
          icon: "session",
          payload: { path: ts.projectPath, name: ts.projectName, threadId: ts.threadId },
          action: {
            kind: "open-session",
            path: ts.projectPath,
            name: ts.projectName,
            threadId: ts.threadId,
          },
        });
      } else if (target?.kind === "project") {
        // A tile under the pointer opens the menu about itself — Open leads,
        // so the top card still reads as "from here".
        const t = target.project;
        items.push({
          id: `open-project:${t.path}`,
          label: `Open ${t.name}`,
          icon: "project",
          payload: { path: t.path, name: t.name },
          action: { kind: "open-project", path: t.path, name: t.name },
        });
      }
      if (ctx.studioHasRows) items.push({ id: "goto-studio", label: "Go to Studio", icon: "studio", action: { kind: "goto", view: "studio" } });
      items.push({ id: "goto-inbox", label: "Go to Inbox", icon: "inbox", action: { kind: "goto", view: "inbox" } });
      break;
    }
    case "project-git":
      items = [
        { id: "goto-overview", label: "Back to Overview", icon: "overview", action: { kind: "goto", view: "overview" } },
        { id: "goto-studio", label: "Go to Studio", icon: "studio", action: { kind: "goto", view: "studio" } },
        { id: "goto-inbox", label: "Go to Inbox", icon: "inbox", action: { kind: "goto", view: "inbox" } },
        { id: "goto-launcher", label: "All projects", icon: "launcher", action: { kind: "goto", view: "launcher" } },
      ];
      break;
    case "project-overview":
    default: {
      items = [];
      // Unknown (no snapshot yet) hides the Git go-to: offering it before the
      // project page publishes means landing on a space with nothing to show.
      if (ctx.git?.repo === true) {
        items.push({ id: "goto-git", label: "Go to Git space", icon: "git", action: { kind: "goto", view: "git" } });
      }
      items.push(
        { id: "goto-studio", label: "Go to Studio", icon: "studio", action: { kind: "goto", view: "studio" } },
        { id: "goto-inbox", label: "Go to Inbox", icon: "inbox", action: { kind: "goto", view: "inbox" } },
        { id: "goto-launcher", label: "All projects", icon: "launcher", action: { kind: "goto", view: "launcher" } },
      );
      break;
    }
  }
  // The drawer is chrome over every view, so its go-to closes every card —
  // unless it is already the thing in front.
  if (!ctx.settingsOpen) {
    items.push({ id: "open-settings", label: "Open Settings", icon: "settings", action: { kind: "open-settings" } });
  }
  return items;
}

// ── target: what the pointer is on ──────────────────────────────────────────
// The tile's (or session row's) own actions, in its own words — the same
// labels as the controls the pointer is over. Only on the launcher, only when
// something is under the pointer. Delete stays off the menu on purpose: the
// row guards it behind hold-to-confirm, and a single menu click must never
// permanently delete.
function targetItems(ctx: IntentContext): IntentItem[] {
  const target = resolveTarget(ctx);
  if (!target) return [];
  if (target.kind === "session") {
    const ts = target.session;
    const payload = { path: ts.projectPath, name: ts.projectName, threadId: ts.threadId };
    return [
      {
        id: `pin-session:${ts.threadId}`,
        label: ts.pinned ? "Unpin conversation" : "Pin conversation",
        icon: "pin",
        payload,
        action: { kind: "pin-session", threadId: ts.threadId },
      },
      {
        id: `archive-session:${ts.threadId}`,
        label: "Archive conversation",
        icon: "archive",
        payload,
        action: { kind: "archive-session", threadId: ts.threadId },
      },
    ];
  }
  const t = target.project;
  const payload = { path: t.path, name: t.name };
  return [
    {
      id: `pin-project:${t.path}`,
      label: t.pinned ? "Unpin project" : "Pin to top",
      icon: "pin",
      payload,
      action: { kind: "pin-project", path: t.path },
    },
    {
      id: `reveal-project:${t.path}`,
      label: "Reveal in Finder",
      icon: "reveal",
      payload,
      action: { kind: "reveal-project", path: t.path },
    },
    {
      id: `forget-project:${t.path}`,
      label: "Remove from recents",
      icon: "forget",
      payload,
      action: { kind: "forget-project", path: t.path },
    },
  ];
}

// ── now: what is live and actionable ────────────────────────────────────────
// Only rows the menu host can actually run belong here. Dirty git state earns
// a review shortcut on project views; portals are covered by the go-to card's
// back row, so they add nothing here.
function nowItems(ctx: IntentContext): IntentItem[] {
  if (ctx.view !== "project-overview" && ctx.view !== "project-git") return [];
  const git = ctx.git;
  if (!git || git.repo === false) return [];
  if (git.dirtyFiles <= 0) return [];
  const noun = git.dirtyFiles === 1 ? "change" : "changes";
  return [
    {
      id: "review-changes",
      label: `Review ${git.dirtyFiles} ${noun}`,
      hint: git.branch ?? undefined,
      icon: "review",
      action: { kind: "review-changes" },
    },
  ];
}

// ── recents: other projects worth jumping to ─────────────────────────────────
// Capped so the card stays a glance. Any launcher target (tile or session)
// focuses the menu on its subject, so this card stays out.
function recentsItems(ctx: IntentContext): IntentItem[] {
  if (resolveTarget(ctx)) return [];
  const others = ctx.recents.filter((p) => p.path !== ctx.currentPath).slice(0, MAX_RECENTS);
  return others.map((p) => ({
    id: `open-project:${p.path}`,
    label: p.name,
    icon: "project",
    payload: { path: p.path, name: p.name },
    action: { kind: "open-project", path: p.path, name: p.name },
  }));
}

// ── sessions: conversations worth resuming ──────────────────────────────────
// A targeted tile narrows this card to its own sessions; a targeted session
// narrows it to its project's others, dropping itself (it already leads).
function sessionsItems(ctx: IntentContext): IntentItem[] {
  const target = resolveTarget(ctx);
  const projectTarget = target?.kind === "project" ? target.project : null;
  const sessionTarget = target?.kind === "session" ? target.session : null;
  const sessions = ctx.sessions
    .filter(
      (s) =>
        s.threadId.length > 0 &&
        (!projectTarget || s.projectPath === projectTarget.path) &&
        (!sessionTarget ||
          (s.projectPath === sessionTarget.projectPath && s.threadId !== sessionTarget.threadId)),
    )
    .slice(0, MAX_SESSIONS);
  return sessions.map((s) => ({
    id: `open-session:${s.projectPath}::${s.threadId}`,
    label: shortSessionTitle(s.title),
    hint: s.projectName,
    icon: "session",
    payload: { path: s.projectPath, name: s.projectName, threadId: s.threadId },
    action: { kind: "open-session", path: s.projectPath, name: s.projectName, threadId: s.threadId },
  }));
}

// ── entry: starting something new ───────────────────────────────────────────
// The same create/open/clone trio the project switcher carries, but only on
// untargeted launcher space — a right-click on empty home is the cheapest
// place to begin, while a tile menu stays about its tile.
function entryItems(ctx: IntentContext): IntentItem[] {
  if (ctx.view !== "launcher" || resolveTarget(ctx)) return [];
  return [
    { id: "create-project", label: "Create a new project", icon: "create", action: { kind: "start", key: "create" } },
    { id: "open-local", label: "Open from local folder", icon: "open", action: { kind: "start", key: "open" } },
    { id: "clone-github", label: "Clone from GitHub", icon: "clone", action: { kind: "start", key: "clone" } },
  ];
}

export function buildIntentMenu(ctx: IntentContext): IntentSection[] {
  const sections: IntentSection[] = [];
  const goto = gotoItems(ctx);
  if (goto.length > 0) sections.push({ key: "goto", items: goto });
  const target = targetItems(ctx);
  if (target.length > 0) sections.push({ key: "target", items: target });
  const now = nowItems(ctx);
  if (now.length > 0) sections.push({ key: "now", items: now });
  const recents = recentsItems(ctx);
  if (recents.length > 0) sections.push({ key: "recents", items: recents });
  const sessions = sessionsItems(ctx);
  if (sessions.length > 0) sections.push({ key: "sessions", items: sessions });
  const entry = entryItems(ctx);
  if (entry.length > 0) sections.push({ key: "entry", items: entry });
  return sections;
}
