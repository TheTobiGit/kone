import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Local images in agent replies.
 *
 * An agent that takes a screenshot writes `![shot](/tmp/shot.png)`, and the
 * reply should show it. The renderer is not given a way to read a path: it asks
 * main to vouch for one, and main checks the file *then* — real path, regular
 * file, image extension, inside a folder the thread may show — and hands back an
 * opaque `local-image://<token>`. Serving the token reads only the file that was
 * checked. A token names one file, expires, and stops working if the file at
 * that path is swapped for another one after the check.
 *
 * The folders a thread may show are its own repository (or its working
 * directory, outside a repo) and the system temp folders, which is where agents
 * leave screenshots. Everything else — the home folder, `/etc`, a symlink out of
 * the workspace — is refused.
 */

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".bmp", ".ico",
]);

/** Long enough for a reply to be read and scrolled back to; short enough that a
 *  leaked token is soon worthless. A reply that outlives it re-grants. */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

type Grant = { realPath: string; dev: number; ino: number; expiresAt: number };

export type LocalImageGrantsOptions = {
  now?: () => number;
  ttlMs?: number;
  /** The temp folders images may come from. Defaults to the system's own. */
  tmpRoots?: () => string[];
  /** A thread's working directory, read from main's own records. The renderer
   *  names only the thread: a folder it supplied could be any folder, and would
   *  open every image under it. Absent, only the temp folders are allowed. */
  threadCwd?: (threadId: string) => string | null;
};

function defaultTmpRoots(): string[] {
  const roots = [os.tmpdir()];
  if (process.env.TMPDIR) roots.push(process.env.TMPDIR);
  // On macOS os.tmpdir() is the per-user /var/folders one, but tools still
  // write to /tmp itself.
  if (process.platform === "darwin") roots.push("/tmp");
  return roots;
}

/** Strictly inside `root`: `..`-free and not absolute once made relative. The
 *  root itself is not inside — it is a folder, never the image. */
export function isPathInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (rel === "" || path.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

/** The nearest folder at or above `dir` holding a `.git` (a directory, or a file
 *  for worktrees and submodules), or null when `dir` is not in a repository. */
async function findGitRoot(dir: string): Promise<string | null> {
  let current = dir;
  for (;;) {
    try {
      await stat(path.join(current, ".git"));
      return current;
    } catch {
      // Not here; keep climbing.
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** The folder a thread's images may come from: its repository, or its working
 *  directory outside one. Never the filesystem root or the home folder itself —
 *  a thread run from either would otherwise open the whole disk. */
async function workspaceRoot(cwd: string | null | undefined): Promise<string | null> {
  if (!cwd || !path.isAbsolute(cwd)) return null;
  const real = await realpathOrNull(cwd);
  if (real === null) return null;
  const root = (await findGitRoot(real)) ?? real;
  const home = await realpathOrNull(os.homedir());
  if (root === path.parse(root).root || root === home) return null;
  return root;
}

export function createLocalImageGrants(options: LocalImageGrantsOptions = {}) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const tmpRoots = options.tmpRoots ?? defaultTmpRoots;
  const threadCwd = options.threadCwd ?? (() => null);
  const grants = new Map<string, Grant>();

  function prune(): void {
    const t = now();
    for (const [token, g] of grants) if (g.expiresAt <= t) grants.delete(token);
  }

  async function allowedRoots(threadId: string | null | undefined): Promise<string[]> {
    const candidates = await Promise.all(tmpRoots().map(realpathOrNull));
    const roots = candidates.filter((r): r is string => r !== null);
    const ws = await workspaceRoot(threadId ? threadCwd(threadId) : null);
    if (ws !== null) roots.push(ws);
    return roots;
  }

  /** Vouch for an image file and return the URL that serves it, or null when
   *  the path fails any check. Every refusal answers the same way, so the
   *  renderer can't use this to learn what exists on disk. */
  async function grant(requested: string, threadId?: string | null): Promise<string | null> {
    if (!requested || requested.includes("\0") || !path.isAbsolute(requested)) return null;
    const real = await realpathOrNull(requested);
    if (real === null) return null;
    // Checked on the real path: `shot.png` symlinked to `/etc/hosts` is a text file.
    if (!IMAGE_EXTENSIONS.has(path.extname(real).toLowerCase())) return null;

    let info;
    try {
      info = await stat(real);
    } catch {
      return null;
    }
    if (!info.isFile()) return null;

    const roots = await allowedRoots(threadId);
    if (!roots.some((root) => isPathInside(root, real))) return null;

    prune();
    const token = randomUUID();
    grants.set(token, { realPath: real, dev: info.dev, ino: info.ino, expiresAt: now() + ttlMs });
    return `local-image://${token}`;
  }

  /** The file a `local-image://<token>` URL serves, or null when the token is
   *  unknown, expired, or the file at its path is no longer the one checked. */
  async function resolve(requestUrl: string): Promise<string | null> {
    let url: URL;
    try {
      url = new URL(requestUrl);
    } catch {
      return null;
    }
    if (url.protocol !== "local-image:") return null;

    const g = grants.get(url.hostname);
    if (!g) return null;
    if (g.expiresAt <= now()) {
      grants.delete(url.hostname);
      return null;
    }

    try {
      const info = await stat(g.realPath);
      if (!info.isFile() || info.dev !== g.dev || info.ino !== g.ino) return null;
    } catch {
      return null;
    }
    return g.realPath;
  }

  return { grant, resolve };
}
