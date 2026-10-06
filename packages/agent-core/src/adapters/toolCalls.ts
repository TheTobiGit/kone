import { z } from "zod";
import type { JsonValue, JsonObject } from "../lib-jsonValue.js";
import { ToolActionSchema, type ToolAction, type ToolCall, type ToolFileChange } from "@kone/protocol/tool-call";
import { unifiedDiffFromTexts } from "@kone/protocol/unified-diff";

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

/** The script a login-shell wrapper runs — `/bin/bash -lc 'git status'` reads
 *  as `git status`. Only the exact `<shell> -c|-lc <one quoted argument>` shape
 *  unwraps; anything else (pipes outside the quotes, a second argument, an
 *  unknown shell) is returned as given, because a wrong unwrap would show a
 *  command that never ran. */
export function unwrapShellCommand(command: string): string {
  const match = command.match(/^(?:\/(?:usr\/)?bin\/)?(?:bash|zsh|sh)\s+-l?c\s+(['"])([\s\S]*)\1$/);
  if (!match) return command;
  const [, quote, body] = match;
  if (quote === "'") {
    // POSIX single quotes can't contain ', so a quote inside is spelled '\''.
    const parts = body!.split("'\\''");
    return parts.some((part) => part.includes("'")) ? command : parts.join("'");
  }
  // Inside double quotes only \" \\ \$ \` and \newline are escapes; a bare "
  // would have ended the argument.
  if (/(^|[^\\])(\\\\)*"/.test(body!)) return command;
  return body!.replace(/\\(["\\$`\n])/g, "$1");
}

/** How a Codex `commandExecution` reads: the unwrapped script as its target,
 *  re-read as a read, listing or search when Codex's own parse says the whole
 *  script is exactly one of those. A compound script stays a run — Codex's
 *  `commandActions` can describe only part of it (`echo x && ls` reports one
 *  `listFiles`). The executed command and cwd stay in the call's input. */
export function codexCommandView(item: JsonValue): { action: ToolAction; target: string; input: string } | undefined {
  const raw = object(item);
  const executed = string(raw?.command) ?? (Array.isArray(raw?.command) ? raw.command.map(string).filter((s) => s !== undefined).join(" ") : undefined);
  if (!raw || !executed) return undefined;
  const script = unwrapShellCommand(executed);
  const cwd = string(raw.cwd);
  const input = JSON.stringify(cwd ? { command: executed, cwd } : { command: executed }, null, 2);
  const actions = Array.isArray(raw.commandActions) ? raw.commandActions.map(object) : [];
  const only = actions.length === 1 ? actions[0] : undefined;
  if (only && string(only.command)?.trim() === script.trim()) {
    const type = string(only.type);
    const path = string(only.path);
    const query = string(only.query);
    if (type === "read" && path) return { action: "read", target: path, input };
    if (type === "listFiles") return { action: "list", target: path ?? script, input };
    if (type === "search") return { action: "search", target: query ?? script, input };
  }
  return { action: "run", target: script, input };
}
