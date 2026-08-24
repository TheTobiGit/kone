import { markKind } from "@kone/protocol/ipc-error";

// A bounded, typed request lifetime for subprocess- and fs-backed IPC reads.
// The git runner already kills a wedged subprocess after its own timeout, but
// that surfaces as a generic "Command failed" the renderer can't tell apart
// from a real failure, and the fs-backed reads (a file preview, a README) have
// no timeout at all, so a stalled read on a network share hangs the caller
// forever. `withTimeout` gives every such read one deadline and one classified
// failure: the TIMEOUT kind survives the IPC boundary (ipcError.ts) and the
// renderer turns it into a retry hint.

/** A request exceeded its deadline at the IPC boundary. The message carries the
 *  "[kone:TIMEOUT] " marker so the kind survives Electron's error flattening.
 */
export class IpcTimeoutError extends Error {
  readonly channel: string;
  readonly timeoutMs: number;

  constructor(channel: string, timeoutMs: number) {
    super(markKind("TIMEOUT", `${channel} timed out after ${timeoutMs}ms`));
    this.name = "IpcTimeoutError";
    this.channel = channel;
    this.timeoutMs = timeoutMs;
  }
}

/** Bound `task`'s lifetime to `timeoutMs`. The task receives an AbortSignal it
 *  can hand to its own work (a readFile, a subprocess) so the deadline cancels
 *  the underlying call rather than merely abandoning it. The deadline is
 *  enforced by a race, not by the task's cooperation: a task that ignores the
 *  signal still resolves to an IpcTimeoutError when the timer fires. A task
 *  that settles first keeps its own outcome, and its error is passed through
 *  unchanged. */
export async function withTimeout<T>(
  task: (signal: AbortSignal) => Promise<T>,
  opts: { channel: string; timeoutMs: number },
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Settle the deadline before aborting: the timer firing means TIMEOUT,
      // regardless of how the task reacts to the signal it was handed.
      reject(new IpcTimeoutError(opts.channel, opts.timeoutMs));
      controller.abort();
    }, opts.timeoutMs);
  });
  try {
    return await Promise.race([task(controller.signal), deadline]);
  } finally {
    clearTimeout(timer!);
  }
}
