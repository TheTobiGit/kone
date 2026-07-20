// The shape the corner "project folder" renders — one changed file as a peeking
// paper. UI-facing (distinct from the raw git model in `desktop.d.ts`): the
// launcher's project summaries map git changes into this, and <ProjectFolder>
// draws its diff-shape marks from it.

export type FileChange = "new" | "edit" | "deleted";

export interface FolderFile {
  change: FileChange;
  /** Lines added/removed for this file — drives the paper's diff-shape marks. */
  added?: number;
  removed?: number;
  /** File path — seeds the deterministic mark jitter so no two read alike. */
  name?: string;
}
