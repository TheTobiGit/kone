// The tool-call vocabulary → icon + label + family hue + running-orb family, plus
// the natural-language phrasing that turns a raw `read_file: src/foo.ts` into a
// legible "Read src/foo.ts".
//
// Icons are Hugeicons stroke icons — same family as the rest of the app's
// iconography — each carrying a soft family hue so a run of calls reads as a
// legible, lightly-coloured timeline rather than a wall of grey: Read blues,
// Write violets, Search ambers, Run greens, Delete red.
//
// Extracted from ConversationThread so the thread's step rows, the Agent
// Activity feed, and its history strip all speak with one voice.

import {
  File01Icon,
  FileEditIcon,
  ListViewIcon,
  Delete02Icon,
  Search01Icon,
  SourceCodeIcon,
  CommandLineIcon,
  GlobalSearchIcon,
  Link01Icon,
  WorkflowSquare01Icon,
  Rocket01Icon,
  ToolsIcon,
} from "@hugeicons/core-free-icons";
import type { RuntimeItem } from "~/types/desktop";
import { activeHues, type ToolOrbFamily } from "~/utils/toolOrbDraw";
import { looksLikeDirectoryPath, looksLikeSite } from "~/utils/siteChip";

// Icons are Hugeicons SVG data objects (the `:icon` prop of <HugeiconsIcon>), not
// Vue components — same shape as File01Icon et al.
export type HugeIcon = typeof File01Icon;
export type ToolMeta = { icon: HugeIcon; label: string; hue: string; family: ToolOrbFamily };
type ToolMetaInput = Omit<ToolMeta, "hue">;

const TOOL_TABLE: Record<string, ToolMetaInput> = {
  // filesystem
  read_file: { icon: File01Icon, label: "Read", family: "read" },
  view_file: { icon: File01Icon, label: "Read", family: "read" },
  read: { icon: File01Icon, label: "Read", family: "read" },
  write_to_file: { icon: FileEditIcon, label: "Write", family: "write" },
  create_file: { icon: FileEditIcon, label: "Write", family: "write" },
  write: { icon: FileEditIcon, label: "Write", family: "write" },
  edit_file: { icon: FileEditIcon, label: "Edit", family: "write" },
  apply_patch: { icon: FileEditIcon, label: "Edit", family: "write" },
  str_replace: { icon: FileEditIcon, label: "Edit", family: "write" },
  replace_file_content: { icon: FileEditIcon, label: "Edit", family: "write" },
  edit: { icon: FileEditIcon, label: "Edit", family: "write" },
  multiedit: { icon: FileEditIcon, label: "Edit", family: "write" }, // Claude
  notebookedit: { icon: FileEditIcon, label: "Edit", family: "write" }, // Claude
  list_dir: { icon: ListViewIcon, label: "List", family: "read" },
  ls: { icon: ListViewIcon, label: "List", family: "read" },
  delete_file: { icon: Delete02Icon, label: "Delete", family: "del" },
  rm: { icon: Delete02Icon, label: "Delete", family: "del" },
  // search & navigation
  grep_search: { icon: Search01Icon, label: "Grep", family: "search" },
  ripgrep: { icon: Search01Icon, label: "Grep", family: "search" },
  glob_file_search: { icon: Search01Icon, label: "Glob", family: "search" },
  find_by_name: { icon: Search01Icon, label: "Glob", family: "search" },
  glob: { icon: Search01Icon, label: "Glob", family: "search" }, // Claude
  codebase_search: { icon: Search01Icon, label: "Search", family: "search" },
  grep: { icon: Search01Icon, label: "Grep", family: "search" },
  search: { icon: Search01Icon, label: "Search", family: "search" },
  go_to_definition: { icon: SourceCodeIcon, label: "Code intel", family: "intel" },
  view_code_item: { icon: SourceCodeIcon, label: "Code intel", family: "intel" },
  lsp: { icon: SourceCodeIcon, label: "Code intel", family: "intel" },
  // execution
  bash: { icon: CommandLineIcon, label: "Run", family: "run" },
  run_terminal_cmd: { icon: CommandLineIcon, label: "Run", family: "run" },
  execute_command: { icon: CommandLineIcon, label: "Run", family: "run" },
  run_command: { icon: CommandLineIcon, label: "Run", family: "run" },
  run: { icon: CommandLineIcon, label: "Run", family: "run" },
  command: { icon: CommandLineIcon, label: "Run", family: "run" },
  // web
  web_search: { icon: GlobalSearchIcon, label: "Web search", family: "web" },
  search_web: { icon: GlobalSearchIcon, label: "Web search", family: "web" },
  websearch: { icon: GlobalSearchIcon, label: "Web search", family: "web" }, // Claude
  web_fetch: { icon: Link01Icon, label: "Web fetch", family: "web" },
  read_url_content: { icon: Link01Icon, label: "Web fetch", family: "web" },
  view_web_document: { icon: Link01Icon, label: "Web fetch", family: "web" },
  webfetch: { icon: Link01Icon, label: "Web fetch", family: "web" }, // Claude
  list: { icon: ListViewIcon, label: "List", family: "read" },
  todowrite: { icon: WorkflowSquare01Icon, label: "Plan", family: "agent" },
  patch: { icon: FileEditIcon, label: "Edit", family: "write" },
  // planning & orchestration
  task: { icon: WorkflowSquare01Icon, label: "Subagent", family: "agent" },
  new_task: { icon: WorkflowSquare01Icon, label: "Subagent", family: "agent" },
  agent: { icon: WorkflowSquare01Icon, label: "Subagent", family: "agent" },
  mcp: { icon: WorkflowSquare01Icon, label: "MCP tool", family: "agent" },
  // context & specialized
  deploy_web_app: { icon: Rocket01Icon, label: "Deploy", family: "run" },
  multi_replace_file_content: { icon: FileEditIcon, label: "Edit", family: "write" },
  manage_task: { icon: WorkflowSquare01Icon, label: "Task", family: "agent" },
  schedule: { icon: WorkflowSquare01Icon, label: "Schedule", family: "agent" },
  invoke_subagent: { icon: WorkflowSquare01Icon, label: "Subagent", family: "agent" },
  define_subagent: { icon: WorkflowSquare01Icon, label: "Subagent", family: "agent" },
  manage_subagents: { icon: WorkflowSquare01Icon, label: "Subagent", family: "agent" },
  generate_image: { icon: Rocket01Icon, label: "Generate image", family: "run" },
  ask_question: { icon: WorkflowSquare01Icon, label: "Question", family: "agent" },
  send_message: { icon: WorkflowSquare01Icon, label: "Message", family: "agent" },
};

export function toolMeta(name: string | undefined): ToolMeta {
  const families = activeHues().families;
  if (!name) return { icon: ToolsIcon, label: "Tool", hue: families.neutral!, family: "neutral" };
  const key = name.trim().toLowerCase();
  if (TOOL_TABLE[key]) {
    const meta = TOOL_TABLE[key]!;
    return { ...meta, hue: families[meta.family]! };
  }
  // MCP tools arrive as `mcp__server__tool` — read the last segment as the label
  // and hue them as external/orchestration rather than a raw title-cased blob.
  if (key.startsWith("mcp__")) {
    const tail = key.split("__").filter(Boolean).pop() ?? key;
    const label = tail.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    return { icon: WorkflowSquare01Icon, label, hue: families.agent!, family: "agent" };
  }
  const label = key.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return { icon: ToolsIcon, label, hue: families.neutral!, family: "neutral" };
}

export function toolStatus(t: RuntimeItem): "running" | "done" | "error" {
  if (t.status === "in-progress") return "running";
  if (t.status === "failed") return "error";
  return "done";
}

// The provider hands args as `read_file: src/foo.ts`; peel the name so we're left
// with the target (path / command / query). Long tails keep their end — the full
// value stays reachable in the row's title attribute.
export function toolTargetRaw(t: RuntimeItem): string {
  const name = (t.name ?? "").trim();
  const raw = (t.text ?? "").trim();
  const prefix = `${name}:`;
  if (raw.startsWith(prefix)) return raw.slice(prefix.length).trim();
  const lowerRaw = raw.toLowerCase();
  const lowerName = name.toLowerCase();
  if (
    lowerRaw === lowerName ||
    lowerRaw === lowerName.replace(/_/g, " ") ||
    lowerRaw.replace(/_/g, " ") === lowerName.replace(/_/g, " ")
  ) {
    return "";
  }
  return raw;
}

export function toolTarget(t: RuntimeItem, max = 64): string {
  const d = toolTargetRaw(t);
  if (d.length <= max) return d;
  const name = (t.name ?? "").trim().toLowerCase();
  const isCommand =
    ["bash", "run_terminal_cmd", "execute_command", "run_command", "run", "command"].includes(name) ||
    looksLikeCommand(d);
  if (isCommand) {
    return d.slice(0, max - 1) + "…";
  }
  if (looksLikeFilePath(d) || looksLikeDirectoryPath(d)) {
    return "…" + d.slice(-(max - 1));
  }
  return d.slice(0, max - 1) + "…";
}

export function toolDetailFull(t: RuntimeItem): string {
  return toolTargetRaw(t);
}

export function looksLikeFilePath(s: string): boolean {
  if (!s) return false;
  const base = s.split("/").filter(Boolean).pop() ?? s;
  const stem = base.replace(/:\d+(?:-\d+)?$/, "");
  if (
    /^[\w.-]+\.(vue|ts|tsx|js|jsx|css|md|json|py|go|rs|rb|php|html|yaml|yml|toml|svg|png|jpg|jpeg|webp|gif|log|sh|sql|toml|lock)$/i.test(
      stem,
    )
  )
    return true;
  if (/[\\/]/.test(s) && /\.[a-z0-9]{1,8}$/i.test(stem)) return true;
  return false;
}

export function looksLikeCommand(s: string): boolean {
  return /^(bun|npm|pnpm|yarn|git|cargo|make|python3?|node|deno|npx|bunx|docker|go|pytest|vitest|sh|bash|zsh)\s/i.test(s);
}

// Natural-language row copy — reads like a brief status line, not "Verb: target".
export type ToolPhraseTarget =
  | { kind: "file"; path: string }
  | { kind: "folder"; path: string }
  | { kind: "site"; url: string }
  | { kind: "mono"; text: string };
export type ToolPhrase = { before: string; target?: ToolPhraseTarget; after?: string };

function targetPhrase(
  lead: string,
  text?: string,
  tail = "",
  force?: ToolPhraseTarget["kind"],
): ToolPhrase {
  if (!text) return { before: `${lead}${tail}` };
  const kind =
    force ??
    (looksLikeSite(text)
      ? "site"
      : looksLikeCommand(text)
        ? "mono"
        : looksLikeFilePath(text)
          ? "file"
          : looksLikeDirectoryPath(text)
            ? "folder"
            : "mono");
  if (kind === "file") return { before: lead, target: { kind: "file", path: text }, after: tail || undefined };
  if (kind === "folder") return { before: lead, target: { kind: "folder", path: text }, after: tail || undefined };
  if (kind === "site") return { before: lead, target: { kind: "site", url: text }, after: tail || undefined };
  return { before: lead, target: { kind: "mono", text }, after: tail || undefined };
}

function plain(text: string): ToolPhrase {
  return { before: text };
}

export function toolPhrase(t: RuntimeItem): ToolPhrase {
  const status = toolStatus(t);
  const ing = status === "running";
  const fail = status === "error";
  const detail = toolTarget(t);
  const full = toolTargetRaw(t);
  const name = (t.name ?? "").trim().toLowerCase();

  // grep-style "query · N matches"
  const matchSplit = full.match(/^(.+?)\s*·\s*(\d+)\s+matches?$/i);
  if (matchSplit) {
    const [, query, count] = matchSplit;
    if (ing) return plain(`Searching for ${query}`);
    if (fail) return plain(`Couldn't search for ${query}`);
    return plain(`Found ${count} matches for ${query}`);
  }

  // code-intel "symbol → file:line"
  const defSplit = full.match(/^(.+?)\s*→\s*(.+)$/);
  if (name === "go_to_definition" || name === "view_code_item" || name === "lsp") {
    if (defSplit) {
      const [, symbol, loc] = defSplit;
      if (ing) return plain(`Looking up ${symbol}`);
      if (fail) return plain(`Couldn't find ${symbol}`);
      return targetPhrase(`Jumped to ${symbol} in `, loc, "", "file");
    }
    if (ing) return plain(full ? `Looking up ${full}` : "Looking up a symbol");
    if (fail) return plain(full ? `Couldn't find ${full}` : "Lookup failed");
    return looksLikeFilePath(full) ? targetPhrase("Jumped to ", full, "", "file") : plain(`Jumped to ${full}`);
  }

  // web fetch "url · label"
  const fetchSplit = full.match(/^(.+?)\s*·\s*(.+)$/);
  if (name === "web_fetch" || name === "read_url_content" || name === "view_web_document" || name === "webfetch") {
    const url = fetchSplit?.[1]?.trim() ?? full;
    if (ing) return targetPhrase("Fetching ", url, "", "site");
    if (fail) return targetPhrase("Couldn't fetch ", url, "", "site");
    return targetPhrase("Fetched ", url, "", "site");
  }

  switch (name) {
    case "read_file":
    case "view_file":
    case "read":
      if (!detail) return plain(ing ? "Reading a file" : fail ? "Couldn't read file" : "Read a file");
      if (ing) return targetPhrase("Reading ", detail, "", "file");
      if (fail) return targetPhrase("Couldn't read ", detail, "", "file");
      return targetPhrase("Read ", detail, "", "file");
    case "write_to_file":
    case "create_file":
    case "write":
      if (!detail) return plain(ing ? "Writing a file" : fail ? "Couldn't write file" : "Wrote a file");
      if (ing) return targetPhrase("Writing ", detail, "", "file");
      if (fail) return targetPhrase("Couldn't write ", detail, "", "file");
      return targetPhrase("Wrote ", detail, "", "file");
    case "edit_file":
    case "apply_patch":
    case "str_replace":
    case "replace_file_content":
    case "multi_replace_file_content":
    case "edit":
    case "multiedit":
    case "notebookedit":
      if (!detail) return plain(ing ? "Editing a file" : fail ? "Couldn't edit file" : "Edited a file");
      if (ing) return targetPhrase("Editing ", detail, "", "file");
      if (fail) return targetPhrase("Couldn't edit ", detail, "", "file");
      return targetPhrase("Edited ", detail, "", "file");
    case "list_dir":
    case "ls":
      if (!detail) return plain(ing ? "Listing a folder" : fail ? "Couldn't list folder" : "Listed a folder");
      if (ing) return targetPhrase("Listing ", detail, "", "folder");
      if (fail) return targetPhrase("Couldn't list ", detail, "", "folder");
      return targetPhrase("Listed ", detail, "", "folder");
    case "delete_file":
    case "rm":
      if (!detail) return plain(ing ? "Deleting a file" : fail ? "Couldn't delete file" : "Deleted a file");
      if (ing) return targetPhrase("Deleting ", detail, "", "file");
      if (fail) return targetPhrase("Couldn't delete ", detail, "", "file");
      return targetPhrase("Deleted ", detail, "", "file");
    case "grep_search":
    case "ripgrep":
    case "grep":
      if (!detail) return plain(ing ? "Searching the codebase" : fail ? "Search failed" : "Searched the codebase");
      if (ing) return plain(`Searching for ${detail}`);
      if (fail) return plain(`Couldn't search for ${detail}`);
      return plain(`Searched for ${detail}`);
    case "glob_file_search":
    case "find_by_name":
    case "glob":
      if (!detail) return plain(ing ? "Finding files" : fail ? "File search failed" : "Found matching files");
      if (ing) return plain(`Finding files matching ${detail}`);
      if (fail) return plain(`Couldn't find files matching ${detail}`);
      return plain(`Found files matching ${detail}`);
    case "codebase_search":
    case "search":
      if (!detail) return plain(ing ? "Searching the codebase" : fail ? "Search failed" : "Searched the codebase");
      if (ing) return plain(`Searching the codebase for ${detail}`);
      if (fail) return plain(`Couldn't find ${detail} in the codebase`);
      return plain(`Searched the codebase for ${detail}`);
    case "bash":
    case "run_terminal_cmd":
    case "execute_command":
    case "run_command":
    case "run":
    case "command":
      if (!detail) return plain(ing ? "Running a command" : fail ? "Command failed" : "Ran a command");
      if (ing) return targetPhrase("Running ", detail, "", "mono");
      if (fail) return targetPhrase("Couldn't run ", detail, "", "mono");
      return targetPhrase("Ran ", detail, "", "mono");
    case "web_search":
    case "search_web":
    case "websearch":
      if (!detail) return plain(ing ? "Searching the web" : fail ? "Web search failed" : "Searched the web");
      if (ing) return plain(`Searching the web for ${detail}`);
      if (fail) return plain(`Couldn't search the web for ${detail}`);
      return plain(`Searched the web for ${detail}`);
    case "task":
    case "new_task":
    case "agent":
      if (!detail) return plain(ing ? "Starting a sub-task" : fail ? "Sub-task failed" : "Finished a sub-task");
      if (ing) return plain(`Running a sub-task — ${detail}`);
      if (fail) return plain(`Sub-task failed — ${detail}`);
      return plain(`Ran a sub-task — ${detail}`);
    case "manage_task":
      if (!detail) return plain(ing ? "Managing task" : fail ? "Task action failed" : "Managed task");
      if (ing) return plain(`Managing task — ${detail}`);
      if (fail) return plain(`Task action failed — ${detail}`);
      return plain(`Task — ${detail}`);
    case "schedule":
      if (!detail) return plain(ing ? "Scheduling a task" : fail ? "Schedule failed" : "Scheduled a task");
      if (ing) return plain(`Scheduling ${detail}`);
      if (fail) return plain(`Schedule failed — ${detail}`);
      return plain(`Scheduled ${detail}`);
    case "invoke_subagent":
      if (!detail) return plain(ing ? "Starting subagent" : fail ? "Subagent failed" : "Finished subagent");
      if (ing) return plain(`Running subagent — ${detail}`);
      if (fail) return plain(`Subagent failed — ${detail}`);
      return plain(`Ran subagent — ${detail}`);
    case "define_subagent":
      if (!detail) return plain(ing ? "Defining subagent" : fail ? "Failed to define subagent" : "Defined subagent");
      if (ing) return plain(`Defining subagent — ${detail}`);
      if (fail) return plain(`Failed to define subagent — ${detail}`);
      return plain(`Defined subagent — ${detail}`);
    case "manage_subagents":
      if (!detail) return plain(ing ? "Managing subagents" : fail ? "Failed to manage subagents" : "Managed subagents");
      if (ing) return plain(`Managing subagents — ${detail}`);
      if (fail) return plain(`Failed to manage subagents — ${detail}`);
      return plain(`Subagents — ${detail}`);
    case "generate_image":
      if (!detail) return plain(ing ? "Generating image" : fail ? "Image generation failed" : "Generated image");
      if (ing) return plain(`Generating image for ${detail}`);
      if (fail) return plain(`Couldn't generate image for ${detail}`);
      return plain(`Generated image for ${detail}`);
    case "ask_question":
      if (!detail) return plain(ing ? "Asking question" : fail ? "Question failed" : "Asked question");
      if (ing) return plain(`Asking: ${detail}`);
      if (fail) return plain(`Couldn't ask: ${detail}`);
      return plain(`Asked: ${detail}`);
    case "send_message":
      if (!detail) return plain(ing ? "Sending message" : fail ? "Failed to send message" : "Sent message");
      if (ing) return plain(`Sending message to ${detail}`);
      if (fail) return plain(`Failed to send message to ${detail}`);
      return plain(`Sent message to ${detail}`);
    case "mcp":
      if (!detail) return plain(ing ? "Running an MCP tool" : fail ? "MCP tool failed" : "Ran an MCP tool");
      if (ing) return plain(`Running an MCP tool — ${detail}`);
      if (fail) return plain(`MCP tool failed — ${detail}`);
      return plain(`Ran an MCP tool — ${detail}`);
    case "deploy_web_app":
      if (!detail) return plain(ing ? "Deploying" : fail ? "Deploy failed" : "Deployed");
      if (ing) return plain(`Deploying ${detail}`);
      if (fail) return plain(`Couldn't deploy ${detail}`);
      return plain(`Deployed ${detail}`);
    default: {
      const human = name.replace(/[_-]+/g, " ");
      if (name.includes("screenshot") || name.includes("capture")) {
        if (ing) return plain("Taking a screenshot");
        if (fail) return plain("Couldn't capture screenshot");
        return detail ? targetPhrase("Captured ", detail, "", "file") : plain("Captured a screenshot");
      }
      if (!detail) {
        if (ing) return plain(`Running ${human}`);
        if (fail) return plain(`${human} failed`);
        return plain(`Ran ${human}`);
      }
      if (ing) return plain(`Running ${human} on ${detail}`);
      if (fail) return plain(`Couldn't run ${human} on ${detail}`);
      return plain(`Ran ${human} on ${detail}`);
    }
  }
}

export type ToolPhrasePart =
  | { kind: "text"; text: string }
  | { kind: "file"; path: string }
  | { kind: "folder"; path: string }
  | { kind: "site"; url: string }
  | { kind: "mono"; text: string };

export function toolPhraseParts(t: RuntimeItem): ToolPhrasePart[] {
  const p = toolPhrase(t);
  const out: ToolPhrasePart[] = [{ kind: "text", text: p.before }];
  if (p.target?.kind === "file") out.push({ kind: "file", path: p.target.path });
  else if (p.target?.kind === "folder") out.push({ kind: "folder", path: p.target.path });
  else if (p.target?.kind === "site") out.push({ kind: "site", url: p.target.url });
  else if (p.target?.kind === "mono") out.push({ kind: "mono", text: p.target.text });
  if (p.after) out.push({ kind: "text", text: p.after });
  return out;
}
