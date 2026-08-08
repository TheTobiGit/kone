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

import { KONE_HOST_CONTEXT_MARKER } from "./gateway/appContext.js";
import { KONE_GATEWAY_TOKEN_ENV, KONE_GATEWAY_URL_ENV, STDIO_PROXY_PATH } from "./gateway/injection.js";
import type { EmitEvent, SessionStartInput } from "./types.js";

/** Flipped by each test before startSession; the fake's initialize result
 *  mirrors it, exactly like a real droid handshake would. */
let httpCapable = false;
/** The session's rpc client — the one spawned with the project cwd (the
 *  model-catalog probe uses homedir() instead, so it can't be mistaken for it). */
let sessionRpc: FakeJsonRpcClient | null = null;

type RecordLike = Record<string, unknown>;

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
          agentCapabilities: {
            mcpCapabilities: { http: httpCapable },
            // droid advertises `loadSession`; resume support rides
            // `sessionCapabilities.resume` (absent here → session/load door).
            sessionCapabilities: {},
            loadSession: true,
          },
          authMethods: [{ id: "factory-api-key" }, { id: "device-pairing" }],
        } as T;
      case "authenticate":
        return {} as T;
      case "session/new":
      case "session/load":
      case "session/resume":
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
  const adapter = new DroidAdapter((() => {}) as EmitEvent);
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
    const adapter = new DroidAdapter((() => {}) as EmitEvent);
    sessionRpc = null;
    await adapter.startSession({
      threadId: "thread-2",
      provider: "droid",
      cwd: "/tmp/kone-test-project",
      gatewayConnection: CONNECTION,
    });

    await adapter.sendTurn({ threadId: "thread-2", input: "hello world" });
    const first = sessionRpc!.calls.find((c) => c.method === "session/prompt");
    const firstText = (first?.params as RecordLike).prompt as { type: string; text: string }[];
    expect(firstText[0].text).toContain(KONE_HOST_CONTEXT_MARKER);
    expect(firstText[0].text).toContain("kone_scratchpad_write");
    expect(firstText[0].text).toContain("hello world");

    await adapter.sendTurn({ threadId: "thread-2", input: "again" });
    const prompts = sessionRpc!.calls.filter((c) => c.method === "session/prompt");
    const secondText = (prompts[1].params as RecordLike).prompt as { type: string; text: string }[];
    expect(secondText[0].text).toBe("again");
  });

  test("no gateway connection: no host-context block even on the first turn", async () => {
    httpCapable = true;
    const adapter = new DroidAdapter((() => {}) as EmitEvent);
    sessionRpc = null;
    await adapter.startSession({
      threadId: "thread-3",
      provider: "droid",
      cwd: "/tmp/kone-test-project",
    });

    await adapter.sendTurn({ threadId: "thread-3", input: "plain" });
    const first = sessionRpc!.calls.find((c) => c.method === "session/prompt");
    const firstText = (first?.params as RecordLike).prompt as { type: string; text: string }[];
    expect(firstText[0].text).toBe("plain");
  });
});
