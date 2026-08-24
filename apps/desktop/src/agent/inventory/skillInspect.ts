// ── Filesystem edge for the pure skill analysers ────────────────────────────
// skillLint and skillSignals are pure functions over a skill's contents; this
// module is the one place that goes to disk for them, so the renderer can ask
// about a skill by path alone. Read-only: it opens SKILL.md and lists the
// folder beside it, nothing more.

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { parseFrontmatter } from "./frontmatter.js";
import { lintSkill, type SkillFinding } from "./skillLint.js";
import { deriveSignals, type SiblingFile, type SkillSignals } from "./skillSignals.js";
import { MAX_FILE_BYTES } from "./skills.js";
import type { SkillEntry } from "./types.js";

/** The frontmatter block at the head of the file, matched the same way
 *  frontmatter.ts parses it so "the body after the frontmatter" and the parsed
 *  keys always agree about where one ends and the other begins. */
const FRONTMATTER_BLOCK = /^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/;

/** How many folder entries to list before stopping. A skill folder is a
 *  handful of files; anything past this is a repository that happens to have a
 *  SKILL.md in it, and reading all of it would stall the pane. */
const MAX_ENTRIES = 200;

type LoadedSkill = {
  raw: string;
  body: string;
  frontmatter: Record<string, string>;
  directory: string;
  files: SiblingFile[];
};

/** Opens a SKILL.md and lists its folder, or returns null when the path is not
 *  a readable SKILL.md — the same refusal shape readSkillDetail uses, so a
 *  stale path clicked in the index can't crash the renderer. */
async function loadSkill(skillMdPath: string): Promise<LoadedSkill | null> {
  if (!path.isAbsolute(skillMdPath) || path.basename(skillMdPath) !== "SKILL.md") return null;

  let info;
  try {
    info = await stat(skillMdPath);
  } catch {
    return null;
  }
  if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;

  let raw: string;
  try {
    raw = await readFile(skillMdPath, "utf8");
  } catch {
    return null;
  }

  const normalized = raw.replace(/\r\n/g, "\n");
  const directory = path.dirname(skillMdPath);
  return {
    raw: normalized,
    body: normalized.replace(FRONTMATTER_BLOCK, ""),
    frontmatter: parseFrontmatter(raw),
    directory,
    files: await listFolder(directory),
  };
}

/** Lists the skill folder, marking directories and executable files. The
 *  executable bit is read from the mode rather than by opening each file for a
 *  shebang: it answers the same question at a fraction of the cost. */
async function listFolder(directory: string): Promise<SiblingFile[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: SiblingFile[] = [];
  for (const entry of entries) {
    if (files.length >= MAX_ENTRIES) break;

    let kind: SiblingFile["kind"];
    if (entry.isDirectory()) {
      kind = "directory";
    } else if (entry.isFile()) {
      kind = "file";
    } else if (entry.isSymbolicLink()) {
      try {
        kind = (await stat(path.join(directory, entry.name))).isDirectory() ? "directory" : "file";
      } catch {
        continue;
      }
    } else {
      continue;
    }

    let isExecutable = false;
    if (kind === "file") {
      try {
        isExecutable = ((await stat(path.join(directory, entry.name))).mode & 0o111) !== 0;
      } catch {
        isExecutable = false;
      }
    }
    files.push({ name: entry.name, kind, isExecutable });
  }

  files.sort((a, b) => a.name.localeCompare(b.name));
  return files;
}

/** Runs the lint rules against the SKILL.md at this path. An unreadable path
 *  yields no findings rather than a finding about being unreadable — the pane
 *  already has nothing to show for a skill it cannot open. */
export async function lintSkillAt(skillMdPath: string): Promise<SkillFinding[]> {
  const loaded = await loadSkill(skillMdPath);
  if (!loaded) return [];

  const directoryName = path.basename(loaded.directory);
  const name = loaded.frontmatter.name?.trim() || directoryName;

  return lintSkill({
    name,
    directoryName,
    frontmatter: loaded.frontmatter,
    body: loaded.raw,
    siblingFiles: loaded.files.filter((f) => f.kind === "file").map((f) => f.name),
    siblingDirs: loaded.files.filter((f) => f.kind === "directory").map((f) => f.name),
  });
}

/** Where the skill came from. The scan knows this and the path does not, so
 *  the caller carries it across. */
export type SkillSignalsContext = { origin: string; scope: SkillEntry["scope"] };

/** Derives the cost and security signals for the SKILL.md at this path.
 *  Returns null when the file cannot be read. */
export async function signalsForSkillAt(
  skillMdPath: string,
  context: SkillSignalsContext,
): Promise<SkillSignals | null> {
  const loaded = await loadSkill(skillMdPath);
  if (!loaded) return null;

  let modifiedAt: number | null = null;
  try {
    modifiedAt = (await stat(skillMdPath)).mtimeMs;
  } catch {
    modifiedAt = null;
  }

  const whenToUse = loaded.frontmatter.when_to_use ?? null;
  return deriveSignals({
    frontmatter: loaded.frontmatter,
    body: loaded.body,
    siblingFiles: loaded.files,
    directory: loaded.directory,
    scope: context.scope,
    origin: context.origin,
    whenToUse,
    modifiedAt,
  });
}
