import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";

// The pin handler is registered inside registerAgentIpc, which constructs the
// whole main-process agent layer; importing it in a test would boot that layer.
// The routing contract is asserted at the source instead: the pin write must go
// through the AgentService so thread.pinned.updated fans out, exactly as done
// does — a direct store write would persist the mark silently.
const source = readFileSync(new URL("./agent-ipc.ts", import.meta.url), "utf8");

describe("agent:set-pinned IPC routing", () => {
  it("writes the pin through the AgentService, never the store directly", () => {
    const start = source.indexOf('ipcMain.handle("agent:set-pinned"');
    const end = source.indexOf('ipcMain.handle("agent:thread-reference-list"');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const registration = source.slice(start, end);
    expect(registration).toContain("svc.setThreadPinned");
    expect(registration).not.toContain("store.setPinned");
    expect(source).not.toMatch(/store\.setPinned\s*\(/);
  });
});
