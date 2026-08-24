// Droid gateway wiring (docs/mcp-gateway-design.md §4, Phase B).
//
// The mirror of cursorGatewayInjection.test.ts: startSession threads the kone
// MCP server into every session door (session/new, session/resume, session/load
// — droid advertises both) with the http/stdio decision from the live
// initialize handshake, and sendTurn delivers the host-context block on the
// first turn. JsonRpcClient is stubbed so no real `droid` child is spawned;
// the adapter is imported dynamically so the stub is in place first.

import { describe, expect, mock, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { KONE_AGENT_IDENTITY_MARKER, KONE_HOST_CONTEXT_MARKER } from "./gateway/appContext.js";
import { KONE_GATEWAY_TOKEN_ENV, KONE_GATEWAY_URL_ENV, STDIO_PROXY_PATH } from "./gateway/injection.js";
import type { EmitEvent, SessionStartInput } from "./types.js";

/** Flipped by each test before startSession; the fake's initialize result
 *  mirrors it, exactly like a real droid handshake would. */
let httpCapable = false;
/** The session's rpc client — the one spawned with the project cwd (the
 *  model-catalog probe uses homedir() instead, so it can't be mistaken for it). */
let sessionRpc: FakeJsonRpcClient | null = null;

/** A JSON object this test builds as a stand-in ACP payload — every field is
 *  test-owned data the assertions pin exactly, never parsed generically. */
type RecordLike = {
  [key: string]: string | number | boolean | null | RecordLike | RecordLike[];
};

/** SAFETY: a no-op emitter — these tests never listen to what the adapter emits. */
const noopEmit = (() => {}) as EmitEvent;

/** The text blocks of an outgoing session/prompt. */
function promptParts(params: RecordLike | undefined): { type: string; text: string }[] {
  // SAFETY: the fake client records exactly what the adapter sent; its prompt
  // is always this list of text blocks.
  return (params as RecordLike).prompt as { type: string; text: string }[];
}

function sessionResponse(): RecordLike {
  return {
    sessionId: "ses-1",
    modes: { availableModes: [{ id: "auto-low" }, { id: "normal" }] },
    configOptions: [
      { id: "model", currentValue: "m1", options: [{ value: "m1" }] },
      { id: "reasoning_effort", currentValue: "medium", options: [{ value: "medium" }] },
      { id: "autonomy_level", currentValue: "auto-low", options: [{ value: "auto-low" }] },
    ],
    models: { availableModels: [{ modelId: "m1", name: "M1" }] },
  };
}

class FakeJsonRpcClient {
  readonly calls: { method: string; params?: RecordLike }[] = [];
  constructor(_command: string, _args: string[], opts: { cwd?: string }) {
    if (opts?.cwd && opts.cwd !== "/tmp/kone-test-project") return;
    // The adapter constructs its own RPC client, so the fake can only reach
    // the tests by registering the constructed instance here.
    // eslint-disable-next-line typescript/no-this-alias
    sessionRpc = this;
  }
  async call<T = RecordLike>(method: string, params?: RecordLike): Promise<T> {
    this.calls.push({ method, params });
    let response: unknown;
    switch (method) {
      case "initialize":
        response = {
          agentCapabilities: {
            mcpCapabilities: { http: httpCapable },
            // droid advertises `loadSession`; resume support rides
            // `sessionCapabilities.resume` (absent here → session/load door).
            sessionCapabilities: {},
            loadSession: true,
          },
          authMethods: [{ id: "factory-api-key" }, { id: "device-pairing" }],
        };
        break;
      case "authenticate":
        response = {};
        break;
      case "session/new":
      case "session/load":
      case "session/resume":
        response = sessionResponse();
        break;
      case "session/prompt":
        response = { stopReason: "end_turn" };
        break;
      default:
        response = {};
        break;
    }
    // SAFETY: each arm above builds exactly the payload this adapter's protocol
    // answers `method` with; T is that shape at every call site.
    return response as T;
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

// `probe` spawns the real `droid` CLI — the gateway registration step
// (registerGatewayMcp) drives `droid mcp remove/add` with it, which would
// mutate the user's persistent droid MCP config and can hang on a daemon.
// Stub it so the test is hermetic: any probe looks like a success.
mock.module(fileURLToPath(new URL("./spawn.ts", import.meta.url)), () => ({
  probe: async () => "ok",
}));

const { DroidAdapter } = await import("./adapters/DroidAdapter.js");

const CONNECTION = { url: "http://127.0.0.1:41231/mcp", bearerToken: "kone_gw_token-1" };

function start(overrides: Partial<SessionStartInput>) {
  sessionRpc = null;
  const adapter = new DroidAdapter(noopEmit);
  return adapter.startSession({
    threadId: "thread-1",
    provider: "droid",
    cwd: "/tmp/kone-test-project",
    ...overrides,
  });
}

describe("Droid gateway injection", () => {
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
    const adapter = new DroidAdapter(noopEmit);
    sessionRpc = null;
    await adapter.startSession({
      threadId: "thread-2",
      provider: "droid",
      cwd: "/tmp/kone-test-project",
      gatewayConnection: CONNECTION,
    });

    await adapter.sendTurn({ threadId: "thread-2", input: "hello world" });
    const first = sessionRpc!.calls.find((c) => c.method === "session/prompt");
    const firstText = promptParts(first?.params);
    expect(firstText[0].text).toContain(KONE_HOST_CONTEXT_MARKER);
    expect(firstText[0].text).toContain("kone_scratchpad_write");
    expect(firstText[0].text).toContain("hello world");

    await adapter.sendTurn({ threadId: "thread-2", input: "again" });
    const prompts = sessionRpc!.calls.filter((c) => c.method === "session/prompt");
    const secondText = promptParts(prompts[1].params);
    expect(secondText[0].text).toBe("again");
  });

  test("no gateway connection: no host-context block even on the first turn", async () => {
    httpCapable = true;
    const adapter = new DroidAdapter(noopEmit);
    sessionRpc = null;
    await adapter.startSession({
      threadId: "thread-3",
      provider: "droid",
      cwd: "/tmp/kone-test-project",
    });

    await adapter.sendTurn({ threadId: "thread-3", input: "plain" });
    const first = sessionRpc!.calls.find((c) => c.method === "session/prompt");
    const firstText = promptParts(first?.params);
    expect(firstText[0].text).toBe("plain");
  });
});

describe("Droid agent identity", () => {
  const MAYA = { name: "Maya" };

  /** The text of the nth session/prompt this adapter sent, in order. */
  function promptText(index: number): string {
    const prompts = sessionRpc!.calls.filter((c) => c.method === "session/prompt");
    const parts = promptParts(prompts[index].params);
    return parts[0].text;
  }

  test("a thread handed to an agent says who it is on the first turn, and once", async () => {
    httpCapable = true;
    const adapter = new DroidAdapter(noopEmit);
    sessionRpc = null;
    await adapter.startSession({
      threadId: "thread-4",
      provider: "droid",
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
    const adapter = new DroidAdapter(noopEmit);
    sessionRpc = null;
    await adapter.startSession({
      threadId: "thread-5",
      provider: "droid",
      cwd: "/tmp/kone-test-project",
      agent: undefined,
    });

    await adapter.sendTurn({ threadId: "thread-5", input: "plain" });
    expect(promptText(0)).toBe("plain");
  });

  test("an agent keeps its name with no gateway to talk to", async () => {
    httpCapable = true;
    const adapter = new DroidAdapter(noopEmit);
    sessionRpc = null;
    await adapter.startSession({
      threadId: "thread-6",
      provider: "droid",
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
