// Resume-path gateway injection for Claude sessions.
//
// startSession's resume path runs through the SAME options builder as fresh
// starts (startFreshSession, with `resume` as just another option), so a
// resumed conversation must receive the gateway mcpServers config AND the
// kone host-context append exactly like a fresh one — this is the regression
// test for that guarantee. The SDK's `query` is stubbed (mock.module, per the
// gateway.test.ts pattern) so no real `claude` subprocess is spawned; the
// adapter is imported dynamically so the stub is in place first.

import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setUserDataDir } from "./userDataDir.js";
import { Database } from "bun:sqlite";

// The adapter transitively imports ConversationStore (via AttachmentStore),
// which loads node:sqlite — an Electron-runtime builtin this bun can't load.
// Stand it in with bun:sqlite and point the agent layer's state dir at a
// throwaway dir, the same pattern gateway.test.ts uses; ClaudeAdapter itself is imported dynamically
// below so the stubs are in place first.
const testUserDataDir = mkdtempSync(path.join(tmpdir(), "kone-claude-gateway-"));
mock.module("./sqlite.js", () => ({
  DatabaseSync: Database,
}));
setUserDataDir(testUserDataDir);

import { KONE_AGENT_IDENTITY_MARKER, KONE_HOST_CONTEXT_MARKER } from "./gateway/appContext.js";
import { CLAUDE_SUBAGENT_SYSTEM_PROMPT_APPEND } from "./claudeSubagents.js";

type CapturedOptions = {
  mcpServers?: Record<string, { type: string; url: string; headers?: { Authorization?: string } }>;
  systemPrompt?: { type?: string; preset?: string; append?: string };
  resume?: string;
};

/** The gateway config the stubbed SDK query was called with — null until one
 *  has been captured. */
type CapturedState = {
  options: CapturedOptions | null;
};

const captured: CapturedState = { options: null };

const stubQuery = mock((input: { options: CapturedOptions }) => {
  captured.options = input.options;
  return {
    initializationResult: async () => ({}),
    async *[Symbol.asyncIterator]() {
      // Empty iterable: consume() drains immediately, nothing to emit.
    },
  };
});

mock.module("@anthropic-ai/claude-agent-sdk", () => ({ query: stubQuery }));

import type { EmitEvent, SessionStartInput } from "./types.js";
// Must be a dynamic import: a static import is hoisted above the mock.module
// calls, which defeats both stubs (the real SDK query and the unstubbed
// node:sqlite chain would load first). Same constraint gateway.test.ts notes.
const { ClaudeAdapter } = await import("./adapters/ClaudeAdapter.js");

const CONNECTION = { url: "http://127.0.0.1:12345/mcp", bearerToken: "token-abc" };

function start(overrides: Partial<SessionStartInput>): Promise<ReturnType<ClaudeAdapter["startSession"]>> {
  // SAFETY: a zero-arg arrow accepts every EmitEvent call signature, and the
  // stubbed query() below never emits session events anyway.
  const adapter = new ClaudeAdapter((() => {}) as EmitEvent);
  return adapter.startSession({
    threadId: "thread-1",
    provider: "claudeAgent",
    cwd: "/tmp/kone-test-project",
    ...overrides,
  });
}

describe("Claude gateway injection", () => {
  test("fresh session: mcpServers + kone host-context append layered on the stock preset", async () => {
    const session = await start({ gatewayConnection: CONNECTION });
    expect(session.resumedFrom).toBeUndefined();

    expect(captured.options?.mcpServers?.kone).toEqual({
      type: "http",
      url: CONNECTION.url,
      headers: { Authorization: `Bearer ${CONNECTION.bearerToken}` },
      alwaysLoad: true,
    });
    expect(captured.options?.systemPrompt?.type).toBe("preset");
    expect(captured.options?.systemPrompt?.preset).toBe("claude_code");
    const append = captured.options?.systemPrompt?.append ?? "";
    expect(append).toContain(CLAUDE_SUBAGENT_SYSTEM_PROMPT_APPEND);
    expect(append).toContain(KONE_HOST_CONTEXT_MARKER);
    expect(append).toContain("kone_scratchpad_read");
    expect(append).toContain("kone_scratchpad_write");
  });

  test("resumed session: same gateway config reaches the resumed conversation", async () => {
    const session = await start({ resume: "conv-42", gatewayConnection: CONNECTION });
    // The resume id was genuinely adopted — startSession only marks it after
    // initialization succeeded.
    expect(session.resumedFrom).toBe("conv-42");
    expect(captured.options?.resume).toBe("conv-42");

    // Same mcpServers + append as a fresh session: no gateway-less resume path.
    expect(captured.options?.mcpServers?.kone).toEqual({
      type: "http",
      url: CONNECTION.url,
      headers: { Authorization: `Bearer ${CONNECTION.bearerToken}` },
      alwaysLoad: true,
    });
    const append = captured.options?.systemPrompt?.append ?? "";
    expect(append).toContain(KONE_HOST_CONTEXT_MARKER);
    expect(append).toContain("kone_scratchpad_write");
  });

  test("no gateway connection: no mcpServers, no kone block (agent is never promised tools it lacks)", async () => {
    await start({});
    expect(captured.options?.mcpServers).toBeUndefined();
    const append = captured.options?.systemPrompt?.append ?? "";
    expect(append).toContain(CLAUDE_SUBAGENT_SYSTEM_PROMPT_APPEND);
    expect(append).not.toContain(KONE_HOST_CONTEXT_MARKER);
  });
});

describe("Claude agent identity", () => {
  const MAYA = { name: "Maya" };

  test("a thread handed to an agent starts a session that knows whose it is", async () => {
    await start({ gatewayConnection: CONNECTION, agent: MAYA });
    const append = captured.options?.systemPrompt?.append ?? "";
    expect(append).toContain(KONE_AGENT_IDENTITY_MARKER);
    expect(append).toContain("in kone you are Maya");
    // The subagent and host-context appends are still there beside it: identity
    // is another block on the channel, not a replacement for it.
    expect(append).toContain(CLAUDE_SUBAGENT_SYSTEM_PROMPT_APPEND);
    expect(append).toContain(KONE_HOST_CONTEXT_MARKER);
  });

  test("a guest session is told nothing at all", async () => {
    await start({ gatewayConnection: CONNECTION });
    const append = captured.options?.systemPrompt?.append ?? "";
    expect(append).not.toContain(KONE_AGENT_IDENTITY_MARKER);
    expect(append).not.toContain("Maya");
  });

  // Claude fixes its system prompt when the process spawns, so getting this
  // wrong isn't a degraded session — it's a session that can never learn its
  // own name. Whose thread it is has nothing to do with which tools it got.
  test("an agent keeps its name with no gateway to talk to", async () => {
    await start({ agent: MAYA });
    const append = captured.options?.systemPrompt?.append ?? "";
    expect(append).toContain(KONE_AGENT_IDENTITY_MARKER);
    expect(append).toContain("in kone you are Maya");
    expect(append).not.toContain(KONE_HOST_CONTEXT_MARKER);
  });
});
