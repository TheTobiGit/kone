import { describe, expect, test } from "bun:test";

import type {
  ThreadExportDialogResult,
  ThreadExportOutcome,
} from "~/types/desktop";
import { useThreadExport, type ThreadExportBridge } from "./useThreadExport";

/** A fake of the two bridge calls: queued answers, called in order. */
function fakeBridge(scenario: {
  dialog: ThreadExportDialogResult | Error | null;
  exported: ThreadExportOutcome | Error | null;
}): ThreadExportBridge & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    pickExportPath: async (suggestedName: string) => {
      calls.push(`dialog:${suggestedName}`);
      const answer = scenario.dialog;
      if (answer instanceof Error) throw answer;
      // SAFETY: the null case below is the test's own "misbehaving main"
      // branch, and the type system already saw the honest union above.
      return answer as ThreadExportDialogResult;
    },
    exportThread: async () => {
      calls.push("export");
      const answer = scenario.exported;
      if (answer instanceof Error) throw answer;
      // SAFETY: same misbehaving-main branch as the dialog fake above.
      return answer as ThreadExportOutcome;
    },
  };
}

describe("useThreadExport", () => {
  test("a picked path writes and confirms the saved file", async () => {
    const bridge = fakeBridge({
      dialog: { canceled: false, filePath: "/tmp/how-do-i.md" },
      exported: { ok: true, path: "/tmp/how-do-i.md", bytes: 2048, format: "markdown" },
    });
    const flow = useThreadExport();
    await flow.runExport("thread-1", "How do I?", "markdown", bridge);
    expect(flow.phase.value).toBe("saved");
    expect(flow.message.value).toBe("Saved how-do-i.md (2.0 KB).");
    expect(bridge.calls).toEqual(["dialog:how-do-i.md", "export"]);
  });

  test("a cancelled dialog ends the flow before any file is touched", async () => {
    const bridge = fakeBridge({
      dialog: { canceled: true },
      exported: { ok: true, path: "/tmp/x.md", bytes: 1, format: "markdown" },
    });
    const flow = useThreadExport();
    await flow.runExport("thread-1", "Title", "markdown", bridge);
    expect(flow.phase.value).toBe("cancelled");
    expect(flow.message.value).toBe("Export cancelled — no file was written.");
    expect(bridge.calls).toEqual(["dialog:title.md"]);
  });

  test("an empty thread is a quiet note, not an error", async () => {
    const bridge = fakeBridge({
      dialog: { canceled: false, filePath: "/tmp/t.json" },
      exported: { ok: false, reason: "no-completed-turns", message: "stale words" },
    });
    const flow = useThreadExport();
    await flow.runExport("thread-1", "Title", "json", bridge);
    expect(flow.phase.value).toBe("empty");
    expect(flow.message.value).toBe("Nothing to export yet: this thread has no completed turns.");
  });

  test("a failed write surfaces the backend's words", async () => {
    const bridge = fakeBridge({
      dialog: { canceled: false, filePath: "/tmp/t.md" },
      exported: { ok: false, reason: "write-failed", message: "Could not write the export: EACCES" },
    });
    const flow = useThreadExport();
    await flow.runExport("thread-1", "Title", "markdown", bridge);
    expect(flow.phase.value).toBe("failed");
    expect(flow.message.value).toBe("Could not write the export: EACCES");
  });

  test("a rejected bridge call peels to the underlying message", async () => {
    const bridge = fakeBridge({
      dialog: new Error("Error invoking remote method 'agent:export-thread-dialog': Error: dialog busy"),
      exported: null,
    });
    const flow = useThreadExport();
    await flow.runExport("thread-1", "Title", "markdown", bridge);
    expect(flow.phase.value).toBe("failed");
    expect(flow.message.value).toBe("dialog busy");
    expect(bridge.calls).toEqual(["dialog:title.md"]);
  });

  test("no bridge and no thread fail legibly without touching IPC", async () => {
    const flow = useThreadExport();
    await flow.runExport("thread-1", "Title", "markdown", null);
    expect(flow.phase.value).toBe("failed");
    expect(flow.message.value).toContain("desktop app");

    const bridge = fakeBridge({ dialog: { canceled: true }, exported: null });
    await flow.runExport("", "Title", "markdown", bridge);
    expect(flow.phase.value).toBe("failed");
    expect(flow.message.value).toBe("There's no thread to export yet.");
    expect(bridge.calls).toEqual([]);
  });

  test("reset returns the flow to idle", async () => {
    const bridge = fakeBridge({ dialog: { canceled: true }, exported: null });
    const flow = useThreadExport();
    await flow.runExport("thread-1", "Title", "markdown", bridge);
    expect(flow.phase.value).toBe("cancelled");
    flow.reset();
    expect(flow.phase.value).toBe("idle");
    expect(flow.message.value).toBeNull();
  });
});
