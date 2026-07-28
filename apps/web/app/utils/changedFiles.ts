// Derive the set of files the agent has touched this thread — the model behind
// the corner "Changes" dock. It reads the same `tool_call` items the thread
// timeline renders and keeps one row per repo-relative path, tagged by what the
// last touch did to it (created / edited / removed) and carrying the +added /
// −removed line counts parsed from the tool's diff body. Mirrors the write /
// edit / delete tool families ConversationThread paints; read, search, run,
// web, and code-intel tools don't mutate the tree, so they're absent here.

import type { ThreadBlock } from "~/composables/useAgent";

export type ChangeKind = "created" | "edited" | "removed";

export type ChangedFile = {
  /** Stable id — the repo-relative path (one row per file). */
  id: string;
  /** Full repo-relative path, as the tool addressed it. */
  path: string;
  /** Just the filename, for the row's primary label + file-type icon. */
  name: string;
  /** The directory portion (may be empty for a repo-root file). */
  dir: string;
  kind: ChangeKind;
  /** Lines added / removed, summed across the touches on this path. */
  added: number;
  removed: number;
  /** True while the write that touched it is the tool currently in flight. */
  streaming: boolean;
};

export type ChangedFilesState = {
  files: ChangedFile[];
  /** Aggregate +/− across every changed file — the dock header's diffstat. */
  totalAdded: number;
  totalRemoved: number;
  /** Any file write is still in flight this turn. */
  streaming: boolean;
};

// Tool names (lowercased) → the kind of change the tool makes to its target.
// Kept in step with ConversationThread's TOOL_TABLE write/edit/delete rows.
const CREATE_TOOLS = new Set(["write_to_file", "create_file", "write"]);
const EDIT_TOOLS = new Set([
  "edit_file",
  "apply_patch",
  "str_replace",
  "replace_file_content",
  "edit",
  "multiedit",
  "notebookedit",
]);
const REMOVE_TOOLS = new Set(["delete_file", "rm"]);

function kindForTool(name: string | undefined): ChangeKind | null {
  if (!name) return null;
  const key = name.trim().toLowerCase();
  if (CREATE_TOOLS.has(key)) return "created";
  if (EDIT_TOOLS.has(key)) return "edited";
  if (REMOVE_TOOLS.has(key)) return "removed";
  return null;
}

// Some providers (Codex) route every file mutation through one generic "edit"
// tool, so the tool name alone can't tell a new file from a changed one. When
// the diff body carries git-style patch headers, they settle it: a new-file or
// /dev/null-source hunk is a creation, a deleted-file or /dev/null-target hunk a
// removal. Returns null when the diff says nothing (keep the tool's own kind).
function kindFromDiff(detail: string | undefined): ChangeKind | null {
  if (!detail) return null;
  if (/^new file mode /m.test(detail) || /^---\s+\/dev\/null/m.test(detail)) return "created";
  if (/^deleted file mode /m.test(detail) || /^\+\+\+\s+\/dev\/null/m.test(detail)) return "removed";
  return null;
}

// A file tool's `text` is its target — the repo-relative path. Providers (and
// our own mock) often prefix it with the tool name ("edit_file: app/x.ts") and
// may append a " · summary"; strip both down to the bare path.
function pathFromText(text: string, name: string | undefined): string {
  let t = text.trim();
  if (name) {
    const prefix = `${name.trim()}:`;
    if (t.toLowerCase().startsWith(prefix.toLowerCase())) {
      t = t.slice(prefix.length).trim();
    }
  }
  const head = t.split(/\s+·\s+/)[0] ?? t;
  return head.trim();
}

function splitPath(path: string): { name: string; dir: string } {
  const parts = path.split("/").filter(Boolean);
  const name = parts.length ? parts[parts.length - 1]! : path;
  const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
  return { name, dir };
}

// Count added/removed lines from a tool's diff body — unified-diff `+`/`-`
// lines, ignoring the `+++`/`---` file headers. Bodies that aren't diffs
// (command stdout) simply contribute nothing meaningful, which is fine.
function countDiff(detail: string | undefined): { added: number; removed: number } {
  if (!detail) return { added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const line of detail.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

// Fold a fresh touch onto a file's running kind. Removal is the terminal fate;
// a created file stays "created" through later edits (it's still new to the
// tree); touching a removed path again resurrects it to the new kind.
function mergeKind(prev: ChangeKind, next: ChangeKind): ChangeKind {
  if (next === "removed") return "removed";
  if (prev === "removed") return next;
  if (prev === "created" || next === "created") return "created";
  return next;
}

/** The files written, edited, or removed across this thread's turns, in the
 *  order they were first touched — what the corner Changes dock lists, with the
 *  per-file and aggregate diffstats it shows. The row whose tool is live is
 *  flagged streaming so the dock can peek it while collapsed. */
export function deriveChangedFiles(blocks: ThreadBlock[]): ChangedFilesState {
  const order: string[] = [];
  const byPath = new Map<string, ChangedFile>();
  let anyLive = false;

  for (const b of blocks) {
    if (b.role !== "assistant") continue;
    for (const it of b.items) {
      if (it.kind !== "tool_call") continue;
      const baseKind = kindForTool(it.name);
      if (!baseKind) continue;
      const path = pathFromText(it.text, it.name);
      if (!path) continue;
      const live = it.status === "in-progress";
      if (live) anyLive = true;
      const { added, removed } = countDiff(it.detail);
      // The diff body can override the tool's kind (a generic edit tool that
      // actually added or deleted the file) — trust it when it speaks.
      const kind = kindFromDiff(it.detail) ?? baseKind;

      const existing = byPath.get(path);
      if (existing) {
        existing.kind = mergeKind(existing.kind, kind);
        existing.added += added;
        existing.removed += removed;
        existing.streaming = live;
      } else {
        const { name, dir } = splitPath(path);
        order.push(path);
        byPath.set(path, { id: path, path, name, dir, kind, added, removed, streaming: live });
      }
    }
  }

  const files = order.map((p) => byPath.get(p)!);
  let totalAdded = 0;
  let totalRemoved = 0;
  for (const f of files) {
    totalAdded += f.added;
    totalRemoved += f.removed;
  }
  return { files, totalAdded, totalRemoved, streaming: anyLive };
}
