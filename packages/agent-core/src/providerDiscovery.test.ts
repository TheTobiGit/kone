// Discovery wiring, end to end: that a probe which reached no verdict actually
// reaches the fold as `transient`, and that the fold's decision is what gets
// published and written to disk.
//
// providerHealth.test.ts already covers the fold as a pure function. The bugs
// this file exists for were one level out — a helper that was right while the
// adapter never set the marker, or a service that folded but republished
// anyway. So the adapter and the service are exercised for real here: fake
// adapters injected into AgentService, and the OpenCode adapter run against a
// scripted `probeResult` so its own `discover()` is the thing under test.

import { beforeAll, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { setUserDataDir } from "./userDataDir.js";
import type { ProbeResult } from "./spawn.js";
import type { EmitEvent, ProviderAdapter, ProviderStatus } from "./types.js";

// Same shim (and throwaway state dir) every adapter-touching test uses: the
// import chain reaches ConversationStore, which loads node:sqlite.
mock.module("./sqlite.js", () => ({
  DatabaseSync: Database,
}));
setUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-provider-discovery-")));

const { AgentService } = await import("./AgentService.js");
const { readProviderCache } = await import("./providerCache.js");

/** An adapter that returns exactly the rows the test hands it, one per round. */
class ScriptedAdapter implements ProviderAdapter {
  readonly capabilities = {
    sessionModelSwitch: "unsupported" as const,
    streamsText: false,
    supportsToolEvents: false,
    supportsResume: false,
    supportsModelList: false,
    supportsSubagents: false,
  };
  rows: ProviderStatus[] = [];
  constructor(readonly provider: ProviderStatus["provider"]) {}
  async discover(): Promise<ProviderStatus> {
    const next = this.rows.shift();
    if (!next) throw new Error(`no scripted row left for ${this.provider}`);
    return next;
  }
  async listModels() {
    return [];
  }
  async startSession(): Promise<never> {
    throw new Error("not used");
  }
  async sendTurn(): Promise<never> {
    throw new Error("not used");
  }
  async stopSession(): Promise<void> {}
}

function ready(provider: ProviderStatus["provider"], label: string): ProviderStatus {
  return { provider, label, available: true, authStatus: "authenticated", readiness: "ready", version: "1.0.0" };
}

function timedOut(provider: ProviderStatus["provider"], label: string): ProviderStatus {
  return {
    provider,
    label,
    available: true,
    authStatus: "unknown",
    readiness: "error",
    message: `${label} did not respond in time.`,
    transient: true,
  };
}

describe("AgentService.discover folds over the last round", () => {
  const codex = new ScriptedAdapter("codex");
  const cursor = new ScriptedAdapter("cursor");
  const published: ProviderStatus[][] = [];
  const service = new AgentService({
    adapters: (_emit: EmitEvent) => [codex, cursor],
  });
  service.onProvidersChanged((statuses) => published.push(statuses));

  test("a first round publishes and persists what it found", async () => {
    codex.rows = [ready("codex", "Codex")];
    cursor.rows = [{ ...ready("cursor", "Cursor"), authStatus: "unauthenticated", readiness: "needs-login" }];

    const statuses = await service.discover();

    expect(statuses.find((row) => row.provider === "codex")?.readiness).toBe("ready");
    expect(published).toHaveLength(1);
    expect(readProviderCache().statuses.find((row) => row.provider === "codex")?.readiness).toBe("ready");
  });

  test("a probe that reached no verdict keeps the known-good row, silently", async () => {
    codex.rows = [timedOut("codex", "Codex")];
    cursor.rows = [{ ...ready("cursor", "Cursor"), authStatus: "unauthenticated", readiness: "needs-login" }];

    const statuses = await service.discover();
    const codexRow = statuses.find((row) => row.provider === "codex");

    expect(codexRow?.readiness).toBe("ready");
    // Nothing the user could see moved, so no renderer is woken.
    expect(published).toHaveLength(1);
    // And the marker is the fold's private business — it never reaches disk.
    expect(codexRow).not.toHaveProperty("transient");
    expect(readProviderCache().statuses.find((row) => row.provider === "codex")).not.toHaveProperty("transient");
  });

  test("a real verdict still lands", async () => {
    codex.rows = [
      { provider: "codex", label: "Codex", available: true, authStatus: "unauthenticated", readiness: "needs-login", message: "Run `codex login`." },
    ];
    cursor.rows = [{ ...ready("cursor", "Cursor"), authStatus: "unauthenticated", readiness: "needs-login" }];

    const statuses = await service.discover();

    expect(statuses.find((row) => row.provider === "codex")?.readiness).toBe("needs-login");
    expect(published).toHaveLength(2);
  });

  test("with nothing usable to fall back to, the inconclusive row stands on its own", async () => {
    codex.rows = [timedOut("codex", "Codex")];
    cursor.rows = [timedOut("cursor", "Cursor")];

    const statuses = await service.discover();
    const cursorRow = statuses.find((row) => row.provider === "cursor");

    // Honest "didn't respond" beats a fabricated verdict — the previous cursor
    // row was needs-login, which was never usable.
    expect(cursorRow?.readiness).toBe("error");
    expect(cursorRow).not.toHaveProperty("transient");
  });
});

// ── OpenCode discover against a scripted probe ──────────────────────────────
// A temp copy of the adapter with its `../spawn.js` import rewritten to a stub,
// so no binary runs — the codexAdapter.test.ts pattern, which also dodges
// mock.module registry collisions with spawn.test.ts.

type OpenCodeAdapterModule = typeof import("./adapters/OpenCodeAdapter.js");

const SANDBOX_DIR = path.join(import.meta.dir, ".sandbox");
const ADAPTER_SOURCE = fileURLToPath(new URL("./adapters/OpenCodeAdapter.ts", import.meta.url));
const ADAPTER_DIR = new URL("./adapters/", import.meta.url);

/** Answers keyed by the probe's first argument (`--version`, `models`). */
type ProbeScript = Record<string, ProbeResult[]>;

interface ScriptHolder {
  current: ProbeScript;
}

declare global {
  var __koneProbeScript: ScriptHolder | undefined;
}

const script: ScriptHolder = { current: {} };
globalThis.__koneProbeScript = script;

const SPAWN_STUB_SOURCE = `
const script = globalThis.__koneProbeScript;
export async function probeResult(_command, args) {
  const queue = script.current[args[0]] ?? [];
  const next = queue.length > 1 ? queue.shift() : queue[0];
  if (!next) throw new Error("no scripted probe result for " + args.join(" "));
  return next;
}
export async function killTree() {}
`;

function probed(outcome: ProbeResult["outcome"], stdout = "", stderr = ""): ProbeResult {
  return { outcome, stdout, stderr, code: outcome === "ok" ? 0 : outcome === "nonzero" ? 1 : null };
}

async function loadOpenCodeAdapterWithStubbedSpawn(): Promise<OpenCodeAdapterModule> {
  mkdirSync(SANDBOX_DIR, { recursive: true });
  const dir = mkdtempSync(path.join(SANDBOX_DIR, "kone-opencode-discover-"));
  const stubPath = path.join(dir, "spawnStub.ts");
  writeFileSync(stubPath, SPAWN_STUB_SOURCE);
  let source = readFileSync(ADAPTER_SOURCE, "utf8");
  source = source.replace(/from "(\.[^"]+?)\.js"/g, (_match, spec: string) =>
    spec === "../spawn"
      ? `from ${JSON.stringify(pathToFileURL(stubPath).href)}`
      : `from ${JSON.stringify(new URL(`${spec}.ts`, ADAPTER_DIR).href)}`,
  );
  source = source.replace(/import\("(\.[^"]+?)\.js"\)/g, (_match, spec: string) =>
    `import(${JSON.stringify(new URL(`${spec}.ts`, ADAPTER_DIR).href)})`,
  );
  const copy = path.join(dir, "OpenCodeAdapter.ts");
  writeFileSync(copy, source);
  // SAFETY: the copy is OpenCodeAdapter.ts with only its spawn import rewritten,
  // so its exports match the real module's.
  return (await import(pathToFileURL(copy).href)) as OpenCodeAdapterModule;
}

const MODELS_OUTPUT = [
  "anthropic/claude-sonnet-4",
  JSON.stringify({ id: "claude-sonnet-4", name: "Claude Sonnet 4", variants: {} }, null, 2),
].join("\n");

describe("OpenCode discovery", () => {
  let adapterModule: OpenCodeAdapterModule;

  beforeAll(async () => {
    adapterModule = await loadOpenCodeAdapterWithStubbedSpawn();
  });

  test("a version printed on a non-zero exit still counts as installed", async () => {
    script.current = {
      "--version": [probed("nonzero", "1.14.19\n", "update available")],
      models: [probed("ok", MODELS_OUTPUT)],
    };
    const adapter = new adapterModule.OpenCodeAdapter(() => {});

    const status = await adapter.discover();

    // The CLI ran and told us its version; a grumpy exit code is not a reason
    // to tell the user it "failed to run".
    expect(status.readiness).toBe("ready");
    expect(status.version).toBe("1.14.19");
  });

  test("a model listing that never came back keeps the row transient", async () => {
    script.current = {
      "--version": [probed("ok", "1.14.19\n")],
      models: [probed("timeout")],
    };
    const adapter = new adapterModule.OpenCodeAdapter(() => {});

    const status = await adapter.discover();

    // The slow-probe bug in its second-stage form: without the marker this row
    // would overwrite a known-good one on disk.
    expect(status.readiness).toBe("error");
    expect(status.transient).toBe(true);
  });

  test("a model listing that ran and reported nothing is a real sign-in verdict", async () => {
    script.current = {
      "--version": [probed("ok", "1.14.19\n")],
      models: [probed("ok", ""), probed("ok", "")],
    };
    const adapter = new adapterModule.OpenCodeAdapter(() => {});

    const status = await adapter.discover();

    expect(status.readiness).toBe("needs-login");
    expect(status.transient).toBeUndefined();
  });
});
