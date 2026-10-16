import { GitError, git, repoRoot, safeRepoPath } from "@kone/git-core/core.js";
import { parseFileDiff } from "./diff.js";
import { numstat } from "@kone/git-core/numstat.js";
import type {
  GitBranch,
  GitBranchCompare,
  GitCommit,
  GitCommitDetail,
  GitCommitFile,
  GitFileDiff,
  GitFileStatus,
} from "@kone/git-core/types.js";

export async function branches(dir: string): Promise<GitBranch[]> {
  const root = await repoRoot(dir);
  if (!root) return [];
  const out = await git(root, [
    "for-each-ref",
    // The full refname tells apart refs/remotes/* from refs/heads/* — the short
    // name alone can't, because a local branch like feature/login looks just
    // like origin/feature (both slash-bearing, both often upstream-less).
    "--format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)%00%(refname)%00%(objectname)%00%(committerdate:iso-strict)%00%(authorname)%00%(worktreepath)%00%(contents:subject)",
    "refs/heads",
    "refs/remotes",
  ]);

  const result: GitBranch[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [name, head, upstream, track, full, sha, date, author, worktree, subject] =
      line.split("\0");
    if (!name) continue;
    // Skip the symbolic "origin/HEAD -> origin/main" pointer.
    if (name.endsWith("/HEAD")) continue;

    const remote = (full ?? "").startsWith("refs/remotes/");
    const branch: GitBranch = {
      name,
      current: head === "*",
      remote,
    };
    if (upstream) branch.upstream = upstream;
    const ahead = track?.match(/ahead (\d+)/);
    const behind = track?.match(/behind (\d+)/);
    if (ahead) branch.ahead = Number(ahead[1]);
    if (behind) branch.behind = Number(behind[1]);
    // "[gone]": the upstream was deleted on the remote, usually after a merge.
    if (track?.includes("gone")) branch.gone = true;
    if (sha) branch.sha = sha;
    if (date) branch.date = date;
    if (author) branch.author = author;
    if (subject) branch.subject = subject;
    // Checked out in another worktree: git refuses to switch to it here.
    if (worktree && head !== "*") branch.worktree = worktree;
    result.push(branch);
  }

  const base = await defaultBranch(root, result);
  if (base) {
    for (const branch of result) {
      if (branch.name === base.local || branch.name === base.ref) branch.default = true;
    }
    const merged = await git(root, [
      "for-each-ref",
      `--merged=${base.ref}`,
      "--format=%(refname:short)",
      "refs/heads",
      "refs/remotes",
    ]).catch(() => "");
    const names = new Set(merged.split("\n").filter(Boolean));
    // A branch still sitting on the default's tip has nothing of its own yet,
    // so calling it merged would invite deleting work that hasn't started.
    const tip = result.find((b) => b.name === base.ref)?.sha;
    for (const branch of result) {
      if (!branch.default && names.has(branch.name) && branch.sha !== tip) branch.merged = true;
    }
  }
  return result;
}

/**
 * The branch the others are measured against: the remote's HEAD when the
 * clone recorded one, else a local main or master. `ref` is what merges are
 * checked against, so a stale local main doesn't hide merged work.
 */
async function defaultBranch(
  root: string,
  all: GitBranch[],
): Promise<{ local: string; ref: string } | null> {
  const names = new Set(all.map((b) => b.name));
  const head = (
    await git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).catch(
      () => "",
    )
  ).trim();
  if (head && names.has(head)) return { local: head.slice(head.indexOf("/") + 1), ref: head };
  for (const local of ["main", "master"]) {
    if (names.has(`origin/${local}`)) return { local, ref: `origin/${local}` };
    if (names.has(local)) return { local, ref: local };
  }
  return null;
}

const LOG_SEP = "\x1f"; // field separator (unit sep)
const LOG_REC = "\x1e"; // record separator
const LOG_FORMAT = ["%H", "%h", "%s", "%an", "%ae", "%aI", "%ar"].join(LOG_SEP) + LOG_REC;

function parseLog(out: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const chunk of out.split(LOG_REC)) {
    const line = chunk.replace(/^\n/, "");
    if (!line.trim()) continue;
    const [hash, short, subject, author, email, date, relative] =
      line.split(LOG_SEP);
    if (!hash) continue;
    commits.push({
      hash,
      short: short ?? hash.slice(0, 7),
      subject: subject ?? "",
      author: author ?? "",
      email: email ?? "",
      date: date ?? "",
      relative: relative ?? "",
    });
  }
  return commits;
}

export async function log(dir: string, limit = 50, skip = 0): Promise<GitCommit[]> {
  const root = await repoRoot(dir);
  if (!root) return [];

  // Fall back to the default for NaN / Infinity / non-positive values rather
  // than passing an invalid --max-count that git would reject.
  const max = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 50;
  const offset = Number.isFinite(skip) ? Math.max(0, Math.floor(skip)) : 0;

  let out: string;
  try {
    out = await git(root, [
      "log",
      `--max-count=${max}`,
      `--skip=${offset}`,
      `--pretty=format:${LOG_FORMAT}`,
    ]);
  } catch (error) {
    // An unborn branch (no commits yet) has no log — treat as empty.
    if (error instanceof GitError) return [];
    throw error;
  }
  return parseLog(out);
}

const COMPARE_LIMIT = 30;

/**
 * One branch against the default branch: how far apart they are, and the
 * branch's own commits (on it, not on the default), newest first. The default
 * branch itself, or a repo without one, gets its latest commits instead.
 * Refs are spelled out in full, so a name can be neither ambiguous nor an option.
 */
export async function branchCompare(
  dir: string,
  name: string,
  remote: boolean,
): Promise<GitBranchCompare | null> {
  const root = await repoRoot(dir);
  if (!root) return null;
  const ref = `${remote ? "refs/remotes" : "refs/heads"}/${name}`;
  const exists = await git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).then(
    () => true,
    () => false,
  );
  if (!exists) return null;

  const all = await branches(root);
  const base = await defaultBranch(root, all);
  const baseRef = base
    ? `${all.find((b) => b.name === base.ref)?.remote ? "refs/remotes" : "refs/heads"}/${base.ref}`
    : null;

  if (!base || !baseRef || baseRef === ref || (!remote && name === base.local)) {
    const out = await git(root, [
      "log",
      `--max-count=${COMPARE_LIMIT}`,
      `--pretty=format:${LOG_FORMAT}`,
      ref,
    ]);
    return { base: null, ahead: 0, behind: 0, commits: parseLog(out) };
  }

  const counts = (await git(root, ["rev-list", "--left-right", "--count", `${baseRef}...${ref}`])).trim();
  const [behind, ahead] = counts.split(/\s+/).map(Number);
  const out = await git(root, [
    "log",
    `--max-count=${COMPARE_LIMIT}`,
    `--pretty=format:${LOG_FORMAT}`,
    `${baseRef}..${ref}`,
  ]);
  return {
    base: base.ref,
    ahead: ahead || 0,
    behind: behind || 0,
    commits: parseLog(out),
  };
}

// The empty tree object — diffing against it turns "the initial commit" into
// "everything added", which is what a root commit's diffstat must read like.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Parent hashes of `rev` (space-separated), or null when the rev doesn't
 *  resolve to a commit. A root commit has no parents → []. */
async function parentsOf(root: string, rev: string): Promise<string[] | null> {
  let out: string;
  try {
    out = await git(root, ["log", "--max-count=1", "--pretty=format:%P", rev]);
  } catch (error) {
    if (error instanceof GitError) return null; // unknown rev
    throw error;
  }
  return out.trim() ? out.trim().split(" ").filter(Boolean) : [];
}

function statusFromCode(code: string): GitFileStatus {
  switch (code) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type-changed";
    default:
      return "modified";
  }
}

/** Per-file diffstat between two commits. Statuses come from --name-status,
 *  counts from --numstat; both read from -z output so spaces, tabs and newlines
 *  in paths survive. */
async function commitFiles(
  root: string,
  base: string,
  head: string,
): Promise<GitCommitFile[]> {
  const [nameOut, counts] = await Promise.all([
    git(root, ["diff", "--name-status", "-z", "--find-renames", base, head]),
    numstat(root, ["--find-renames", base, head]),
  ]);

  const metaByPath = new Map<string, { status: GitFileStatus; from?: string }>();
  const nameFields = nameOut.split("\0");
  for (let i = 0; i < nameFields.length; i++) {
    const code = nameFields[i];
    if (!code) continue;
    const letter = code[0] ?? "";
    const path = nameFields[i + 1];
    if (!path) continue;
    if (letter === "R" || letter === "C") {
      // "<R|C><score>\0<from>\0<to>\0" — two paths follow the status record.
      const to = nameFields[i + 2];
      i += 2;
      if (to) metaByPath.set(to, { status: statusFromCode(letter), from: path });
    } else {
      i += 1;
      metaByPath.set(path, { status: statusFromCode(letter) });
    }
  }

  const files: GitCommitFile[] = [];
  for (const entry of counts) {
    // numstat counts lines; --name-status says what actually happened to the
    // file. Both run --find-renames over the same pair of trees, so they agree
    // on which paths are a rename — only the status letter is worth taking here.
    const meta = metaByPath.get(entry.path);
    const file: GitCommitFile = {
      path: entry.path,
      status: meta?.status ?? "modified",
      added: entry.added,
      removed: entry.removed,
      binary: entry.binary,
    };
    if (entry.from !== undefined) file.from = entry.from;
    files.push(file);
  }
  return files;
}

/** One commit's metadata, body, parents and per-file diffstat. Null when `dir`
 *  isn't a repo or `hash` doesn't resolve. A merge commit diffs against its
 *  first parent; a root commit against the empty tree — both read as "what this
 *  commit introduced". */
export async function commitDetail(
  dir: string,
  hash: string,
): Promise<GitCommitDetail | null> {
  const root = await repoRoot(dir);
  if (!root) return null;
  const sep = "\x1f";
  const rec = "\x1e";
  const format = ["%H", "%h", "%s", "%an", "%ae", "%aI", "%ar", "%P", "%b"].join(sep) + rec;

  let out: string;
  try {
    out = await git(root, ["log", "--max-count=1", `--pretty=format:${format}`, hash]);
  } catch (error) {
    if (error instanceof GitError) return null;
    throw error;
  }
  const chunk = out.split(rec)[0]?.replace(/^\n/, "");
  if (!chunk?.trim()) return null;
  const [full, short, subject, author, email, date, relative, parentsRaw, body] =
    chunk.split(sep);
  if (!full) return null;

  const parents = (parentsRaw ?? "").split(" ").filter(Boolean);
  const base = parents[0] ?? EMPTY_TREE;
  const files = await commitFiles(root, base, full);
  let added = 0;
  let removed = 0;
  for (const file of files) {
    added += file.added;
    removed += file.removed;
  }
  return {
    commit: {
      hash: full,
      short: short ?? full.slice(0, 7),
      subject: subject ?? "",
      author: author ?? "",
      email: email ?? "",
      date: date ?? "",
      relative: relative ?? "",
    },
    body: body ?? "",
    parents,
    files,
    added,
    removed,
  };
}

/** The unified diff of ONE file inside a commit, parsed into the same
 *  GitFileDiff shape the working-tree diff produces. Null when `dir` isn't a
 *  repo, `hash` doesn't resolve, the path escapes the repo, or the commit
 *  doesn't touch the path. A file renamed in the commit diffs against its
 *  original path too — rename detection needs both endpoints in the pathspec,
 *  otherwise the diff would read as a plain add. */
export async function commitDiff(
  dir: string,
  hash: string,
  path: string,
): Promise<GitFileDiff | null> {
  const root = await repoRoot(dir);
  if (!root) return null;
  if (safeRepoPath(root, path) === null) return null;
  const parents = await parentsOf(root, hash);
  if (parents === null) return null;
  const base = parents[0] ?? EMPTY_TREE;

  // If the file was renamed (or copied) into `path` in this commit, include
  // its original path in the pathspec so git can pair the two sides.
  let pathspec = [path];
  try {
    const names = (
      await git(root, ["diff", "--name-status", "-z", "--find-renames", base, hash])
    ).split("\0");
    for (let i = 0; i < names.length; i++) {
      const code = names[i] ?? "";
      const from = names[i + 1];
      if (!code || !from) continue;
      if (code[0] !== "R" && code[0] !== "C") {
        i += 1;
        continue;
      }
      const to = names[i + 2];
      i += 2;
      if (to === path && from) pathspec = [from, path];
    }
  } catch {
    // Rename scan failed — fall back to the plain single-path diff.
  }

  let out: string;
  try {
    out = await git(root, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--find-renames",
      base,
      hash,
      "--",
      ...pathspec,
    ]);
  } catch (error) {
    if (error instanceof GitError) return null;
    throw error;
  }
  if (!out.trim()) return null;
  return parseFileDiff(path, out);
}
