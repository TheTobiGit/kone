import { readdir } from "node:fs/promises";
import path from "node:path";

import { git, repoRoot } from "./core.js";
import type { GitRemote, GitRepoState } from "./types.js";

// Repo-level facts the Git Space masthead hangs on: the configured remotes
// (origin first) and whether the repo is parked mid-operation. Operation state
// is probed by looking for git's marker files/dirs in the repo's git dir — not
// by parsing status output — because those markers are the ground truth git
// itself uses. The git dir is resolved via `rev-parse --git-dir` rather than
// assuming `.git` is a directory: in a linked worktree it is a plain file.

// Marker → operation, in git's own precedence order (a merge and a cherry-pick
// can never be in progress at once, so the first hit wins).
const GIT_STATE_MARKERS: { name: string; operation: GitRepoState["operation"] }[] = [
  { name: "MERGE_HEAD", operation: "merging" },
  { name: "rebase-merge", operation: "rebasing" },
  { name: "rebase-apply", operation: "rebasing" },
  { name: "CHERRY_PICK_HEAD", operation: "cherry-picking" },
  { name: "REVERT_HEAD", operation: "reverting" },
  { name: "BISECT_LOG", operation: "bisecting" },
];

/** Parse a remote URL into host + owner/repo slug. Handles the two common
 *  forms — ssh (`git@host:owner/repo.git`) and https
 *  (`https://host/owner/repo.git`) — plus ssh:// and git:// variants. A
 *  non-GitHub host still yields its host; the slug is only set when the path
 *  unambiguously parses as exactly one owner/repo pair. */
function parseRemoteUrl(url: string): { host: string | null; slug: string | null } {
  const m =
    /^(?:git@([^:]+):|ssh:\/\/git@([^/]+)\/|https?:\/\/([^/]+)\/|git:\/\/([^/]+)\/)(.+)$/i.exec(
      url.trim(),
    );
  if (!m) return { host: null, slug: null };
  const host = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? "").trim().toLowerCase() || null;
  const pathPart = (m[5] ?? "").trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  const slug = /^[^/\s]+\/[^/\s]+$/.test(pathPart) ? pathPart : null;
  return { host, slug };
}

/** Configured remotes, origin first. */
export async function remotes(dir: string): Promise<GitRemote[]> {
  const root = await repoRoot(dir);
  if (!root) return [];
  const out = await git(root, ["remote", "-v"]);
  const byName = new Map<string, { fetchUrl: string; pushUrl: string }>();
  for (const line of out.split("\n")) {
    // "origin\thttps://github.com/owner/repo.git (fetch)"
    const m = /^(\S+)\t(\S+)\s+\((fetch|push)\)$/.exec(line);
    if (!m) continue;
    const name = m[1] ?? "";
    const entry = byName.get(name) ?? { fetchUrl: "", pushUrl: "" };
    if (m[3] === "fetch") entry.fetchUrl = m[2] ?? "";
    else entry.pushUrl = m[2] ?? "";
    byName.set(name, entry);
  }
  const result: GitRemote[] = [];
  for (const [name, urls] of byName) {
    // Prefer the fetch URL for identity; a fetch-less push-only remote is
    // still parsed from its push URL.
    const parsed = parseRemoteUrl(urls.fetchUrl || urls.pushUrl);
    result.push({ name, fetchUrl: urls.fetchUrl, pushUrl: urls.pushUrl, ...parsed });
  }
  // origin first, then the rest in git's own order (Map preserves insertion).
  return result.sort((a, b) => (a.name === "origin" ? -1 : b.name === "origin" ? 1 : 0));
}

/** Whether `remote` is configured on the repo. A repo with no such remote has
 *  nothing to fetch — callers guard doomed network commands with this instead
 *  of running them and surfacing git's "does not appear to be a git
 *  repository" noise. */
export async function remoteExists(dir: string, remote: string): Promise<boolean> {
  const root = await repoRoot(dir);
  if (!root || !remote.trim()) return false;
  try {
    const out = (await git(root, ["remote"])).trim();
    return out
      .split("\n")
      .map((line) => line.trim())
      .includes(remote.trim());
  } catch {
    return false;
  }
}

/** Repo-relative paths with unresolved conflict entries in the index. */
async function unmergedPaths(root: string): Promise<string[]> {
  try {
    const out = await git(root, ["diff", "--name-only", "--diff-filter=U"]);
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/** Mid-operation state (merge/rebase/cherry-pick/revert/bisect) plus the
 *  conflicted paths. Null when `dir` isn't a repo. Conflicts are computed even
 *  with no operation marker — a conflicted `git stash apply` leaves unmerged
 *  index entries without any marker file, and that is still a conflict. */
export async function repoState(dir: string): Promise<GitRepoState | null> {
  const root = await repoRoot(dir);
  if (!root) return null;
  const gitDirRaw = (await git(root, ["rev-parse", "--git-dir"])).trim();
  const gitDir = path.isAbsolute(gitDirRaw) ? gitDirRaw : path.resolve(root, gitDirRaw);
  let names: Set<string>;
  try {
    names = new Set(await readdir(gitDir));
  } catch {
    // No git dir on disk — nothing can be in progress.
    return { operation: "none", conflicts: [] };
  }
  const marker = GIT_STATE_MARKERS.find((candidate) => names.has(candidate.name));
  return {
    operation: marker?.operation ?? "none",
    conflicts: await unmergedPaths(root),
  };
}
