import { describe, expect, test } from "bun:test";

import { createStreamGate } from "./useStreamGate";
import { highlightThrottleMs } from "./useHighlighter";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createStreamGate", () => {
  test("first request runs immediately (history / settled renders stay instant)", () => {
    const gate = createStreamGate(50);
    let runs = 0;
    gate.request(() => runs++);
    expect(runs).toBe(1);
  });

  test("rapid updates coalesce: burst of 10 lands as one trailing run with the latest source", async () => {
    const gate = createStreamGate(120); // burst (10 × 5 ms) fits inside one window
    let runs = 0;
    let rendered = "";
    // Simulate chunks arriving faster than the window — each one replaces the
    // pending task, like the watcher capturing a newer `src`.
    for (let i = 1; i <= 10; i++) {
      const chunk = `chunk-${i}`;
      gate.request(() => {
        runs++;
        rendered = chunk;
      });
      await sleep(5);
    }
    expect(runs).toBe(1); // leading run only; the rest were coalesced
    await sleep(150); // window elapses → trailing flush
    expect(runs).toBe(2);
    expect(rendered).toBe("chunk-10"); // …and it saw the newest source
  });

  test("final content flushes promptly after the stream settles", async () => {
    const gate = createStreamGate(30);
    let rendered = "";
    gate.request(() => (rendered = "a")); // immediate
    await sleep(5);
    for (let i = 0; i < 4; i++) {
      gate.request(() => (rendered += "b"));
      await sleep(5);
    }
    gate.request(() => (rendered += "FINAL"));
    await sleep(60); // well within one window past settle
    expect(rendered.endsWith("FINAL")).toBe(true);
  });

  test("cancel() drops the pending run — no work after unmount", async () => {
    const gate = createStreamGate(20);
    let runs = 0;
    gate.request(() => runs++); // immediate
    gate.request(() => runs++); // scheduled
    gate.cancel();
    await sleep(60);
    expect(runs).toBe(1);
  });

  test("replacing the source re-arms the gate and the new source wins", async () => {
    const gate = createStreamGate(30);
    let rendered = "";
    gate.request(() => (rendered = "old"));
    gate.request(() => (rendered = "pending-old")); // gated, pending
    gate.cancel(); // unmount / replacement tears it down
    await sleep(50);
    gate.request(() => (rendered = "new")); // fresh lifecycle
    expect(rendered).toBe("new");
    await sleep(50);
    expect(rendered).toBe("new"); // nothing stale ever landed
  });

  test("interval function is honoured per-request (size-aware throttling)", async () => {
    let interval = 20;
    const gate = createStreamGate(() => interval);
    let runs = 0;
    gate.request(() => runs++); // immediate
    gate.request(() => runs++); // gated behind 20 ms
    await sleep(45);
    expect(runs).toBe(2);
    interval = 200; // now "large code" — window stretches
    gate.request(() => runs++);
    await sleep(45);
    expect(runs).toBe(2); // still waiting on the stretched window
    await sleep(220);
    expect(runs).toBe(3);
  });
});

describe("highlightThrottleMs", () => {
  test("short code updates quickly", () => {
    expect(highlightThrottleMs(0)).toBeLessThanOrEqual(50);
    expect(highlightThrottleMs(8_000)).toBeLessThanOrEqual(50);
  });

  test("very large code updates far less frequently", () => {
    expect(highlightThrottleMs(150_000)).toBeGreaterThanOrEqual(200);
    expect(highlightThrottleMs(150_000 + 1)).toBe(
      highlightThrottleMs(Number.MAX_SAFE_INTEGER),
    ); // clamped
  });

  test("grows monotonically between the extremes", () => {
    let prev = -1;
    for (const len of [8_001, 20_000, 60_000, 100_000, 150_000]) {
      const ms = highlightThrottleMs(len);
      expect(ms).toBeGreaterThan(prev);
      prev = ms;
    }
  });
});
