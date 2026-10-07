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
