import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildClineApprovalRequest,
  clineActModeToApply,
  clineModelCatalog,
  clinePermissionAutoApproves,
  clinePermissionCommand,
  clineToolDetail,
  clineToolStatus,
  clineToolTarget,
  isClineAuthRequired,
  parseClineConfigOptions,
  parseClinePlan,
  selectClinePermissionOption,
} from "./adapters/clineProtocol.js";
import { detectClineAuth, parseClineVersion, resolveClineBinary } from "./clineHome.js";
import type { ApprovalDecision, EmitEvent, RuntimeEvent } from "./types.js";

// The `session/new` fixture is trimmed from a live `cline --acp` 3.0.65 capture
// (2026-09-29): the same field names and shapes (`modelId`, the `provider` /
// `model` / `mode` selects, the boolean `auto_approve`), just fewer models.
// Everything on the streamed-turn side — `session/update` payloads, the
// permission request, the prompt result — is the ACP standard, NOT a Cline
// capture (no signed-in account to run a turn on), so those fixtures are
// spec-derived and say so where they appear.

/** A JSON object this test builds as a stand-in ACP payload — every field is
 *  test-owned data the assertions pin exactly, never parsed generically. */
type RecordLike = {
  [key: string]: string | number | boolean | null | RecordLike | RecordLike[];
};

/** A fixture field the test knows holds a list of payload objects. */
function recordList(value: RecordLike[string] | undefined): RecordLike[] {
  // SAFETY: only called on fields the fake child and the adapter build as lists of objects.
  return Array.isArray(value) ? (value as RecordLike[]) : [];
}

/** A fixture field the test knows holds one payload object. */
function recordOf(value: RecordLike[string] | undefined): RecordLike {
  // SAFETY: only called on fields the fake child and the adapter build as objects.
  return value as RecordLike;
}

const AUTH_REQUIRED = "Authentication required: Call authenticate before starting a session";

/** What the fake `cline --acp` child does. Reset before every test. */
type Behavior = {
  /** `session/new` and `session/load` answer -32000 until `authenticate` ran. */
  authRequired: boolean;
  /** Mode the session opens on. */
  currentModeId: string;
  /** Errors by method, thrown instead of the scripted answer. */
  errors: Record<string, { message: string; code: number } | undefined>;
  /** Refuse `session/new` with invalid-params whenever it carries an MCP server. */
  refuseMcpServers: boolean;
  /** The `session/prompt` gate: resolves the stop reason. Unset = end_turn now. */
  prompt?: () => Promise<RecordLike>;
};

const behavior: Behavior = {
  authRequired: false,
  currentModeId: "act",
  errors: {},
  refuseMcpServers: false,
};

function resetBehavior(): void {
  behavior.authRequired = false;
  behavior.currentModeId = "act";
  behavior.errors = {};
  behavior.refuseMcpServers = false;
  behavior.prompt = undefined;
}

class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

function sessionResponse(sessionId: string): RecordLike {
  return {
    sessionId,
    modes: {
      availableModes: [
        { id: "plan", name: "Plan", description: "Explore the codebase and plan changes without modifying files" },
        { id: "act", name: "Act", description: "Make changes to the codebase" },
      ],
      currentModeId: behavior.currentModeId,
    },
    models: {
      availableModels: [
        { modelId: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" },
        { modelId: "openai/gpt-6-sol", name: "GPT-6 Sol" },
        { modelId: "moonshotai/kimi-k3", name: "Kimi K3" },
      ],
      currentModelId: "anthropic/claude-sonnet-5",
    },
    configOptions: configMatrix("anthropic/claude-sonnet-5"),
  };
}

function configMatrix(model: string): RecordLike[] {
  return [
    {
      type: "select", id: "provider", name: "Provider", description: "The authentication provider to use",
      category: "model", currentValue: "cline",
      options: [{ value: "cline", name: "Cline Usage-Billing" }, { value: "cline-pass", name: "ClinePass" }],
    },
    {
      type: "select", id: "model", name: "Model", category: "model", currentValue: model,
      options: [
        { value: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" },
        { value: "openai/gpt-6-sol", name: "GPT-6 Sol" },
        { value: "moonshotai/kimi-k3", name: "Kimi K3" },
      ],
    },
    {
      type: "select", id: "mode", name: "Session Mode", description: "Controls whether the agent can modify files",
      category: "mode", currentValue: "act",
      options: [{ value: "plan", name: "Plan" }, { value: "act", name: "Act" }],
    },
    {
      type: "boolean", id: "auto_approve", name: "Auto-approve tools",
      description: "Automatically approve all tool calls without asking for permission", currentValue: false,
    },
  ];
}

/** Every fake child the adapter spawned, in order. */
const children: FakeJsonRpcClient[] = [];

/** A scripted stand-in for the `cline --acp` child: it answers the requests
 *  the adapter sends the way the live 3.0.65 build does (see the header of
 *  ClineAdapter.ts), records every call, and lets a test push `session/update`
 *  notifications and permission requests through the handlers the adapter
 *  registered. */
class FakeJsonRpcClient {
  readonly calls: { method: string; params?: RecordLike }[] = [];
  readonly notifications: { method: string; params?: RecordLike }[] = [];
  killed = false;
  private authenticated = false;
  private readonly notificationHandlers = new Map<string, Set<(params: RecordLike) => void>>();
  private readonly requestHandlers = new Map<string, (params: RecordLike) => Promise<RecordLike>>();
  private readonly exitHandlers = new Set<(code: number | null) => void>();

  constructor(
    readonly command: string,
    readonly args: string[],
    readonly opts: { cwd?: string },
  ) {
    children.push(this);
  }

  async call<T = RecordLike>(method: string, params?: RecordLike): Promise<T> {
    this.calls.push({ method, params });
    const scripted = behavior.errors[method];
    if (scripted) throw new RpcError(scripted.message, scripted.code);
    let response: RecordLike;
    switch (method) {
      case "initialize":
        // Verbatim from the live handshake.
        response = {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: false } },
          agentInfo: { name: "cline", version: "3.0.65" },
          authMethods: [{ id: "cline", name: "Sign in with Cline" }, { id: "cline-pass", name: "Sign in with ClinePass" }],
        };
        break;
      case "authenticate":
        this.authenticated = true;
        response = {};
        break;
      case "session/new":
      case "session/load": {
        if (behavior.authRequired && !this.authenticated) throw new RpcError(AUTH_REQUIRED, -32000);
        const servers = recordList(params?.mcpServers);
        if (method === "session/new" && behavior.refuseMcpServers && servers.length > 0) {
          throw new RpcError("Invalid params", -32602);
        }
        response = sessionResponse(method === "session/load" ? String(params?.sessionId) : `cline-session-${children.length}`);
        break;
      }
      case "session/set_config_option":
        // Verbatim behaviour: the refreshed matrix comes back in the response.
        response = { configOptions: configMatrix(String(params?.value)) };
        break;
      case "session/prompt":
        response = behavior.prompt ? await behavior.prompt() : { stopReason: "end_turn" };
        break;
      default:
        response = {};
        break;
    }
    // SAFETY: each arm above builds the payload the live build answers `method`
    // with; T is that shape at every call site.
    return response as T;
  }

  notify(method: string, params?: RecordLike): void {
    this.notifications.push({ method, params });
  }

  onNotification(method: string, handler: (params: RecordLike) => void): () => void {
    const set = this.notificationHandlers.get(method) ?? new Set();
    set.add(handler);
    this.notificationHandlers.set(method, set);
    return () => set.delete(handler);
  }

  onRequest(method: string, handler: (params: RecordLike) => Promise<RecordLike>): void {
    this.requestHandlers.set(method, handler);
  }

  onExit(handler: (code: number | null) => void): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  onStderrLine(): () => void {
    return () => {};
  }

  async kill(): Promise<void> {
    if (this.killed) return;
    this.killed = true;
    for (const handler of this.exitHandlers) handler(0);
  }

  /** Push one `session/update` notification through the adapter's handler. */
  update(update: RecordLike): void {
    for (const handler of this.notificationHandlers.get("session/update") ?? []) {
      handler({ sessionId: "s", update });
    }
  }

  /** Issue one `session/request_permission` reverse request and await the reply. */
  request(params: RecordLike): Promise<RecordLike> {
    const handler = this.requestHandlers.get("session/request_permission");
    if (!handler) throw new Error("adapter registered no permission handler");
    return handler(params);
  }
}

// The adapter imports `{ JsonRpcClient } from "../jsonRpc.js"` — mocked by its
// resolved absolute path, and the adapter is imported dynamically afterwards so
// the stub is in place first (same arrangement as droidGatewayInjection.test).
mock.module(fileURLToPath(new URL("./jsonRpc.ts", import.meta.url)), () => ({
  JsonRpcClient: FakeJsonRpcClient,
}));

// The `cline --version` probe, scripted for two marker paths and passed through
// for everything else. bun keeps one mock registry per worker process, so a
// blanket stub here would reach every later suite (and another suite's stub —
// claudeAdapter.test's — already reaches this one, which is why the tests can't
// just spawn a real fake binary and read its output).
const actualSpawn = await import("./spawn.js");
const FAKE_CLINE = "/kone-cline-fake/cline";
const MISSING_CLINE = "/kone-cline-fake/missing";
mock.module(fileURLToPath(new URL("./spawn.ts", import.meta.url)), () => ({
  ...actualSpawn,
  probeResult: async (...args: Parameters<typeof actualSpawn.probeResult>) => {
    if (args[0] === FAKE_CLINE) return { outcome: "ok", stdout: "3.0.65\n", stderr: "", code: 0 } as const;
    if (args[0] === MISSING_CLINE) return { outcome: "missing", stdout: "", stderr: "", code: null } as const;
    return actualSpawn.probeResult(...args);
  },
}));

const { ClineAdapter } = await import("./adapters/ClineAdapter.js");

const PROJECT = "/tmp/kone-test-project";

/** The session's child — the one spawned with the project cwd (the catalog
 *  probe uses tmpdir(), so it can't be mistaken for it). */
function sessionChild(): FakeJsonRpcClient {
  const child = children.find((candidate) => candidate.opts.cwd === PROJECT);
  if (!child) throw new Error("no session child was spawned");
  return child;
}

function makeAdapter() {
  const events: RuntimeEvent[] = [];
  // SAFETY: EmitEvent takes a RuntimeEvent; the collector only stores it.
  const emit: EmitEvent = (event) => {
    events.push(event);
  };
  return { adapter: new ClineAdapter(emit), events };
}

function types(events: RuntimeEvent[]): string[] {
  return events.map((event) => event.type);
}

/** Wait until `predicate` holds, or fail. Events land asynchronously after the
 *  prompt promise settles. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** ACP permission options as the standard spells them. UNVERIFIED for Cline. */
const PERMISSION_OPTIONS: RecordLike[] = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];

function permissionRequest(kind: string, rawInput: RecordLike, title = "Tool"): RecordLike {
  return { sessionId: "s", toolCall: { toolCallId: "call-1", title, kind, rawInput }, options: PERMISSION_OPTIONS };
}

function selected(reply: RecordLike): string | undefined {
  const outcome = recordOf(reply.outcome);
  return outcome.outcome === "selected" ? String(outcome.optionId) : undefined;
}

beforeEach(() => {
  resetBehavior();
  children.length = 0;
});

// ── install / auth detection ─────────────────────────────────────────────────

describe("Cline install detection", () => {
  test("resolves a blank override to `cline`, keeps a real path", () => {
    expect(resolveClineBinary(undefined)).toBe("cline");
    expect(resolveClineBinary("  ")).toBe("cline");
    expect(resolveClineBinary("/opt/bin/cline")).toBe("/opt/bin/cline");
  });

  test("reads the bare semver `cline --version` prints", () => {
    expect(parseClineVersion("3.0.65\n")).toBe("3.0.65");
  });

  describe("auth", () => {
    let dataDir: string;
    beforeEach(() => {
      dataDir = mkdtempSync(path.join(tmpdir(), "kone-cline-data-"));
    });
    afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

    test("an API key in the env is a login, and a blank one is not", async () => {
      expect(await detectClineAuth({ CLINE_API_KEY: "x", CLINE_DATA_DIR: dataDir })).toEqual({
        authenticated: true,
        label: "Cline API Key",
      });
      expect((await detectClineAuth({ CLINE_API_KEY: "  ", CLINE_DATA_DIR: dataDir })).authenticated).toBe(false);
    });

    test("only a non-empty provider-settings file counts — the settings dir alone does not", async () => {
      mkdirSync(path.join(dataDir, "settings"), { recursive: true });
      expect((await detectClineAuth({ CLINE_DATA_DIR: dataDir })).authenticated).toBe(false);
      writeFileSync(path.join(dataDir, "settings", "providers.json"), "");
      expect((await detectClineAuth({ CLINE_DATA_DIR: dataDir })).authenticated).toBe(false);
      writeFileSync(path.join(dataDir, "settings", "providers.json"), "{}");
      expect(await detectClineAuth({ CLINE_DATA_DIR: dataDir })).toEqual({ authenticated: true, label: "Cline Login" });
    });
  });
});

describe("Cline discovery", () => {
  let dir: string;
  const previous = { data: process.env.CLINE_DATA_DIR, key: process.env.CLINE_API_KEY };
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "kone-cline-bin-"));
    process.env.CLINE_DATA_DIR = path.join(dir, "data");
    delete process.env.CLINE_API_KEY;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (previous.data === undefined) delete process.env.CLINE_DATA_DIR;
    else process.env.CLINE_DATA_DIR = previous.data;
    if (previous.key === undefined) delete process.env.CLINE_API_KEY;
    else process.env.CLINE_API_KEY = previous.key;
  });

  test("a missing binary is not installed, with the npm install hint", async () => {
    const { adapter } = makeAdapter();
    adapter.setConfig({ binaryPath: MISSING_CLINE });
    const status = await adapter.discover();
    expect(status).toMatchObject({ provider: "cline", available: false, readiness: "not-installed" });
    expect(status.message).toContain("npm i -g cline");
  });

  test("installed but signed out needs login, and says how", async () => {
    const { adapter } = makeAdapter();
    adapter.setConfig({ binaryPath: FAKE_CLINE });
    const status = await adapter.discover();
    expect(status).toMatchObject({
      provider: "cline",
      available: true,
      authStatus: "unauthenticated",
      readiness: "needs-login",
      version: "3.0.65",
    });
    expect(status.message).toContain("cline auth");
  });

  test("installed with credentials on disk is ready", async () => {
    mkdirSync(path.join(dir, "data", "settings"), { recursive: true });
    writeFileSync(path.join(dir, "data", "settings", "providers.json"), "{}");
    const { adapter } = makeAdapter();
    adapter.setConfig({ binaryPath: FAKE_CLINE });
    expect(await adapter.discover()).toMatchObject({
      authStatus: "authenticated",
      readiness: "ready",
      authLabel: "Cline Login",
      version: "3.0.65",
    });
  });
});

// ── protocol decoders ────────────────────────────────────────────────────────

describe("Cline config options and catalog", () => {
  test("projects the live matrix, keeping the boolean option's value as text", () => {
    const parsed = parseClineConfigOptions(configMatrix("openai/gpt-6-sol"));
    expect(parsed.map((option) => option.id)).toEqual(["provider", "model", "mode", "auto_approve"]);
    expect(parsed[1]).toMatchObject({ id: "model", currentValue: "openai/gpt-6-sol" });
    expect(parsed[1]?.options).toHaveLength(3);
    expect(parsed[3]).toMatchObject({ id: "auto_approve", type: "boolean", currentValue: "false", options: [] });
  });

  test("tolerates malformed rows", () => {
    expect(parseClineConfigOptions([{ name: "no id" }, { id: "model", options: [{ name: "no value" }] }])).toEqual([
      { id: "model", name: undefined, category: undefined, type: undefined, currentValue: undefined, options: [] },
    ]);
    expect(parseClineConfigOptions(undefined)).toEqual([]);
  });

  test("the catalog is models.availableModels, and falls back to the model option", () => {
    const options = parseClineConfigOptions(configMatrix("x"));
    expect(clineModelCatalog(sessionResponse("s"), options)).toEqual([
      { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5" },
      { id: "openai/gpt-6-sol", label: "GPT-6 Sol" },
      { id: "moonshotai/kimi-k3", label: "Kimi K3" },
    ]);
    expect(clineModelCatalog({ sessionId: "s" }, options).map((model) => model.id)).toEqual([
      "anthropic/claude-sonnet-5",
      "openai/gpt-6-sol",
      "moonshotai/kimi-k3",
    ]);
  });

  test("a session that opened off `act` is switched onto it, once", () => {
    expect(clineActModeToApply("act", ["plan", "act"])).toBeUndefined();
    expect(clineActModeToApply("plan", ["plan", "act"])).toBe("act");
    // A build that advertises no `act` is left where it is rather than sent an id it lacks.
    expect(clineActModeToApply("plan", ["plan"])).toBeUndefined();
  });
});

describe("Cline auth-required detection", () => {
  test("recognises the live signed-out answer, and nothing else", () => {
    expect(isClineAuthRequired(new RpcError(AUTH_REQUIRED, -32000))).toBe(true);
    expect(isClineAuthRequired(new Error(AUTH_REQUIRED))).toBe(true);
    expect(isClineAuthRequired(new RpcError("Resource not found: ses-1", -32002))).toBe(false);
    expect(isClineAuthRequired(new RpcError("Internal error", -32603))).toBe(false);
  });
});

describe("Cline permission policy", () => {
  test("full-access lets everything through; reads always; edits from accept-edits up", () => {
    for (const kind of ["read", "search", "edit", "execute", "fetch", "other", ""]) {
      expect(clinePermissionAutoApproves("full-access", kind)).toBe(true);
    }
    expect(clinePermissionAutoApproves("ask", "read")).toBe(true);
    expect(clinePermissionAutoApproves("ask", "edit")).toBe(false);
    expect(clinePermissionAutoApproves("accept-edits", "edit")).toBe(true);
    expect(clinePermissionAutoApproves("accept-edits", "delete")).toBe(true);
    expect(clinePermissionAutoApproves("accept-edits", "execute")).toBe(false);
    // An unclassified kind is never waved through below full-access.
    expect(clinePermissionAutoApproves("accept-edits", "")).toBe(false);
    expect(clinePermissionAutoApproves("accept-edits", "fetch")).toBe(false);
  });

  test("selects the option by ACP kind, not by id", () => {
    expect(selectClinePermissionOption(PERMISSION_OPTIONS, "allow-once")).toBe("allow-once");
    expect(selectClinePermissionOption(PERMISSION_OPTIONS, "allow-always")).toBe("allow-always");
    expect(selectClinePermissionOption(PERMISSION_OPTIONS, "reject-once")).toBe("reject");
    // reject-and-stop matches nothing: the agent gets a cancelled outcome.
    expect(selectClinePermissionOption(PERMISSION_OPTIONS, "reject-and-stop")).toBeUndefined();
    // A build that omits `kind` is matched on the option id.
    expect(selectClinePermissionOption([{ optionId: "allow_once" }, { optionId: "reject_once" }], "reject-once")).toBe(
      "reject_once",
    );
  });

  test("reads the command and classifies the ask", () => {
    const run = permissionRequest("execute", { command: "npm test" }, "Run tests");
    expect(clinePermissionCommand(run)).toBe("npm test");
    expect(buildClineApprovalRequest(run)).toEqual({ kind: "command", title: "npm test" });
    // An execute ask with no command falls back to its title for the safety screen.
    expect(clinePermissionCommand(permissionRequest("execute", {}, "rm -rf ~"))).toBe("rm -rf ~");
    expect(clinePermissionCommand(permissionRequest("edit", { path: "a.ts" }))).toBeUndefined();
    expect(buildClineApprovalRequest(permissionRequest("edit", { path: "a.ts" }, "Edit a.ts")).kind).toBe("file-change");
    expect(buildClineApprovalRequest(permissionRequest("read", {}, "Read a.ts")).kind).toBe("file-read");
    expect(buildClineApprovalRequest(permissionRequest("other", {}, "MCP call")).kind).toBe("permission");
  });
});

describe("Cline tool-call and plan translation", () => {
  // ACP-standard shapes, not Cline captures.
  test("prefers the command, then the path, then the title", () => {
    expect(clineToolTarget({ rawInput: { command: " ls -la " } })).toBe("ls -la");
    expect(clineToolTarget({ rawInput: { path: "src/a.ts" } })).toBe("src/a.ts");
    expect(clineToolTarget({ locations: [{ path: "a.ts" }, { path: "b.ts" }] })).toBe("a.ts +1 more");
    expect(clineToolTarget({ title: "Search files" })).toBe("Search files");
    expect(clineToolTarget({})).toBe("");
  });

  test("collects text blocks and raw output; unknown output shapes are stringified", () => {
    expect(
      clineToolDetail({ content: [{ type: "content", content: { type: "text", text: "hello" } }], rawOutput: { output: "world" } }),
    ).toBe("hello\nworld");
    expect(clineToolDetail({ rawOutput: { weird: 1 } })).toBe(`{\n  "weird": 1\n}`);
    expect(clineToolDetail({})).toBe("");
  });

  test("only completed and failed close a tool row", () => {
    expect(["pending", "in_progress", "completed", "failed", undefined].map(clineToolStatus)).toEqual([
      "in-progress",
      "in-progress",
      "completed",
      "failed",
      "in-progress",
    ]);
  });

  test("re-spells ACP's in_progress and drops empty entries", () => {
    expect(
      parseClinePlan({
        entries: [
          { content: "Read", status: "completed" },
          { content: "Edit", status: "in_progress" },
          { content: "  ", status: "pending" },
        ],
      }),
    ).toEqual([
      { content: "Read", status: "completed" },
      { content: "Edit", status: "in-progress" },
    ]);
    expect(parseClinePlan({ entries: [] })).toBeUndefined();
  });
});

// ── adapter against the fake child ───────────────────────────────────────────

describe("ClineAdapter startSession", () => {
  test("initializes over `cline --acp`, opens a session, and adopts its model and catalog", async () => {
    const { adapter, events } = makeAdapter();
    const session = await adapter.startSession({ threadId: "t1", provider: "cline", cwd: PROJECT });

    const child = sessionChild();
    expect(child.args).toEqual(["--acp"]);
    expect(child.calls.map((call) => call.method)).toEqual(["initialize", "session/new"]);
    expect(child.calls[0]?.params).toMatchObject({ protocolVersion: 1, clientInfo: { name: "kone" } });
    expect(child.calls[1]?.params).toEqual({ cwd: PROJECT, mcpServers: [] });
    expect(session).toMatchObject({
      threadId: "t1",
      provider: "cline",
      status: "ready",
      model: "anthropic/claude-sonnet-5",
      mode: "accept-edits",
    });
    expect(session.conversationId).toStartWith("cline-session-");
    expect(session.resumedFrom).toBeUndefined();
    expect(types(events)).toEqual(["session.started"]);
    // No login is ever driven: an already-good session never sees `authenticate`.
    expect(child.calls.some((call) => call.method === "authenticate")).toBe(false);

    // The session's own `session/new` seeded the catalog — no second child.
    const spawned = children.length;
    expect(await adapter.listModels()).toEqual([
      { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5" },
      { id: "openai/gpt-6-sol", label: "GPT-6 Sol" },
      { id: "moonshotai/kimi-k3", label: "Kimi K3" },
    ]);
    expect(children.length).toBe(spawned);
  });

  test("a session that opened in plan mode is switched to act; an act session is left alone", async () => {
    behavior.currentModeId = "plan";
    const { adapter } = makeAdapter();
    await adapter.startSession({ threadId: "t1", provider: "cline", cwd: PROJECT });
    const setMode = sessionChild().calls.find((call) => call.method === "session/set_mode");
    expect(setMode?.params).toMatchObject({ modeId: "act" });

    children.length = 0;
    behavior.currentModeId = "act";
    const second = makeAdapter();
    await second.adapter.startSession({ threadId: "t2", provider: "cline", cwd: PROJECT });
    expect(sessionChild().calls.some((call) => call.method === "session/set_mode")).toBe(false);
  });

  test("a requested catalog model is set and adopted from the refreshed matrix", async () => {
    const { adapter } = makeAdapter();
    const session = await adapter.startSession({
      threadId: "t1",
      provider: "cline",
      cwd: PROJECT,
      model: "openai/gpt-6-sol",
    });
    const set = sessionChild().calls.find((call) => call.method === "session/set_config_option");
    expect(set?.params).toMatchObject({ configId: "model", value: "openai/gpt-6-sol" });
    expect(session.model).toBe("openai/gpt-6-sol");
  });

  test("a model outside the catalog is never sent — cline would accept it and fail at the prompt", async () => {
    const { adapter, events } = makeAdapter();
    const session = await adapter.startSession({
      threadId: "t1",
      provider: "cline",
      cwd: PROJECT,
      model: "nope/none",
    });
    expect(sessionChild().calls.some((call) => call.method === "session/set_config_option")).toBe(false);
    expect(session.model).toBe("anthropic/claude-sonnet-5");
    const warning = events.find((event) => event.type === "session.state.changed");
    expect(warning).toMatchObject({ message: expect.stringContaining("nope/none") });
  });

  test("signed out: fails with the `cline auth` message, never runs authenticate, and kills the child", async () => {
    behavior.authRequired = true;
    const { adapter, events } = makeAdapter();
    const previousKey = process.env.CLINE_API_KEY;
    delete process.env.CLINE_API_KEY;
    try {
      const failure = await adapter
        .startSession({ threadId: "t1", provider: "cline", cwd: PROJECT })
        .then(() => undefined, (error: Error) => error);
      expect(failure?.message).toContain("cline auth");
      const child = sessionChild();
      expect(child.calls.map((call) => call.method)).toEqual(["initialize", "session/new"]);
      expect(child.killed).toBe(true);
      expect(types(events)).not.toContain("session.started");
      expect(await adapter.hasSession("t1")).toBe(false);
    } finally {
      if (previousKey !== undefined) process.env.CLINE_API_KEY = previousKey;
    }
  });

  test("signed out with CLINE_API_KEY set: one headless authenticate, then the open is retried", async () => {
    behavior.authRequired = true;
    const previousKey = process.env.CLINE_API_KEY;
    process.env.CLINE_API_KEY = "test-key";
    try {
      const { adapter } = makeAdapter();
      const session = await adapter.startSession({ threadId: "t1", provider: "cline", cwd: PROJECT });
      expect(sessionChild().calls.map((call) => call.method)).toEqual([
        "initialize",
        "session/new",
        "authenticate",
        "session/new",
      ]);
      expect(sessionChild().calls[2]?.params).toEqual({ methodId: "cline" });
      expect(session.status).toBe("ready");
    } finally {
      if (previousKey === undefined) delete process.env.CLINE_API_KEY;
      else process.env.CLINE_API_KEY = previousKey;
    }
  });

  test("a server that refuses the MCP entry costs the app tools, not the thread", async () => {
    behavior.refuseMcpServers = true;
    const { adapter, events } = makeAdapter();
    const session = await adapter.startSession({
      threadId: "t1",
      provider: "cline",
      cwd: PROJECT,
      gatewayConnection: { url: "http://127.0.0.1:1/mcp", bearerToken: "tok", tools: [] },
    });
    const opens = sessionChild().calls.filter((call) => call.method === "session/new");
    expect(opens).toHaveLength(2);
    expect(recordList(opens[0]?.params?.mcpServers)).toHaveLength(1);
    expect(opens[1]?.params).toEqual({ cwd: PROJECT, mcpServers: [] });
    expect(session.status).toBe("ready");
    expect(events.some((event) => event.type === "session.state.changed")).toBe(true);
  });

  test("hands the agent a stdio MCP proxy: cline advertises no http capability", async () => {
    const { adapter } = makeAdapter();
    await adapter.startSession({
      threadId: "t1",
      provider: "cline",
      cwd: PROJECT,
      gatewayConnection: { url: "http://127.0.0.1:1/mcp", bearerToken: "tok", tools: [] },
    });
    const servers = recordList(sessionChild().calls.find((call) => call.method === "session/new")?.params?.mcpServers);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: "kone", command: process.execPath });
    expect(servers[0]).not.toHaveProperty("type");
  });
});

describe("ClineAdapter resume", () => {
  test("resumes through session/load — cline has no session/resume — and keeps the id", async () => {
    const { adapter } = makeAdapter();
    const session = await adapter.startSession({ threadId: "t1", provider: "cline", cwd: PROJECT, resume: "ses-old" });
    const methods = sessionChild().calls.map((call) => call.method);
    expect(methods).toEqual(["initialize", "session/load"]);
    expect(sessionChild().calls[1]?.params).toEqual({ sessionId: "ses-old", cwd: PROJECT, mcpServers: [] });
    expect(session.conversationId).toBe("ses-old");
    expect(session.resumedFrom).toBe("ses-old");
  });

  test("a load cline refuses (session gone, or never prompted) starts fresh instead of failing the thread", async () => {
    behavior.errors["session/load"] = { message: "Resource not found: ses-old", code: -32002 };
    const { adapter } = makeAdapter();
    const session = await adapter.startSession({ threadId: "t1", provider: "cline", cwd: PROJECT, resume: "ses-old" });
    expect(sessionChild().calls.map((call) => call.method)).toEqual(["initialize", "session/load", "session/new"]);
    expect(session.resumedFrom).toBeUndefined();
    expect(session.conversationId).not.toBe("ses-old");
  });

  test("a load that fails for any other reason surfaces", async () => {
    behavior.errors["session/load"] = { message: "database is locked", code: -32603 };
    const { adapter } = makeAdapter();
    const failure = await adapter
      .startSession({ threadId: "t1", provider: "cline", cwd: PROJECT, resume: "ses-old" })
      .then(() => undefined, (error: Error) => error);
    expect(failure?.message).toContain("database is locked");
    expect(sessionChild().calls.some((call) => call.method === "session/new")).toBe(false);
  });

  test("a signed-out load is an auth failure, not a stale id to paper over with a fresh session", async () => {
    behavior.authRequired = true;
    const previousKey = process.env.CLINE_API_KEY;
    delete process.env.CLINE_API_KEY;
    try {
      const { adapter } = makeAdapter();
      const failure = await adapter
        .startSession({ threadId: "t1", provider: "cline", cwd: PROJECT, resume: "ses-old" })
        .then(() => undefined, (error: Error) => error);
      expect(failure?.message).toContain("cline auth");
      expect(sessionChild().calls.some((call) => call.method === "session/new")).toBe(false);
    } finally {
      if (previousKey !== undefined) process.env.CLINE_API_KEY = previousKey;
    }
  });
});

describe("ClineAdapter streamed turn", () => {
  test("maps thought, message, tool and plan updates onto runtime items, then completes", async () => {
    let finish: (result: RecordLike) => void = () => {};
    behavior.prompt = () => new Promise<RecordLike>((resolve) => (finish = resolve));
    const { adapter, events } = makeAdapter();
    await adapter.startSession({ threadId: "t1", provider: "cline", cwd: PROJECT });
    const child = sessionChild();

    const { turnId } = await adapter.sendTurn({ threadId: "t1", input: "  fix the bug  " });
    expect(turnId).toStartWith("cline-turn-");
    const prompt = child.calls.find((call) => call.method === "session/prompt");
    expect(prompt?.params).toMatchObject({ prompt: [{ type: "text", text: "fix the bug" }] });

    child.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Look at " } });
    child.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "the parser." } });
    child.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reading " } });
    child.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "the file." } });
    child.update({
      sessionUpdate: "tool_call", toolCallId: "call-1", title: "Read parser.ts", kind: "read", status: "pending",
      rawInput: { path: "src/parser.ts" },
    });
    child.update({
      sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed",
      content: [{ type: "content", content: { type: "text", text: "export const x = 1;" } }],
    });
    child.update({
      sessionUpdate: "plan",
      entries: [{ content: "Fix parser", status: "in_progress" }, { content: "Run tests", status: "pending" }],
    });
    child.update({ sessionUpdate: "usage_update", used: 1200, size: 200000 });
    finish({ stopReason: "end_turn" });
    await until(() => types(events).includes("turn.completed"), "turn.completed");

    const items = events.flatMap((event) => (event.type.startsWith("item.") && "item" in event ? [event] : []));
    const reasoning = items.filter((event) => "item" in event && event.item.kind === "reasoning_text");
    const lastReasoning = reasoning[reasoning.length - 1];
    expect(lastReasoning && "item" in lastReasoning ? lastReasoning.item.text : "").toBe("Look at the parser.");
    const assistant = items.filter((event) => "item" in event && event.item.kind === "assistant_text");
    const lastAssistant = assistant[assistant.length - 1];
    expect(lastAssistant && "item" in lastAssistant ? lastAssistant.item : undefined).toMatchObject({
      text: "Reading the file.",
      status: "completed",
    });
    const tool = items.filter((event) => "item" in event && event.item.kind === "tool_call");
    const lastTool = tool[tool.length - 1];
    expect(lastTool && "item" in lastTool ? lastTool.item : undefined).toMatchObject({
      name: "read_file",
      text: "src/parser.ts",
      detail: "export const x = 1;",
      status: "completed",
    });
    const plan = items.find((event) => "item" in event && event.item.kind === "plan_text");
    expect(plan && "item" in plan ? plan.item.tasks?.map((task) => task.status) : undefined).toEqual([
      "in-progress",
      "pending",
    ]);
    expect(events.find((event) => event.type === "thread.token-usage.updated")).toMatchObject({
      usage: { contextUsed: 1200, contextWindow: 200000 },
    });

    // The turn is bracketed and carries the resume id on its envelope.
    expect(types(events).filter((type) => type.startsWith("turn."))).toEqual(["turn.started", "turn.completed"]);
    const completed = events.find((event) => event.type === "turn.completed");
    expect(completed).toMatchObject({ turnId, conversationId: expect.any(String) });
    expect((await adapter.listSessions())[0]?.status).toBe("ready");
  });

  test("the first turn carries the host-context block only when there is a gateway, and only once", async () => {
    const { adapter } = makeAdapter();
    await adapter.startSession({
      threadId: "t1",
      provider: "cline",
      cwd: PROJECT,
      gatewayConnection: {
        url: "http://127.0.0.1:1/mcp",
        bearerToken: "tok",
        tools: [{ name: "scratchpad_read", snippet: "Read the scratchpad.", guidelines: [], needsApproval: false }],
      },
    });
    const child = sessionChild();
    await adapter.sendTurn({ threadId: "t1", input: "hello" });
    await adapter.sendTurn({ threadId: "t1", input: "again" });
    const prompts = child.calls.filter((call) => call.method === "session/prompt");
    const text = (index: number) => recordList(prompts[index]?.params?.prompt)[0]?.text;
    expect(text(0)).toContain("scratchpad_read");
    expect(text(0)).toContain("hello");
    expect(text(1)).toBe("again");
  });

  test("a turn asking for another catalog model switches it first; one asking for the current model does not", async () => {
    const { adapter } = makeAdapter();
    await adapter.startSession({ threadId: "t1", provider: "cline", cwd: PROJECT });
    const child = sessionChild();
    await adapter.sendTurn({ threadId: "t1", input: "a", model: "anthropic/claude-sonnet-5" });
    expect(child.calls.some((call) => call.method === "session/set_config_option")).toBe(false);
    await adapter.sendTurn({ threadId: "t1", input: "b", model: "moonshotai/kimi-k3" });
    const methods = child.calls.map((call) => call.method);
    expect(methods.lastIndexOf("session/set_config_option")).toBeLessThan(methods.lastIndexOf("session/prompt"));
    expect((await adapter.listSessions())[0]?.model).toBe("moonshotai/kimi-k3");
  });

  test("a rejected prompt fails the turn instead of leaving it spinning", async () => {
    behavior.errors["session/prompt"] = { message: "boom", code: -32603 };
    const { adapter, events } = makeAdapter();
    await adapter.startSession({ threadId: "t1", provider: "cline", cwd: PROJECT });
    await adapter.sendTurn({ threadId: "t1", input: "go" });
    await until(() => types(events).includes("turn.aborted"), "turn.aborted");
    expect(events.find((event) => event.type === "turn.aborted")).toMatchObject({ reason: "failed", message: "boom" });
  });

  test("a prompt refused as signed out tells the user to run `cline auth`", async () => {
    behavior.errors["session/prompt"] = { message: AUTH_REQUIRED, code: -32000 };
    const { adapter, events } = makeAdapter();
    await adapter.startSession({ threadId: "t1", provider: "cline", cwd: PROJECT });
    await adapter.sendTurn({ threadId: "t1", input: "go" });
    await until(() => types(events).includes("turn.aborted"), "turn.aborted");
    expect(events.find((event) => event.type === "turn.aborted")).toMatchObject({
      message: expect.stringContaining("cline auth"),
    });
  });

  test("interrupt sends session/cancel and the turn ends aborted, not completed", async () => {
    let finish: (result: RecordLike) => void = () => {};
    behavior.prompt = () => new Promise<RecordLike>((resolve) => (finish = resolve));
    const { adapter, events } = makeAdapter();
    await adapter.startSession({ threadId: "t1", provider: "cline", cwd: PROJECT });
    const child = sessionChild();
    await adapter.sendTurn({ threadId: "t1", input: "long job" });
    child.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working" } });

    await adapter.interruptTurn("t1");
    expect(child.notifications).toEqual([{ method: "session/cancel", params: { sessionId: expect.any(String) } }]);
    finish({ stopReason: "cancelled" });
    await until(() => types(events).includes("turn.aborted"), "turn.aborted");
    expect(events.find((event) => event.type === "turn.aborted")).toMatchObject({ reason: "interrupted" });
    expect(types(events)).not.toContain("turn.completed");
    // The half-streamed message is settled, not left running forever.
    const assistant = events.filter((event) => event.type === "item.completed");
    expect(assistant.length).toBeGreaterThan(0);
  });

  test("stopping mid-turn seals the live turn and kills the child", async () => {
    behavior.prompt = () => new Promise<RecordLike>(() => {});
    const { adapter, events } = makeAdapter();
    await adapter.startSession({ threadId: "t1", provider: "cline", cwd: PROJECT });
    await adapter.sendTurn({ threadId: "t1", input: "long job" });
    await adapter.stopSession("t1");
    expect(sessionChild().killed).toBe(true);
    expect(events.find((event) => event.type === "turn.aborted")).toMatchObject({ reason: "interrupted" });
    expect(await adapter.hasSession("t1")).toBe(false);
  });
});

describe("ClineAdapter permissions", () => {
  async function open(mode: "ask" | "accept-edits" | "full-access") {
    behavior.prompt = () => new Promise<RecordLike>(() => {});
    const made = makeAdapter();
    await made.adapter.startSession({ threadId: "t1", provider: "cline", cwd: PROJECT, mode });
    await made.adapter.sendTurn({ threadId: "t1", input: "go" });
    return { ...made, child: sessionChild() };
  }

  const approvals = (events: RuntimeEvent[]) => events.filter((event) => event.type === "approval.requested");

  async function decide(
    { adapter, events }: Awaited<ReturnType<typeof open>>,
    decision: ApprovalDecision,
  ): Promise<void> {
    await until(() => approvals(events).length > 0, "approval.requested");
    const asked = approvals(events)[0];
    if (!asked || asked.type !== "approval.requested") throw new Error("no approval was requested");
    await adapter.respondToRequest("t1", asked.requestId, decision);
  }

  test("ask: a command is parked, surfaced, and answered with the user's decision", async () => {
    const opened = await open("ask");
    const reply = opened.child.request(permissionRequest("execute", { command: "npm test" }));
    await decide(opened, "allow-once");
    expect(selected(await reply)).toBe("allow-once");
    const asked = approvals(opened.events)[0];
    expect(asked).toMatchObject({ approval: { kind: "command", title: "npm test" } });
    expect(types(opened.events)).toContain("approval.resolved");
  });

  test("ask: a read is answered at once, without bothering the user", async () => {
    const opened = await open("ask");
    const reply = await opened.child.request(permissionRequest("read", { path: "a.ts" }));
    expect(selected(reply)).toBe("allow-once");
    expect(approvals(opened.events)).toHaveLength(0);
  });

  test("ask: a rejection selects the reject option", async () => {
    const opened = await open("ask");
    const reply = opened.child.request(permissionRequest("edit", { path: "a.ts" }));
    await decide(opened, "reject-once");
    expect(selected(await reply)).toBe("reject");
  });

  test("reject-and-stop cancels the call and interrupts the turn", async () => {
    const opened = await open("ask");
    const reply = opened.child.request(permissionRequest("execute", { command: "npm test" }));
    await decide(opened, "reject-and-stop");
    expect(await reply).toEqual({ outcome: { outcome: "cancelled" } });
    expect(opened.child.notifications.some((note) => note.method === "session/cancel")).toBe(true);
  });

  test("accept-edits: an edit goes through, a command still asks", async () => {
    const opened = await open("accept-edits");
    expect(selected(await opened.child.request(permissionRequest("edit", { path: "a.ts" })))).toBe("allow-once");
    expect(approvals(opened.events)).toHaveLength(0);
    const reply = opened.child.request(permissionRequest("execute", { command: "make" }));
    await decide(opened, "allow-once");
    expect(selected(await reply)).toBe("allow-once");
    expect(approvals(opened.events)).toHaveLength(1);
  });

  test("full-access: auto-approves with allow_once, never persisting an always rule", async () => {
    const opened = await open("full-access");
    const reply = await opened.child.request(permissionRequest("execute", { command: "npm test" }));
    expect(selected(reply)).toBe("allow-once");
    expect(approvals(opened.events)).toHaveLength(0);
  });

  test("full-access: falls back to allow_always when that is the only allow option", async () => {
    const opened = await open("full-access");
    const reply = await opened.child.request({
      ...permissionRequest("execute", { command: "npm test" }),
      options: [{ optionId: "always", kind: "allow_always" }, { optionId: "no", kind: "reject_once" }],
    });
    expect(selected(reply)).toBe("always");
  });

  test("full-access: still refuses a critical command", async () => {
    const opened = await open("full-access");
    const reply = await opened.child.request(permissionRequest("execute", { command: "mkfs.ext4 /dev/sda1" }));
    expect(reply).toEqual({ outcome: { outcome: "cancelled" } });
    expect(approvals(opened.events)).toHaveLength(0);
  });

  test("full-access: a critical command hidden in the title of a command-less ask is still refused", async () => {
    const opened = await open("full-access");
    const reply = await opened.child.request(permissionRequest("execute", {}, "rm -rf ~"));
    expect(reply).toEqual({ outcome: { outcome: "cancelled" } });
  });

  test("a request with no turn in flight is cancelled rather than parked", async () => {
    const { adapter } = makeAdapter();
    await adapter.startSession({ threadId: "t1", provider: "cline", cwd: PROJECT, mode: "ask" });
    const reply = await sessionChild().request(permissionRequest("execute", { command: "ls" }));
    expect(reply).toEqual({ outcome: { outcome: "cancelled" } });
  });

  test("interrupting drains a parked ask as a rejection so nothing hangs", async () => {
    const opened = await open("ask");
    const reply = opened.child.request(permissionRequest("execute", { command: "npm test" }));
    await until(() => approvals(opened.events).length > 0, "approval.requested");
    await opened.adapter.interruptTurn("t1");
    expect(selected(await reply)).toBe("reject");
  });
});
