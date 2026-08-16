import path from "node:path";

/**
 * Resolve an `app://` request URL to an absolute file path inside `rendererRoot`,
 * or null when the URL cannot be verified to point inside it.
 *
 * Every can't-verify branch fails closed and returns null. Serving a path we
 * cannot prove is inside the renderer would leak arbitrary host files: the
 * renderer root itself is built by join/resolve from trusted fixed segments,
 * so any `..` or absolute remainder is by construction outside it. The request
 * is percent-decoded only after URL parsing — an encoded slash is then a real
 * segment, and a decoded `..` is refused as a segment rather than being
 * resolved as a traversal — and the leftover relative path is re-based onto
 * the root with resolve, then re-checked to still sit under it. Missing files
 * are not our concern here: returning a contained path that does not yet exist
 * is correct, the caller's net.fetch 404s on its own.
 */
export function resolveAppProtocolPath(
  rendererRoot: string,
  requestUrl: string,
): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }

  if (pathname.includes("\0")) {
    return null;
  }

  const root = path.resolve(rendererRoot);

  if (pathname === "/" || pathname === "") {
    return path.join(root, "index.html");
  }

  // Split the decoded pathname *before* posix.normalize: normalize of an
  // absolute path collapses `/../../etc/passwd` to `/etc/passwd`, which would
  // re-anchor a traversal as a file under the renderer. A `..` segment in the
  // decoded request is a traversal we cannot prove stays inside the root, so
  // refuse it.
  const segments = pathname
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) {
    return null;
  }

  const relativeRequest = segments.join("/");
  if (relativeRequest === "") {
    return path.join(root, "index.html");
  }

  if (
    path.posix.isAbsolute(relativeRequest) ||
    path.win32.isAbsolute(relativeRequest)
  ) {
    return null;
  }

  const candidate = path.resolve(root, relativeRequest);
  if (
    candidate !== path.join(root, "index.html") &&
    !candidate.startsWith(root + path.sep)
  ) {
    return null;
  }

  return candidate;
}
