// FILE: skillDetail.ts
// Purpose: the per-skill detail read behind the Agents page's detail view.
// discoverSkills answers "which skills exist" but deliberately keeps only a
// name/description snippet per skill — showing a skill's full frontmatter and
// body would otherwise mean re-walking the disk. This is the single-file read
// for that: one stat, one read, one readdir of the skill's own folder, with
// the same refusal habits as the scan (absolute SKILL.md path only, the same
// byte cap, never throws) so the handler stays a skills read and can't be
// repurposed as a general file-reading primitive for the renderer.
// Exports: readSkillDetail

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { parseFrontmatter } from "./frontmatter.js";
import { MAX_FILE_BYTES } from "./skills.js";

const MAX_BODY_CHARS = 20_000;
const MAX_RESOURCES = 60;

// The same leading-block pattern frontmatter.ts parses with, so "the body
// after the frontmatter" and the parsed frontmatter always agree about what a
// file contains (frontmatter.ts can't host this without touching its exports).
const FRONTMATTER_BLOCK = /^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/;

/** Full per-skill detail for the Agents page detail view. */
export type SkillDetail = {
  /** The SKILL.md absolute path, as resolved. */
  path: string;
  directory: string;
  bytes: number;
  /** Epoch ms. */
  modifiedAt: number;
  /** Every frontmatter key/value as written, keys lowercased-as-parsed. */
  frontmatter: Record<string, string>;
  /** Markdown body after the frontmatter block, whitespace-trimmed and
   *  capped (see below). */
  body: string;
  /** True when the body was cut short by the cap. */
  bodyTruncated: boolean;
  /** Sibling files/dirs bundled with the skill (scripts/, references/, ...),
   *  relative to `directory`, sorted, dirs marked. Capped at 60 entries. */
  resources: { name: string; kind: "file" | "directory" }[];
};

function stripFrontmatter(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n");
  return normalized.replace(FRONTMATTER_BLOCK, "");
}

async function readResources(directory: string): Promise<SkillDetail["resources"]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    // A skill whose folder can't be listed is still a skill — the body is the
    // point, sibling files are a bonus the renderer can do without.
    return [];
  }

  const resources: SkillDetail["resources"] = [];
  for (const entry of entries) {
    if (entry.name === "SKILL.md" || entry.name.startsWith(".")) continue;
    let kind: "file" | "directory";
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
    resources.push({ name: entry.name, kind });
    if (resources.length >= MAX_RESOURCES) break;
  }

  // Directories first, then alphabetical within each kind — folders like
  // scripts/ are the "primary" resources, loose files are secondary.
  resources.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1,
  );
  return resources;
}

/** Reads one SKILL.md's detail for the detail view: parsed frontmatter, the
 *  markdown body after the frontmatter block, and the skill folder's sibling
 *  resources. Read-only and never rejects — anything it must not or cannot
 *  read (a non-absolute path, a wrong basename, a missing or non-file path,
 *  a file over the byte cap) resolves to null, so an "open skill" click on a
 *  bad path can't crash or hang the renderer. */
export async function readSkillDetail(skillMdPath: string): Promise<SkillDetail | null> {
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

  const frontmatter = parseFrontmatter(raw);
  let body = stripFrontmatter(raw).trim();
  const bodyTruncated = body.length > MAX_BODY_CHARS;
  if (bodyTruncated) body = body.slice(0, MAX_BODY_CHARS);

  return {
    path: skillMdPath,
    directory: path.dirname(skillMdPath),
    bytes: info.size,
    modifiedAt: info.mtimeMs,
    frontmatter,
    body,
    bodyTruncated,
    resources: await readResources(path.dirname(skillMdPath)),
  };
}
