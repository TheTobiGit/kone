// Coalescing gate for live-streamed renders. While an agent reply is arriving,
// its source can change on every animation frame; reparsing Markdown or
// re-highlighting code that often just burns the main thread for frames nobody
// sees. The gate is a leading+trailing throttle:
//
//   • Idle (or first change): the task runs immediately — history, edits and
//     settled messages never wait.
//   • Burst: changes inside the window cancel the pending run and re-schedule
//     it at the window's edge, so at most one run happens per interval no
//     matter how fast chunks land.
//   • Settle: the last scheduled run carries the latest captured source, so
//     the exact final content flushes within one interval of the stream
//     stopping. Nothing is dropped or left stale.
//
// The interval may be a function so callers can make it size-aware (big code
// re-highlights less often than short snippets).
export interface StreamGate {
  /** Run `task` now if enough time has passed since the last run, otherwise
   *  schedule exactly one later run (which will see the caller's latest state
   *  via closure). Replacing a pending request never stacks runs. */
  request(task: () => void): void;
  /** Drop any pending scheduled run. In-flight async work is not touched —
   *  guard that with a sequence token as before. */
  cancel(): void;
}

export function createStreamGate(intervalMs: number | (() => number)): StreamGate {
  const resolve = intervalMs instanceof Function ? intervalMs : () => (Number.isFinite(intervalMs) ? intervalMs : 0);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastRun = 0;

  return {
    request(task) {
      // No timer environment (server render) — nothing to coalesce against.
      if (!("setTimeout" in globalThis)) {
        task();
        return;
      }
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      const interval = resolve();
      const elapsed = Date.now() - lastRun;
      if (elapsed >= interval) {
        lastRun = Date.now();
        task();
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        lastRun = Date.now();
        task();
      }, interval - elapsed);
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
