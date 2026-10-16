import type { InjectionKey } from "vue";

// Where an image in an agent reply comes from, decided before anything loads.
//
// `direct` sources load as written. `local` ones are files on disk: the
// renderer can't load a path itself, so it asks the desktop shell to vouch for
// the file and shows the URL it gets back. `blocked` never loads — a home-
// relative path (the renderer has no home to expand it against), a scheme
// nothing here serves, or a relative path with no folder to resolve it in.

export type ImageSource =
  | { kind: "direct"; src: string }
  | { kind: "local"; path: string }
  | { kind: "blocked" };

/** The thread's working directory, for the images in its replies. Provided by
 *  the thread view; absent wherever a reply has no folder of its own. */
export const IMAGE_CWD_KEY: InjectionKey<() => string | null> = Symbol("markdown-image-cwd");

/** The thread the reply belongs to. The desktop shell checks a local image
 *  against that thread's folder as it has it on record; the cwd above only
 *  turns a relative path into an absolute one. */
export const IMAGE_THREAD_KEY: InjectionKey<() => string | null> = Symbol("markdown-image-thread");

/** A context that can serve files the renderer can't reach itself — a repo
 *  checkout showing its README. Given a Markdown image `src`, it answers a URL
 *  to show or null when it can't reach the file. Provided by such a context;
 *  where none is provided, `MarkdownImage` falls back to loading the source
 *  directly, or asking the desktop shell to vouch for a thread's local file. */
export type MarkdownImageResolver = (src: string) => Promise<string | null>;
export const IMAGE_RESOLVER_KEY: InjectionKey<MarkdownImageResolver> = Symbol("markdown-image-resolver");

const DIRECT_SCHEMES = new Set(["https", "data", "blob", "attachment", "kone-page"]);
const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/;

const BLOCKED: ImageSource = { kind: "blocked" };

/** Markdown percent-encodes the link it parses (a space becomes %20); the file
 *  on disk has the decoded name. A malformed escape is left as written. */
function decodePath(p: string): string {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

/** `rel` joined onto `base`, with `.` and `..` segments folded away. Written in
 *  whichever separator the base uses, so a Windows folder stays one. */
function joinPath(base: string, rel: string): string {
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  const out: string[] = [];
  for (const seg of `${base}${sep}${rel}`.split(/[\\/]/)) {
    if (seg === ".") continue;
    if (seg === "..") {
      if (out.length > 1) out.pop();
      continue;
    }
    if (seg === "" && out.length > 0) continue;
    out.push(seg);
  }
  const joined = out.join(sep);
  return joined === "" ? sep : joined;
}

function fromFileUrl(src: string): ImageSource {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return BLOCKED;
  }
  // A file on another machine is a network read, not a local image.
  if (url.hostname !== "" && url.hostname !== "localhost") return BLOCKED;
  const p = decodePath(url.pathname);
  if (p === "" || p === "/") return BLOCKED;
  // file:///C:/x.png names a drive path; the slash before the drive isn't part of it.
  return { kind: "local", path: /^\/[a-zA-Z]:\//.test(p) ? p.slice(1) : p };
}

export function classifyImageSource(raw: string, cwd?: string | null): ImageSource {
  const src = raw.trim();
  if (src === "" || src.startsWith("#") || src.startsWith("?")) return BLOCKED;
  if (src.startsWith("~")) return BLOCKED;
  // `//host/x` and `\\host\x` reach across the network, not into a folder.
  if (src.startsWith("//") || src.startsWith("\\\\")) return BLOCKED;

  // Before the scheme test: `C:` would otherwise read as one.
  if (WINDOWS_DRIVE.test(src)) return { kind: "local", path: decodePath(src) };

  const scheme = SCHEME.exec(src)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    if (DIRECT_SCHEMES.has(scheme)) return { kind: "direct", src };
    if (scheme === "file") return fromFileUrl(src);
    return BLOCKED;
  }

  if (src.startsWith("/")) return { kind: "local", path: decodePath(src) };

  if (!cwd) return BLOCKED;
  return { kind: "local", path: joinPath(cwd, decodePath(src)) };
}

/** Fold `rel` onto the repo-relative `base`, giving the repo-relative path to
 *  read. `..` pops a real folder and never climbs above the root: a path that
 *  would escape it yields null instead of a path outside the repo. */
function joinRepo(base: string, rel: string): string | null {
  const out: string[] = [];
  for (const part of `${base}/${rel}`.split(/[\\/]/)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.length > 0 ? out.join("/") : null;
}

/** Resolve a Markdown image `src` against the folder of the document it lives
 *  in, giving the repo-relative path a checkout can read — or null when the src
 *  is not a repo file at all (a remote/data source, a fragment, a protocol-
 *  relative or home-relative path, an absolute file URL). A leading `/` is
 *  repo-root-relative, exactly as GitHub reads it. */
export function repoImagePath(baseDir: string, rawSrc: string): string | null {
  const src = rawSrc.trim();
  if (src === "" || src.startsWith("#") || src.startsWith("?") || src.startsWith("~")) return null;
  if (classifyImageSource(src, null).kind === "direct") return null;
  if (/^file:/i.test(src) || src.startsWith("//") || src.startsWith("\\\\")) return null;
  const clean = src.split(/[?#]/)[0] ?? "";
  if (clean.startsWith("/")) return joinRepo("", clean.slice(1));
  if (WINDOWS_DRIVE.test(clean)) return null;
  return joinRepo(baseDir, decodePath(clean));
}
