// FILE: skillMutate.ts
// Purpose: the write capabilities behind the Skills pane's manager phase.
// editSkillFrontmatter applies surgical line edits to a SKILL.md, and
// deleteSkillToTrash moves a skill folder to the system Trash. Every function
// reports what it did to which path. All writes share the same gates:
// validate before touching disk, never unlink user data, never touch a
// plugin-owned skill. The frontmatter line-editing logic
// (applyFrontmatterEdits) is pure and unit-testable; fs sits at the edge of
// the exported actions.
// Exports: MutateResult, FrontmatterEdit, FrontmatterEditResult,
// applyFrontmatterEdits, validateSkillName, validateSkillDescription,
// editSkillFrontmatter, deleteSkillToTrash

import { access, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { userDataPath } from "../userDataDir.js";

import { parseFrontmatter } from "./frontmatter.js";
import { MAX_FILE_BYTES } from "./skills.js";

/** What every mutation reports back: what it did, to which path, in one
 *  finished sentence. `ok: false` means nothing was changed. */
export type MutateResult = {
  ok: boolean;
  action: string;
  /** The path the action targeted — the SKILL.md for edits, the skill folder
   *  for delete/install — or null when the action never reached a path. */
  path: string | null;
  /** One finished sentence describing what happened. */
  detail: string;
};

/** One surgical frontmatter edit: set replaces the key's line (and its
 *  indented subtree, if any) with a single flat line; delete removes them. */
export type FrontmatterEdit =
  | { op: "set"; key: string; value: string }
  | { op: "delete"; key: string };

export type FrontmatterEditResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const NAME_MAX_CHARS = 64;
const DESCRIPTION_MAX_CHARS = 1024;
const FRONTMATTER_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Returns an error sentence for an invalid skill name, or null when valid.
 *  The name must be lowercase letters, numbers, and hyphens (the folder name
 *  is the command name, and scanners key on it case-sensitively). */
export function validateSkillName(name: string): string | null {
  if (!NAME_PATTERN.test(name)) {
    return "The name must be lowercase letters, numbers, and hyphens, like review-code.";
  }
  if (name.length > NAME_MAX_CHARS) {
    return `The name must be ${NAME_MAX_CHARS} characters or fewer.`;
  }
  return null;
}

/** Returns an error sentence for an invalid description, or null when valid.
 *  A description is not optional for every CLI (two refuse to load a skill
 *  without one), so kone always writes one and refuses to edit one away. */
export function validateSkillDescription(description: string): string | null {
  const trimmed = description?.trim() ?? "";
  if (!trimmed) {
    return "A description is required — two of the four CLIs refuse to load a skill without one.";
  }
  if (/[\r\n]/.test(trimmed)) {
    return "The description must be a single line.";
  }
  if (trimmed.length > DESCRIPTION_MAX_CHARS) {
    return `The description must be ${DESCRIPTION_MAX_CHARS} characters or fewer.`;
  }
  return null;
}

/** ── Pure frontmatter line editing ──────────────────────────────────────── */

function eolOf(raw: string): string {
  return raw.includes("\r\n") ? "\r\n" : "\n";
}

function keyLinePattern(key: string): RegExp {
  // key is validated against [A-Za-z0-9_-], so no regex escaping is needed.
  return new RegExp(`^${key}\\s*:`);
}

function indentedKeyPattern(key: string): RegExp {
  return new RegExp(`^\\s+${key}\\s*:`);
}

/** The line indexes of the frontmatter block: the opening `---` delimiter at
 *  `open`, the first content line, and the closing `---` at `close`. Returns
 *  "none" when the file has no block and "unclosed" when it starts with `---`
 *  but never closes it. */
function frontmatterBounds(lines: string[]): { contentStart: number; close: number } | "none" | "unclosed" {
  if (lines.length === 0 || lines[0]!.trim() !== "---") return "none";
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") return { contentStart: 1, close: i };
  }
  return "unclosed";
}

function findKeyLine(lines: string[], key: string, from: number, to: number): number {
  const pattern = keyLinePattern(key);
  for (let i = from; i < to; i++) {
    if (pattern.test(lines[i]!)) return i;
  }
  return -1;
}

function hasIndentedKey(lines: string[], key: string, from: number, to: number): boolean {
  const pattern = indentedKeyPattern(key);
  for (let i = from; i < to; i++) {
    if (pattern.test(lines[i]!)) return true;
  }
  return false;
}

/** Index one past a key line's value. Blank and indented lines right after
 *  the key belong to its value (a nested map, a block scalar); a blank line
 *  with no indented line following is field spacing and stays untouched.
 *  Returns the key line + 1 when the key has no continuation lines. */
function valueEnd(lines: string[], keyLine: number, close: number): number {
  let end = keyLine + 1;
  let sawIndented = false;
  while (end < close) {
    const line = lines[end]!;
    if (line.trim() === "") {
      end += 1;
      continue;
    }
    if (line.startsWith(" ") || line.startsWith("\t")) {
      sawIndented = true;
      end += 1;
      continue;
    }
    break;
  }
  return sawIndented ? end : keyLine + 1;
}

/** Applies surgical line edits to a SKILL.md's frontmatter. Only the edited
 *  key's own line(s) change — everything else in the file is preserved
 *  byte-for-byte, including comments, quoted values, nested maps, and line
 *  endings. A file with no frontmatter gets a block prepended. */
export function applyFrontmatterEdits(raw: string, edits: FrontmatterEdit[]): FrontmatterEditResult {
  for (const edit of edits) {
    if (!FRONTMATTER_KEY_PATTERN.test(edit.key)) {
      return { ok: false, error: `"${edit.key}" is not a usable frontmatter key.` };
    }
    if (edit.op === "set" && /[\r\n]/.test(edit.value)) {
      return { ok: false, error: `The value for "${edit.key}" must be a single line.` };
    }
  }

  const eol = eolOf(raw);
  const lines = raw.split(/\r?\n/);

  const bounds = frontmatterBounds(lines);
  if (bounds === "unclosed") {
    return { ok: false, error: "The frontmatter has an opening --- with no closing ---; fix the file before editing it." };
  }

  // A frontmatter-less file gets a synthetic block at the top; everything
  // original becomes body, byte-for-byte.
  const missing = bounds === "none";
  if (missing) lines.unshift("---");
  const contentStart = missing ? 1 : bounds.contentStart;
  // The synthetic closing delimiter sits right after the opening one; each
  // inserted key pushes it one line further down.
  let close = missing ? 1 : bounds.close;

  for (const edit of edits) {
    if (edit.op === "set") {
      const at = findKeyLine(lines, edit.key, contentStart, close);
      if (at !== -1) {
        const end = valueEnd(lines, at, close);
        const prefix = lines[at]!.slice(0, lines[at]!.indexOf(":"));
        lines.splice(at, end - at, `${prefix}:${edit.value ? ` ${edit.value}` : ""}`);
      } else {
        if (hasIndentedKey(lines, edit.key, contentStart, close)) {
          return {
            ok: false,
            error: `"${edit.key}" exists only as a nested field — rewriting it would flatten the map it lives in; use a text editor for that.`,
          };
        }
        lines.splice(close, 0, `${edit.key}:${edit.value ? ` ${edit.value}` : ""}`);
        close += 1;
      }
    } else {
      const at = findKeyLine(lines, edit.key, contentStart, close);
      if (at !== -1) {
        const end = valueEnd(lines, at, close);
        lines.splice(at, end - at);
        close -= end - at;
      } else if (hasIndentedKey(lines, edit.key, contentStart, close)) {
        return {
          ok: false,
          error: `"${edit.key}" exists only as a nested field — deleting it would flatten the map it lives in; use a text editor for that.`,
        };
      }
    }
  }

  if (missing) lines.splice(close, 0, "---");
  return { ok: true, text: lines.join(eol) };
}

/** ── Shared guards ──────────────────────────────────────────────────────── */

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** Whether a path sits inside a CLI's plugin install area — a segment named
 *  "plugins" under a hidden config root (e.g. ~/.claude/plugins/...). The
 *  plugin owns those files: edits are clobbered on update and a delete leaves
 *  a manifest expecting the folder, so both are refused here; the plugin's
 *  own install/uninstall commands are the only honest path. */
function isPluginOwnedPath(p: string): boolean {
  const segments = p.split(path.sep);
  for (let i = 1; i < segments.length; i++) {
    if (segments[i] === "plugins" && segments[i - 1]!.startsWith(".")) return true;
  }
  return false;
}

/** The system Trash on macOS; elsewhere a kone-owned trash folder under the
 *  per-user state directory, which sits outside every scanned skills root. */
function defaultTrashRoot(): string {
  if (process.platform === "darwin") return path.join(homedir(), ".Trash");
  try {
    return userDataPath("trash");
  } catch {
    return path.join(homedir(), ".kone-trash");
  }
}

/** A free destination inside the trash root: the name itself, or the name
 *  with a numeric suffix when a previous trip to the trash took it. */
async function trashTarget(trashRoot: string, name: string): Promise<string> {
  await mkdir(trashRoot, { recursive: true });
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? path.join(trashRoot, name) : path.join(trashRoot, `${name} ${i}`);
    if (!(await exists(candidate))) return candidate;
  }
}

/** ── Action: edit frontmatter ───────────────────────────────────────────── */

/** Re-parses the edited text and checks every edit landed as intended — the
 *  guard that a line edit never produced a frontmatter the parser reads
 *  differently than the caller asked for. Returns an error sentence or null. */
function verifyEditedFrontmatter(text: string, edits: FrontmatterEdit[]): string | null {
  const parsed = parseFrontmatter(text);
  for (const edit of edits) {
    const got = parsed[edit.key];
    if (edit.op === "set") {
      if (got === undefined) return `The edited frontmatter does not contain ${edit.key}.`;
      if (got.trim() !== edit.value.trim()) {
        return `The edited ${edit.key} does not round-trip through the parser (it likely starts and ends with quotes, which kone cannot represent).`;
      }
    } else if (got !== undefined) {
      return `The edited frontmatter still contains ${edit.key}.`;
    }
  }
  return null;
}

/** Apply surgical frontmatter edits to a SKILL.md on disk. Never serializes a
 *  parsed map back to the file — only the edited key's own lines change, and
 *  the result is re-parsed before writing so a lossy field (quotes, a nested
 *  map) can never be silently mangled. Plugin-owned skills are refused. */
export async function editSkillFrontmatter(skillMdPath: string, edits: FrontmatterEdit[]): Promise<MutateResult> {
  if (!path.isAbsolute(skillMdPath) || path.basename(skillMdPath) !== "SKILL.md") {
    return { ok: false, action: "editFrontmatter", path: null, detail: "Could not edit: the target must be an absolute path to a file named SKILL.md." };
  }
  if (edits.length === 0) {
    return { ok: false, action: "editFrontmatter", path: skillMdPath, detail: "Could not edit: no edits were supplied." };
  }
  if (isPluginOwnedPath(skillMdPath)) {
    return {
      ok: false,
      action: "editFrontmatter",
      path: skillMdPath,
      detail: "Could not edit: the skill lives inside a plugin's install directory, which the plugin owns and overwrites on update — edit the plugin's source instead.",
    };
  }

  // Domain gates before any read: the name must keep matching its folder (a
  // mismatch makes some CLIs silently ignore the skill), and name/description
  // have hard limits.
  const folderName = path.basename(path.dirname(skillMdPath));
  for (const edit of edits) {
    if (edit.op === "set" && edit.key === "name") {
      const error = validateSkillName(edit.value);
      if (error) {
        return { ok: false, action: "editFrontmatter", path: skillMdPath, detail: `Could not edit: ${error}` };
      }
      if (edit.value !== folderName) {
        return {
          ok: false,
          action: "editFrontmatter",
          path: skillMdPath,
          detail: `Could not edit: the name must match the folder name (${folderName}) or some CLIs will not load the skill — rename the folder instead.`,
        };
      }
    }
    if (edit.op === "set" && edit.key === "description") {
      const error = validateSkillDescription(edit.value);
      if (error) {
        return { ok: false, action: "editFrontmatter", path: skillMdPath, detail: `Could not edit: ${error}` };
      }
    }
    if (edit.op === "delete" && edit.key === "name") {
      return {
        ok: false,
        action: "editFrontmatter",
        path: skillMdPath,
        detail: "Could not edit: some CLIs refuse to load a skill without a name, and the name must keep matching the folder — removing it is not an edit kone will make.",
      };
    }
  }

  let info;
  try {
    info = await stat(skillMdPath);
  } catch {
    return { ok: false, action: "editFrontmatter", path: skillMdPath, detail: "Could not edit: the SKILL.md could not be read." };
  }
  if (!info.isFile()) {
    return { ok: false, action: "editFrontmatter", path: skillMdPath, detail: "Could not edit: the path is not a file." };
  }
  if (info.size > MAX_FILE_BYTES) {
    return { ok: false, action: "editFrontmatter", path: skillMdPath, detail: `Could not edit: the file exceeds the ${MAX_FILE_BYTES}-byte read cap.` };
  }

  let raw: string;
  try {
    raw = await readFile(skillMdPath, "utf8");
  } catch {
    return { ok: false, action: "editFrontmatter", path: skillMdPath, detail: "Could not edit: the SKILL.md could not be read." };
  }

  const applied = applyFrontmatterEdits(raw, edits);
  if (!applied.ok) {
    return { ok: false, action: "editFrontmatter", path: skillMdPath, detail: `Could not edit: ${applied.error}` };
  }
  const verifyError = verifyEditedFrontmatter(applied.text, edits);
  if (verifyError) {
    return { ok: false, action: "editFrontmatter", path: skillMdPath, detail: `Could not edit: ${verifyError}` };
  }

  try {
    await writeFile(skillMdPath, applied.text, "utf8");
  } catch (error) {
    return { ok: false, action: "editFrontmatter", path: skillMdPath, detail: `Could not edit: ${error instanceof Error ? error.message : String(error)}.` };
  }

  const keys = edits.map((edit) => edit.key);
  return { ok: true, action: "editFrontmatter", path: skillMdPath, detail: `Updated ${keys.join(", ")} in ${skillMdPath}.` };
}

/** ── Action: delete to trash ────────────────────────────────────────────── */

/** Move a skill folder to the system Trash (macOS) or kone's own trash
 *  folder, never unlink. Deletion is the one irreversible-looking action in
 *  the pane, so it must stay reversible. Takes an explicit path — the caller
 *  decides which skill (and which policy applies to it); this function only
 *  refuses what it can prove is unsafe: plugin-owned paths. `trashDir`
 *  overrides the destination for tests. */
export async function deleteSkillToTrash(skillDir: string, trashDir?: string): Promise<MutateResult> {
  if (!path.isAbsolute(skillDir)) {
    return { ok: false, action: "delete", path: null, detail: "Could not delete: the skill path must be absolute." };
  }

  const resolved = await realpath(skillDir).catch(() => null);
  if (!resolved) {
    return { ok: false, action: "delete", path: skillDir, detail: "Could not delete: no skill folder exists at that path." };
  }

  let info;
  try {
    info = await stat(resolved);
  } catch {
    return { ok: false, action: "delete", path: skillDir, detail: "Could not delete: no skill folder exists at that path." };
  }
  if (!info.isDirectory()) {
    return { ok: false, action: "delete", path: skillDir, detail: "Could not delete: the path is not a folder." };
  }

  if (isPluginOwnedPath(resolved)) {
    return {
      ok: false,
      action: "delete",
      path: skillDir,
      detail: "Could not delete: the skill lives inside a plugin's install directory, which the plugin owns and restores on update — uninstall the plugin instead.",
    };
  }

  let target: string;
  try {
    target = await trashTarget(trashDir ?? defaultTrashRoot(), path.basename(resolved));
  } catch (error) {
    return { ok: false, action: "delete", path: skillDir, detail: `Could not delete: ${error instanceof Error ? error.message : String(error)}.` };
  }
  try {
    await rename(resolved, target);
  } catch (error) {
    // A rename fails across filesystems (EXDEV); never fall back to
    // copy-then-unlink — if the trash cannot take the folder, nothing goes.
    return { ok: false, action: "delete", path: skillDir, detail: `Could not delete: ${error instanceof Error ? error.message : String(error)}.` };
  }

  return { ok: true, action: "delete", path: skillDir, detail: `Moved the skill folder to ${target}.` };
}
