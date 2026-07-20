// One changed file as the changes UI renders it — the shared model behind the
// project rail's lanes, the file detail view, and the corner folder. UI-facing:
// derived from the raw git model in `desktop.d.ts`, flattened to just what the
// cards and lanes address (a stable `path` id + display counts and flags).

export interface ChangeItem {
  /** Full repo-relative path — the stable id actions address. */
  path: string;
  name: string;
  added: number;
  removed: number;
  staged: boolean;
  isNew: boolean;
  deleted: boolean;
}
