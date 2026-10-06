import { diffStats } from "@kone/protocol/unified-diff";
import type { RuntimeItem } from "~/types/desktop";
// The Changes dock folds confirmed per-file records across the thread,
// including subagent transcripts. Historical items retain a conservative
// single-file fallback; diff statistics only come from numbered hunks.

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

function splitPath(path: string): Pick<ChangedFile, "name" | "dir"> {
  const parts = path.split("/").filter(Boolean);
  const name = parts.length ? parts[parts.length - 1]! : path;
  const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
  return { name, dir };
}

// Count added/removed lines from a diff body. Only numbered hunks count, so a
// body that isn't a diff (command stdout) contributes nothing.
const countDiff = diffStats;

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

  function touch(path: string, kind: ChangeKind, detail: string | undefined, live: boolean, counts?: Pick<ChangedFile, "added" | "removed">): void {
    if (!path) return;
    anyLive ||= live;
    const { added, removed } = counts ?? countDiff(detail);
    const existing = byPath.get(path);
    if (existing) {
      existing.kind = mergeKind(existing.kind, kind);
      existing.added += added;
      existing.removed += removed;
      existing.streaming ||= live;
    } else {
      order.push(path);
      byPath.set(path, { id: path, path, ...splitPath(path), kind, added, removed, streaming: live });
    }
  }

  function visit(items: RuntimeItem[]): void {
    for (const it of items) {
      if (it.subagent) visit(it.subagent.items);
      if (it.kind !== "tool_call" || it.status === "failed") continue;
      if (it.fileChanges !== undefined) {
        for (const change of it.fileChanges) {
          if (!change.applied) continue;
          if (change.kind === "renamed" && change.oldPath) touch(change.oldPath, "removed", undefined, false);
          // A diff clipped for the wire carries counts measured on the whole diff.
          const counts = change.added !== undefined && change.removed !== undefined
            ? { added: change.added, removed: change.removed } : undefined;
          touch(change.path, change.kind === "renamed" ? "created" : change.kind, change.diff, it.status === "in-progress", counts);
        }
        continue;
      }
      // Historical rows lack structured file records. Only successful, single-path
      // file calls qualify; display summaries and pending proposals aren't files.
      if (it.status !== "completed" || it.tool !== undefined) continue;
      const baseKind = kindForTool(it.name);
      if (!baseKind) continue;
      const path = pathFromText(it.text, it.name);
      if (!path || /\s(?:\+\d+ more|·)|\n/.test(path)) continue;
      touch(path, kindFromDiff(it.detail) ?? baseKind, it.detail, false);
    }
  }
  for (const block of blocks) {
    if (block.role === "assistant") visit(block.items);
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
