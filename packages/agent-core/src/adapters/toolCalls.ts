import { z } from "zod";
import type { JsonValue, JsonObject } from "../lib-jsonValue.js";
import { ToolActionSchema, type ToolAction, type ToolCall, type ToolFileChange } from "@kone/protocol/tool-call";
import { unifiedDiffFromTexts } from "@kone/protocol/unified-diff";
import type { ToolObservation } from "../toolCallAccumulator.js";

export function object(value: JsonValue): JsonObject | undefined {
  // SAFETY: decoded JSON objects exclude primitive values and arrays here.
  return value instanceof Object && !Array.isArray(value) ? value as JsonObject : undefined;
}
export function string(value: JsonValue): string | undefined {
  const parsed = z.string().safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
export function number(value: JsonValue): number | undefined {
  const parsed = z.number().safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
export function parsedInput(value: string | undefined): JsonObject | undefined {
  try { return object(JSON.parse(value ?? "")); } catch { return undefined; }
}

const ACTION_NAMES = {
  read: ["read", "read_file", "view_file", "view_code_item", "readfile"],
  list: ["list", "ls", "list_dir", "list_directory", "listfiles"],
  search: ["search", "grep", "glob", "grep_search", "glob_file_search", "codebase_search", "find_by_name", "ripgrep"],
  write: ["write", "write_to_file", "create_file", "writefile"],
  edit: ["edit", "edit_file", "apply_patch", "applypatch", "patch", "str_replace", "replace_file_content", "multiedit", "notebookedit"],
  delete: ["delete", "delete_file", "rm"],
  run: ["bash", "shell", "run", "command", "execute", "exec", "exec_command", "execute_command", "run_command", "run_terminal_cmd"],
  fetch: ["fetch", "web_fetch", "webfetch", "read_url_content", "view_web_document"],
  "web-search": ["web_search", "websearch", "search_web"],
  agent: ["agent", "task", "spawn_agent", "spawnagent", "subagent"],
  plan: ["todowrite", "todoread", "plan"],
  image: ["image", "generate_image", "imagegen", "view_image"],
  other: [],
} satisfies Record<ToolAction, string[]>;
export function inferAction(name?: string): ToolAction {
  const key = (name?.split("__").pop() ?? "").toLowerCase();
  return ToolActionSchema.parse(Object.entries(ACTION_NAMES).find(([, names]) => names.some((name) => name === key))?.[0] ?? "other");
}

export function inputTarget(input: JsonValue, action?: ToolAction): string | undefined {
  const args = object(input);
  if (!args) return undefined;
  const preferred = action === "search" || action === "web-search" ? ["query", "Query", "pattern", "Pattern"]
    : action === "fetch" ? ["url", "URL", "Url"] : [];
  for (const key of [...preferred, "command", "cmd", "CommandLine", "file_path", "filePath", "path", "TargetFile", "AbsolutePath", "DirectoryPath", "SearchPath", "pattern", "query", "url", "URL", "description", "prompt"]) {
    const value = string(args[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function describeTool(name?: string, input?: JsonValue, title?: string): ToolCall {
  const transportMatch = name?.match(/^mcp__(.+?)__(.+)$/);
  const tool: ToolCall = { action: inferAction(name) };
  const target = inputTarget(input, tool.action);
  if (target !== undefined) tool.target = target;
  if (title !== undefined) tool.title = title;
  if (input !== undefined) tool.input = JSON.stringify(input, null, 2);
  if (transportMatch) tool.transport = { server: transportMatch[1]!, tool: transportMatch[2]! };
  return tool;
}

/** ACP updates are partial snapshots. A title never outranks structured input. */
export function acpObservation(update: JsonValue, name: string | undefined, detail: string): ToolObservation {
  const raw = object(update) ?? {};
  const input = raw.rawInput;
  const title = string(raw.title);
  const target = inputTarget(input, inferAction(name));
  const locations = Array.isArray(raw.locations) ? raw.locations : [];
  const path = string(object(locations[0])?.path);
  const kind = string(raw.kind);
  const action = kind === "execute" ? "run" : kind === "fetch" ? "fetch"
    : kind === "move" ? "edit" : kind === "think" || kind === "other" ? "other"
    : kind && ["read", "edit", "delete", "search"].includes(kind) ? ToolActionSchema.parse(kind) : undefined;
  const status = string(raw.status);
  const observation: ToolObservation = {
    title,
    name: name ? { value: name, authority: kind ? "explicit" : "fallback" } : undefined,
    action: { value: action ?? inferAction(name), authority: action ? "explicit" : "inferred" },
    target: target !== undefined ? { value: target, authority: "explicit" }
      : path ? { value: path, authority: "explicit" }
      : title !== undefined ? { value: title, authority: "inferred" } : undefined,
    input: input !== undefined ? JSON.stringify(input, null, 2) : undefined,
    status: status === undefined ? undefined : status === "failed" ? "failed"
      : status === "completed" ? "completed" : "in-progress",
  };
  if (detail) observation.detail = { value: detail, mode: "snapshot" };
  const blocks = Array.isArray(raw.content) ? raw.content : [];
  const changes: ToolFileChange[] = [];
  for (const b of blocks) {
    const block = object(b);
    if (block?.type !== "diff") continue;
    const file = string(block.path);
    const before = string(block.oldText);
    const after = string(block.newText);
    if (file && before !== undefined && after !== undefined) changes.push({ path: file,
      kind: before === "" ? "created" : after === "" ? "removed" : "edited",
      diff: beforeAfterDiff(before, after), applied: status === "completed" });
  }
  const filePath = string(object(input)?.file_path) ?? string(object(input)?.path) ?? string(object(input)?.TargetFile) ?? path;
  const mutation = action ?? inferAction(name);
  if (!changes.length && filePath && ["edit", "write", "delete"].includes(mutation)) {
    changes.push({ path: filePath, kind: mutation === "delete" ? "removed" : "edited", applied: status === "completed" });
  }
  if (changes.length) observation.fileChanges = changes;
  return observation;
}

/** Before/after content has known line origins: diff it into numbered hunks
 *  rather than reading a bare run of +/- lines. */
export function beforeAfterDiff(before: string, after: string): string {
  return unifiedDiffFromTexts(before, after);
}

export function codexFileChanges(raw: JsonValue): ToolFileChange[] | undefined {
  const item = object(raw);
  if (!Array.isArray(item?.changes)) return undefined;
  return item.changes.flatMap((entry): ToolFileChange[] => {
    const change = object(entry);
    const path = string(change?.path);
    if (!path) return [];
    const kind = object(change?.kind);
    const type = string(kind?.type) ?? string(change?.kind);
    const diff = string(change?.diff);
    const movePath = string(kind?.movePath ?? kind?.move_path);
    const file: ToolFileChange = {
      path: movePath ?? path,
      kind: type === "add" ? "created" : type === "delete" ? "removed" : movePath ? "renamed" : "edited",
      diff: type === "add" && diff !== undefined ? beforeAfterDiff("", diff) : diff,
      applied: item.status === "completed",
    };
    if (movePath) file.oldPath = path;
    return [file];
  });
}

export function openCodeFileChanges(metadata: JsonValue, applied: boolean): ToolFileChange[] | undefined {
  const raw = object(metadata);
  if (!Array.isArray(raw?.files)) return undefined;
  return raw.files.flatMap((entry): ToolFileChange[] => {
    const f = object(entry);
    const path = string(f?.filePath) ?? string(f?.path) ?? string(f?.file);
    if (!path) return [];
    const diff = string(f?.patch);
    return [{ path, kind: diff?.includes("--- /dev/null") ? "created"
      : diff?.includes("+++ /dev/null") ? "removed" : "edited", diff, applied }];
  });
}
