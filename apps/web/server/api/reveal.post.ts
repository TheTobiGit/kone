import { execFile } from "node:child_process";

// Dev fallback for reveal-in-file-manager (desktop uses the Electron bridge).
// execFile + arg array (never a shell string) so paths can't inject.
export default defineEventHandler(async (event) => {
  const { path } = await readBody<{ path?: string }>(event);
  if (!path) return { ok: false };

  const [cmd, args] =
    process.platform === "darwin"
      ? (["open", [path]] as const)
      : process.platform === "win32"
        ? (["explorer", [path]] as const)
        : (["xdg-open", [path]] as const);

  try {
    await new Promise<void>((resolve, reject) => {
      execFile(cmd, [...args], (err) => (err ? reject(err) : resolve()));
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
});
