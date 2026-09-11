// Shared workspace-path helpers for gateway tools.
//
// Tool path arguments are workspace-relative; these resolve them against the
// project root and refuse escapes, so every tool enforces the same boundary.

import { statSync } from "node:fs";
import path from "node:path";

import { GatewayToolError } from "./schemas.js";

// A workspace-relative path resolved against the project root, or null when
// it escapes. Absolute paths inside the project resolve fine; anything
// climbing out with `..` is refused rather than normalized into place.
export function resolveInWorkspace(projectRoot: string, relPath: string): string | null {
  const absolute = path.resolve(projectRoot, relPath);
  const relative = path.relative(projectRoot, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) return null;
  return absolute;
}

export function hasGlobMagic(value: string): boolean {
  return value.includes("*") || value.includes("?") || value.includes("[");
}

// Resolve a tool path argument to an absolute search root. Escapes and
// literal paths naming nothing throw invalid_input (a glob matching nothing
// is a successful empty search instead).
export function resolveSearchRoot(projectRoot: string, relPath: string): string {
  const absPath = resolveInWorkspace(projectRoot, relPath);
  if (absPath === null) {
    throw new GatewayToolError(
      "invalid_input",
      `Path "${relPath}" escapes the project root; pass a workspace-relative path inside the project.`,
    );
  }
  // A literal path naming nothing is an agent-fixable mistake; a glob that
  // matches nothing is a successful empty search.
  let exists = false;
  try {
    statSync(absPath);
    exists = true;
  } catch {
    exists = false;
  }
  if (!exists && !hasGlobMagic(relPath)) {
    throw new GatewayToolError(
      "invalid_input",
      `Cannot search "${relPath}": no such file or directory inside the project.`,
    );
  }
  return absPath;
}
