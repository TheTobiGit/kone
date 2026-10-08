import { realpathSync } from "node:fs";
import path from "node:path";

import type { ConversationDb } from "./ConversationDb.js";

/** The two per-project scripts kone runs around a thread's worktree. `setup`
 *  runs once after a worktree is materialized, before the agent's first turn
 *  (install dependencies, copy env files); `settle` runs when a thread settles
 *  (stop a dev server, clean up). */
export type ProjectScriptKind = "setup" | "settle";

/** Where a project's scripts live. Kone has no per-project settings table —
 *  projects are paths, and the durable key/value surface that already holds
 *  other global settings (`app_state`, see workspaces.ts) is the closest thing
 *  to one. Keying by the project path keeps a script with the project it
 *  belongs to without inventing a store. */
export class ProjectScriptRepo {
  constructor(private readonly dbh: ConversationDb) {}

  /** The command stored for a project and kind, trimmed, or null when unset. */
  script(projectPath: string, kind: ProjectScriptKind): string | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      // SAFETY: app_state holds at most one row per key, one TEXT column.
      const row = db
        .prepare(`SELECT value FROM app_state WHERE key = ?`)
        .get(scriptKey(projectPath, kind)) as { value: string } | undefined;
      const value = row?.value?.trim();
      return value ? value : null;
    } catch (err) {
      console.error("[conversation-store] project script read failed:", err);
      return null;
    }
  }

  /** Set (or clear, with null/empty) a project's script. A blank command is
   *  stored as an empty value rather than removed — either way `script` reads
   *  it as unset. */
  setScript(projectPath: string, kind: ProjectScriptKind, command: string | null): void {
    const db = this.dbh.handle();
    if (!db) return;
    try {
      db.prepare(
        `INSERT INTO app_state (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      ).run(scriptKey(projectPath, kind), command?.trim() ?? "", Date.now());
    } catch (err) {
      console.error("[conversation-store] project script write failed:", err);
    }
  }
}

/** The app_state key for one project's script. The path is the identity, so it
 *  is resolved to its real location first: a project opened by two different
 *  spellings (a symlink, a relative path) is one project and must share one
 *  script. A path that cannot be resolved uses its absolute form so the key is
 *  still stable. */
function scriptKey(projectPath: string, kind: ProjectScriptKind): string {
  return `project_${kind}_script:${normalizeProjectPath(projectPath)}`;
}

/** Resolve a project path for use as a store key. Exported so callers can
 *  compare on the same identity the store keys by. */
export function normalizeProjectPath(projectPath: string): string {
  const trimmed = projectPath.trim();
  try {
    return realpathSync.native(trimmed);
  } catch {
    return path.resolve(trimmed);
  }
}
