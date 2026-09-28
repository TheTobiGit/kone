/**
 * What the user is looking at, as both ends of the app:state mirror agree on it.
 *
 * The global assistant is summoned over whatever is on screen, and "this
 * thread", "that error", "why is it stuck" only mean something if it knows what
 * that is. The renderer is the only party that does — which surfaces are open,
 * what each one holds, what the user has selected — so it describes the screen
 * as a `ViewSnapshot`, pushes it to the shell, and the gateway reads it back:
 * as a block riding in front of every assistant turn, and in full through
 * `app_get_view`.
 *
 * A snapshot is a *description*, not a DOM dump. Each surface says what it is
 * showing in its own terms (a studio row names its columns, the inbox names the
 * thread it is reading), which is what lets the assistant act on it: every id
 * here is one the app tools take.
 *
 * Everything here stays environment-agnostic (no DOM, no node builtins) so the
 * main process and the renderer import it directly. Three halves:
 *
 * - the types the renderer builds,
 * - `parseViewSnapshot`, which the shell runs on every push (the payload
 *   crosses IPC, so it is parsed and bounded here rather than trusted),
 * - `renderViewSnapshot`, the one wording of a snapshot a model reads, shared by
 *   the per-turn block and the tool so the two can never describe the same
 *   screen two ways.
 */

import { z } from "zod";

// ── bounds ───────────────────────────────────────────────────────────────────

export const VIEW_SNAPSHOT_VERSION = 1;

/** Longest string field kept. Titles, paths and summaries all fit well inside;
 *  anything longer is a payload that has no business in a description. */
export const VIEW_TEXT_MAX = 400;
/** Longest selection kept. Enough for a stack trace or a paragraph. */
export const VIEW_SELECTION_MAX = 4_000;
/** Most entries any one list keeps (layers, panes, rows, projects). */
export const VIEW_LIST_MAX = 40;

function clip(max: number) {
  return (value: string): string => (value.length <= max ? value : `${value.slice(0, max - 1)}…`);
}

/** A string, clipped rather than refused: a long title is still a title. */
const Text = z.string().transform(clip(VIEW_TEXT_MAX));

/** A list, capped rather than refused, for the same reason. */
function list<T extends z.ZodType>(item: T) {
  return z.array(item).transform((items) => items.slice(0, VIEW_LIST_MAX));
}

// ── the snapshot ─────────────────────────────────────────────────────────────
// Schemas first, types derived from them: the shell parses every push with the
// same definitions the renderer builds against, so the two cannot drift.

/** A thread column's state, in the vocabulary `app_list_threads` reports, plus
 *  the two only a column can be in: never started, and restored but not yet
 *  attached. */
const ViewThreadStatusSchema = z.enum([
  "working",
  "waiting-for-approval",
  "waiting-for-user-input",
  "idle",
  "failed",
  "starting",
  "not-started",
  "dormant",
]);
export type ViewThreadStatus = z.infer<typeof ViewThreadStatusSchema>;

const ViewProjectRefSchema = z.object({ name: Text, path: Text });
export type ViewProjectRef = z.infer<typeof ViewProjectRefSchema>;

/** What a parked thread is waiting on, in a line: the command, path or tool an
 *  approval is for, or a question's text. */
const ViewWaitingOnSchema = z.object({
  kind: z.enum(["approval", "question"]),
  summary: Text,
});
export type ViewWaitingOn = z.infer<typeof ViewWaitingOnSchema>;

const PaneBase = { focused: z.boolean(), zen: z.boolean().optional() };

const ViewPaneSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("thread"),
    ...PaneBase,
    /** Null for a blank column nothing has been said in yet. */
    threadId: Text.nullable(),
    title: Text,
    status: ViewThreadStatusSchema,
    provider: Text.optional(),
    model: Text.optional(),
    sideChat: z.boolean().optional(),
    /** The worktree the thread runs in, when it has one of its own. */
    worktree: Text.nullable().optional(),
    /** Follow-ups queued behind the running turn. */
    queued: z.number().int().nonnegative().optional(),
    waitingOn: ViewWaitingOnSchema.optional(),
    /** The last error the thread surfaced, when it is failed. */
    error: Text.optional(),
  }),
  z.object({
    kind: z.literal("terminal"),
    ...PaneBase,
    terminalId: Text.nullable(),
    cwd: Text,
    status: Text,
    /** The foreground command running under the shell, when there is one. */
    running: Text.nullable(),
  }),
  z.object({
    kind: z.literal("scratchpad"),
    ...PaneBase,
    title: Text,
  }),
]);
export type ViewPane = z.infer<typeof ViewPaneSchema>;

const ViewStudioRowSchema = ViewProjectRefSchema.extend({
  panes: z.number().int().nonnegative(),
  focused: z.boolean(),
});
export type ViewStudioRow = z.infer<typeof ViewStudioRowSchema>;

const ViewThreadRefSchema = z.object({
  threadId: Text,
  title: Text,
  projectPath: Text.optional(),
  status: ViewThreadStatusSchema.optional(),
});
export type ViewThreadRef = z.infer<typeof ViewThreadRefSchema>;

/** `covered` marks a surface that is open but hidden behind an opaque one in
 *  front of it — still worth knowing about ("the studio is behind the inbox"),
 *  never what the user is looking at. */
const LayerBase = { covered: z.boolean().optional() };

/** One surface on screen. */
const ViewLayerSchema = z.discriminatedUnion("surface", [
  z.object({
    surface: z.literal("home"),
    ...LayerBase,
    /** `empty` is the first-run launcher; `recent` lists projects. */
    state: z.enum(["empty", "recent"]),
    projects: list(ViewProjectRefSchema.extend({ pinned: z.boolean().optional() })),
  }),
  z.object({
    surface: z.literal("project"),
    ...LayerBase,
    project: ViewProjectRefSchema,
    /** The page's tabs: the working-tree overview, the git space, and the
     *  read-only file browser. */
    tab: z.enum(["overview", "git", "files"]),
    /** The file shown in the Files tab's viewer, if one is. */
    viewing: Text.nullable().optional(),
    branch: Text.nullable(),
    ahead: z.number().int().nonnegative().optional(),
    behind: z.number().int().nonnegative().optional(),
    changes: z
      .object({
        files: z.number().int().nonnegative(),
        staged: z.number().int().nonnegative(),
        added: z.number().int().nonnegative(),
        removed: z.number().int().nonnegative(),
      })
      .optional(),
    /** The file whose diff is open full-screen, if one is. */
    file: z
      .object({
        path: Text,
        staged: z.boolean().optional(),
        isNew: z.boolean().optional(),
        deleted: z.boolean().optional(),
      })
      .nullable()
      .optional(),
  }),
  z.object({
    surface: z.literal("studio"),
    ...LayerBase,
    /** `row` is one project's columns; `overview` is the zoomed-out map. */
    mode: z.enum(["row", "overview"]),
    row: z.object({ project: ViewProjectRefSchema, panes: list(ViewPaneSchema) }).nullable(),
    rows: list(ViewStudioRowSchema),
  }),
  z.object({
    surface: z.literal("inbox"),
    ...LayerBase,
    /** Which list is showing. */
    list: Text,
    pane: z.enum(["idle", "composer", "reader"]),
    thread: ViewThreadRefSchema.optional(),
  }),
  z.object({
    surface: z.literal("bench"),
    ...LayerBase,
    composing: z.boolean(),
    /** Job counts by group label, in the bench's own order. */
    jobs: list(z.object({ group: Text, count: z.number().int().nonnegative() })),
  }),
  z.object({ surface: z.literal("settings"), ...LayerBase, pane: Text }),
  z.object({ surface: z.literal("search"), ...LayerBase, query: Text }),
  z.object({
    surface: z.literal("modal"),
    ...LayerBase,
    modal: z.enum(["open-folder", "clone", "create-project"]),
  }),
  z.object({ surface: z.literal("menu"), ...LayerBase }),
]);
export type ViewLayer = z.infer<typeof ViewLayerSchema>;
export type ViewSurface = ViewLayer["surface"];

const ViewSurfaceSchema = z.enum([
  "home",
  "project",
  "studio",
  "inbox",
  "bench",
  "settings",
  "search",
  "modal",
  "menu",
]);

/** Text the user had selected when they last selected something outside the
 *  assistant. Kept after the selection collapses into the assistant's own
 *  composer, because selecting and then asking is the whole gesture. */
const ViewSelectionSchema = z.object({
  text: z.string().trim().min(1).transform(clip(VIEW_SELECTION_MAX)),
  /** The surface it was selected on. */
  surface: z.union([ViewSurfaceSchema, z.literal("unknown")]).catch("unknown"),
  at: z.number(),
});
export type ViewSelection = z.infer<typeof ViewSelectionSchema>;

/** The envelope. Layers are parsed one at a time below, so this only checks
 *  there is a list of them. */
const ViewSnapshotEnvelope = z.object({
  version: z.literal(VIEW_SNAPSHOT_VERSION),
  /** Epoch ms the renderer built this. */
  at: z.number(),
  layers: z.array(z.unknown()),
  assistantOpen: z.boolean().catch(false),
  selection: ViewSelectionSchema.nullable().catch(null),
});

export interface ViewSnapshot {
  version: typeof VIEW_SNAPSHOT_VERSION;
  /** Epoch ms the renderer built this. */
  at: number;
  /** Frontmost first. The assistant's own card is never a layer. */
  layers: ViewLayer[];
  assistantOpen: boolean;
  selection: ViewSelection | null;
}

/**
 * The snapshot a push carried, or null if it isn't one. Typed as the shape the
 * renderer claims to send, and checked as if it were anything, because it
 * crossed IPC from a renderer that may be a different build.
 *
 * Layers are parsed one at a time and a layer that doesn't parse is dropped
 * rather than failing the push, so a renderer a version ahead of the shell (a
 * surface this build doesn't know) still describes everything the shell can
 * read.
 */
export function parseViewSnapshot(raw: Partial<ViewSnapshot> | null | undefined): ViewSnapshot | null {
  const envelope = ViewSnapshotEnvelope.safeParse(raw);
  if (!envelope.success) return null;
  const layers: ViewLayer[] = [];
  for (const entry of envelope.data.layers.slice(0, VIEW_LIST_MAX)) {
    const layer = ViewLayerSchema.safeParse(entry);
    if (layer.success) layers.push(layer.data);
  }
  return {
    version: VIEW_SNAPSHOT_VERSION,
    at: envelope.data.at,
    layers,
    assistantOpen: envelope.data.assistantOpen,
    selection: envelope.data.selection,
  };
}

/** A stable key for "is this the same screen": everything but the clock. Two
 *  snapshots with the same signature describe the same thing. */
export function viewSignature(snapshot: ViewSnapshot, options: ViewRenderOptions = {}): string {
  if (!options.brief) return JSON.stringify({ layers: snapshot.layers, selection: snapshot.selection });
  // Only what the brief wording reads: a background column changing status or
  // a hidden surface moving is not a new screen as far as the brief can say.
  const layers = visibleLayers(snapshot).map((layer) =>
    layer.surface === "studio" && layer.row
      ? {
          ...layer,
          row: {
            project: layer.row.project,
            panes: layer.row.panes.length,
            focused: layer.row.panes.find((p) => p.focused) ?? null,
          },
        }
      : layer,
  );
  return JSON.stringify({ layers, selection: snapshot.selection });
}

// ── reading one ──────────────────────────────────────────────────────────────

/** The layers the user can actually see, frontmost first. */
export function visibleLayers(snapshot: ViewSnapshot): ViewLayer[] {
  return snapshot.layers.filter((layer) => !layer.covered);
}

/**
 * The thread the user is looking at, if there is one: the focused thread column
 * of a visible studio row, or the thread a visible inbox is reading. Frontmost
 * wins, so with the inbox over the studio this names the inbox's thread.
 */
export function focusedThreadOf(snapshot: ViewSnapshot): ViewThreadRef | null {
  for (const layer of visibleLayers(snapshot)) {
    if (layer.surface === "inbox" && layer.pane === "reader" && layer.thread?.threadId) {
      return layer.thread;
    }
    if (layer.surface === "studio" && layer.mode === "row" && layer.row) {
      const pane = layer.row.panes.find((p) => p.focused);
      if (pane?.kind === "thread" && pane.threadId) {
        return {
          threadId: pane.threadId,
          title: pane.title,
          projectPath: layer.row.project.path,
          status: pane.status,
        };
      }
      // The studio is in front: whatever is focused there is what the user is
      // on, and a terminal is not a thread.
      return null;
    }
  }
  return null;
}

/** The terminal the user is looking at: the focused column of a visible studio
 *  row, when that column is a terminal. */
export function focusedTerminalOf(
  snapshot: ViewSnapshot,
): { terminalId: string; cwd: string; running: string | null } | null {
  for (const layer of visibleLayers(snapshot)) {
    if (layer.surface !== "studio" || layer.mode !== "row" || !layer.row) continue;
    const pane = layer.row.panes.find((p) => p.focused);
    if (pane?.kind === "terminal" && pane.terminalId) {
      return { terminalId: pane.terminalId, cwd: pane.cwd, running: pane.running };
    }
    return null;
  }
  return null;
}

// ── wording one ──────────────────────────────────────────────────────────────

const STATUS_WORDS = {
  working: "working",
  "waiting-for-approval": "waiting for the user's approval",
  "waiting-for-user-input": "waiting for the user to answer a question",
  idle: "idle",
  failed: "failed",
  starting: "starting",
  "not-started": "not started",
  dormant: "not loaded",
} satisfies Record<ViewThreadStatus, string>;

const SETTINGS_PANE_WORDS: Record<string, string> = {
  root: "the settings list",
  profile: "Profile",
  shortcuts: "Shortcuts",
  appearance: "Appearance",
  typography: "Typography",
  conversation: "Conversation",
  composer: "Composer",
  studio: "Studio",
  inbox: "Inbox",
  bench: "Bench",
  assistant: "Assistant",
  providers: "Providers",
  agentsUsage: "Agents usage",
  providerLimits: "Provider limits",
  agentSkills: "Agent skills",
  teams: "Teams",
};

const MODAL_WORDS = {
  "open-folder": "the folder picker (opening a project)",
  clone: "the clone-from-GitHub dialog",
  "create-project": "the new-project dialog",
} as const;

function quote(text: string): string {
  return `"${text.replace(/\s+/g, " ").trim()}"`;
}

function paneLine(pane: ViewPane): string {
  const mark = pane.focused ? " [focused]" : "";
  const zen = pane.zen ? " [maximized]" : "";
  if (pane.kind === "thread") {
    if (!pane.threadId) return `- new thread (blank)${mark}${zen}`;
    const parts = [`- thread ${quote(pane.title || "Untitled")}${mark}${zen}: ${STATUS_WORDS[pane.status]}`];
    if (pane.waitingOn) {
      parts.push(`on ${pane.waitingOn.kind === "approval" ? "approving" : "the question"} ${quote(pane.waitingOn.summary)}`);
    }
    if (pane.error) parts.push(`error ${quote(pane.error)}`);
    if (pane.queued) parts.push(`${pane.queued} follow-up${pane.queued === 1 ? "" : "s"} queued`);
    const runsOn = [pane.provider, pane.model].filter(Boolean).join(" / ");
    if (runsOn) parts.push(runsOn);
    if (pane.sideChat) parts.push("side chat");
    if (pane.worktree) parts.push(`worktree ${pane.worktree}`);
    parts.push(`id ${pane.threadId}`);
    return parts.join(", ");
  }
  if (pane.kind === "terminal") {
    const running = pane.running ? `running ${quote(pane.running)}` : "at the prompt";
    return `- terminal in ${pane.cwd}${mark}${zen}: ${pane.status === "exited" ? "exited" : running}`;
  }
  return `- scratchpad ${quote(pane.title || "Scratchpad")}${mark}${zen}`;
}

function projectName(ref: ViewProjectRef): string {
  return `${quote(ref.name)} (${ref.path})`;
}

function layerLines(layer: ViewLayer, brief: boolean): string[] {
  switch (layer.surface) {
    case "home":
      if (layer.state === "empty") return ["The launcher, with no projects opened yet."];
      return [
        `The launcher, listing ${layer.projects.length} project${layer.projects.length === 1 ? "" : "s"}: ` +
          layer.projects
            .slice(0, 12)
            .map((p) => `${p.name}${p.pinned ? " (pinned)" : ""}`)
            .join(", ") +
          ".",
      ];
    case "project": {
      const tab =
        layer.tab === "git"
          ? "git tab (branches, history, commits)"
          : layer.tab === "files"
            ? "files tab (a read-only browser of the project's files)"
            : "overview tab (the working tree's changes)";
      const lines = [`The project page for ${projectName(layer.project)}, on its ${tab}.`];
      if (layer.tab === "files" && layer.viewing) lines.push(`  Viewing: ${layer.viewing}.`);
      const repo: string[] = [];
      if (layer.branch) repo.push(`branch ${layer.branch}`);
      if (layer.ahead) repo.push(`${layer.ahead} ahead`);
      if (layer.behind) repo.push(`${layer.behind} behind`);
      if (layer.changes) {
        repo.push(
          layer.changes.files === 0
            ? "clean working tree"
            : `${layer.changes.files} changed file${layer.changes.files === 1 ? "" : "s"} (${layer.changes.staged} staged, +${layer.changes.added} -${layer.changes.removed})`,
        );
      }
      if (repo.length) lines.push(`  Repo: ${repo.join(", ")}.`);
      if (layer.file) {
        const flags = [
          layer.file.isNew ? "new" : "",
          layer.file.deleted ? "deleted" : "",
          layer.file.staged ? "staged" : "",
        ].filter(Boolean);
        lines.push(`  Open full-screen: the diff of ${layer.file.path}${flags.length ? ` (${flags.join(", ")})` : ""}.`);
      }
      return lines;
    }
    case "studio": {
      if (layer.mode === "overview") {
        return [
          `The studio, zoomed out to its overview of every project row: ` +
            layer.rows.map((r) => `${r.name} (${r.panes} column${r.panes === 1 ? "" : "s"})`).join(", ") +
            ".",
        ];
      }
      if (!layer.row) return ["The studio, with no work open in it."];
      const count = layer.row.panes.length;
      const columns = `${count} column${count === 1 ? "" : "s"}`;
      let lines: string[];
      if (brief) {
        // The focused column only; the rest are a count the model can follow up
        // with app_get_view when the message is about them.
        const focused = layer.row.panes.find((p) => p.focused);
        const rest = focused ? count - 1 : count;
        lines = [`The studio, on the row for ${projectName(layer.row.project)} with ${columns}.`];
        if (focused) lines.push(`  Focused column: ${paneLine({ ...focused, focused: false }).slice(2)}`);
        if (rest > 0) {
          lines.push(`  ${rest} ${focused ? "other " : ""}column${rest === 1 ? "" : "s"} not described here; app_get_view lists them.`);
        }
      } else {
        lines = [
          `The studio, on the row for ${projectName(layer.row.project)} with ${columns}, left to right:`,
          ...layer.row.panes.map((pane) => `  ${paneLine(pane)}`),
        ];
      }
      const others = layer.rows.filter((r) => !r.focused);
      if (others.length) {
        lines.push(`  Other rows: ${others.map((r) => `${r.name} (${r.panes})`).join(", ")}.`);
      }
      return lines;
    }
    case "inbox": {
      const list = `the ${quote(layer.list)} list`;
      if (layer.pane === "reader" && layer.thread) {
        const status = layer.thread.status ? `, ${STATUS_WORDS[layer.thread.status]}` : "";
        return [
          `The inbox, showing ${list} and reading the thread ${quote(layer.thread.title || "Untitled")}${status} (id ${layer.thread.threadId}${layer.thread.projectPath ? `, project ${layer.thread.projectPath}` : ""}).`,
        ];
      }
      if (layer.pane === "composer") return [`The inbox, showing ${list} with a new-thread composer open.`];
      return [`The inbox, showing ${list} with no thread picked.`];
    }
    case "bench": {
      const counts = layer.jobs.filter((j) => j.count > 0);
      const jobs = counts.length ? counts.map((j) => `${j.count} ${j.group.toLowerCase()}`).join(", ") : "no jobs";
      return [`The bench (the job queue): ${jobs}.${layer.composing ? " A new-job composer is open." : ""}`];
    }
    case "settings":
      return [`Settings, open on ${SETTINGS_PANE_WORDS[layer.pane] ?? layer.pane}.`];
    case "search":
      return [
        layer.query
          ? `The conversation search palette, searching ${quote(layer.query)}.`
          : "The conversation search palette, empty.",
      ];
    case "modal":
      return [`${MODAL_WORDS[layer.modal]}.`.replace(/^./, (c) => c.toUpperCase())];
    case "menu":
      return ["A right-click menu."];
  }
}

/** "12s ago" style, coarse on purpose: a model needs to know whether the
 *  description is fresh, not the millisecond. */
function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

export interface ViewRenderOptions {
  /** The per-message wording: the focused studio column only, with the rest a
   *  count, and nothing about surfaces hidden behind the front one. The full
   *  wording is what app_get_view answers with. */
  brief?: boolean;
}

/**
 * The snapshot as prose a model reads: what is in front, what is under it, and
 * what the user had selected. Ids are left in, because they are what the app
 * tools take.
 */
export function renderViewSnapshot(
  snapshot: ViewSnapshot,
  now: number = Date.now(),
  options: ViewRenderOptions = {},
): string {
  const brief = options.brief ?? false;
  const visible = snapshot.layers.filter((l) => !l.covered);
  const covered = brief ? [] : snapshot.layers.filter((l) => l.covered);
  const lines: string[] = [];

  if (!visible.length) {
    lines.push("Nothing kone can describe is on screen.");
  } else {
    lines.push(visible.length === 1 ? "On screen:" : "On screen, front to back:");
    visible.forEach((layer, i) => {
      const [head, ...rest] = layerLines(layer, brief);
      lines.push(`${i + 1}. ${head}`, ...rest.map((line) => `   ${line.trimStart()}`));
    });
  }

  if (covered.length) {
    lines.push("Open but hidden behind that:");
    for (const layer of covered) {
      const [head, ...rest] = layerLines(layer, brief);
      lines.push(`- ${head}`, ...rest.map((line) => `  ${line.trimStart()}`));
    }
  }

  if (snapshot.selection) {
    const where = snapshot.selection.surface === "unknown" ? "" : ` (on the ${snapshot.selection.surface})`;
    lines.push(
      `Text the user selected${where}, ${ago(now - snapshot.selection.at)}:`,
      "<<<",
      snapshot.selection.text,
      ">>>",
    );
  }

  return lines.join("\n");
}
