// Which of OpenCode's message layouts a channel database holds.
//
// OpenCode moved its log from one `message` table — role, providerID and
// modelID at the top of each row's JSON — to `session_message` (a `type`
// column for the role, the model as `{ id, providerID }`) beside a
// `session_v2` table that carries each session's working directory. A
// database that has been through the migration can hold both, so callers read
// every layout present and dedupe by message id rather than picking one.

import type { DatabaseSync } from "../../sqlite.js";

export type OpenCodeLayout = {
  /** `message`: the original single-table log. */
  legacy: boolean;
  /** `session_message`. */
  v2: boolean;
  /** `session_v2`, which holds each v2 session's directory. */
  v2Sessions: boolean;
  /** The legacy `session` table has a `directory` column to join on. */
  legacySessionDirectory: boolean;
};

export function detectOpenCodeLayout(db: DatabaseSync): OpenCodeLayout {
  // SAFETY: the projection names exactly one text column.
  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  let legacySessionDirectory = false;
  if (tables.has("session")) {
    // SAFETY: PRAGMA table_info rows always carry a `name` column.
    const columns = db.prepare("PRAGMA table_info(session)").all() as Array<{ name: string }>;
    legacySessionDirectory = columns.some((column) => column.name === "directory");
  }
  return {
    legacy: tables.has("message"),
    v2: tables.has("session_message"),
    v2Sessions: tables.has("session_v2"),
    legacySessionDirectory,
  };
}
