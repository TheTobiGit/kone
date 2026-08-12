// FILE: instructions.ts
// Purpose: read-only discovery of AGENTS.md/CLAUDE.md instruction files —
// user scope, the project root, and nested occurrences within the project
// (e.g. a monorepo package's own instructions) — with a short plain-text
// excerpt of each for the Agents-page inventory. Never writes anything.
// Exports: discoverInstructions

import type { Dirent } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { InstructionFile, InventoryError } from "./types.js";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_EXCERPT_CHARS = 400;
const MAX_NESTED_DEPTH = 3;
const MAX_TOTAL_RESULTS = 40;
const MAX_ENTRIES_PER_DIR = 500;
const SKIPPED_DIR_NAMES = new Set(["node_modules", ".git", "dist", "build", ".next", "target"]);
const INSTRUCTION_FILE_NAMES = new Set(["CLAUDE.md", "AGENTS.md"]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function kindForFileName(name: string): InstructionFile["kind"] {
  if (name === "CLAUDE.md") return "CLAUDE.md";
  if (name === "AGENTS.md") return "AGENTS.md";
  return "other";
}

// Strips YAML frontmatter and markdown heading marks so the excerpt reads as
// plain prose rather than raw markup.
function plainTextExcerpt(raw: string): string {
  const withoutFrontmatter = raw.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "");
  const withoutHeadingMarks = withoutFrontmatter.replace(/^#{1,6}\s*/gm, "");
  const collapsed = withoutHeadingMarks.trim().replace(/\s+/g, " ");
  return collapsed.slice(0, MAX_EXCERPT_CHARS);
}

async function readInstructionFile(filePath: string, scope: InstructionFile["scope"]): Promise<InstructionFile | null> {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    return null;
  }
  if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;

  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return null;
  }

  return {
    path: filePath,
    kind: kindForFileName(path.basename(filePath)),
    scope,
    bytes: info.size,
    modifiedAt: Math.round(info.mtimeMs),
    excerpt: plainTextExcerpt(raw),
  };
}

async function readdirOrEmpty(dir: string): Promise<Dirent[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.slice(0, MAX_ENTRIES_PER_DIR);
  } catch {
    return [];
  }
}

// Walks the project tree to a capped depth for nested AGENTS.md/CLAUDE.md
// files, skipping the usual build/dependency directories so a huge checkout
// can't hang the scan, and stopping once the total result cap is hit.
async function walkNestedInstructions(rootDir: string, results: InstructionFile[], errors: InventoryError[]): Promise<void> {
  async function visit(dir: string, depth: number): Promise<void> {
    if (results.length >= MAX_TOTAL_RESULTS) return;
    const entries = await readdirOrEmpty(dir);
    const subdirs: string[] = [];

    for (const entry of entries) {
      if (results.length >= MAX_TOTAL_RESULTS) return;
      if (entry.isFile() && INSTRUCTION_FILE_NAMES.has(entry.name)) {
        // The project root's own CLAUDE.md/AGENTS.md is read separately at
        // scope "project" — only report deeper occurrences here.
        if (depth === 0) continue;
        const found = await readInstructionFile(path.join(dir, entry.name), "nested");
        if (found) results.push(found);
        continue;
      }
      if (entry.isDirectory() && !SKIPPED_DIR_NAMES.has(entry.name)) {
        subdirs.push(entry.name);
      }
    }

    if (depth >= MAX_NESTED_DEPTH) return;
    for (const name of subdirs) {
      if (results.length >= MAX_TOTAL_RESULTS) return;
      await visit(path.join(dir, name), depth + 1);
    }
  }

  try {
    await visit(rootDir, 0);
  } catch (error) {
    errors.push({ source: `instructions:nested:${rootDir}`, message: errorMessage(error) });
  }
}

/** Finds AGENTS.md/CLAUDE.md at user scope (`~/.claude/CLAUDE.md`,
 *  `~/.agents/AGENTS.md`), the project root, and nested within the project
 *  (capped at depth 3, skipping node_modules/.git/dist/build/.next/target,
 *  capped at ~40 total results). Every individual read failure is caught
 *  into `errors`; this function never rejects. */
export async function discoverInstructions(projectPath: string | null): Promise<{
  instructions: InstructionFile[];
  errors: InventoryError[];
}> {
  const home = homedir();
  const errors: InventoryError[] = [];
  const results: InstructionFile[] = [];

  const userCandidates = [path.join(home, ".claude", "CLAUDE.md"), path.join(home, ".agents", "AGENTS.md")];
  for (const filePath of userCandidates) {
    try {
      const found = await readInstructionFile(filePath, "user");
      if (found) results.push(found);
    } catch (error) {
      errors.push({ source: `instructions:user:${filePath}`, message: errorMessage(error) });
    }
  }

  if (projectPath) {
    const projectCandidates = [path.join(projectPath, "CLAUDE.md"), path.join(projectPath, "AGENTS.md")];
    for (const filePath of projectCandidates) {
      try {
        const found = await readInstructionFile(filePath, "project");
        if (found) results.push(found);
      } catch (error) {
        errors.push({ source: `instructions:project:${filePath}`, message: errorMessage(error) });
      }
    }

    await walkNestedInstructions(projectPath, results, errors);
  }

  return { instructions: results.slice(0, MAX_TOTAL_RESULTS), errors };
}
