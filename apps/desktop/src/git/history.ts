import { GitError, git, repoRoot } from "./core.js";
import type { GitBranch, GitCommit } from "./types.js";

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

export async function log(dir: string, limit = 50): Promise<GitCommit[]> {
  const root = await repoRoot(dir);
  if (!root) return [];
  const sep = "\x1f"; // field separator (unit sep)
  const rec = "\x1e"; // record separator
  const format = ["%H", "%h", "%s", "%an", "%ae", "%aI", "%ar"].join(sep) + rec;

  // Fall back to the default for NaN / Infinity / non-positive values rather
  // than passing an invalid --max-count that git would reject.
  const max = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 50;

  let out: string;
  try {
    out = await git(root, [
      "log",
      `--max-count=${max}`,
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
