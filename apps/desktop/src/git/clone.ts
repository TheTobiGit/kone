import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { GitError, exists, lastStderrLine } from "./core.js";
import type { CloneProgress, CloneResult } from "./types.js";

// `git clone --progress` narrates its work on stderr, updating a line in place
// with `\r` as each phase advances. We parse those percentages and fold them
// onto a single 0..1 ramp — each phase owns a band, weighted by how long it
// actually takes (receiving objects is the long middle stretch), so the bar
// moves at a believable pace rather than snapping between phases.

const CLONE_PHASES: { re: RegExp; lo: number; hi: number; label: string }[] = [
  { re: /Counting objects:\s+(\d+)%/, lo: 0.0, hi: 0.1, label: "Counting objects…" },
  { re: /Compressing objects:\s+(\d+)%/, lo: 0.1, hi: 0.25, label: "Compressing objects…" },
  { re: /Receiving objects:\s+(\d+)%/, lo: 0.25, hi: 0.9, label: "Receiving objects…" },
  { re: /Resolving deltas:\s+(\d+)%/, lo: 0.9, hi: 0.98, label: "Resolving deltas…" },
  { re: /(?:Updating|Checking out) files:\s+(\d+)%/, lo: 0.98, hi: 1.0, label: "Checking out files…" },
];

/** Fold a chunk of clone stderr into the latest progress tick, or null when the
 *  chunk holds no recognizable phase update. Bands are monotonic, so the last
 *  match in the chunk is always the furthest along. */
function parseCloneProgress(chunk: string): CloneProgress | null {
  let latest: CloneProgress | null = null;
  for (const line of chunk.split(/[\r\n]+/)) {
    for (const phase of CLONE_PHASES) {
      const m = line.match(phase.re);
      if (m) {
        const pct = Number(m[1]) / 100;
        latest = {
          progress: phase.lo + (phase.hi - phase.lo) * pct,
          stage: phase.label,
        };
      }
    }
  }
  return latest;
}

// The one clone in flight, so `cancelClone` can reach it to abort. Only one
// clone runs at a time (the UI enforces it), so a single slot is enough.
let inFlight: { abort: () => void } | null = null;

/** Clone `url` into `dest` (an absolute path that must not already exist),
 *  reporting progress as each phase advances. Resolves with the created folder;
 *  rejects (GitError) on any git failure — bad URL, auth, network, existing dir,
 *  or a `cancelClone()` abort. */
export function clone(
  url: string,
  dest: string,
  onProgress: (p: CloneProgress) => void,
): Promise<CloneResult> {
  return new Promise((resolve, reject) => {
    void (async () => {
      const target = path.resolve(dest);
      if (await exists(target)) {
        reject(
          new GitError(`A folder already exists at ${target}`, null),
        );
        return;
      }
      try {
        await mkdir(path.dirname(target), { recursive: true });
      } catch (error) {
        reject(new GitError((error as Error).message, null));
        return;
      }

      onProgress({ progress: 0, stage: "Connecting to github.com…" });

      const child = spawn("git", ["clone", "--progress", url, target], {
        env: {
          ...process.env,
          LC_ALL: "C",
          // Never block on an interactive credential prompt for a private repo;
          // fail fast so the UI can surface the auth error instead of hanging.
          GIT_TERMINAL_PROMPT: "0",
        },
        windowsHide: true,
      });

      let aborted = false;
      inFlight = {
        abort: () => {
          aborted = true;
          child.kill("SIGTERM");
        },
      };

      let stderr = "";
      child.stderr.on("data", (buf: Buffer) => {
        const text = buf.toString();
        stderr += text;
        const tick = parseCloneProgress(text);
        if (tick) onProgress(tick);
      });
      child.on("error", (error) => {
        inFlight = null;
        reject(new GitError(error.message, null));
      });
      child.on("close", (code) => {
        inFlight = null;
        if (aborted) {
          // Sweep the half-written clone so its destination is reusable, then
          // reject — the renderer that asked to cancel treats this as its own
          // action, not a failure to surface.
          void rm(target, { recursive: true, force: true }).finally(() => {
            reject(new GitError("Clone cancelled", null));
          });
          return;
        }
        if (code === 0) {
          resolve({ root: target, name: path.basename(target) });
        } else {
          const message = lastStderrLine(
            stderr,
            `git clone exited with code ${code}`,
          );
          reject(new GitError(message, code));
        }
      });
    })();
  });
}

/** Abort the clone currently in flight, if any. No-op when none is running. */
export function cancelClone(): void {
  inFlight?.abort();
}
