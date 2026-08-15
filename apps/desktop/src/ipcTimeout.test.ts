import { describe, expect, test } from "bun:test";

import { IpcTimeoutError, withTimeout } from "./ipcTimeout.js";

describe("withTimeout", () => {
  test("resolves with the task's value when the task settles before the deadline", async () => {
    const value = await withTimeout(async () => "ok", {
      channel: "git:status",
      timeoutMs: 1000,
    });
    expect(value).toBe("ok");
  });

  test("rejects with an IpcTimeoutError when the task never settles", async () => {
    const rejection = withTimeout(() => new Promise(() => {}), {
      channel: "git:status",
      timeoutMs: 20,
    });
    await expect(rejection).rejects.toBeInstanceOf(IpcTimeoutError);
    await expect(rejection).rejects.toMatchObject({
      name: "IpcTimeoutError",
    });
    await expect(rejection).rejects.toMatchObject({
      message: "[kone:TIMEOUT] git:status timed out after 20ms",
    });
  });

  test("passes an AbortSignal to the task and aborts it when the timer fires", async () => {
    let captured: AbortSignal | undefined;
    const rejection = withTimeout(
      (signal) => {
        captured = signal;
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            queueMicrotask(() => reject(new Error("aborted")));
          });
        });
      },
      { channel: "read:preview", timeoutMs: 20 },
    );
    await expect(rejection).rejects.toBeInstanceOf(IpcTimeoutError);
    expect(captured?.aborted).toBe(true);
  });

  test("rethrows the task's own error unchanged when the task rejects before the deadline", async () => {
    await expect(
      withTimeout(() => Promise.reject(new Error("boom")), {
        channel: "x",
        timeoutMs: 100,
      }),
    ).rejects.toThrow("boom");
  });

  test("clears its timer on success so the process can exit", async () => {
    const value = await withTimeout(async () => "done", {
      channel: "x",
      timeoutMs: 1000,
    });
    expect(value).toBe("done");
  });
});
