// useIntentHost — the intent menu's orchestration layer.
//
// The page used to hold this: signal gathering (view under the pointer, live
// portal + git state, recent projects + sessions), DOM scraping for the
// right-clicked tile or session row, the open/close timer dance, and the pick
// switch. That block now lives here, so index.vue is one host call plus the
// teleport. The content model stays in useIntentMenu (pure, tested); this file
// owns the signals, the timing, and the dispatch.
//
// Launcher modal ownership stays with the page: the pending/picker/clone/
// create flags and the summon/dismiss/open wiring arrive as params, and the
// host only reads or flips them.

import { computed, onBeforeUnmount, ref } from "vue";
import type { ComputedRef, Ref } from "vue";
import { buildIntentMenu, resolveIntentTitle } from "./useIntentMenu";
import type {
  IntentItem,
  IntentSection,
  IntentTargetProject,
  IntentTargetSession,
  IntentView,
} from "./useIntentMenu";
import { useAllRecentSessions } from "./useAllRecentSessions";
import { useIntentContext } from "./useIntentContext";
import { useRecentProjects } from "./useRecentProjects";
import type { RecentProject } from "./useRecentProjects";
import { useReveal } from "./useReveal";
import { useSound } from "./useSound";
import { useStudioPlane } from "./useStudioPlane";
import type { SessionSummary } from "~/types/session";
import type { Project } from "./useProject";
import type { PortalId } from "./usePortals";

export interface IntentOpenSessionTarget {
  path: string;
  name: string;
  threadId: string;
}

export interface UseIntentHostOptions {
  project: Ref<Project | null>;
  activePortal: Ref<PortalId | null> | ComputedRef<PortalId | null>;
  settingsOpen: Ref<boolean>;
  pickerOpen: Ref<boolean>;
  cloneOpen: Ref<boolean>;
  createOpen: Ref<boolean>;
  onStart: (key: "create" | "open" | "clone") => void;
  summon: (portal: PortalId) => void;
  dismiss: (portal?: PortalId) => void;
  openProject: (folder: Project, threadId?: string) => void;
  onOpenSession: (target: IntentOpenSessionTarget) => void;
}

export interface UseIntentHost {
  view: ComputedRef<IntentView>;
  isOpen: Ref<boolean>;
  shown: Ref<boolean>;
  x: Ref<number>;
  y: Ref<number>;
  title: Ref<string>;
  sections: Ref<IntentSection[]>;
  open: (e: MouseEvent) => void;
  close: () => void;
  pick: (item: IntentItem) => void;
}

// The shapes the host joins against: the session fan-out rows and the recents
// grid. Structural (not the store types) so the joins stay testable without a
// bridge or storage.
export interface IntentSessionCandidate {
  threadId: string;
  title: string;
  projectPath?: string | null;
  projectName?: string | null;
  pinned?: boolean;
}

// The cross-project aggregate rows the menu maps verbatim. Required (unlike
// the candidate above) because the fan-out always tags: its live fetch keeps
// only metas whose project path is in the recents grid and attaches that path
// plus the grid name, and its mocks carry both fields.
export type IntentTaggedSession = SessionSummary & {
  projectPath: string;
  projectName: string;
};

// Session-id to target join. Null when nothing matches or the row names no
// project — an unclickable row must never become a menu subject.
export function intentTargetSessionFor(
  sessionId: string | null,
  candidates: IntentSessionCandidate[],
): IntentTargetSession | null {
  if (!sessionId) return null;
  const row = candidates.find((s) => s.threadId === sessionId) ?? null;
  if (!row || !row.projectPath) return null;
  return {
    threadId: row.threadId,
    title: row.title,
    projectPath: row.projectPath,
    projectName: row.projectName ?? row.projectPath,
    pinned: row.pinned,
  };
}

// Tile-path to target join. The caller skips this lookup when a session
// already matched — the builder's session-beats-tile rule, applied at lookup.
export function intentTargetProjectFor(
  targetPath: string | null,
  recents: RecentProject[],
): IntentTargetProject | null {
  if (!targetPath) return null;
  const found = recents.find((p) => p.path === targetPath) ?? null;
  if (!found) return null;
  return { path: found.path, name: found.name, pinned: found.pinned };
}

// The native menu keeps what it is good at: form fields, terminals, copying a
// text selection, and keyboard-invoked menus. Everything else is menu space.
function yieldsToNativeMenu(e: MouseEvent, el: Element | null): boolean {
  // Keyboard-invoked menus (Menu key / Shift+F10) arrive with button 0 and a
  // 0,0 pointer — leave those to the native menu, without preventDefault.
  if (e.button !== 2 && !e.ctrlKey && !e.metaKey) return true;
  if (el?.closest("input, textarea, select, [contenteditable], .xterm")) return true;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && !el?.closest("button, a")) return true;
  return false;
}

export function useIntentHost(options: UseIntentHostOptions): UseIntentHost {
  const {
    project,
    activePortal,
    settingsOpen,
    pickerOpen,
    cloneOpen,
    createOpen,
  } = options;

  // Reads the project page's published surface + git snapshot through the
  // shared intent context, and reaches its surface switcher directly (no
  // event wire) for go-to rows.
  const { surface: intentSurface, git: intentGit, goSurface: goIntentSurface } =
    useIntentContext();
  const studioPlane = useStudioPlane();
  const { recents, forget, togglePin } = useRecentProjects();
  const {
    pinned: intentPinned,
    recent: intentRecent,
    togglePin: toggleSessionPin,
    archive: archiveSession,
  } = useAllRecentSessions();
  const { reveal } = useReveal();
  const { cue } = useSound();

  const isOpen = ref(false);
  const shown = ref(false);
  const x = ref(0);
  const y = ref(0);
  const title = ref("Kone");
  const sections = ref<IntentSection[]>([]);
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const view = computed<IntentView>(() => {
    if (activePortal.value === "studio") return "studio";
    if (activePortal.value === "inbox") return "inbox";
    if (!project.value) return "launcher";
    return intentSurface.value === "git" ? "project-git" : "project-overview";
  });

  // While a launcher modal owns the screen the plane, the inbox, the drawer
  // and the assistant would all open underneath it, so menu rows that summon
  // them stay quiet. The check lives here alone — every pick below goes
  // through runWhenFree, never past a second copy of the flag read.
  const isModalOpen = computed(
    () => pickerOpen.value || cloneOpen.value || createOpen.value,
  );

  function runWhenFree(fn: () => void): void {
    if (isModalOpen.value) return;
    fn();
  }

  function open(e: MouseEvent): void {
    // SAFETY: Element (not HTMLElement) covers inline-SVG targets, and
    // closest() exists on Element so the lookups below stay valid.
    const el = e.target instanceof Element ? e.target : null;
    if (yieldsToNativeMenu(e, el)) return;
    e.preventDefault();

    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    const current = view.value;
    // On the all-projects page there is no open project, so the context comes
    // from whatever is under the pointer — a session row first (rows never sit
    // inside tiles, but the pointer can only mean one thing), then a project
    // tile — or from nothing at all on empty space.
    const sessionId =
      current === "launcher"
        ? (el?.closest("[data-intent-session]")?.getAttribute("data-intent-session") ??
          null)
        : null;
    const targetSession = intentTargetSessionFor(sessionId, [
      ...intentPinned.value,
      ...intentRecent.value,
    ]);
    const targetPath =
      current === "launcher" && !targetSession
        ? (el?.closest("[data-intent-path]")?.getAttribute("data-intent-path") ?? null)
        : null;
    const targetProject = intentTargetProjectFor(targetPath, recents.value);
    // SAFETY: the aggregate always tags its rows (live rows are filtered by
    // grid membership and tagged with that path plus the grid name; mocks
    // carry both fields), so the downcast to the required-fields shape holds.
    const taggedSessions = [...intentPinned.value, ...intentRecent.value] as IntentTaggedSession[];
    sections.value = buildIntentMenu({
      view: current,
      currentPath: project.value?.path ?? null,
      git: intentGit.value,
      recents: recents.value.map((p) => ({ path: p.path, name: p.name })),
      sessions: taggedSessions.map((s) => ({
        threadId: s.threadId,
        title: s.title,
        projectPath: s.projectPath,
        projectName: s.projectName,
      })),
      studioHasRows: studioPlane.rows.value.length > 0,
      targetProject,
      targetSession,
      settingsOpen: settingsOpen.value,
    });
    title.value = resolveIntentTitle(
      current,
      targetSession,
      targetProject,
      project.value?.name,
    );
    x.value = e.clientX;
    y.value = e.clientY;
    // Already up: jump to the new pointer and content rather than blinking.
    // (Re-assert shown: the second press's pointerdown may have started the
    // outside-click fade, which the clearTimeout above just abandoned.)
    if (isOpen.value) {
      shown.value = true;
      return;
    }
    isOpen.value = true;
    shown.value = false;
    requestAnimationFrame(() => {
      if (isOpen.value) shown.value = true;
    });
  }

  function close(): void {
    shown.value = false;
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      isOpen.value = false;
      closeTimer = null;
    }, 160);
  }

  function pick(item: IntentItem): void {
    close();
    const action = item.action;
    switch (action.kind) {
      case "pin-project":
        // Pin/unpin is the one launcher toggle worth a sound — a discrete flip.
        cue("toggle");
        togglePin(action.path);
        return;
      case "reveal-project":
        void reveal(action.path);
        return;
      case "forget-project":
        cue("press");
        forget(action.path);
        return;
      case "pin-session":
        cue("press");
        toggleSessionPin(action.threadId);
        return;
      case "archive-session": {
        cue("press");
        void archiveSession(action.threadId);
        return;
      }
      case "goto": {
        switch (action.view) {
          case "studio":
            runWhenFree(() => {
              cue("expand");
              options.summon("studio");
            });
            return;
          case "inbox":
            runWhenFree(() => {
              cue("expand");
              options.summon("inbox");
            });
            return;
          case "launcher":
            cue("collapse");
            project.value = null;
            return;
          case "overview":
          case "git": {
            cue("press");
            goIntentSurface(action.view === "git" ? "git" : "overview");
            return;
          }
        }
        return;
      }
      case "open-settings":
        runWhenFree(() => {
          cue("press");
          settingsOpen.value = true;
        });
        return;
      case "back-to-page":
        cue("collapse");
        options.dismiss();
        return;
      case "review-changes":
        cue("press");
        goIntentSurface("overview");
        return;
      case "start":
        // The page owns the begin flow (pending guard, cue, modal flags) —
        // the menu only names which door, never re-implements the opening.
        options.onStart(action.key);
        return;
      case "open-session":
        cue("open");
        options.onOpenSession({
          path: action.path,
          name: action.name,
          threadId: action.threadId,
        });
        return;
      case "open-project":
        cue("open");
        options.openProject({ path: action.path, name: action.name });
        return;
    }
  }

  onBeforeUnmount(() => {
    if (closeTimer) clearTimeout(closeTimer);
  });

  return { view, isOpen, shown, x, y, title, sections, open, close, pick };
}
