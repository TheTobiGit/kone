// What a live turn is *doing right now*, boiled down to one orb + one status
// line — the thing the away-from-thread status pill (TurnStatusPill) reads so it
// can say "Reading example.vue", "Searching for foo", "Thinking", "Working".
//
// It looks only at the running block's latest item (the current activity), and
// mirrors ConversationThread's tool vocabulary — the same family hues + natural
// phrasing — so the pill and the in-thread step rows always agree, just here in
// a compact present-tense form.

import type { AssistantBlock } from "~/composables/useAgent";
import type { RuntimeItem } from "~/types/desktop";
import { activeHues, type ToolOrbFamily } from "~/utils/toolOrbDraw";

export type TurnActivity = {
  /** Which orb/glyph the pill shows at its left. `done` is a settled turn held
   *  in the corner (a completed/failed/stopped reply waiting to be opened). */
  orb: "thinking" | "tool" | "working" | "done";
  /** For a tool orb — its family motion + hue (same table as the thread). */
  family?: ToolOrbFamily;
  hue?: string;
  /** The one-line status: "Reading example.vue", "Thinking", "Replied". */
  label: string;
  /** Colours a settled (`done`) turn's glyph + label. */
  tone?: "ok" | "error" | "muted";
};

/** Peel the `name:` prefix the providers stamp on a tool_call's text, leaving
 *  just the target (path / query / command). */
function targetOf(item: RuntimeItem): string {
  const name = (item.name ?? "").trim();
  const raw = (item.text ?? "").trim();
  const prefix = `${name}:`;
  if (raw.startsWith(prefix)) return raw.slice(prefix.length).trim();
  return raw === name ? "" : raw;
}

/** Compact truncation — keep a path's basename, clip anything else at the end. */
function shorten(s: string, max = 30): string {
  if (s.length <= max) return s;
  if (s.includes("/")) {
    const base = s.split("/").filter(Boolean).pop() ?? s;
    return base.length <= max ? base : "…" + base.slice(-(max - 1));
  }
  return s.slice(0, max - 1) + "…";
}

function tool(family: ToolOrbFamily, label: string): TurnActivity {
  return { orb: "tool", family, hue: activeHues().families[family]!, label };
}

/** The present-tense status for a running tool_call, matching the thread's
 *  running-branch phrasing (Reading/Editing/Searching for/Running…). */
function toolActivity(item: RuntimeItem): TurnActivity {
  const name = (item.name ?? "").trim().toLowerCase();
  const raw = targetOf(item);
  const t = shorten(raw);
  // grep summaries arrive as "query · N matches"; the query is what's live.
  const query = shorten(raw.split("·")[0]?.trim() || raw);

  switch (name) {
    case "read_file":
    case "view_file":
    case "read":
      return tool("read", t ? `Reading ${t}` : "Reading a file");
    case "write_to_file":
    case "create_file":
    case "write":
      return tool("write", t ? `Writing ${t}` : "Writing a file");
    case "edit_file":
    case "apply_patch":
    case "str_replace":
    case "replace_file_content":
    case "edit":
    case "multiedit":
    case "notebookedit":
      return tool("write", t ? `Editing ${t}` : "Editing a file");
    case "list_dir":
    case "ls":
      return tool("read", t ? `Listing ${t}` : "Listing a folder");
    case "delete_file":
    case "rm":
      return tool("del", t ? `Deleting ${t}` : "Deleting a file");
    case "grep_search":
    case "ripgrep":
    case "grep":
    case "codebase_search":
    case "search":
      return tool("search", query ? `Searching for ${query}` : "Searching the codebase");
    case "glob_file_search":
    case "find_by_name":
    case "glob":
      return tool("search", t ? `Finding files matching ${t}` : "Finding files");
    case "go_to_definition":
    case "view_code_item":
    case "lsp": {
      const symbol = shorten(raw.split("→")[0]?.trim() || raw);
      return tool("intel", symbol ? `Looking up ${symbol}` : "Looking something up");
    }
    case "bash":
    case "run_terminal_cmd":
    case "execute_command":
    case "run_command":
    case "run":
    case "command":
      return tool("run", t ? `Running ${t}` : "Running a command");
    case "web_search":
    case "search_web":
    case "websearch":
      return tool("web", query ? `Searching the web for ${query}` : "Searching the web");
    case "web_fetch":
    case "read_url_content":
    case "view_web_document":
    case "webfetch": {
      const url = shorten(raw.split("·")[0]?.trim() || raw);
      return tool("web", url ? `Fetching ${url}` : "Fetching a page");
    }
    case "task":
    case "new_task":
    case "agent":
      return tool("agent", "Running a sub-task");
    case "mcp":
      return tool("agent", "Running an MCP tool");
    default: {
      if (name.startsWith("mcp__")) return tool("agent", "Running an MCP tool");
      if (name.includes("screenshot") || name.includes("capture"))
        return tool("neutral", "Taking a screenshot");
      const human = name ? name.replace(/[_-]+/g, " ") : "a tool";
      return tool("neutral", `Running ${human}`);
    }
  }
}

/** The current activity of a running assistant turn — or null when there's no
 *  live turn (the pill hides). Reads the latest item: a settled tail (or none
 *  yet) is a quiet gap → "Working"; otherwise it's thinking, responding, or a
 *  named tool call. */
export function describeTurnActivity(block: AssistantBlock | null | undefined): TurnActivity | null {
  if (!block) return null;
  // Settled — the pill holds a finished turn until it's opened.
  if (block.state === "completed") return { orb: "done", label: "Replied", tone: "ok" };
  if (block.state === "failed") return { orb: "done", label: "Couldn't finish", tone: "error" };
  if (block.state === "interrupted") return { orb: "done", label: "Stopped", tone: "muted" };
  const last = block.items[block.items.length - 1];
  // Nothing in flight — the opening beat after send, or a lull between steps.
  if (!last || last.status !== "in-progress") return { orb: "working", label: "Working" };
  if (last.kind === "reasoning_text") return { orb: "thinking", label: "Thinking" };
  if (last.kind === "plan_text") return { orb: "working", label: "Planning" };
  if (last.kind === "assistant_text") return { orb: "working", label: "Working" };
  return toolActivity(last);
}
