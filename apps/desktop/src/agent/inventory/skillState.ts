// FILE: skillState.ts
// Purpose: read and write the effective per-skill state for the origins kone
// scans. One skill has one effective state — enabled | name-only |
// user-invocable-only | disabled | unsupported — derived from the owning
// CLI's own config file: Claude Code's `skillOverrides` in its settings JSON,
// Codex's `[[skills.config]]` in config.toml, opencode's `permission.skill`
// pattern map in opencode.json. Cursor skills, Claude plugin skills, bundled
// skills and the shared `.agents` root have no switch, so they are
// `unsupported` with a stated reason rather than a dead toggle.
//
// Settings files are JSONC/TOML written by humans: a parse-and-reserialize
// would silently reformat a user's config, so every write below is a surgical
// edit of the exact key/block region (byte-preserving elsewhere) and reports
// what it wrote to which path. The pure functions take file contents as
// strings; the thin fs edge at the bottom resolves the real config paths and
// can be pointed at an injected fs + home for tests.
// Exports: SkillState, WritableSkillState, SkillStateResult, StateWriteResult,
// SkillStateFs, CodexSkillEntry, readClaudeOverrides, deriveClaudeSkillState,
// applyClaudeOverride, readCodexSkillConfig, resolveCodexSkillState,
// applyCodexSkillConfig, readOpenCodePermission, matchOpenCodePattern,
// resolveOpenCodeSkillState, applyOpenCodePermission, readSkillState,
// writeSkillState

import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { parseFrontmatter } from "./frontmatter.js";
import type { SkillEntry } from "./types.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type SkillState = "enabled" | "name-only" | "user-invocable-only" | "disabled" | "unsupported";

/** The states a write may request; `unsupported` is never writable. */
export type WritableSkillState = Exclude<SkillState, "unsupported">;

export type SkillStateResult = {
  state: SkillState;
  /** A finished sentence explaining why the state is what it is, or null when
   *  the state is the plain default (nothing recorded anywhere). */
  reason: string | null;
  /** The config file (or SKILL.md) that determined the state, as a finished
   *  sentence naming the path, or null when nothing on disk constrained it. */
  source: string | null;
};

export type StateWriteResult = {
  ok: boolean;
  /** Absolute path written, or null when nothing needed writing. */
  wrotePath: string | null;
  reason: string;
};

/** Injectable fs so the edge is testable without touching a real home dir. */
export type SkillStateFs = {
  readFile(filePath: string): Promise<string | null>;
  writeFile(filePath: string, contents: string): Promise<void>;
};

/** One `[[skills.config]]` entry from Codex's config.toml. `path` and `name`
 *  are the two selector forms; Codex rejects entries that carry both. */
export type CodexSkillEntry = {
  path: string | null;
  name: string | null;
  /** Absent in TOML means enabled. */
  enabled: boolean;
};

type JsonKey = { key: string; keyStart: number; valueStart: number; valueEnd: number };
type ScannedObject = { open: number; close: number; keys: JsonKey[] };

const CLAUDE_VALUE = {
  enabled: "on",
  "name-only": "name-only",
  "user-invocable-only": "user-invocable-only",
  disabled: "off",
} satisfies Record<WritableSkillState, string>;

// ── JSONC helpers ───────────────────────────────────────────────────────────

/** Removes line and block comments while leaving strings (and their escapes)
 *  untouched, so a settings file with comments can be parsed. */
function stripJsoncComments(contents: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < contents.length; i++) {
    const ch = contents[i]!;
    if (lineComment) {
      if (ch === "\n") {
        lineComment = false;
        out += ch;
      }
      continue;
    }
    if (blockComment) {
      if (ch === "*" && contents[i + 1] === "/") {
        blockComment = false;
        i += 1;
        out += "  ";
      } else {
        out += ch === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && contents[i + 1] === "/") {
      lineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && contents[i + 1] === "*") {
      blockComment = true;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

// Parses arbitrary JSONC into whatever it held; the caller narrows it to the
// shape it expects. There is no domain type to name at the parse itself.
// eslint-disable-next-line anti-slop/no-unknown-returns
function parseJsonc(contents: string): unknown | null {
  try {
    return JSON.parse(stripJsoncComments(contents).replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return null;
  }
}

/** Walks one JSON object starting at `openIndex` (the `{`), skipping strings,
 *  escapes and comments, and returns the index of its matching `}` plus its
 *  direct keys (exact key text, start of the key token, and the span of the
 *  key's value token ending at the following `,` or `}`). */
function scanJsonObject(contents: string, openIndex: number): ScannedObject | null {
  const keys: JsonKey[] = [];
  let depth = 1;
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let pending: JsonKey | null = null;
  let i = openIndex + 1;
  while (i < contents.length) {
    const ch = contents[i]!;
    if (lineComment) {
      if (ch === "\n") lineComment = false;
      i += 1;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && contents[i + 1] === "/") blockComment = false;
      i += 1;
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      if (depth === 1 && !pending) {
        const tokenStart = i;
        let j = i + 1;
        let esc = false;
        while (j < contents.length) {
          const c = contents[j]!;
          if (esc) esc = false;
          else if (c === "\\") esc = true;
          else if (c === '"') break;
          j += 1;
        }
        if (j < contents.length) {
          let k = j + 1;
          while (k < contents.length && /\s/.test(contents[k]!)) k += 1;
          if (contents[k] === ":") {
            const raw = contents.slice(tokenStart, j + 1);
            try {
              let valueStart = k + 1;
              while (valueStart < contents.length && /\s/.test(contents[valueStart]!)) valueStart += 1;
              pending = { key: JSON.parse(raw) as string, keyStart: tokenStart, valueStart, valueEnd: -1 };
            } catch {
              // not a valid string token — ignore this opening quote
            }
          }
        }
      }
      i += 1;
      continue;
    }
    if (ch === "/" && contents[i + 1] === "/") {
      lineComment = true;
      i += 2;
      continue;
    }
    if (ch === "/" && contents[i + 1] === "*") {
      blockComment = true;
      i += 2;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        if (pending) {
          // A last key's value ends at the closing brace — stop the span
          // before any whitespace so a value replacement never eats it.
          let end = i;
          while (end > pending.valueStart && /\s/.test(contents[end - 1]!)) end -= 1;
          pending.valueEnd = end;
          keys.push(pending);
        }
        return { open: openIndex, close: i, keys };
      }
      i += 1;
      continue;
    }
    if (ch === "," && depth === 1 && pending) {
      pending.valueEnd = i;
      keys.push(pending);
      pending = null;
      i += 1;
      continue;
    }
    i += 1;
  }
  return null;
}

/** The leading whitespace of the line containing `index`. */
function lineIndentBefore(contents: string, index: number): string {
  const lineStart = contents.lastIndexOf("\n", index - 1) + 1;
  return /^\s*/.exec(contents.slice(lineStart, index))?.[0] ?? "";
}

/** Inserts `keyToken: valueToken` as a new entry into a scanned object;
 *  new entries always land at the END so a later rule beats an earlier
 *  wildcard (opencode evaluates rules last-match-wins). The comma attaches to
 *  the previous key's last character and the closing brace keeps its line. */
function insertObjectEntry(contents: string, obj: ScannedObject, keyToken: string, valueToken: string): string {
  if (obj.keys.length === 0) {
    return contents.slice(0, obj.open + 1) + keyToken + ": " + valueToken + contents.slice(obj.open + 1);
  }
  if (contents.slice(obj.open + 1, obj.close).includes("\n")) {
    const lineStart = contents.lastIndexOf("\n", obj.close - 1) + 1;
    const closeLineIndent = contents.slice(lineStart, obj.close);
    const afterLastValue = obj.keys[obj.keys.length - 1]!.valueEnd;
    const insertion = "," + "\n" + closeLineIndent + "  " + keyToken + ": " + valueToken + "\n" + closeLineIndent;
    return contents.slice(0, afterLastValue) + insertion + contents.slice(obj.close);
  }
  const insertion = ", " + keyToken + ": " + valueToken;
  const afterLastValue = obj.keys[obj.keys.length - 1]!.valueEnd;
  return contents.slice(0, afterLastValue) + insertion + contents.slice(afterLastValue);
}

/** Inserts a whole new top-level key before the root object's closing brace;
 *  the comma attaches to the previous key's last character, and every body
 *  line is indented to sit alongside the other top-level keys. */
function insertTopLevelKey(
  contents: string,
  root: ScannedObject,
  body: string,
): string {
  const indent = lineIndentBefore(contents, root.close);
  const pad = indent + "  ";
  const indented = body
    .split("\n")
    .map((line) => pad + line)
    .join("\n");
  if (root.keys.length === 0) {
    const block = "\n" + indented + "\n" + indent;
    return contents.slice(0, root.close) + block + contents.slice(root.close);
  }
  const afterLastValue = root.keys[root.keys.length - 1]!.valueEnd;
  const block = "," + "\n" + indented + "\n" + indent;
  return contents.slice(0, afterLastValue) + block + contents.slice(root.close);
}

// ── Claude Code: skillOverrides ─────────────────────────────────────────────

/** The `skillOverrides` object from a Claude settings file (any of the scopes
 *  that honor it), as a name → raw-value map. Non-string values are dropped;
 *  a missing key is the same as no overrides. */
export function readClaudeOverrides(contents: string): Record<string, string> {
  const parsed = parseJsonc(contents);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const raw = (parsed as Record<string, unknown>).skillOverrides;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const overrides: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") overrides[name] = value;
  }
  return overrides;
}

/** Effective state from an overrides map, mirroring how Claude Code itself
 *  resolves a skill: absent key means "on", an unrecognized value behaves as
 *  enabled, and the skill's own `disable-model-invocation: true` frontmatter
 *  forces user-invocable-only unless the override is "off". */
export function deriveClaudeSkillState(
  overrides: Record<string, string>,
  skillName: string,
  disableModelInvocation: boolean,
): SkillState {
  const raw = overrides[skillName] ?? "on";
  const state: SkillState =
    raw === "off"
      ? "disabled"
      : raw === "name-only"
        ? "name-only"
        : raw === "user-invocable-only"
          ? "user-invocable-only"
          : "enabled";
  if (disableModelInvocation) return state === "disabled" ? "disabled" : "user-invocable-only";
  return state;
}

/** Surgically sets one skill's skillOverrides value. When the key is absent a
 *  fresh `"skillOverrides"` block is added at the end of the root object; when
 *  the key exists its value token alone is replaced. Returns the input
 *  unchanged when the file is not a parseable JSON object or the key is not an
 *  object — callers re-verify and report rather than guessing. */
export function applyClaudeOverride(contents: string, skillName: string, state: WritableSkillState): string {
  if (parseJsonc(contents) === null) return contents;
  const keyToken = JSON.stringify(skillName);
  const valueToken = JSON.stringify(CLAUDE_VALUE[state]);

  const rootOpen = contents.indexOf("{");
  if (rootOpen < 0) return contents;
  const root = scanJsonObject(contents, rootOpen);
  if (!root) return contents;

  const overrideKey = root.keys.find((key) => key.key === "skillOverrides");
  if (overrideKey) {
    let open = overrideKey.valueStart;
    while (open < overrideKey.valueEnd && /\s/.test(contents[open]!)) open += 1;
    if (contents[open] !== "{") return contents;
    const obj = scanJsonObject(contents, open);
    if (!obj) return contents;
    const existing = obj.keys.find((key) => key.key === skillName);
    if (existing) {
      return contents.slice(0, existing.valueStart) + valueToken + contents.slice(existing.valueEnd);
    }
    return insertObjectEntry(contents, obj, keyToken, valueToken);
  }

  const body = '"skillOverrides": {\n  ' + keyToken + ": " + valueToken + "\n}";
  return insertTopLevelKey(contents, root, body);
}

// ── Codex: [[skills.config]] ────────────────────────────────────────────────

/** Parses a TOML string token: double-quoted basic string (escapes honored
 *  for `\"` and `\\`), single-quoted literal, or bare text. */
function parseTomlStringValue(token: string): string {
  const trimmed = token.trim();
  if (trimmed.startsWith('"')) {
    const end = trimmed.lastIndexOf('"');
    if (end > 0) return trimmed.slice(1, end).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (trimmed.startsWith("'")) {
    const end = trimmed.lastIndexOf("'");
    if (end > 0) return trimmed.slice(1, end);
  }
  return trimmed;
}

/** The value of a `key = value` TOML line, with a trailing `#` comment
 *  stripped only when it is outside a quoted string. */
function tomlValue(line: string): string | null {
  const eq = line.indexOf("=");
  if (eq < 0) return null;
  let value = line.slice(eq + 1);
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#") {
      value = value.slice(0, i);
      break;
    }
  }
  return parseTomlStringValue(value);
}

function tomlQuote(value: string): string {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/** All `[[skills.config]]` entries in a Codex config.toml, in file order;
 *  entries in other table sections are skipped, and an entry without an
 *  `enabled` line reads as enabled. */
export function readCodexSkillConfig(contents: string): CodexSkillEntry[] {
  const entries: CodexSkillEntry[] = [];
  let current: CodexSkillEntry | null = null;
  for (const rawLine of contents.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed === "[[skills.config]]") {
      current = { path: null, name: null, enabled: true };
      entries.push(current);
      continue;
    }
    if (trimmed.startsWith("[[") || trimmed.startsWith("[")) {
      current = null;
      continue;
    }
    if (!current) continue;
    if (trimmed.startsWith("path")) {
      const value = tomlValue(trimmed);
      if (value !== null) current.path = value;
    } else if (trimmed.startsWith("name")) {
      const value = tomlValue(trimmed);
      if (value !== null) current.name = value;
    } else if (trimmed.startsWith("enabled")) {
      current.enabled = (tomlValue(trimmed) ?? "").trim() === "true";
    }
  }
  return entries;
}

/** Effective Codex state: the LAST entry selecting the skill (by SKILL.md
 *  path or by name) wins; an entry carrying both selectors is one Codex
 *  ignores, so it never counts. Absence means enabled. */
export function resolveCodexSkillState(
  entries: readonly CodexSkillEntry[],
  skillMdPath: string,
  skillName: string,
): SkillState {
  let found: CodexSkillEntry | null = null;
  for (const entry of entries) {
    if (entry.path !== null && entry.name !== null) continue;
    if ((entry.path !== null && entry.path === skillMdPath) || (entry.name !== null && entry.name === skillName)) {
      found = entry;
    }
  }
  return found && !found.enabled ? "disabled" : "enabled";
}

/** Surgically sets (or clears) the `enabled` line of the `[[skills.config]]`
 *  entry selecting `skillMdPath`, or appends a fresh top-level block when
 *  disabling a skill that has no entry yet. New blocks are inserted before the
 *  first table header so they can never nest under another section. Returns
 *  the input unchanged when there was nothing to change (an absent entry
 *  already means enabled). */
export function applyCodexSkillConfig(contents: string, skillMdPath: string, enabled: boolean): string {
  const lines = contents.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() !== "[[skills.config]]") continue;
    let pathLine = -1;
    let enabledLine = -1;
    let j = i + 1;
    while (j < lines.length && !lines[j]!.trim().startsWith("[")) {
      const trimmed = lines[j]!.trim();
      if (trimmed.startsWith("path")) pathLine = j;
      else if (trimmed.startsWith("enabled")) enabledLine = j;
      j += 1;
    }
    if (pathLine >= 0) {
      const value = tomlValue(lines[pathLine]!);
      if (value !== null && value === skillMdPath) {
        if (enabledLine >= 0) {
          const next = lines.slice();
          next[enabledLine] = lines[enabledLine]!.replace(/(enabled\s*=\s*)(true|false)/, `$1${enabled ? "true" : "false"}`);
          return next.join("\n");
        }
        const next = lines.slice();
        next.splice(pathLine + 1, 0, `enabled = ${enabled ? "true" : "false"}`);
        return next.join("\n");
      }
    }
    i = j - 1;
  }

  if (enabled) return contents;

  const block = `[[skills.config]]\npath = ${tomlQuote(skillMdPath)}\nenabled = false`;
  let insertAt = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim().startsWith("[")) {
      insertAt = i;
      break;
    }
  }
  // A blank line keeps the block separated from whatever section follows.
  const padded = insertAt < lines.length ? block + "\n" : block;
  const next = [...lines.slice(0, insertAt), padded, ...lines.slice(insertAt)];
  return next.join("\n");
}

// ── opencode: permission.skill ──────────────────────────────────────────────

/** The `permission.skill` pattern → action map from an opencode config file.
 *  The shorthand `"permission": { "skill": "deny" }` reads as the wildcard
 *  pattern `*`. */
export function readOpenCodePermission(contents: string): Record<string, string> {
  const parsed = parseJsonc(contents);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const permission = (parsed as Record<string, unknown>).permission;
  if (!permission || typeof permission !== "object" || Array.isArray(permission)) return {};
  const skill = (permission as Record<string, unknown>).skill;
  if (typeof skill === "string") return { "*": skill };
  if (!skill || typeof skill !== "object" || Array.isArray(skill)) return {};
  const patterns: Record<string, string> = {};
  for (const [pattern, action] of Object.entries(skill as Record<string, unknown>)) {
    if (typeof action === "string") patterns[pattern] = action;
  }
  return patterns;
}

/** opencode's pattern matching: `*` matches any run, `?` matches one
 *  character, everything else is literal, and the match is anchored. */
export function matchOpenCodePattern(pattern: string, name: string): boolean {
  let regex = "";
  for (const ch of pattern) {
    if (ch === "*") regex += ".*";
    else if (ch === "?") regex += ".";
    else regex += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${regex}$`, "s").test(name);
}

/** One skill name's opencode verdict: the state it resolves to plus the
 *  pattern and action that decided it (both null when nothing matched). */
export type ResolvedSkillState = {
  state: SkillState;
  pattern: string | null;
  action: string | null;
};

/** Effective opencode state for one skill name: the LAST matching pattern in
 *  file order decides (opencode evaluates rules last-match-wins); `deny`
 *  hides the skill from the agent, anything else leaves it reachable. */
export function resolveOpenCodeSkillState(
  patterns: Record<string, string>,
  skillName: string,
): ResolvedSkillState {
  let matched: { pattern: string; action: string } | null = null;
  for (const [pattern, action] of Object.entries(patterns)) {
    if (matchOpenCodePattern(pattern, skillName)) matched = { pattern, action };
  }
  if (!matched) return { state: "enabled", pattern: null, action: null };
  if (matched.action === "deny") return { state: "disabled", pattern: matched.pattern, action: "deny" };
  return { state: "enabled", pattern: matched.pattern, action: matched.action };
}

/** Surgically adds (`"deny"`) or removes (`"remove"`) the exact-name entry for
 *  one skill in the `permission.skill` map. New deny entries always land at
 *  the END of the map so they beat earlier wildcards; the shorthand
 *  `"skill": "deny"` is converted to `{ "*": "deny", "<name>": "deny" }`
 *  rather than overwritten. Returns the input unchanged whenever nothing can
 *  (or needs to) change. */
export function applyOpenCodePermission(contents: string, skillName: string, action: "deny" | "remove"): string {
  if (parseJsonc(contents) === null) return contents;
  const keyToken = JSON.stringify(skillName);
  const rootOpen = contents.indexOf("{");
  if (rootOpen < 0) return contents;
  const root = scanJsonObject(contents, rootOpen);
  if (!root) return contents;

  const permissionKey = root.keys.find((key) => key.key === "permission");
  if (!permissionKey) {
    if (action === "remove") return contents;
    return insertTopLevelKey(
      contents,
      root,
      '"permission": {\n  "skill": {\n    ' + keyToken + ': "deny"\n  }\n}',
    );
  }

  let permOpen = permissionKey.valueStart;
  while (permOpen < permissionKey.valueEnd && /\s/.test(contents[permOpen]!)) permOpen += 1;
  if (contents[permOpen] !== "{") return contents;
  const permission = scanJsonObject(contents, permOpen);
  if (!permission) return contents;

  const skillKey = permission.keys.find((key) => key.key === "skill");
  if (!skillKey) {
    if (action === "remove") return contents;
    return insertObjectEntry(contents, permission, '"skill"', '{\n    ' + keyToken + ': "deny"\n  }');
  }

  const skillValue = contents.slice(skillKey.valueStart, skillKey.valueEnd).trim();
  if (skillValue.startsWith("{")) {
    let skillOpen = skillKey.valueStart;
    while (skillOpen < skillKey.valueEnd && /\s/.test(contents[skillOpen]!)) skillOpen += 1;
    const map = scanJsonObject(contents, skillOpen);
    if (!map) return contents;
    const existing = map.keys.find((key) => key.key === skillName);
    if (action === "remove") {
      if (!existing) return contents;
      let from = existing.keyStart;
      let to = existing.valueEnd;
      let next = existing.valueEnd;
      while (next < contents.length && /\s/.test(contents[next]!)) next += 1;
      if (contents[next] === ",") {
        to = next + 1;
        while (to < contents.length && /\s/.test(contents[to]!)) to += 1;
      } else {
        let prev = existing.keyStart - 1;
        while (prev >= 0 && /\s/.test(contents[prev]!)) prev -= 1;
        if (contents[prev] === ",") from = prev;
        else from = contents.lastIndexOf("\n", existing.keyStart - 1) + 1;
      }
      return contents.slice(0, from) + contents.slice(to);
    }
    if (existing) {
      return contents.slice(0, existing.valueStart) + '"deny"' + contents.slice(existing.valueEnd);
    }
    return insertObjectEntry(contents, map, keyToken, '"deny"');
  }

  if (skillValue.startsWith('"')) {
    if (action === "remove") return contents;
    let old: string;
    try {
      old = JSON.parse(skillValue) as string;
    } catch {
      return contents;
    }
    const replacement = '{ "*": ' + JSON.stringify(old) + ', ' + keyToken + ': "deny" }';
    return contents.slice(0, skillKey.valueStart) + replacement + contents.slice(skillKey.valueEnd);
  }

  return contents;
}

// ── The fs edge ─────────────────────────────────────────────────────────────

const defaultFs: SkillStateFs = {
  async readFile(filePath) {
    try {
      return await fsReadFile(filePath, "utf8");
    } catch {
      return null;
    }
  },
  async writeFile(filePath, contents) {
    await fsWriteFile(filePath, contents, "utf8");
  },
};

/** Inputs shared by the edge functions. `scope` is the skill's inventory
 *  scope; `frontmatter` is the skill's parsed SKILL.md frontmatter (read from
 *  `skillPath` when not provided) so `disable-model-invocation: true` is
 *  honored. */
export type SkillStateContext = {
  origin: string;
  skillName: string;
  /** Absolute SKILL.md path — Codex's config selects skills by this path. */
  skillPath?: string;
  scope?: SkillEntry["scope"];
  /** The pane's project path, for project-scope settings files. */
  projectPath?: string | null;
  frontmatter?: Record<string, string> | null;
  home?: string;
  fs?: SkillStateFs;
};

/** The part of a context that can cross a process boundary. `home` and `fs`
 *  are seams for tests, so a caller on the far side of IPC must not be able to
 *  set them — that would let it point a settings write at another directory. */
export type SkillStateQuery = Omit<SkillStateContext, "home" | "fs">;

type ResolvedContext = Required<Pick<SkillStateContext, "home" | "fs">> &
  Omit<SkillStateContext, "home" | "fs">;

function tilde(filePath: string, home: string): string {
  if (filePath.startsWith(home)) return "~" + filePath.slice(home.length);
  return filePath;
}

function modelInvocationFlag(frontmatter: Record<string, string> | null | undefined): boolean {
  const raw = frontmatter?.["disable-model-invocation"] ?? frontmatter?.["disableModelInvocation"];
  return raw?.trim().toLowerCase() === "true";
}

async function claudeContextFrontmatter(ctx: ResolvedContext): Promise<Record<string, string>> {
  if (ctx.frontmatter) return ctx.frontmatter;
  if (!ctx.skillPath) return {};
  const raw = await ctx.fs.readFile(ctx.skillPath);
  if (raw === null) return {};
  return parseFrontmatter(raw);
}

async function readClaudeState(ctx: ResolvedContext): Promise<SkillStateResult> {
  if (ctx.scope === "plugin") {
    return {
      state: "unsupported",
      reason: "Plugin-provided skills are owned by the plugin, so Claude Code's skillOverrides setting does not apply to them.",
      source: null,
    };
  }
  if (ctx.scope === "system") {
    return {
      state: "unsupported",
      reason: "Bundled skills are managed by Claude Code itself, not by skillOverrides, so there is no per-skill switch to read.",
      source: null,
    };
  }

  const files: Array<{ filePath: string; label: string }> = [
    { filePath: path.join(ctx.home, ".claude", "settings.json"), label: "Claude user settings" },
  ];
  if (ctx.projectPath) {
    files.push(
      { filePath: path.join(ctx.projectPath, ".claude", "settings.json"), label: "Claude project settings" },
      { filePath: path.join(ctx.projectPath, ".claude", "settings.local.json"), label: "Claude local project settings" },
    );
  }

  // Layer order matches the CLI's own: user < project < local, later wins.
  const merged: Record<string, string> = {};
  const governing = new Map<string, { filePath: string; label: string }>();
  let broken: { filePath: string; label: string } | null = null;
  for (const file of files) {
    const contents = await ctx.fs.readFile(file.filePath);
    if (contents === null) continue;
    if (parseJsonc(contents) === null) {
      broken ??= file;
      continue;
    }
    for (const [name, value] of Object.entries(readClaudeOverrides(contents))) {
      merged[name] = value;
      governing.set(name, file);
    }
  }

  const flag = await claudeContextFrontmatter(ctx);
  const disableModelInvocation = modelInvocationFlag(flag);
  const state = deriveClaudeSkillState(merged, ctx.skillName, disableModelInvocation);
  const file = governing.get(ctx.skillName);
  const fileSentence = (target: { filePath: string; label: string }): string =>
    `${target.label} (${tilde(target.filePath, ctx.home)}).`;

  if (state === "disabled" && file) {
    return {
      state,
      reason: `The skillOverrides entry in ${tilde(file.filePath, ctx.home)} is "off", so the agent will not use this skill at all.`,
      source: fileSentence(file),
    };
  }
  if (state === "name-only" && file) {
    return {
      state,
      reason: `The skillOverrides entry in ${tilde(file.filePath, ctx.home)} is "name-only", so the agent knows the skill exists but will not load it unasked.`,
      source: fileSentence(file),
    };
  }
  if (state === "user-invocable-only") {
    if (disableModelInvocation && ctx.skillPath) {
      return {
        state,
        reason: "The skill's own SKILL.md sets disable-model-invocation: true, so it only runs when you ask for it by name.",
        source: `The skill's own frontmatter (${tilde(ctx.skillPath, ctx.home)}).`,
      };
    }
    if (file) {
      return {
        state,
        reason: `The skillOverrides entry in ${tilde(file.filePath, ctx.home)} is "user-invocable-only", so it only runs when you ask for it by name.`,
        source: fileSentence(file),
      };
    }
  }
  if (state === "enabled" && file) {
    const raw = merged[ctx.skillName];
    const known = raw === "on" || raw === "off" || raw === "name-only" || raw === "user-invocable-only";
    return {
      state,
      reason: known
        ? `The skillOverrides entry in ${tilde(file.filePath, ctx.home)} is "${raw}", so the agent reaches for it on its own.`
        : `The skillOverrides entry in ${tilde(file.filePath, ctx.home)} has the value "${raw}", which Claude Code reads as enabled.`,
      source: fileSentence(file),
    };
  }
  if (broken) {
    return {
      state: "enabled",
      reason: `${broken.label} (${tilde(broken.filePath, ctx.home)}) could not be parsed as JSON, so no skillOverrides could be read from it.`,
      source: fileSentence(broken),
    };
  }
  return { state: "enabled", reason: null, source: null };
}

async function readCodexState(ctx: ResolvedContext): Promise<SkillStateResult> {
  const target = path.join(ctx.home, ".codex", "config.toml");
  const contents = await ctx.fs.readFile(target);
  if (contents === null) return { state: "enabled", reason: null, source: null };
  const state = resolveCodexSkillState(readCodexSkillConfig(contents), ctx.skillPath ?? "", ctx.skillName);
  if (state === "disabled") {
    return {
      state,
      reason: `A [[skills.config]] entry in ${tilde(target, ctx.home)} sets enabled = false for this skill, so Codex will not load it.`,
      source: `Codex user config (${tilde(target, ctx.home)}).`,
    };
  }
  return { state: "enabled", reason: null, source: null };
}

async function readOpenCodeState(ctx: ResolvedContext): Promise<SkillStateResult> {
  const files: string[] = [
    path.join(ctx.home, ".config", "opencode", "opencode.json"),
    path.join(ctx.home, ".config", "opencode", "opencode.jsonc"),
  ];
  if (ctx.projectPath) {
    files.push(
      path.join(ctx.projectPath, ".opencode", "opencode.json"),
      path.join(ctx.projectPath, ".opencode", "opencode.jsonc"),
    );
  }
  let matched: { filePath: string; pattern: string; action: string } | null = null;
  for (const filePath of files) {
    const contents = await ctx.fs.readFile(filePath);
    if (contents === null) continue;
    const local = resolveOpenCodeSkillState(readOpenCodePermission(contents), ctx.skillName);
    if (local.pattern !== null) matched = { filePath, pattern: local.pattern, action: local.action ?? "ask" };
  }
  if (matched && matched.action === "deny") {
    return {
      state: "disabled",
      reason: `opencode's permission map in ${tilde(matched.filePath, ctx.home)} denies this skill (pattern "${matched.pattern}"), so the agent cannot reach it.`,
      source: `opencode config (${tilde(matched.filePath, ctx.home)}).`,
    };
  }
  return { state: "enabled", reason: null, source: null };
}

/** Reads the effective state of one skill for the origin it lives under.
 *  Reads never throw: a missing config file is simply "no restriction". */
export async function readSkillState(context: SkillStateContext): Promise<SkillStateResult> {
  const ctx: ResolvedContext = { ...context, home: context.home ?? homedir(), fs: context.fs ?? defaultFs };
  switch (context.origin) {
    case "claude":
      return readClaudeState(ctx);
    case "codex":
      return readCodexState(ctx);
    case "opencode":
      return readOpenCodeState(ctx);
    case "cursor":
      return { state: "unsupported", reason: "Cursor has no per-skill switch, so there is nothing to read for this skill.", source: null };
    case "factory":
      return { state: "unsupported", reason: "Factory has no per-skill switch, so there is nothing to read for this skill.", source: null };
    case "agents":
      return {
        state: "unsupported",
        reason: "This skill lives in the shared .agents root; each CLI reads it from its own config, so there is no single per-skill switch to read.",
        source: null,
      };
    default:
      return {
        state: "unsupported",
        reason: `kone does not know a switch for the "${context.origin}" origin, so there is nothing to read.`,
        source: null,
      };
  }
}

async function writeClaudeState(ctx: ResolvedContext, state: WritableSkillState): Promise<StateWriteResult> {
  if (ctx.scope === "plugin") {
    return { ok: false, wrotePath: null, reason: "Plugin-provided skills are owned by the plugin, so skillOverrides does not apply — nothing was written." };
  }
  if (ctx.scope === "system") {
    return { ok: false, wrotePath: null, reason: "Bundled skills are managed by Claude Code itself; there is no skillOverrides entry kone can write." };
  }
  let target: string;
  let label: string;
  if (ctx.scope === "project") {
    if (!ctx.projectPath) {
      return { ok: false, wrotePath: null, reason: "No project is open, so there is no .claude/settings.local.json to write." };
    }
    target = path.join(ctx.projectPath, ".claude", "settings.local.json");
    label = "Claude local project settings";
  } else {
    target = path.join(ctx.home, ".claude", "settings.json");
    label = "Claude user settings";
  }
  const desired = CLAUDE_VALUE[state];
  const existing = await ctx.fs.readFile(target);
  if (existing === null && state === "enabled") {
    return { ok: true, wrotePath: null, reason: "No settings file exists, and an absent override already means the skill is enabled; nothing was written." };
  }
  const contents = existing ?? "{}";
  const applied = applyClaudeOverride(contents, ctx.skillName, state);
  if (applied === contents) {
    if (readClaudeOverrides(applied)[ctx.skillName] === desired) {
      return {
        ok: true,
        wrotePath: null,
        reason: `The skillOverrides entry in ${tilde(target, ctx.home)} is already "${desired}"; nothing was written.`,
      };
    }
    return {
      ok: false,
      wrotePath: null,
      reason: `Could not apply the "${desired}" override to ${label} (${tilde(target, ctx.home)}); the file did not parse as expected.`,
    };
  }
  await ctx.fs.writeFile(target, applied);
  const after = await ctx.fs.readFile(target);
  if (after === null || readClaudeOverrides(after)[ctx.skillName] !== desired) {
    return { ok: false, wrotePath: target, reason: `Wrote ${tilde(target, ctx.home)} but the override did not take effect; the file may have changed in between.` };
  }
  return {
    ok: true,
    wrotePath: target,
    reason: `Wrote the "${desired}" override for "${ctx.skillName}" to ${label} (${tilde(target, ctx.home)}).`,
  };
}

async function writeCodexState(ctx: ResolvedContext, state: WritableSkillState): Promise<StateWriteResult> {
  if (state !== "enabled" && state !== "disabled") {
    return { ok: false, wrotePath: null, reason: "Codex's per-skill switch is a boolean — it only knows enabled and disabled, so nothing was written." };
  }
  if (!ctx.skillPath) {
    return { ok: false, wrotePath: null, reason: "The skill's SKILL.md path is needed to address Codex's [[skills.config]] entry; nothing was written." };
  }
  const target = path.join(ctx.home, ".codex", "config.toml");
  const desired = state === "disabled";
  const existing = await ctx.fs.readFile(target);
  const contents = existing ?? "";
  const applied = applyCodexSkillConfig(contents, ctx.skillPath, !desired);
  if (applied === contents) {
    if (resolveCodexSkillState(readCodexSkillConfig(applied), ctx.skillPath, ctx.skillName) === state) {
      return {
        ok: true,
        wrotePath: null,
        reason: `The [[skills.config]] entry for this skill in ${tilde(target, ctx.home)} already sets enabled = ${desired ? "false" : "true"}; nothing was written.`,
      };
    }
    return { ok: false, wrotePath: null, reason: `Could not edit the [[skills.config]] entry in ${tilde(target, ctx.home)}.` };
  }
  await ctx.fs.writeFile(target, applied);
  const after = await ctx.fs.readFile(target);
  const afterState = after === null ? "enabled" : resolveCodexSkillState(readCodexSkillConfig(after), ctx.skillPath, ctx.skillName);
  if (afterState !== state) {
    return { ok: false, wrotePath: target, reason: `Wrote ${tilde(target, ctx.home)} but the entry did not take effect.` };
  }
  return {
    ok: true,
    wrotePath: target,
    reason: `Wrote a [[skills.config]] entry with enabled = ${desired ? "false" : "true"} for ${tilde(ctx.skillPath, ctx.home)} in ${tilde(target, ctx.home)}.`,
  };
}

async function writeOpenCodeState(ctx: ResolvedContext, state: WritableSkillState): Promise<StateWriteResult> {
  if (state !== "enabled" && state !== "disabled") {
    return { ok: false, wrotePath: null, reason: "opencode's permission map only distinguishes denied from not denied; there is no between state to write." };
  }
  const candidates = [
    path.join(ctx.home, ".config", "opencode", "opencode.json"),
    path.join(ctx.home, ".config", "opencode", "opencode.jsonc"),
  ];
  let target = candidates[0]!;
  for (const candidate of candidates) {
    if ((await ctx.fs.readFile(candidate)) !== null) {
      target = candidate;
      break;
    }
  }
  const action = state === "disabled" ? "deny" : "remove";
  const existing = await ctx.fs.readFile(target);
  const contents = existing ?? "{}";
  const applied = applyOpenCodePermission(contents, ctx.skillName, action);
  const appliedResolved = resolveOpenCodeSkillState(readOpenCodePermission(applied), ctx.skillName);
  if (applied === contents) {
    if (appliedResolved.state === state) {
      return {
        ok: true,
        wrotePath: null,
        reason: `opencode is already ${state === "disabled" ? "disabled" : "enabled"} for this skill in ${tilde(target, ctx.home)}; nothing was written.`,
      };
    }
    if (state === "enabled" && appliedResolved.pattern !== null) {
      return {
        ok: false,
        wrotePath: null,
        reason: `This skill is denied by the "${appliedResolved.pattern}" wildcard in ${tilde(target, ctx.home)}; remove that wildcard to enable it.`,
      };
    }
    return { ok: false, wrotePath: null, reason: `Could not edit the permission map in ${tilde(target, ctx.home)}; the file did not parse as expected.` };
  }
  await ctx.fs.writeFile(target, applied);
  const after = await ctx.fs.readFile(target);
  const afterResolved = after === null ? resolveOpenCodeSkillState({}, ctx.skillName) : resolveOpenCodeSkillState(readOpenCodePermission(after), ctx.skillName);
  if (afterResolved.state !== state) {
    return { ok: false, wrotePath: target, reason: `Wrote ${tilde(target, ctx.home)} but the entry did not take effect.` };
  }
  return {
    ok: true,
    wrotePath: target,
    reason:
      state === "disabled"
        ? `Wrote a "deny" entry for "${ctx.skillName}" into the permission.skill map in ${tilde(target, ctx.home)}.`
        : `Removed the "deny" entry for "${ctx.skillName}" from the permission.skill map in ${tilde(target, ctx.home)}.`,
  };
}

/** Writes the requested state for one skill into the owning CLI's config,
 *  surgically, then re-reads the file to confirm the change took. Returns
 *  `ok: false` with a finished reason whenever the origin has no mechanism
 *  for the requested state (never a silent no-op that pretends success). */
export async function writeSkillState(
  context: SkillStateContext & { state: WritableSkillState },
): Promise<StateWriteResult> {
  const ctx: ResolvedContext = { ...context, home: context.home ?? homedir(), fs: context.fs ?? defaultFs };
  switch (context.origin) {
    case "claude":
      return writeClaudeState(ctx, context.state);
    case "codex":
      return writeCodexState(ctx, context.state);
    case "opencode":
      return writeOpenCodeState(ctx, context.state);
    case "cursor":
      return {
        ok: false,
        wrotePath: null,
        reason: "Cursor has no per-skill switch; the honest way to stop a Cursor skill is to move it out of the skills folder, so nothing was written.",
      };
    case "factory":
      return {
        ok: false,
        wrotePath: null,
        reason: "Factory has no per-skill switch; the honest way to stop a Factory skill is to move it out of the skills folder, so nothing was written.",
      };
    case "agents":
      return {
        ok: false,
        wrotePath: null,
        reason: "This skill lives in the shared .agents root, where no single config toggle exists; disable it in the CLI that reads it instead.",
      };
    default:
      return {
        ok: false,
        wrotePath: null,
        reason: `kone does not know a switch for the "${context.origin}" origin, so nothing was written.`,
      };
  }
}
