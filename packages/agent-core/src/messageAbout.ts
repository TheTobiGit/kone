// What a message refers to, checked when it is opened.
//
// An instruction about a branch goes stale the moment the branch moves: a
// relay that says "fix the review findings on p3 at 4c1e" is wrong once
// someone else already pushed the fix. A message may name the branch and
// commit it is about; when its recipient opens it, kone reads the branch's tip
// and says how far it has moved since, so the recipient checks before acting.
//
// Synchronous on purpose: it runs where a hand-over renders its turn, which
// is synchronous, and only for the few messages that carry an `about`. Each
// git call is capped, and any failure says nothing rather than something
// wrong.

import { execFileSync } from "node:child_process";

import type { MessageAbout } from "./store/agentInbox.js";

const GIT_TIMEOUT_MS = 1500;

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** Whether `git` exits 0 for these arguments. */
function gitSucceeds(cwd: string, args: string[]): boolean {
  return git(cwd, args) !== null;
}

const short = (sha: string): string => sha.slice(0, 7);

/**
 * How far `about.branch` has moved past `about.commit`, in the repository at
 * `cwd`, as one line for the recipient — or null when it has not moved, or
 * kone cannot tell (no repository, an unknown commit, git unavailable).
 */
export function describeAboutDrift(cwd: string, about: MessageAbout): string | null {
  const ref = `${about.branch} at ${short(about.commit)}`;
  const commit = git(cwd, ["rev-parse", "--verify", "--quiet", `${about.commit}^{commit}`]);
  if (!commit) return null;
  const tip = git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${about.branch}^{commit}`]);
  if (!tip) return `This message is about ${ref}, and that branch no longer exists. Check what replaced it before acting on this.`;
  if (tip === commit) return null;
  if (!gitSucceeds(cwd, ["merge-base", "--is-ancestor", commit, tip])) {
    return `This message is about ${ref}, but the branch was rewritten since: that commit is no longer on it (tip ${short(tip)}). Check the branch before acting on this.`;
  }
  const ahead = Number(git(cwd, ["rev-list", "--count", `${commit}..${tip}`]));
  if (!Number.isFinite(ahead) || ahead <= 0) return null;
  return `This message is about ${ref}; the branch has moved ${ahead} commit${ahead === 1 ? "" : "s"} past it since (tip ${short(tip)}). Check what changed before acting on this.`;
}

/** A message's words, followed by how far the branch it is about has moved
 *  since it was sent, when it has. */
export function withDrift(m: { message: string; aboutDrift?: string }): string {
  return m.aboutDrift ? `${m.message}\n(kone: ${m.aboutDrift})` : m.message;
}
