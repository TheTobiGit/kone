import path from "node:path";

// The per-user state directory, injected once at startup instead of read from
// Electron's `app.getPath("userData")` at every call site.
//
// Why: this was the only thing the agent stores needed Electron for, and it was
// enough to make the whole layer un-runnable outside the Electron runtime — the
// tests each had to stand up a fake `app` object to load a store at all. Main
// resolves the real path once (see main.ts) and hands it down; a test hands down
// a temp dir. Everything else under `agent/` is now plain Node, except `ipc.ts`,
// which is the renderer bridge itself and stays Electron-coupled by definition.

let userDataDir: string | null = null;

/** Set the per-user state directory. Called once, before any store is used. */
export function setUserDataDir(dir: string): void {
  userDataDir = dir;
}

/** The per-user state directory. Throws if the host never injected one — that's
 *  a wiring bug, and failing loudly beats silently writing to the wrong place. */
export function getUserDataDir(): string {
  if (!userDataDir) {
    throw new Error("User data directory not set — call setUserDataDir() during startup.");
  }
  return userDataDir;
}

/** Join a path under the per-user state directory. */
export function userDataPath(...segments: string[]): string {
  return path.join(getUserDataDir(), ...segments);
}
