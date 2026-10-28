import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { cacheStatuses } from "./providerCache.js";
import { ProviderRuntime } from "./providerRuntime.js";
import { setUserDataDir } from "./userDataDir.js";
import type {
  AdapterCapabilities,
  ModelDescriptor,
  ProviderAdapter,
  ProviderConfig,
  ProviderKind,
  ProviderStatus,
  Session,
  SessionStartInput,
  SendTurnInput,
  TurnStartResult,
  UserInputRespondResult,
} from "./types.js";

// The provider runtime's two invalidation paths. A completed sign-in retires
// the previous credential's sessions, quota and catalog even when readiness
// stayed `ready`; an ordinary health check never does.

const userDataDir = mkdtempSync(path.join(tmpdir(), "kone-provider-runtime-"));
setUserDataDir(userDataDir);

afterAll(() => rmSync(userDataDir, { recursive: true, force: true }));

const CAPABILITIES: AdapterCapabilities = {
  sessionModelSwitch: "unsupported",
  streamsText: false,
  supportsToolEvents: false,
  supportsResume: false,
  supportsModelList: true,
  supportsSubagents: false,
};

class RuntimeFakeAdapter implements ProviderAdapter {
  readonly capabilities = CAPABILITIES;
  discoverCalls = 0;
  listModelsCalls = 0;
  discoveryInvalidations = 0;
  readonly configs: ProviderConfig[] = [];
  status: ProviderStatus;
  models: ModelDescriptor[] = [];

  constructor(readonly provider: ProviderKind) {
    this.status = readyStatus(provider);
  }

  async discover(): Promise<ProviderStatus> {
    this.discoverCalls += 1;
    return this.status;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    this.listModelsCalls += 1;
    return this.models;
  }

  invalidateDiscoveryCaches(): void {
    this.discoveryInvalidations += 1;
  }

  setConfig(config: ProviderConfig): void {
    this.configs.push(config);
  }

  async startSession(input: SessionStartInput): Promise<Session> {
    return {
      threadId: input.threadId,
      provider: input.provider,
      cwd: input.cwd,
      status: "ready",
      mode: input.mode ?? "ask",
    };
  }

  async sendTurn(input: SendTurnInput): Promise<TurnStartResult> {
    return { threadId: input.threadId, turnId: "turn-1" };
  }

  async interruptTurn(): Promise<void> {}
  async stopSession(): Promise<void> {}
  async stopAll(): Promise<void> {}
  async respondToRequest(): Promise<void> {}
  async respondToUserInput(): Promise<UserInputRespondResult> {
    return { owned: true };
  }
  async listSessions(): Promise<Session[]> {
    return [];
  }
  async hasSession(): Promise<boolean> {
    return false;
  }
}

function readyStatus(provider: ProviderKind): ProviderStatus {
  return {
    provider,
    label: provider,
    available: true,
    authStatus: "authenticated",
    readiness: "ready",
    authLabel: "person@example.com",
  };
}

type Harness = {
  runtime: ProviderRuntime;
  adapter: RuntimeFakeAdapter;
  retired: ProviderKind[];
  invalidatedQuota: ProviderKind[];
};

function harness(provider: ProviderKind): Harness {
  const adapter = new RuntimeFakeAdapter(provider);
  const retired: ProviderKind[] = [];
  const invalidatedQuota: ProviderKind[] = [];
  const runtime = new ProviderRuntime({
    adapters: [adapter],
    retireSessions: (kind) => {
      retired.push(kind);
      return Promise.resolve(0);
    },
    invalidateQuota: (kind) => invalidatedQuota.push(kind),
  });
  return { runtime, adapter, retired, invalidatedQuota };
}

beforeEach(() => {
  cacheStatuses([]);
});

describe("ProviderRuntime sign-in confirmation", () => {
  test("a ready -> ready sign-in retires the previous runtime", async () => {
    // antigravity is not in the sibling service tests' adapter roster, so the
    // catalog this test writes cannot leak into their model-validation cases.
    const { runtime, adapter, retired, invalidatedQuota } = harness("antigravity");
    cacheStatuses([readyStatus("antigravity")]);
    adapter.models = [{ id: "gemini-6", label: "Gemini 6" }];

    const row = await runtime.confirmProviderSignIn("antigravity");

    expect(row.readiness).toBe("ready");
    // The row never changed — same readiness, same auth label — but the sign-in
    // is the explicit evidence that the credentials did.
    expect(retired).toEqual(["antigravity"]);
    expect(invalidatedQuota).toEqual(["antigravity"]);
    expect(adapter.discoveryInvalidations).toBeGreaterThanOrEqual(2);
    // The new account's catalog is fetched rather than serving the old one.
    expect(adapter.listModelsCalls).toBe(1);
  });

  test("a failed sign-in attempt leaves the runtime alone", async () => {
    const { runtime, adapter, retired, invalidatedQuota } = harness("cline");
    adapter.status = {
      provider: "cline",
      label: "cline",
      available: true,
      authStatus: "unauthenticated",
      readiness: "needs-login",
    };
    cacheStatuses([{ ...adapter.status }]);

    const row = await runtime.confirmProviderSignIn("cline");

    expect(row.readiness).toBe("needs-login");
    expect(retired).toEqual([]);
    expect(invalidatedQuota).toEqual([]);
  });

  test("a timed-out sign-in cannot use cached ready health as confirmation", async () => {
    const { runtime, adapter, retired, invalidatedQuota } = harness("codex");
    cacheStatuses([readyStatus("codex")]);
    adapter.status = {
      provider: "codex",
      label: "Codex",
      available: true,
      authStatus: "unknown",
      readiness: "error",
      transient: true,
      message: "Sign-in check timed out",
    };

    const row = await runtime.confirmProviderSignIn("codex");

    expect(row.readiness).toBe("error");
    expect(row.message).toBe("Sign-in check timed out");
    expect(retired).toEqual([]);
    expect(invalidatedQuota).toEqual([]);
    expect(runtime.cachedSurface().statuses[0]?.readiness).toBe("ready");
  });
});

describe("ProviderRuntime health checks", () => {
  test("an ordinary check probes without retiring sessions or caches", async () => {
    const { runtime, adapter, retired, invalidatedQuota } = harness("cline");
    cacheStatuses([readyStatus("cline")]);

    const row = await runtime.checkProvider("cline");

    expect(row.readiness).toBe("ready");
    expect(adapter.discoverCalls).toBe(1);
    expect(retired).toEqual([]);
    expect(invalidatedQuota).toEqual([]);
    expect(adapter.listModelsCalls).toBe(0);
  });
});

describe("ProviderRuntime settings application", () => {
  test("a runtime-moving setting retires; a presentation-only one does not", async () => {
    const { runtime, adapter, retired, invalidatedQuota } = harness("cline");
    const before: ProviderConfig = { binaryPath: "/old/cline" };
    const moved: ProviderConfig = { binaryPath: "/new/cline" };

    await runtime.applyProviderSettings("cline", before, moved);

    expect(adapter.configs.at(-1)).toEqual(moved);
    expect(retired).toEqual(["cline"]);
    expect(invalidatedQuota).toEqual(["cline"]);

    const cosmetic: ProviderConfig = { ...moved, hiddenModels: ["one-model"] };
    await runtime.applyProviderSettings("cline", moved, cosmetic);

    expect(adapter.configs.at(-1)).toEqual(cosmetic);
    expect(retired).toEqual(["cline"]);
    expect(invalidatedQuota).toEqual(["cline"]);
  });
});
