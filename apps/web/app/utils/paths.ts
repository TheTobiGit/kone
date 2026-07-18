// Path display + join helpers, shared by the launcher flows (clone / create).

/** `/abs/path` → `~/path` for display, when it sits under `home`. */
export function collapseHome(path: string, home: string): string {
  if (!path) return "";
  if (!home) return path;
  if (path === home) return "~";
  if (path.startsWith(home + "/")) return "~" + path.slice(home.length);
  return path;
}

/** Join a directory and a single segment with a POSIX separator. */
export function joinPath(dir: string, segment: string): string {
  if (!dir) return segment;
  return dir.endsWith("/") ? dir + segment : `${dir}/${segment}`;
}
