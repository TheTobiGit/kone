// FILE: skillMutate.ts
// Purpose: the four write capabilities behind the Skills pane's manager phase.
// scaffoldSkill creates a new skill folder, editSkillFrontmatter applies
// surgical line edits to a SKILL.md, deleteSkillToTrash moves a skill folder
// to the system Trash, and installSkillFromGit clones a plain git repo into a
// skills root and records its source. Every function reports what it did to
// which path. All writes share the same gates: validate before touching disk,
// never overwrite an existing skill (a shadow copy would fork under every
// scanner), never unlink user data, never touch a plugin-owned skill. The
// frontmatter line-editing logic (applyFrontmatterEdits) is pure and
// unit-testable; fs and git sit at the edge of the exported actions.
// Exports: MutateResult, FrontmatterEdit, FrontmatterEditResult,
// SkillSourceManifest, SOURCE_MANIFEST_FILENAME, applyFrontmatterEdits,
// validateSkillName, validateSkillDescription, scaffoldSkill,
// editSkillFrontmatter, deleteSkillToTrash, installSkillFromGit

import { access, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { clone } from "../../modules/git/clone.js";
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

/** The dotfile kone writes into a git-installed skill so "update" and
 *  "uninstall" later stay honest: they only exist for sources kone recorded. */
export const SOURCE_MANIFEST_FILENAME = ".kone-source.json";

export type SkillSourceManifest = {
  source: "git";
  /** The URL (or local folder path) the skill was cloned from. */
  url: string;
  /** ISO timestamp of the install. */
  installedAt: string;
};

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

async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

function isContainedIn(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
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

/** Resolve an allowed skills root: absolute, created if missing, realpath'd
 *  so every derived path is built on the real location. */
async function prepareRoot(root: string): Promise<{ ok: true; real: string } | { ok: false; error: string }> {
  if (!path.isAbsolute(root)) {
    return { ok: false, error: "the skills root must be an absolute path." };
  }
  try {
    await mkdir(root, { recursive: true });
  } catch (error) {
    return { ok: false, error: `${error instanceof Error ? error.message : String(error)}.` };
  }
  try {
    return { ok: true, real: await realpath(root) };
  } catch {
    return { ok: false, error: "the skills root could not be resolved." };
  }
}

/** Remove a folder this module created itself moments ago — rollback for a
 *  failed scaffold or install only, never a path the user had before. */
async function removeCreated(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
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

/** ── Action: scaffold ───────────────────────────────────────────────────── */

/** Create a new skill folder and its SKILL.md in `root`. Always writes both
 *  required frontmatter fields — a skill without a name or description is
 *  refused by some CLIs, and kone never scaffolds one it can't stand behind. */
export async function scaffoldSkill(root: string, name: string, description: string): Promise<MutateResult> {
  const nameError = validateSkillName(name);
  if (nameError) {
    return { ok: false, action: "scaffold", path: null, detail: `Could not scaffold: ${nameError}` };
  }
  const descriptionError = validateSkillDescription(description);
  if (descriptionError) {
    return { ok: false, action: "scaffold", path: null, detail: `Could not scaffold: ${descriptionError}` };
  }

  const prepared = await prepareRoot(root);
  if (!prepared.ok) {
    return { ok: false, action: "scaffold", path: null, detail: `Could not scaffold: ${prepared.error}` };
  }

  const dir = path.join(prepared.real, name);
  if (await exists(dir)) {
    return {
      ok: false,
      action: "scaffold",
      path: dir,
      detail: `Could not scaffold: ${name} already exists at ${dir} — kone never overwrites an existing skill.`,
    };
  }

  try {
    await mkdir(dir);
  } catch (error) {
    return { ok: false, action: "scaffold", path: dir, detail: `Could not scaffold: ${error instanceof Error ? error.message : String(error)}.` };
  }

  const skillMdPath = path.join(dir, "SKILL.md");
  try {
    await writeFile(skillMdPath, `---\nname: ${name}\ndescription: ${description.trim()}\n---\n`, "utf8");
  } catch (error) {
    await removeCreated(dir);
    return { ok: false, action: "scaffold", path: skillMdPath, detail: `Could not scaffold: ${error instanceof Error ? error.message : String(error)}.` };
  }

  // Containment: the created folder must resolve back inside the root — a
  // symlink planted at `name` between our checks would make the write land
  // outside the skills root.
  const dirReal = await realpath(dir).catch(() => dir);
  if (!isContainedIn(dirReal, prepared.real)) {
    await removeCreated(dir);
    return { ok: false, action: "scaffold", path: skillMdPath, detail: `Could not scaffold: ${dir} resolves outside the skills root.` };
  }

  return { ok: true, action: "scaffold", path: skillMdPath, detail: `Created the skill at ${dir} with its name and description.` };
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

/** ── Action: install from git ───────────────────────────────────────────── */

/** Accepts the source forms `git clone` itself accepts — http(s), git, ssh,
 *  and scp-style URLs, plus local repository folders — and rejects anything
 *  else (a marketplace name, a zip URL, a shell-ish string). */
function validateInstallSource(url: string): string | null {
  if (url.length === 0) {
    return "the source is empty.";
  }
  if (/\s/.test(url)) {
    return `"${url}" is not a plain git source.`;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    const protocol = url.slice(0, url.indexOf("://")).toLowerCase();
    if (["http", "https", "git", "ssh", "file"].includes(protocol)) return null;
    return `"${protocol}://" is not a plain git source — use https, git, or ssh, or a local folder.`;
  }
  if (/^[\w.-]+@[\w.-]+:[\w./~-]+$/.test(url)) return null; // scp-style git@host:path
  if (path.isAbsolute(url)) return null; // a local repository folder
  return `"${url}" is not a plain git source — kone installs skills from git URLs or local folders only.`;
}

/** The folder name a clone of `url` would produce — the URL's last path
  *  segment with any trailing ".git" and query/fragment dropped. */
function installSourceName(url: string): string {
  const tail = (url.split(/[/:]/).pop() ?? url).split(/[?#]/)[0] ?? "";
  const cleaned = tail.endsWith(".git") ? tail.slice(0, -4) : tail;
  return cleaned || "skill";
}

/** Park a refused or failed install's clone in the trash (so even a rejected
 *  clone stays recoverable) instead of unlinking it. */
async function discardClone(dir: string, trashDir?: string): Promise<void> {
  try {
    const target = await trashTarget(trashDir ?? defaultTrashRoot(), path.basename(dir));
    await rename(dir, target);
  } catch {
    // The trash may live on another volume than the skills root; a clone this
    // call created seconds ago is then removed rather than left half-installed.
    await removeCreated(dir);
  }
}

/** Clone a plain git repository into a skills root and write kone's own
 *  source manifest (a dotfile in the skill folder) so update and uninstall
 *  later stay honest. The folder is named after the SKILL.md's frontmatter
 *  name — a repo whose folder name would not match its skill name is renamed
 *  before the manifest lands. Plugin-shaped repositories (a .claude-plugin
 *  manifest) are refused and handed off to the CLI's own installer. */
export async function installSkillFromGit(
  url: string,
  root: string,
  options?: { trashDir?: string },
): Promise<MutateResult> {
  const urlError = validateInstallSource(url);
  if (urlError) {
    return { ok: false, action: "install", path: null, detail: `Could not install: ${urlError}` };
  }

  const prepared = await prepareRoot(root);
  if (!prepared.ok) {
    return { ok: false, action: "install", path: null, detail: `Could not install: ${prepared.error}` };
  }

  const cloneName = installSourceName(url);
  const cloneTarget = path.join(prepared.real, cloneName);
  if (await exists(cloneTarget)) {
    return {
      ok: false,
      action: "install",
      path: cloneTarget,
      detail: `Could not install: ${cloneName} already exists at ${cloneTarget} — kone never overwrites an existing skill.`,
    };
  }

  let cloned: string;
  try {
    const result = await clone(url, cloneTarget, () => {});
    cloned = result.root;
  } catch (error) {
    return { ok: false, action: "install", path: cloneTarget, detail: `Could not install: ${error instanceof Error ? error.message : String(error)}.` };
  }

  if (await exists(path.join(cloned, ".claude-plugin"))) {
    await discardClone(cloned, options?.trashDir);
    return {
      ok: false,
      action: "install",
      path: cloned,
      detail: "Could not install: the repository is a plugin, not a plain skill — install it with the CLI's plugin installer so it keeps its own update loop.",
    };
  }

  const skillMdPath = path.join(cloned, "SKILL.md");
  if (!(await isFile(skillMdPath))) {
    await discardClone(cloned, options?.trashDir);
    return {
      ok: false,
      action: "install",
      path: cloned,
      detail: "Could not install: the repository has no SKILL.md at its root, so it is not a single-skill repository.",
    };
  }

  let raw: string;
  try {
    raw = await readFile(skillMdPath, "utf8");
  } catch {
    await discardClone(cloned, options?.trashDir);
    return { ok: false, action: "install", path: cloned, detail: "Could not install: the repository's SKILL.md could not be read." };
  }

  const parsedName = parseFrontmatter(raw).name;
  if (!parsedName) {
    await discardClone(cloned, options?.trashDir);
    return {
      ok: false,
      action: "install",
      path: cloned,
      detail: "Could not install: the repository's SKILL.md has no name field, and some CLIs refuse to load a skill without one.",
    };
  }
  const nameError = validateSkillName(parsedName);
  if (nameError) {
    await discardClone(cloned, options?.trashDir);
    return { ok: false, action: "install", path: cloned, detail: `Could not install: ${nameError}` };
  }
  const name = parsedName;

  let finalDir: string;
  if (name !== cloneName) {
    const renamedTarget = path.join(prepared.real, name);
    if (await exists(renamedTarget)) {
      await discardClone(cloned, options?.trashDir);
      return {
        ok: false,
        action: "install",
        path: renamedTarget,
        detail: `Could not install: a skill named ${name} already exists at ${renamedTarget} — kone never overwrites an existing skill.`,
      };
    }
    try {
      await rename(cloned, renamedTarget);
    } catch (error) {
      await discardClone(cloned, options?.trashDir);
      return { ok: false, action: "install", path: cloned, detail: `Could not install: ${error instanceof Error ? error.message : String(error)}.` };
    }
    finalDir = renamedTarget;
  } else {
    finalDir = cloned;
  }

  const finalReal = await realpath(finalDir).catch(() => finalDir);
  if (!isContainedIn(finalReal, prepared.real)) {
    await discardClone(finalDir, options?.trashDir);
    return { ok: false, action: "install", path: finalDir, detail: "Could not install: the cloned folder resolves outside the skills root." };
  }

  const manifest: SkillSourceManifest = {
    source: "git",
    url,
    installedAt: new Date().toISOString(),
  };
  try {
    await writeFile(path.join(finalDir, SOURCE_MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } catch (error) {
    // Without the manifest there is no honest update or uninstall later, so
    // the install is rolled back rather than left half-claimed.
    await discardClone(finalDir, options?.trashDir);
    return { ok: false, action: "install", path: finalDir, detail: `Could not install: the source manifest could not be written (${error instanceof Error ? error.message : String(error)}).` };
  }

  const renamed = name !== cloneName ? ` (renamed to ${name} to match its frontmatter name)` : "";
  return {
    ok: true,
    action: "install",
    path: finalDir,
    detail: `Cloned the skill from ${url} into ${finalDir}${renamed} and recorded its source in ${SOURCE_MANIFEST_FILENAME}.`,
  };
}
