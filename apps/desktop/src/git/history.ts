import { GitError, git, repoRoot, safeRepoPath } from "./core.js";
import { parseFileDiff } from "./diff.js";
import type {
  GitBranch,
  GitCommit,
  GitCommitDetail,
  GitCommitFile,
  GitFileDiff,
  GitFileStatus,
} from "./types.js";

export async function branches(dir: string): Promise<GitBranch[]> {
  const root = await repoRoot(dir);
  if (!root) return [];
  const out = await git(root, [
    "for-each-ref",
    "--format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)",
    "refs/heads",
    "refs/remotes",
  ]);

  const result: GitBranch[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [name, head, upstream, track] = line.split("\0");
    if (!name) continue;
    // Skip the symbolic "origin/HEAD -> origin/main" pointer.
    if (name.endsWith("/HEAD")) continue;

    const remote = name.includes("/") && !upstream && head !== "*";
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
    result.push(branch);
  }
  return result;
}

export async function log(dir: string, limit = 50, skip = 0): Promise<GitCommit[]> {
  const root = await repoRoot(dir);
  if (!root) return [];
  const sep = "\x1f"; // field separator (unit sep)
  const rec = "\x1e"; // record separator
  const format = ["%H", "%h", "%s", "%an", "%ae", "%aI", "%ar"].join(sep) + rec;

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
      `--pretty=format:${format}`,
    ]);
  } catch (error) {
    // An unborn branch (no commits yet) has no log — treat as empty.
    if (error instanceof GitError) return [];
    throw error;
  }

  const commits: GitCommit[] = [];
  for (const chunk of out.split(rec)) {
    const line = chunk.replace(/^\n/, "");
    if (!line.trim()) continue;
    const [hash, short, subject, author, email, date, relative] =
      line.split(sep);
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
 *  counts from --numstat; both with -z so spaces (and tabs) in paths survive.
 *  With -z, numstat prints a rename as "added\tdeleted\t\0from\0to\0" — an
 *  entry whose path slot is empty, followed by two path records — while a
 *  plain entry is the single record "added\tdeleted\tpath\0". Binary files
 *  report "-\t-". */
async function commitFiles(
  root: string,
  base: string,
  head: string,
): Promise<GitCommitFile[]> {
  const [nameOut, numOut] = await Promise.all([
    git(root, ["diff", "--name-status", "-z", "--find-renames", base, head]),
    git(root, ["diff", "--numstat", "-z", "--find-renames", base, head]),
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
  const numFields = numOut.split("\0");
  for (let i = 0; i < numFields.length; i++) {
    const record = numFields[i];
    if (!record) continue;
    const tab1 = record.indexOf("\t");
    const tab2 = tab1 < 0 ? -1 : record.indexOf("\t", tab1 + 1);
    if (tab1 < 0 || tab2 < 0) continue;
    const addedRaw = record.slice(0, tab1);
    const removedRaw = record.slice(tab1 + 1, tab2);
    let path = record.slice(tab2 + 1);
    let from: string | undefined;
    if (path.length === 0) {
      // Rename/copy head: the path slot is empty; the from and to paths are
      // the next two records.
      from = numFields[i + 1] ?? undefined;
      path = numFields[i + 2] ?? "";
      i += 2;
    }
    if (!path) continue;
    const meta = metaByPath.get(path);
    const binary = addedRaw === "-" && removedRaw === "-";
    files.push({
      path,
      ...(from !== undefined ? { from } : {}),
      status: meta?.status ?? "modified",
      added: binary ? 0 : Number(addedRaw) || 0,
      removed: binary ? 0 : Number(removedRaw) || 0,
      binary,
    });
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
