// Pure helpers for edit-fork lineage and titles. Edit-and-resend of an
// earlier message forks the thread rather than mutating it, so sibling forks
// of one conversation need stable, distinct titles — and every walk over the
// fork chain must terminate even on corrupted rows.
//
// The version suffix is computed over the whole lineage (every thread sharing
// the root), not the immediate parent: forking the same source twice yields
// "(2)" then "(3)", never "(2)" twice. A deleted "(2)" still advances the next
// fork past it, because the floor also considers the highest version seen.

/** The fields an edit-fork title/lineage walk reads per thread. */
export type ForkLineageNode = {
  id: string;
  projectPath: string;
  title: string | null;
  sourceThreadId: string | null;
};

/** Where a source-thread walk ended. `complete` is false when the walk
 *  stopped early — a missing parent row, a parent in another project, a
 *  revisited id (a pointer cycle), or the hop cap — so callers can fall back
 *  to the source itself instead of trusting a partial root. */
export type LineageRoot = {
  root: ForkLineageNode;
  complete: boolean;
};

/** A thread title split into its fork base and generation. */
export type ForkVersion = {
  baseTitle: string;
  version: number;
};

/** The title-versioning family for one lineage: the root id plus every
 *  collected family title (root included). */
export type EditForkFamily = {
  rootId: string;
  titles: string[];
};

/** Cap on parent-pointer hops. Real chains are a handful deep; anything near
 *  this is a cycle or corruption, and the walk must return, not hang. */
export const LINEAGE_WALK_CAP = 64;

/** Cap on descendant breadth-first collection for title versioning. Forks are
 *  rare; this only bounds corrupted super-graphs. */
export const LINEAGE_FAMILY_CAP = 512;

const FORK_VERSION_SUFFIX = /^(.*) \((\d+)\)$/;

/** Walk `sourceThreadId` pointers from `source` up to the lineage root.
 *  Guards the same three ways a stored chain can lie: a cycle (revisited id),
 *  a parent in another project (fork rows always inherit their source's
 *  project, so a foreign parent is corruption), and a missing parent row. */
export function findEditLineageRoot(
  source: ForkLineageNode,
  nodesById: ReadonlyMap<string, ForkLineageNode>,
): LineageRoot {
  const visited = new Set<string>([source.id]);
  let current = source;
  for (let hops = 0; hops < LINEAGE_WALK_CAP; hops++) {
    const parentId = current.sourceThreadId;
    if (!parentId) return { root: current, complete: true };
    const parent = nodesById.get(parentId);
    if (!parent || parent.projectPath !== source.projectPath || visited.has(parent.id)) {
      return { root: current, complete: false };
    }
    visited.add(parent.id);
    current = parent;
  }
  return { root: current, complete: false };
}

/** Split a thread title into its base and fork version. `"Fix leak (3)"`
 *  reads as base `"Fix leak"` version 3; anything without a well-formed
 *  numeric suffix (including `"(1)"`, `"(0)"`, `"(x)"`) reads as version 1 of
 *  itself, so hand-written parentheses never parse as a fork generation. */
export function parseForkVersion(title: string): ForkVersion {
  const match = FORK_VERSION_SUFFIX.exec(title);
  if (!match) return { baseTitle: title, version: 1 };
  const version = Number(match[2]);
  if (!Number.isSafeInteger(version) || version < 2) {
    return { baseTitle: title, version: 1 };
  }
  const base = match[1] ?? title;
  if (base.trim().length === 0) {
    return { baseTitle: title, version: 1 };
  }
  return { baseTitle: base, version };
}

/** The title for a new fork off a thread titled `sourceTitle`, given the
 *  titles of every thread already in the lineage family (root included).
 *  The next version is the highest of: 2 (a first fork is always "(2)",
 *  never "(1)"), family size + 1 (a rename that broke the base match still
 *  advances the count), and highest seen version + 1 (a deleted "(2)" is not
 *  reused). */
export function buildEditForkTitle(sourceTitle: string, familyTitles: readonly string[]): string {
  const lineageTitle = parseForkVersion(sourceTitle);
  let latestNamedVersion = lineageTitle.version;
  let familySize = 0;
  for (const title of familyTitles) {
    familySize++;
    const candidate = parseForkVersion(title);
    if (candidate.baseTitle === lineageTitle.baseTitle && candidate.version > latestNamedVersion) {
      latestNamedVersion = candidate.version;
    }
  }
  const nextVersion = Math.max(2, familySize + 1, latestNamedVersion + 1);
  return `${lineageTitle.baseTitle} (${nextVersion})`;
}
