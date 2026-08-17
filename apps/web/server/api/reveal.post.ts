import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import nodePath from "node:path";

// Dev fallback for reveal-in-file-manager (desktop uses the Electron bridge).
// execFile + arg array (never a shell string) so paths can't inject.
export default defineEventHandler(async (event) => {
  const { path } = await readBody<{ path?: string }>(event);
  if (typeof path !== "string" || path.trim() === "") return { ok: false };

  const resolved = nodePath.resolve(path);

  let stats;
  try {
    stats = await stat(resolved);
  } catch {
    return { ok: false };
  }

  const [cmd, args] = stats.isDirectory()
    ? process.platform === "darwin"
      ? (["open", [resolved]] as const)
      : process.platform === "win32"
        ? (["explorer", [resolved]] as const)
        : (["xdg-open", [resolved]] as const)
    : // A file must not be launched with its default app; reveal it in the
      // file manager instead. Linux's xdg-open has no select-in-folder flag,
      // so opening the parent directory is the reveal.
      process.platform === "darwin"
      ? (["open", ["-R", resolved]] as const)
      : process.platform === "win32"
        ? (["explorer", ["/select,", resolved]] as const)
        : (["xdg-open", [nodePath.dirname(resolved)]] as const);

  try {
    await new Promise<void>((resolve, reject) => {
      execFile(cmd, [...args], (err) => (err ? reject(err) : resolve()));
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
});
