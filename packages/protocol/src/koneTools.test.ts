import { describe, expect, test } from "bun:test";

import {
  KONE_WORKER_TOOL_NAMES,
  LEGACY_KONE_TOOL_NAMES,
  currentKoneToolName,
  isKoneToolName,
} from "./koneTools";

describe("kone tool names", () => {
  // An alias that lands on a name nobody serves would strand every thread
  // still calling it.
  test("every former name resolves to a tool served today", () => {
    for (const [former, current] of Object.entries(LEGACY_KONE_TOOL_NAMES)) {
      expect(KONE_WORKER_TOOL_NAMES).toContain(current);
      expect(currentKoneToolName(former)).toBe(current);
    }
  });

  test("a former name is never also a current one", () => {
    for (const former of Object.keys(LEGACY_KONE_TOOL_NAMES)) {
      expect(isKoneToolName(former)).toBe(false);
    }
  });

  // Threads from the worker/peer generation keep working after the move to agent_*.
  test("the worker and peer names reach their agent tools", () => {
    expect(currentKoneToolName("worker_spawn")).toBe("worker_start");
    expect(currentKoneToolName("worker_continue")).toBe("agent_followup");
    expect(currentKoneToolName("peer_send")).toBe("agent_notify");
    expect(currentKoneToolName("peer_inbox")).toBe("agent_inbox");
  });

  test("the agent-only generation reaches the worker and follow-up tools", () => {
    expect(currentKoneToolName("agent_spawn")).toBe("worker_start");
    expect(currentKoneToolName("agent_spawn_preset")).toBe("worker_start");
    expect(currentKoneToolName("agent_spawn_batch")).toBe("worker_start_batch");
    expect(currentKoneToolName("agent_targets")).toBe("agent_directory");
    expect(currentKoneToolName("agent_ask")).toBe("agent_followup");
    expect(currentKoneToolName("agent_cancel")).toBe("agent_withdraw");
  });

  test("a current name passes through unchanged", () => {
    expect(currentKoneToolName("agent_wait")).toBe("agent_wait");
    expect(currentKoneToolName("read_file")).toBe("read_file");
  });
});
