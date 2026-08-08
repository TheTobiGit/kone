import { describe, expect, test } from "bun:test";

import type { EmitEvent, RuntimeEvent } from "../../types.js";
import type { ScratchpadRecord } from "../../ConversationStore.js";
import { createRegistry } from "./registry.js";
import {
  createScratchpadTools,
  type ScratchpadStore,
} from "./tools/scratchpad.js";
import type { GatewayToolContext } from "./schemas.js";

const PROJECT = "/tmp/proj";

function ctx(overrides: Partial<GatewayToolContext> = {}): GatewayToolContext {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    provider: "claudeAgent",
    model: "sonnet",
    cwd: PROJECT,
    requestId: 1,
    ...overrides,
  };
}

/** In-memory ScratchpadStore double mirroring the real store's semantics
 *  (revision bump, append merge, expectedRevision guard, op reserve/replay). */
class FakeScratchpadStore implements ScratchpadStore {
  pads = new Map<string, ScratchpadRecord>();
  ops = new Map<string, { fingerprint: string; result: unknown }>();
  private clock = 1;

  constructor(seed?: ScratchpadRecord[]) {
    for (const pad of seed ?? []) this.pads.set(pad.id, { ...pad });
  }

  listScratchpads(projectPath: string): ScratchpadRecord[] {
    return [...this.pads.values()].filter((pad) => pad.projectPath === projectPath);
  }

  getScratchpad(padId: string): ScratchpadRecord | null {
    return this.pads.get(padId) ?? null;
  }

  saveScratchpad(input: {
    padId: string;
    projectPath: string;
    title: string;
    body: string;
    expectedRevision?: number;
    append?: boolean;
  }): { savedAt: number; revision: number } | { conflict: number } | null {
    const existing = this.pads.get(input.padId);
    if (existing && input.expectedRevision !== undefined && input.expectedRevision !== existing.revision) {
      return { conflict: existing.revision };
    }
    const savedAt = this.clock++;
    const revision = existing ? existing.revision + 1 : 1;
    const body = input.append && existing && existing.body.trim()
      ? `${existing.body}\n\n${input.body}`
      : input.body;
    this.pads.set(input.padId, {
      id: input.padId,
      projectPath: input.projectPath,
      title: input.title,
      body,
      createdAt: existing?.createdAt ?? savedAt,
      updatedAt: savedAt,
      sortIndex: existing?.sortIndex ?? 0,
      revision,
    });
    return { savedAt, revision };
  }

  reserveGatewayOp(input: {
    threadId: string;
    turnId: string;
    requestId: string;
    kind: string;
    fingerprint: string;
  }): { kind: "reserved" } | { kind: "replay"; result: unknown } | { kind: "conflict" } | null {
    const key = `${input.threadId}|${input.turnId}|${input.requestId}`;
    const prior = this.ops.get(key);
    if (!prior) {
      this.ops.set(key, { fingerprint: input.fingerprint, result: undefined });
      return { kind: "reserved" };
    }
    if (prior.fingerprint === input.fingerprint && prior.result !== undefined) {
      return { kind: "replay", result: prior.result };
    }
    return { kind: "conflict" };
  }

  setGatewayOpResult(input: {
    threadId: string;
    turnId: string;
    requestId: string;
    resultJson: string;
  }): void {
    const key = `${input.threadId}|${input.turnId}|${input.requestId}`;
    const prior = this.ops.get(key);
    if (prior) prior.result = JSON.parse(input.resultJson);
  }
}

function makeTools() {
  const events: RuntimeEvent[] = [];
  const store = new FakeScratchpadStore();
  const emit: EmitEvent = (event) => {
    events.push(event);
  };
  const registry = createRegistry(createScratchpadTools({ store, emit }));
  return { registry, store, events };
}

describe("registry", () => {
  test("tools/list advertises both scratchpad tools with JSON schemas", () => {
    const { registry } = makeTools();
    const names = registry.listTools().map((tool) => tool.name);
    expect(names).toEqual(["kone_scratchpad_read", "kone_scratchpad_write"]);
    const write = registry.listTools().find((t) => t.name === "kone_scratchpad_write")!;
    expect(write.inputSchema.required).toEqual(["title", "body"]);
  });

  test("denied tools are omitted from tools/list and refused with permission_denied", async () => {
    const { store } = makeTools();
    const denied = createScratchpadTools({ store, emit: () => {} });
    denied[0]!.permission = "deny";
    const registry = createRegistry(denied);
    expect(registry.listTools().map((t) => t.name)).toEqual(["kone_scratchpad_write"]);
    const result = await registry.call(ctx(), "kone_scratchpad_read", {});
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error.code).toBe("permission_denied");
  });

  test("unknown tool → invalid_input", async () => {
    const { registry } = makeTools();
    const result = await registry.call(ctx(), "kone_nope", {});
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error.code).toBe("invalid_input");
  });

  test("write without a live turn → capability_denied", async () => {
    const { registry } = makeTools();
    const result = await registry.call(
      ctx({ turnId: null }),
      "kone_scratchpad_write",
      { title: "Scratchpad", body: "hi" },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error.code).toBe("capability_denied");
  });

  test("read works without a turn", async () => {
    const { registry } = makeTools();
    const result = await registry.call(ctx({ turnId: null }), "kone_scratchpad_read", {});
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error.code).toBe("not_found");
  });

  test("invalid arguments → invalid_input with issues", async () => {
    const { registry } = makeTools();
    const result = await registry.call(ctx(), "kone_scratchpad_write", { body: "no title" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error.code).toBe("invalid_input");
    expect(result.structuredContent?.error.details.issues.length).toBeGreaterThan(0);
  });
});

describe("kone_scratchpad_read", () => {
  test("no pad yet → not_found", async () => {
    const { registry } = makeTools();
    const result = await registry.call(ctx(), "kone_scratchpad_read", {});
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error.code).toBe("not_found");
  });

  test("reads the most-recently-updated pad when padId omitted", async () => {
    const { registry, store } = makeTools();
    store.saveScratchpad({ padId: "old", projectPath: PROJECT, title: "Scratchpad", body: "old" });
    store.saveScratchpad({ padId: "new", projectPath: PROJECT, title: "Scratchpad", body: "new body" });
    const result = await registry.call(ctx(), "kone_scratchpad_read", {});
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe("new body");
    expect(result.structuredContent?.pad).toMatchObject({ id: "new", body: "new body", revision: 1 });
  });

  test("reads by explicit padId", async () => {
    const { registry, store } = makeTools();
    store.saveScratchpad({ padId: "p1", projectPath: PROJECT, title: "Scratchpad", body: "one" });
    const result = await registry.call(ctx(), "kone_scratchpad_read", { padId: "p1" });
    expect(result.structuredContent?.pad.id).toBe("p1");
  });
});

describe("kone_scratchpad_write", () => {
  test("creates the pad on first write and attributes the writer", async () => {
    const { registry, events } = makeTools();
    const result = await registry.call(ctx(), "kone_scratchpad_write", {
      title: "Scratchpad",
      body: "hello agent",
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      savedAt: expect.any(Number),
      revision: 1,
      writer: { model: "sonnet", provider: "claudeAgent" },
    });
    expect(result.structuredContent?.pad).toMatchObject({ body: "hello agent", revision: 1 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "scratchpad.updated",
      projectPath: PROJECT,
      revision: 1,
      writer: { model: "sonnet", provider: "claudeAgent" },
    });
  });

  test("append merges server-side with a blank line and bumps revision", async () => {
    const { registry } = makeTools();
    await registry.call(ctx(), "kone_scratchpad_write", {
      title: "Scratchpad",
      body: "first",
    });
    const result = await registry.call(ctx(), "kone_scratchpad_write", {
      title: "Scratchpad",
      body: "second",
      append: true,
    });
    expect(result.structuredContent?.revision).toBe(2);
    expect(result.structuredContent?.pad.body).toBe("first\n\nsecond");
  });

  test("stale expectedRevision → revision_conflict carrying the current revision", async () => {
    const { registry } = makeTools();
    await registry.call(ctx(), "kone_scratchpad_write", { title: "Scratchpad", body: "v1" });
    // An intermediate write moves the revision to 2, so a write based on 1 is stale.
    await registry.call(ctx(), "kone_scratchpad_write", { title: "Scratchpad", body: "v1.5" });
    const result = await registry.call(ctx(), "kone_scratchpad_write", {
      title: "Scratchpad",
      body: "v2",
      expectedRevision: 1,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error.code).toBe("revision_conflict");
    expect(result.structuredContent?.error.details).toEqual({ currentRevision: 2 });
  });

  test("omitting expectedRevision overwrites unconditionally", async () => {
    const { registry } = makeTools();
    await registry.call(ctx(), "kone_scratchpad_write", { title: "Scratchpad", body: "v1" });
    const result = await registry.call(ctx(), "kone_scratchpad_write", {
      title: "Scratchpad",
      body: "v2",
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.revision).toBe(2);
  });

  test("idempotency: same clientRequestId + same content replays the stored result", async () => {
    const { registry } = makeTools();
    const first = await registry.call(ctx(), "kone_scratchpad_write", {
      title: "Scratchpad",
      body: "once",
      clientRequestId: "op-1",
    });
    const replay = await registry.call(ctx(), "kone_scratchpad_write", {
      title: "Scratchpad",
      body: "once",
      clientRequestId: "op-1",
    });
    expect(first.structuredContent).toEqual(replay.structuredContent);
    expect(replay.content[0]!.text).toContain("Replayed");
  });

  test("idempotency: same clientRequestId + different content → idempotency_conflict", async () => {
    const { registry } = makeTools();
    await registry.call(ctx(), "kone_scratchpad_write", {
      title: "Scratchpad",
      body: "once",
      clientRequestId: "op-1",
    });
    const second = await registry.call(ctx(), "kone_scratchpad_write", {
      title: "Scratchpad",
      body: "twice",
      clientRequestId: "op-1",
    });
    expect(second.isError).toBe(true);
    expect(second.structuredContent?.error.code).toBe("idempotency_conflict");
  });

  test("idempotency keys are turn-scoped (different turn = fresh op)", async () => {
    const { registry } = makeTools();
    await registry.call(ctx({ turnId: "turn-1" }), "kone_scratchpad_write", {
      title: "Scratchpad",
      body: "first turn",
      clientRequestId: "op-1",
    });
    const secondTurn = await registry.call(ctx({ turnId: "turn-2" }), "kone_scratchpad_write", {
      title: "Scratchpad",
      body: "second turn",
      clientRequestId: "op-1",
    });
    expect(secondTurn.isError).toBeUndefined();
    expect(secondTurn.structuredContent?.revision).toBe(2);
  });
});
