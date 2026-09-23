// What the dispatcher needs from the host to give a thread its own worktree,
// and the pieces of building one that don't depend on dispatcher state.

/** Build the directory a worktree thread runs in. Injected because git lives in
 *  the desktop layer, and a headless host (a test, the spawn engine's own
 *  harness) can run every thread local without one. Absent means worktrees are
 *  unavailable here, and a thread that asked for one fails its send rather than
 *  quietly running in the project's checkout. */
export type ProvisionThreadWorkspace = (input: {
  projectPath: string;
  branch?: string;
  base?: string;
}) => Promise<{
  path: string;
  branch: string;
  /** True when the provisioner invented the branch name, so the caller may
   *  clean it up later. Absent reads as not generated: never delete unless
   *  the provisioner positively says it invented the name. */
  generatedBranch?: boolean;
  /** The branch already existed and was moved into this worktree. Its history
   *  is not ours to discard, even when the name looks generated. */
  attachedExisting?: boolean;
  /** Project-relative paths of the private files (`.env` and the like) brought
   *  into the new directory, for the setup steps to name. */
  copiedFiles?: string[];
}>;

/** Tear down a worktree this dispatcher built. Only ever called on one it just
 *  created and then had to give back — a user who cancelled while it was being
 *  made. Best effort: a worktree left behind is untidy, a failed teardown that
 *  masked the real error would be worse. */
export type ReleaseThreadWorkspace = (input: {
  projectPath: string;
  worktreePath: string;
  /** The branch the worktree was built on, for logging. The remover re-reads
   *  the live branch itself rather than trusting this. */
  branch?: string;
  /** Delete the worktree's branch after removal, when it was generated for
   *  this build. The remover still refuses user-named branches regardless. */
  reclaimGeneratedBranch?: boolean;
}) => Promise<void>;

/** Where a new worktree's branch should start: the freshest copy of `base`
 *  (the project's current branch when absent) that loses nothing. Expected
 *  never to throw — a starting point that cannot be freshened is still a
 *  starting point, and the host knows best why it couldn't. `note` is a
 *  sentence for the setup card, present only when there is one to say. */
export type FreshenThreadWorkspaceBase = (input: {
  projectPath: string;
  base?: string;
}) => Promise<{ base?: string; note?: string }>;

/** Give the placeholder branch a worktree was built on a name taken from the
 *  thread's title. Returns the new name, or null when the branch was left
 *  alone. Never throws — a thread keeps working on its placeholder either way. */
export type RenameThreadWorkspaceBranch = (input: {
  worktreePath: string;
  title: string;
}) => Promise<string | null>;

/** What the create step says about the private files a new worktree was
 *  given, or nothing when it was given none. */
export function describeCopiedFiles(copied: readonly string[] | undefined): string | undefined {
  if (!copied || copied.length === 0) return undefined;
  const shown = copied.slice(0, 3).join(", ");
  const more = copied.length - 3;
  return more > 0 ? `Copied ${shown} and ${more} more.` : `Copied ${shown}.`;
}

/** The fetch step: the starting point for a new branch, made current, and the
 *  note the step shows. A host that throws anyway gets the plain starting point
 *  back — freshening is never a reason to fail a build. */
export async function freshenBase(
  freshen: FreshenThreadWorkspaceBase,
  projectPath: string,
  base: string | undefined,
): Promise<{ base: string | undefined; note: string | undefined }> {
  const input: Parameters<FreshenThreadWorkspaceBase>[0] = { projectPath };
  if (base) input.base = base;
  try {
    const fresh = await freshen(input);
    return { base: fresh.base || base, note: fresh.note };
  } catch {
    return { base, note: "Couldn't get the latest changes — started from your copy." };
  }
}
