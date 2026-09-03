// Where the global assistant's sessions actually run.
//
// The assistant has no project, and `GLOBAL_ASSISTANT_PROJECT_PATH` says so: it
// is a sentinel, not a directory. That is the right identity to store and to
// scope tools by — an assistant thread is recognisable at a glance and can
// never collide with a real checkout — but it is not a place, and two things in
// the app need one anyway. A provider CLI is a child process, and a child
// process is spawned *in* a directory; so is the one-shot that names a thread.
// Handed the sentinel, both fail before they start.
//
// So the sentinel resolves here, and only here, to a directory the app owns: an
// empty folder under the per-user state directory, made on first use. Empty on
// purpose — the assistant's work is app steering through the gateway, not files
// on disk, and a session rooted at the state directory itself would be sitting
// on top of kone's own database.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GLOBAL_ASSISTANT_PROJECT_PATH } from "./conversationStoreTypes.js";
import { getUserDataDir } from "./userDataDir.js";

/** Resolved once: the answer cannot change while the app is up, and every
 *  spawn would otherwise re-run the mkdir. */
let workingDir: string | null = null;

/**
 * The assistant's own directory, created if it isn't there yet.
 *
 * Falls back to the home directory if it cannot be made — a session in the
 * wrong place still works, and an assistant that refuses to start because a
 * mkdir failed would be worse than one running a directory up.
 */
export function assistantWorkingDir(): string {
  if (workingDir) return workingDir;
  let dir: string;
  try {
    dir = path.join(getUserDataDir(), "assistant");
  } catch {
    // No host injected a state directory (a test, or a boot ordering slip):
    // the app's own dot-directory is the next most predictable place.
    dir = path.join(os.homedir(), ".kone", "assistant");
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.error("[assistant] could not create the assistant directory:", err);
    dir = os.homedir();
  }
  workingDir = dir;
  return workingDir;
}

/** Forget the resolved directory, so a test can point the state directory
 *  somewhere else and resolve again. The app resolves once and never moves. */
export function resetAssistantWorkingDirForTests(): void {
  workingDir = null;
}

/** Whether a project path is the assistant's sentinel rather than a checkout. */
export function isAssistantProjectPath(projectPath: string | null | undefined): boolean {
  return projectPath === GLOBAL_ASSISTANT_PROJECT_PATH;
}

/**
 * The directory to run a process in for a thread on `projectPath`.
 *
 * The identity in, a place out. Every project path but the assistant's is
 * already a place and comes back untouched, so this is safe to wrap around any
 * cwd on its way to a spawn.
 */
export function workingDirFor(projectPath: string): string {
  return isAssistantProjectPath(projectPath) ? assistantWorkingDir() : projectPath;
}
