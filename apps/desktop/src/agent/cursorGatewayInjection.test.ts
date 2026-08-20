// Cursor gateway wiring (docs/mcp-gateway-design.md §4, Phase B).
//
// startSession must thread the kone MCP server into BOTH session doors
// (session/new and session/load) — the direct HTTP entry when the agent
// advertises agentCapabilities.mcpCapabilities.http, else the stdio proxy —
// and sendTurn must deliver the kone host-context block on the first turn.
// JsonRpcClient is stubbed (mock.module, per the claudeGatewayInjection.test.ts
// pattern) so no real `cursor-agent` child is spawned; the adapter is imported
// dynamically so the stub is in place first.

import { describe, expect, mock, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { KONE_AGENT_IDENTITY_MARKER, KONE_HOST_CONTEXT_MARKER } from "./gateway/appContext.js";
import { KONE_GATEWAY_TOKEN_ENV, KONE_GATEWAY_URL_ENV, STDIO_PROXY_PATH } from "./gateway/injection.js";
import type { EmitEvent, SessionStartInput } from "./types.js";

/** Flipped by each test before startSession; the fake's initialize result
 *  mirrors it, exactly like a real Cursor handshake would. */
let httpCapable = false;
/** The session's rpc client — the one spawned with the project cwd (the
 *  model-catalog probe uses homedir() instead, so it can't be mistaken for it). */
let sessionRpc: FakeJsonRpcClient | null = null;

type RecordLike = Record<string, unknown>;

function sessionResponse(): RecordLike {
  return {
    sessionId: "ses-1",
    modes: { availableModes: [{ id: "agent" }, { id: "ask" }] },
  };
}

class FakeJsonRpcClient {
  readonly calls: { method: string; params?: unknown }[] = [];
  constructor(_command: string, _args: string[], opts: { cwd?: string }) {
    if (opts?.cwd && opts.cwd !== "/tmp/kone-test-project") return;
    sessionRpc = this;
  }
  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    switch (method) {
      case "initialize":
        return {
          agentCapabilities: { mcpCapabilities: { http: httpCapable } },
          authMethods: [{ methodId: "cursor_login" }],
        } as T;
      case "authenticate":
        return {} as T;
      case "cursor/list_available_models":
        // A non-empty catalog keeps fetchModels off the CLI probe fallback.
        return { models: [{ value: "m1", name: "M1" }] } as T;
      case "session/new":
      case "session/load":
        return sessionResponse() as T;
      case "session/prompt":
        return { stopReason: "end_turn" } as T;
      default:
        return {} as T;
    }
  }
  notify(): void {}
  onNotification(): () => void {
    return () => {};
  }
  onRequest(): void {}
  onExit(): () => void {
    return () => {};
  }
  onStderrLine(): () => void {
    return () => {};
  }
  kill(): void {}
}

// The adapter imports `{ JsonRpcClient } from "../jsonRpc.js"` — mocked by its
// resolved absolute path (the claude test mocks package specifiers; relative
// specifiers need the canonical path here). Registered after the fake class so
// the factory's reference resolves; the adapter is imported dynamically so the
// stub is in place first.
mock.module(fileURLToPath(new URL("./jsonRpc.ts", import.meta.url)), () => ({
  JsonRpcClient: FakeJsonRpcClient,
}));

const { CursorAdapter } = await import("./adapters/CursorAdapter.js");

const CONNECTION = { url: "http://127.0.0.1:41231/mcp", bearerToken: "kone_gw_token-1" };

function start(overrides: Partial<SessionStartInput>) {
  sessionRpc = null;
  const adapter = new CursorAdapter((() => {}) as EmitEvent);
  return adapter.startSession({
    threadId: "thread-1",
    provider: "cursor",
    cwd: "/tmp/kone-test-project",
    ...overrides,
  });
}

describe("Cursor gateway injection", () => {
  test("http-capable agent: session/new gets the direct HTTP entry", async () => {
    httpCapable = true;
    await start({ gatewayConnection: CONNECTION });
    const newCall = sessionRpc!.calls.find((c) => c.method === "session/new");
    expect(newCall?.params).toEqual({
      cwd: "/tmp/kone-test-project",
      mcpServers: [
        {
          type: "http",
          name: "kone",
          url: CONNECTION.url,
          headers: [{ name: "Authorization", value: `Bearer ${CONNECTION.bearerToken}` }],
        },
      ],
    });
  });

  test("agent without http capability: session/new spawns the stdio proxy with URL+token env", async () => {
    httpCapable = false;
    await start({ gatewayConnection: CONNECTION });
    const newCall = sessionRpc!.calls.find((c) => c.method === "session/new");
    expect(newCall?.params).toEqual({
      cwd: "/tmp/kone-test-project",
      mcpServers: [
        {
          name: "kone",
          command: process.execPath,
          args: [STDIO_PROXY_PATH],
          env: [
            { name: KONE_GATEWAY_URL_ENV, value: CONNECTION.url },
            { name: KONE_GATEWAY_TOKEN_ENV, value: CONNECTION.bearerToken },
          ],
        },
      ],
    });
  });

  test("resumed session: session/load carries the same gateway config", async () => {
    httpCapable = true;
    await start({ resume: "ses-old", gatewayConnection: CONNECTION });
    const loadCall = sessionRpc!.calls.find((c) => c.method === "session/load");
    expect(loadCall?.params).toMatchObject({
      sessionId: "ses-old",
      mcpServers: [
        {
          type: "http",
          name: "kone",
          url: CONNECTION.url,
          headers: [{ name: "Authorization", value: `Bearer ${CONNECTION.bearerToken}` }],
        },
      ],
    });
  });

  test("no gateway connection: mcpServers stays empty (agent is never promised tools it lacks)", async () => {
    httpCapable = true;
    await start({});
    const newCall = sessionRpc!.calls.find((c) => c.method === "session/new");
    expect(newCall?.params).toMatchObject({ mcpServers: [] });
  });

  test("first turn carries the kone host-context block, later turns do not", async () => {
    httpCapable = false;
    const adapter = new CursorAdapter((() => {}) as EmitEvent);
    sessionRpc = null;
    await adapter.startSession({
      threadId: "thread-2",
      provider: "cursor",
      cwd: "/tmp/kone-test-project",
      gatewayConnection: CONNECTION,
    });

    await adapter.sendTurn({ threadId: "thread-2", input: "hello world" });
    const first = sessionRpc!.calls.find((c) => c.method === "session/prompt");
    const firstText = (first?.params as RecordLike).prompt as { type: string; text: string }[];
    expect(firstText[0].text).toContain(KONE_HOST_CONTEXT_MARKER);
    expect(firstText[0].text).toContain("kone_scratchpad_read");
    expect(firstText[0].text).toContain("hello world");

    await adapter.sendTurn({ threadId: "thread-2", input: "again" });
    const prompts = sessionRpc!.calls.filter((c) => c.method === "session/prompt");
    const secondText = (prompts[1].params as RecordLike).prompt as { type: string; text: string }[];
    expect(secondText[0].text).toBe("again");
  });

  test("no gateway connection: no host-context block even on the first turn", async () => {
    httpCapable = true;
    const adapter = new CursorAdapter((() => {}) as EmitEvent);
    sessionRpc = null;
    await adapter.startSession({
      threadId: "thread-3",
      provider: "cursor",
      cwd: "/tmp/kone-test-project",
    });

    await adapter.sendTurn({ threadId: "thread-3", input: "plain" });
    const first = sessionRpc!.calls.find((c) => c.method === "session/prompt");
    const firstText = (first?.params as RecordLike).prompt as { type: string; text: string }[];
    expect(firstText[0].text).toBe("plain");
  });
});

describe("Cursor agent identity", () => {
  const MAYA = { name: "Maya" };

  /** The text of the nth session/prompt this adapter sent, in order. */
  function promptText(index: number): string {
    const prompts = sessionRpc!.calls.filter((c) => c.method === "session/prompt");
    const parts = (prompts[index].params as RecordLike).prompt as { type: string; text: string }[];
    return parts[0].text;
  }

  test("a thread handed to an agent says who it is on the first turn, and once", async () => {
    httpCapable = true;
    const adapter = new CursorAdapter((() => {}) as EmitEvent);
    sessionRpc = null;
    await adapter.startSession({
      threadId: "thread-4",
      provider: "cursor",
      cwd: "/tmp/kone-test-project",
      gatewayConnection: CONNECTION,
      agent: MAYA,
    });

    await adapter.sendTurn({ threadId: "thread-4", input: "hello world" });
    const first = promptText(0);
    expect(first).toContain("<kone_agent_identity>");
    expect(first).toContain(KONE_AGENT_IDENTITY_MARKER);
    expect(first).toContain("in kone you are Maya");
    expect(first).toContain("hello world");

    await adapter.sendTurn({ threadId: "thread-4", input: "again" });
    expect(promptText(1)).toBe("again");
  });

  test("a guest thread's turns are the plain prompt, exactly as before agents existed", async () => {
    httpCapable = true;
    const adapter = new CursorAdapter((() => {}) as EmitEvent);
    sessionRpc = null;
    await adapter.startSession({
      threadId: "thread-5",
      provider: "cursor",
      cwd: "/tmp/kone-test-project",
      agent: undefined,
    });

    await adapter.sendTurn({ threadId: "thread-5", input: "plain" });
    expect(promptText(0)).toBe("plain");
  });

  test("an agent keeps its name with no gateway to talk to", async () => {
    httpCapable = true;
    const adapter = new CursorAdapter((() => {}) as EmitEvent);
    sessionRpc = null;
    await adapter.startSession({
      threadId: "thread-6",
      provider: "cursor",
      cwd: "/tmp/kone-test-project",
      agent: MAYA,
    });

    await adapter.sendTurn({ threadId: "thread-6", input: "hello" });
    const first = promptText(0);
    expect(first).toContain(KONE_AGENT_IDENTITY_MARKER);
    expect(first).not.toContain(KONE_HOST_CONTEXT_MARKER);
    expect(first).toContain("<user_request>\nhello\n</user_request>");
  });
});
