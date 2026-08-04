import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { GitError, git, repoRoot, safeRepoPath } from "./core.js";
import { GIT_CONTRIBUTOR_CAP } from "./types.js";
import type { GitContributor, GitContributors, GitIdentity, GitLogo, GitReadme } from "./types.js";

// The About section of the git space — the repository's presentation surface:
// its README, its identity (git config), and a logo. Everything here is a
// cheap local read from the working tree (no network, no gh), so it lives in
// the git module rather than the GitHub surface. The "nothing here" states
// are normal: every entry point resolves to null instead of throwing.

const README_CAP = 512 * 1024;
const LOGO_CAP = 512 * 1024;

// README candidates, best first. The root candidates match the root listing
// case-insensitively (a repo that ships `readme.md` still counts); the nested
// ones are looked up the same way inside their folder.
const ROOT_README_NAMES = [
  "README.md",
  "README.markdown",
  "README.rst",
  "README.txt",
  "README",
  "readme.md",
];
const NESTED_README_PATHS = ["docs/README.md", ".github/README.md"];

// Logo candidates, best first. These are exact repo-relative paths; the
// README-image fallback below covers the logos that live in odd places.
const LOGO_CANDIDATES = [
  "public/logo.svg",
  "public/logo.png",
  "public/icon.svg",
  "public/icon.png",
  "assets/logo.svg",
  "assets/logo.png",
  ".github/logo.png",
  ".github/logo.svg",
  "docs/logo.png",
  "build/icon.png",
  "apps/desktop/build/icon.png",
];

const LOGO_MIME: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/** Case-insensitive lookup of `wanted` among `dir`'s entries, returning the
 *  on-disk (real-case) name — or null when the folder is unreadable or lacks it. */
async function matchEntry(dir: string, wanted: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const needle = wanted.toLowerCase();
  return entries.find((name) => name.toLowerCase() === needle) ?? null;
}

/** Locate the repo's README. Returns its repo-relative path with the on-disk
 *  case, or null when there is none. Shared by `readme` and the logo fallback. */
async function findReadme(root: string): Promise<string | null> {
  for (const name of ROOT_README_NAMES) {
    const real = await matchEntry(root, name);
    if (real) return real;
  }
  for (const rel of NESTED_README_PATHS) {
    const dir = path.dirname(rel);
    const real = await matchEntry(path.join(root, dir), path.basename(rel));
    if (real) return `${dir}/${real}`;
  }
  return null;
}

/** The repo's README, capped at 512 KB (cut back to a line boundary, then
 *  `\n\n…`). Null when the repo has no README — a normal state, not an error. */
export async function readme(dir: string): Promise<GitReadme | null> {
  const root = await repoRoot(dir);
  if (!root) return null;
  const rel = await findReadme(root);
  if (!rel) return null;
  const abs = safeRepoPath(root, rel);
  if (abs === null) return null;
  let buf: Buffer;
  try {
    buf = await readFile(abs);
  } catch {
    // Unreadable (a broken pipe of a symlink, permissions…) — treat as absent.
    return null;
  }
  // Binary bytes have no markdown worth rendering.
  if (buf.includes(0)) return null;
  const truncated = buf.length > README_CAP;
  let slice = truncated ? buf.subarray(0, README_CAP) : buf;
  if (truncated) {
    // Cut back to the last line boundary so the visible text never ends on a
    // clipped line, then mark the cut.
    const lastNl = slice.lastIndexOf(0x0a);
    if (lastNl > 0) slice = slice.subarray(0, lastNl);
  }
  let markdown = slice.toString("utf8");
  if (truncated) markdown += "\n\n…";
  return { path: rel, markdown };
}

/** One `git config <key>` read. git exits 1 when the key is unset — that is
 *  "no value", not a failure. Any other exit stays an error. */
async function configValue(root: string, key: string): Promise<string | null> {
  try {
    const value = (await git(root, ["config", key])).trim();
    return value.length > 0 ? value : null;
  } catch (error) {
    if (error instanceof GitError && error.code === 1) return null;
    throw error;
  }
}

/** The user git will attribute work to in this repo — `git config user.name` /
 *  `user.email` run at the repo root, so repo-local config overrides global. */
export async function identity(dir: string): Promise<GitIdentity> {
  const root = await repoRoot(dir);
  if (!root) return { name: null, email: null };
  const [name, email] = await Promise.all([
    configValue(root, "user.name"),
    configValue(root, "user.email"),
  ]);
  return { name, email };
}

/** The first image src in a README that points at a repo-local file, or null.
 *  Accepts inline markdown `![alt](src)` and `<img src="…">`; absolute
 *  http(s)/data URLs, protocol-relative URLs and reference-style images are
 *  skipped. Fragments/queries (`logo.png?raw=true`) are stripped. */
function firstLocalImageSrc(markdown: string): string | null {
  const hits: { src: string; index: number }[] = [];
  const markdownRe = /!\[[^\]]*\]\(([^)\s]+)["'\s]?[^)]*\)/g;
  for (let m: RegExpExecArray | null; (m = markdownRe.exec(markdown)) !== null; ) {
    hits.push({ src: m[1]!, index: m.index });
  }
  const htmlRe = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  for (let m: RegExpExecArray | null; (m = htmlRe.exec(markdown)) !== null; ) {
    hits.push({ src: m[1] ?? m[2] ?? "", index: m.index });
  }
  // The "first image" is the first of either form in document order.
  hits.sort((a, b) => a.index - b.index);
  for (const hit of hits) {
    const src = hit.src.trim().split(/[?#]/)[0]!.trim();
    if (!src) continue;
    // A scheme (http:, https:, data:, …) or `//` means it is not a repo file.
    if (/^(?:[a-z]+:|\/\/)/i.test(src)) continue;
    return src;
  }
  return null;
}

/** Read a repo-relative logo into a base64 data URL, or null when it is
 *  missing, unreadable, has an unmapped extension, or exceeds the 512 KB cap
 *  (a truncated image is broken — oversize means "doesn't qualify"). */
async function readLogoDataUrl(root: string, relPath: string): Promise<string | null> {
  const abs = safeRepoPath(root, relPath);
  if (abs === null) return null;
  const ext = path.extname(relPath).slice(1).toLowerCase();
  const mime = LOGO_MIME[ext];
  if (!mime) return null;
  let buf: Buffer;
  try {
    buf = await readFile(abs);
  } catch {
    return null;
  }
  if (buf.length === 0 || buf.length > LOGO_CAP) return null;
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/** The repo's logo: the first hit from the known candidate paths, else the
 *  README's first image that points at a repo-local file (resolved against the
 *  README's directory, and rejected if it escapes the repo root). Null when
 *  nothing qualifies. */
export async function logo(dir: string): Promise<GitLogo | null> {
  const root = await repoRoot(dir);
  if (!root) return null;
  for (const rel of LOGO_CANDIDATES) {
    const dataUrl = await readLogoDataUrl(root, rel);
    if (dataUrl) return { path: rel, dataUrl };
  }
  const repoReadme = await readme(dir);
  if (!repoReadme) return null;
  const src = firstLocalImageSrc(repoReadme.markdown);
  if (!src) return null;
  const rel = path.posix.normalize(path.posix.join(path.posix.dirname(repoReadme.path), src));
  const dataUrl = await readLogoDataUrl(root, rel);
  return dataUrl ? { path: rel, dataUrl } : null;
}

/** The repository's contributors, from `git shortlog`. The git source is
 *  always available — no network, no gh — at the price of having no avatars:
 *  it can only name people by the email they committed with. Never throws:
 *  a repo with no commits, or no repo at all, is just nobody. */
export async function contributors(dir: string): Promise<GitContributors> {
  const root = await repoRoot(dir);
  if (!root) return { source: "git", people: [], total: 0 };
  let out: string;
  try {
    // `-e` adds the email to the count line. git shortlog honours `.mailmap`,
    // which merges one human's several emails into a single person — that is
    // the point (count people, not raw addresses), not noise to strip.
    // --max-count=50000 bounds the history walk so a giant repo can't freeze
    // the About section counting every commit it ever made.
    out = await git(root, ["shortlog", "-sne", "--no-merges", "--max-count=50000", "HEAD"]);
  } catch {
    // HEAD doesn't exist before the first commit — no commits, no contributors.
    return { source: "git", people: [], total: 0 };
  }
  const people: GitContributor[] = [];
  for (const rawLine of out.split("\n")) {
    // "   164\tGideon Sarfo <aemonsarfo@outlook.com>" — leading spaces, count,
    // TAB, name, space, angle-bracketed email. A line that doesn't match (a
    // name git couldn't render) is skipped rather than failing the list.
    const m = /^(\d+)\t(.+?) <(.+)>$/.exec(rawLine.trim());
    if (!m) continue;
    people.push({
      name: m[2]!,
      login: null,
      email: m[3]!,
      avatarDataUrl: null,
      commits: Number(m[1]),
    });
  }
  // `-n` already sorts by count, but sort again so the cap is exactly the top
  // people regardless of how git ordered ties.
  people.sort((a, b) => b.commits - a.commits);
  return { source: "git", people: people.slice(0, GIT_CONTRIBUTOR_CAP), total: people.length };
}
