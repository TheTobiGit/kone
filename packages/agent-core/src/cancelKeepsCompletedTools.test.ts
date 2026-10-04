import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setUserDataDir } from "./userDataDir.js";
import type { AdapterCapabilities, EmitEvent, ProviderAdapter, ProviderKind } from "./types.js";

// kone steer may only interrupt a provider that keeps a finished tool call's
// result across the cancel. These pin the lookup and the values the cancel
// probe (scripts/cancelProbe.ts) measured, so a flip is a deliberate edit.

const userData = mkdtempSync(path.join(tmpdir(), "kone-cancel-capability-"));
setUserDataDir(userData);
afterAll(() => rmSync(userData, { recursive: true, force: true }));

const { AgentService } = await import("./AgentService.js");
const { CursorAdapter } = await import("./adapters/CursorAdapter.js");
const { ClineAdapter } = await import("./adapters/ClineAdapter.js");
const { DroidAdapter } = await import("./adapters/DroidAdapter.js");
const { AntigravityAdapter } = await import("./adapters/AntigravityAdapter.js");
const { AntigravityAcpAdapter } = await import("./adapters/AntigravityAcpAdapter.js");
const { AntigravityPrintAdapter } = await import("./adapters/AntigravityPrintAdapter.js");

function fakeAdapter(provider: ProviderKind, cancelKeepsCompletedTools?: boolean): ProviderAdapter {
  const capabilities: AdapterCapabilities = {
    sessionModelSwitch: "unsupported",
    streamsText: false,
    supportsToolEvents: true,
    supportsResume: true,
    supportsModelList: false,
    supportsSubagents: false,
  };
  if (cancelKeepsCompletedTools !== undefined) capabilities.cancelKeepsCompletedTools = cancelKeepsCompletedTools;
  const adapter: Partial<ProviderAdapter> = { provider, capabilities };
  // SAFETY: the lookup reads only `provider` and `capabilities`; nothing here starts a session.
  return adapter as ProviderAdapter;
}

function serviceWith(adapters: ProviderAdapter[]) {
  return new AgentService({ retentionSweepMs: 0, checkpointStore: null, adapters: () => adapters });
}

describe("AgentService.providerCancelKeepsCompletedTools", () => {
  test("reads the provider's capability", () => {
    const service = serviceWith([fakeAdapter("cursor", true), fakeAdapter("cline", false)]);
    expect(service.providerCancelKeepsCompletedTools("cursor")).toBe(true);
    expect(service.providerCancelKeepsCompletedTools("cline")).toBe(false);
  });

  test("a provider that never declares it does not keep them", () => {
    const service = serviceWith([fakeAdapter("droid")]);
    expect(service.providerCancelKeepsCompletedTools("droid")).toBe(false);
  });

  test("an unregistered provider does not keep them", () => {
    const service = serviceWith([fakeAdapter("cursor", true)]);
    expect(service.providerCancelKeepsCompletedTools("antigravity")).toBe(false);
  });
});

describe("the cancel probe's results", () => {
  const emit: EmitEvent = () => {};

  test.each([
    ["Cursor", () => new CursorAdapter(emit), false],
    ["Cline", () => new ClineAdapter(emit), true],
    ["Droid", () => new DroidAdapter(emit), false],
    ["Antigravity ACP", () => new AntigravityAcpAdapter(emit, { userDataDir: userData }), false],
    ["Antigravity print", () => new AntigravityPrintAdapter(emit), true],
    ["Antigravity", () => new AntigravityAdapter(emit, undefined, { userDataDir: userData }), false],
  ] as const)("%s", (_name, make, expected) => {
    expect(make().capabilities.cancelKeepsCompletedTools).toBe(expected);
  });
});
