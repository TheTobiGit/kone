import { GitError, git, repoRoot } from "./core.js";
import { withRepoMutation } from "./mutationLock.js";
import type { GitStashEntry } from "./types.js";

// The stash surface. Two parsing rules matter: the stash ref comes straight
// from git's own --format (%gd, the "stash@{N}" string git's apply/drop expect)
// instead of being minted from a counter, and the message prefix is stripped
// structurally ("WIP on <branch>: <sha> " for the default stash, "On <branch>:
// " for `stash push -m`) — never by splitting on ":", because stash messages
// routinely contain colons.
//
// Push/apply/drop all take the index lock, so they run under the repo mutation
// queue and must not overlap other kone git writes.

/** A stash message split into the branch it was made on and its stripped
 *  subject, with no branch when the prefix is unrecognized. */
type ParsedStashMessage = {
  message: string;
  branch: string | null;
};

/** "WIP on main: b6afb12 subject" / "On main: message" → message + branch.
 *  Branch names may contain spaces, so the branch is the non-greedy span up to
 *  the first ": <sha> " / ": " delimiter; anything unrecognized is kept whole
 *  with no branch. */
function parseStashMessage(raw: string): ParsedStashMessage {
  const wip = /^WIP on (.+?): [0-9a-f]{7,40} (.*)$/.exec(raw);
  if (wip) return { message: wip[2] ?? "", branch: wip[1] ?? null };
  const on = /^On (.+?): (.*)$/.exec(raw);
  if (on) return { message: on[2] ?? "", branch: on[1] ?? null };
  return { message: raw, branch: null };
}

/** Validate + format a list index into the stash@{N} ref git expects. */
function stashRefFor(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new GitError(`Invalid stash index: ${index}`, null);
  }
  return `stash@{${index}}`;
}

/** Every stash, newest first. Uses an explicit --format with unit separators
 *  (the same scheme `log()` uses) so messages with colons or odd spacing
 *  survive untouched. */
export async function stashes(dir: string): Promise<GitStashEntry[]> {
  const root = await repoRoot(dir);
  if (!root) return [];
  const sep = "\x1f";
  const rec = "\x1e";
  const format = `%gd${sep}%gs${sep}%aI${sep}%ar${rec}`;
  const out = await git(root, ["stash", "list", `--format=${format}`]);

  const entries: GitStashEntry[] = [];
  for (const chunk of out.split(rec)) {
    const line = chunk.replace(/^\n/, "");
    if (!line.trim()) continue;
    const [ref, message, date, relative] = line.split(sep);
    const indexMatch = /^stash@\{(\d+)\}$/.exec(ref ?? "");
    if (!ref || !indexMatch) continue;
    const parsed = parseStashMessage(message ?? "");
    entries.push({
      index: Number(indexMatch[1]),
      ref,
      message: parsed.message,
      branch: parsed.branch,
      date: date ?? "",
      relative: relative ?? "",
    });
  }
  return entries;
}

/** Stash the working tree. Nothing to save is a no-op (git exits 0 and says
 *  so); `includeUntracked` also stashes untracked files. */
export async function stashPush(
  dir: string,
  opts?: { message?: string; includeUntracked?: boolean },
): Promise<void> {
  await withRepoMutation(dir, async () => {
    const root = await repoRoot(dir);
    if (!root) return;
    const args = ["stash", "push"];
    if (opts?.includeUntracked) args.push("-u");
    if (opts?.message?.trim()) args.push("-m", opts.message.trim());
    await git(root, args);
  });
}

/** Apply a stash entry by its list index; `pop` additionally drops it once the
 *  apply succeeds (git's own pop semantics — a conflicted pop keeps the stash).
 *  A conflicted apply writes its report to stdout, not stderr, so the surfaced
 *  error prefers that captured output. */
export async function stashApply(
  dir: string,
  index: number,
  opts?: { pop?: boolean },
): Promise<void> {
  await withRepoMutation(dir, async () => {
    const root = await repoRoot(dir);
    if (!root) return;
    const ref = stashRefFor(index);
    try {
      await git(root, opts?.pop ? ["stash", "pop", ref] : ["stash", "apply", ref]);
    } catch (error) {
      if (error instanceof GitError) {
        const conflictReport = error.stdout.trim();
        if (conflictReport) throw new GitError(conflictReport, error.code);
      }
      throw error;
    }
  });
}

export async function stashDrop(dir: string, index: number): Promise<void> {
  await withRepoMutation(dir, async () => {
    const root = await repoRoot(dir);
    if (!root) return;
    await git(root, ["stash", "drop", stashRefFor(index)]);
  });
}
