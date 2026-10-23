import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildProviderChildEnv, defaultHomeDirFor, homeEnvVarFor } from "./providerChildEnv.js";
import {
  customModelsFor,
  healthCheckIntervalSecFor,
  isProviderShownInPicker,
  patchGlobalProviderSettings,
  patchProviderSettings,
  providerOrderFor,
  resetProviderSettingsForTests,
} from "./providerSettings.js";
import { setUserDataDir } from "./userDataDir.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "kone-child-env-"));

beforeEach(() => {
  rmSync(path.join(dir, "provider-settings.json"), { force: true });
  setUserDataDir(dir);
  resetProviderSettingsForTests();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  resetProviderSettingsForTests();
});

describe("providerSettings extended fields (L2, M3, M4, H5)", () => {
  test("showInPicker is separate from enabled and defaults to true", () => {
    expect(isProviderShownInPicker("codex")).toBe(true);
    patchProviderSettings("codex", { showInPicker: false });
    expect(isProviderShownInPicker("codex")).toBe(false);
    // Still enabled even when hidden from picker:
    const snapshot = patchProviderSettings("codex", {});
    expect(snapshot.codex?.enabled).toBe(true);
    expect(snapshot.codex?.showInPicker).toBe(false);
  });

  test("customModels trims, dedupes, and round-trips per provider", () => {
    expect(customModelsFor("codex")).toEqual([]);
    patchProviderSettings("codex", {
      customModels: [" o3-pro ", "gpt-5-custom", "o3-pro", ""],
    });
    expect(customModelsFor("codex")).toEqual(["o3-pro", "gpt-5-custom"]);
  });

  test("homeDir and env vars round-trip and sanitize empty names", () => {
    patchProviderSettings("codex", {
      homeDir: " ~/.codex-work ",
      env: [
        { name: " OPENAI_BASE_URL ", value: "https://proxy.example/v1", secret: false },
        { name: "OPENAI_API_KEY", value: "sk-secret", secret: true },
        { name: "   ", value: "ignored" },
      ],
    });
    const snap = patchProviderSettings("codex", {});
    expect(snap.codex?.homeDir).toBe("~/.codex-work");
    expect(snap.codex?.env).toEqual([
      { name: "OPENAI_BASE_URL", value: "https://proxy.example/v1" },
      { name: "OPENAI_API_KEY", value: "sk-secret", secret: true },
    ]);
  });

  test("providerOrder and healthCheckIntervalSec persist in the envelope", () => {
    expect(providerOrderFor()).toEqual([]);
    expect(healthCheckIntervalSecFor()).toBe(300);

    const updated = patchGlobalProviderSettings({
      providerOrder: ["claudeAgent", "codex", "cursor"],
      healthCheckIntervalSec: 60,
    });
    expect(updated.providerOrder).toEqual(["claudeAgent", "codex", "cursor"]);
    expect(updated.healthCheckIntervalSec).toBe(60);

    resetProviderSettingsForTests();
    expect(providerOrderFor()).toEqual(["claudeAgent", "codex", "cursor"]);
    expect(healthCheckIntervalSecFor()).toBe(60);
  });
});

describe("buildProviderChildEnv (H5)", () => {
  test("strips NODE_OPTIONS, ELECTRON_RUN_AS_NODE, and KONE_* internal vars", () => {
    const base: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/Users/test",
      NODE_OPTIONS: "--inspect",
      ELECTRON_RUN_AS_NODE: "1",
      KONE_INTERNAL_TOKEN: "secret",
      USER: "test",
    };
    const env = buildProviderChildEnv("codex", base);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.USER).toBe("test");
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.KONE_INTERNAL_TOKEN).toBeUndefined();
  });

  test("maps configured homeDir (expanding ~) to the provider's native env var and overlays env vars", () => {
    patchProviderSettings("codex", {
      homeDir: "~/.codex-team",
      env: [
        { name: "OPENAI_BASE_URL", value: "https://gateway.internal/v1" },
        { name: "OPENAI_API_KEY", value: "sk-123", secret: true },
      ],
    });
    const env = buildProviderChildEnv("codex", { PATH: "/usr/bin", HOME: "/Users/alice" });
    expect(homeEnvVarFor("codex")).toBe("CODEX_HOME");
    expect(defaultHomeDirFor("codex")).toBe("~/.codex");
    expect(env.CODEX_HOME).toBe(path.join(os.homedir(), ".codex-team"));
    expect(env.OPENAI_BASE_URL).toBe("https://gateway.internal/v1");
    expect(env.OPENAI_API_KEY).toBe("sk-123");
  });

  test("maps claudeAgent homeDir to CLAUDE_CONFIG_DIR without touching HOME", () => {
    patchProviderSettings("claudeAgent", { homeDir: "/custom/claude" });
    const env = buildProviderChildEnv("claudeAgent", { HOME: "/Users/alice" });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/custom/claude");
    expect(env.HOME).toBe("/Users/alice");
  });
});

describe("AgentService provider features (M2, M3, M4, M5)", () => {
  test("listModels and refreshProviderModels merge customModels and preserve catalog on probe error", async () => {
    const { AgentService } = await import("./AgentService.js");
    let shouldFail = false;
    let discoverCount = 0;
    const stoppedThreads: string[] = [];

    const fakeAdapter = {
      provider: "codex" as const,
      capabilities: {
        sessionModelSwitch: "unsupported" as const,
        streamsText: false,
        supportsToolEvents: false,
        supportsResume: true,
        supportsModelList: true,
        supportsSubagents: false,
      },
      async discover() {
        discoverCount += 1;
        return {
          provider: "codex" as const,
          label: "Codex",
          available: true,
          authStatus: "authenticated" as const,
          readiness: "ready" as const,
          version: "0.48.0",
        };
      },
      async listModels() {
        if (shouldFail) throw new Error("CLI probe timed out");
        return [{ id: "gpt-5.5", label: "GPT-5.5", provider: "codex" as const }];
      },
      async startSession(input: { threadId: string; provider: "codex"; cwd: string }) {
        return { threadId: input.threadId, provider: input.provider, cwd: input.cwd, status: "ready" as const };
      },
      async sendTurn(input: { threadId: string; model?: string }) {
        return { threadId: input.threadId, turnId: `turn-${input.model ?? "default"}` };
      },
      async interruptTurn() {},
      async stopSession(threadId: string) {
        stoppedThreads.push(threadId);
      },
      async stopAll() {},
      async respondToRequest() {},
      async respondToUserInput() {
        return { owned: false as const };
      },
      async listSessions() {
        return [];
      },
      async hasSession() {
        return true;
      },
    };

    const svc = new AgentService({
      retentionSweepMs: 0,
      stopTotalTimeoutMs: 50,
      adapters: () => [fakeAdapter],
    });

    patchProviderSettings("codex", { customModels: ["o3-pro"] });
    const models = await svc.listModels("codex");
    expect(models.map((m) => m.id)).toEqual(["gpt-5.5", "o3-pro"]);

    // When a refresh fails, keep the cached catalog and return the error:
    shouldFail = true;
    const refreshed = await svc.refreshProviderModels("codex");
    expect(refreshed.error).toContain("CLI probe timed out");
    expect(refreshed.models.map((m) => m.id)).toEqual(["gpt-5.5", "o3-pro"]);

    // Starting a session with a custom model keeps the custom model id:
    await svc.startSession({ threadId: "t-custom", provider: "codex", cwd: "/tmp", model: "o3-pro" });
    const turn = await svc.sendTurn({ threadId: "t-custom", input: "hi", model: "o3-pro" });
    expect(turn.turnId).toBe("turn-o3-pro");

    // Changing binaryPath or homeDir stops active sessions on that provider and re-probes:
    const prevDiscovers = discoverCount;
    svc.patchProviderSettings("codex", { homeDir: "~/.codex-alt" });
    await new Promise((r) => setTimeout(r, 30));
    expect(stoppedThreads).toContain("t-custom");
    expect(discoverCount).toBeGreaterThan(prevDiscovers);

    await svc.stopAll();
  });

  test("checkProviderBinary validates an executable path or reports missing", async () => {
    const { AgentService } = await import("./AgentService.js");
    const svc = new AgentService({
      retentionSweepMs: 0,
      stopTotalTimeoutMs: 50,
      adapters: () => [],
    });
    const missing = await svc.checkProviderBinary("codex", "/definitely/missing/codex-bin");
    expect(missing.ok).toBe(false);
    expect(missing.error).toBeDefined();

    const present = await svc.checkProviderBinary("codex", process.execPath);
    expect(present.ok).toBe(true);
    expect(present.resolvedPath).toBeTruthy();
    await svc.stopAll();
  });
});

describe("resolveProviderSignInLaunch with provider env overrides", () => {
  test("locates the executable using a PATH override from the provider's configured env", async () => {
    const { chmodSync, writeFileSync } = await import("node:fs");
    const { resolveProviderSignInLaunch } = await import("./providerSignIn.js");
    const binDir = mkdtempSync(path.join(os.tmpdir(), "kone-signin-env-bin-"));
    const fakeCodex = path.join(binDir, "codex");
    writeFileSync(fakeCodex, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeCodex, 0o755);

    try {
      const settings = patchProviderSettings("codex", {
        env: [{ name: "PATH", value: binDir }],
      });
      const launch = resolveProviderSignInLaunch({
        provider: "codex",
        settings,
        env: { PATH: "/nonexistent" },
        platform: "linux",
      });
      expect(launch.ok).toBe(true);
      if (launch.ok) {
        expect(launch.file).toBe(fakeCodex);
        expect(launch.env.PATH).toBe(binDir);
      }
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});

describe("PR #24 review fixes", () => {
  test("CodexAdapter.discover() reads auth from the provider's configured homeDir and env", async () => {
    const { chmodSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { CodexAdapter } = await import("./adapters/CodexAdapter.js");
    const fakeHome = mkdtempSync(path.join(os.tmpdir(), "kone-codex-custom-home-"));
    const binDir = mkdtempSync(path.join(os.tmpdir(), "kone-codex-fake-bin-"));
    const fakeBin = path.join(binDir, "codex");
    writeFileSync(fakeBin, "#!/bin/sh\necho 'codex 0.48.0'\n");
    chmodSync(fakeBin, 0o755);

    try {
      // 1. An empty configured homeDir must report unauthenticated even if ~/.codex is logged in:
      mkdirSync(fakeHome, { recursive: true });
      patchProviderSettings("codex", {
        binaryPath: fakeBin,
        homeDir: fakeHome,
      });

      const adapter = new CodexAdapter(() => {});
      adapter.setConfig({ binaryPath: fakeBin, homeDir: fakeHome });
      const unauthStatus = await adapter.discover();
      expect(unauthStatus.authStatus).toBe("unauthenticated");
      expect(unauthStatus.readiness).toBe("needs-login");

      // 2. Writing an API-key auth.json into fakeHome makes discover() report API Key:
      writeFileSync(
        path.join(fakeHome, "auth.json"),
        JSON.stringify({ OPENAI_API_KEY: "sk-custom" }),
      );
      const authedStatus = await adapter.discover();
      expect(authedStatus.authStatus).toBe("authenticated");
      expect(authedStatus.readiness).toBe("ready");
      expect(authedStatus.authLabel).toBe("API Key");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  test("toggling secret display metadata on an env var does not stop active sessions or re-probe", async () => {
    const { AgentService } = await import("./AgentService.js");
    let discoverCount = 0;
    const stoppedThreads: string[] = [];

    const fakeAdapter = {
      provider: "codex" as const,
      capabilities: {
        sessionModelSwitch: "unsupported" as const,
        streamsText: false,
        supportsToolEvents: false,
        supportsResume: true,
        supportsModelList: false,
        supportsSubagents: false,
      },
      async discover() {
        discoverCount += 1;
        return {
          provider: "codex" as const,
          label: "Codex",
          available: true,
          authStatus: "authenticated" as const,
          readiness: "ready" as const,
        };
      },
      async listModels() {
        return [];
      },
      async startSession(input: { threadId: string; provider: "codex"; cwd: string }) {
        return { threadId: input.threadId, provider: input.provider, cwd: input.cwd, status: "ready" as const };
      },
      async sendTurn(input: { threadId: string }) {
        return { threadId: input.threadId, turnId: "t-1" };
      },
      async interruptTurn() {},
      async stopSession(threadId: string) {
        stoppedThreads.push(threadId);
      },
      async stopAll() {},
      async respondToRequest() {},
      async respondToUserInput() {
        return { owned: false as const };
      },
      async listSessions() {
        return [];
      },
      async hasSession() {
        return true;
      },
    };

    patchProviderSettings("codex", {
      env: [{ name: "OPENAI_API_KEY", value: "sk-123", secret: false }],
    });
    const svc = new AgentService({
      retentionSweepMs: 0,
      stopTotalTimeoutMs: 50,
      adapters: () => [fakeAdapter],
    });
    await svc.startSession({ threadId: "t-keep-alive", provider: "codex", cwd: "/tmp" });
    const beforeDiscovers = discoverCount;

    // Flip only `secret: true` on the same name/value pair:
    svc.patchProviderSettings("codex", {
      env: [{ name: "OPENAI_API_KEY", value: "sk-123", secret: true }],
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(stoppedThreads).toEqual([]);
    expect(discoverCount).toBe(beforeDiscovers);

    // Changing the actual value DOES stop the session and re-probe:
    svc.patchProviderSettings("codex", {
      env: [{ name: "OPENAI_API_KEY", value: "sk-456", secret: true }],
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(stoppedThreads).toEqual(["t-keep-alive"]);
    expect(discoverCount).toBeGreaterThan(beforeDiscovers);

    await svc.stopAll();
  });
});

describe("PR #24 round-2 review fixes", () => {
  test("resolveDroidAuthMethodId uses the passed provider env rather than process.env", async () => {
    const { resolveDroidAuthMethodId } = await import("./adapters/DroidAdapter.js");
    const init = {
      authMethods: [{ id: "device-pairing" }, { id: "factory-api-key" }],
    };
    expect(resolveDroidAuthMethodId(init, {})).toBe("device-pairing");
    expect(resolveDroidAuthMethodId(init, { FACTORY_API_KEY: "fk-from-provider-env" })).toBe(
      "factory-api-key",
    );
  });

  test("quota credential detection and fetching honour configured provider homeDir and env, and settings changes invalidate quota cache", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { detectCodexCredential, fetchCodexQuota } = await import("./quota/codex.js");
    const { detectClaudeCredential } = await import("./quota/claude.js");
    const { detectDroidCredential, resolveFactoryApiKey } = await import("./quota/droid.js");

    const emptyCodexHome = mkdtempSync(path.join(os.tmpdir(), "kone-quota-codex-empty-"));
    const emptyClaudeHome = mkdtempSync(path.join(os.tmpdir(), "kone-quota-claude-empty-"));
    const customDroidHome = mkdtempSync(path.join(os.tmpdir(), "kone-quota-droid-"));

    try {
      mkdirSync(emptyCodexHome, { recursive: true });
      mkdirSync(emptyClaudeHome, { recursive: true });
      mkdirSync(customDroidHome, { recursive: true });

      // Point codex and claudeAgent at empty custom homes -> must NOT read ~/.codex or ~/.claude:
      patchProviderSettings("codex", { homeDir: emptyCodexHome });
      patchProviderSettings("claudeAgent", { homeDir: emptyClaudeHome });
      expect(await detectCodexCredential()).toBe(false);
      const codexQuota = await fetchCodexQuota();
      expect(codexQuota.report.connection).toBe("disconnected");
      expect(await detectClaudeCredential()).toBe(false);

      // Now write a valid credential into emptyCodexHome and emptyClaudeHome:
      writeFileSync(
        path.join(emptyCodexHome, "auth.json"),
        JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "tok-1" } }),
        { mode: 0o600 },
      );
      writeFileSync(
        path.join(emptyClaudeHome, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: "cl-tok-1" } }),
        { mode: 0o600 },
      );
      expect(await detectCodexCredential()).toBe(true);
      expect(await detectClaudeCredential()).toBe(true);

      // Droid reads FACTORY_API_KEY from provider env settings or custom DROID_HOME/.env:
      patchProviderSettings("droid", {
        homeDir: customDroidHome,
        env: [{ name: "FACTORY_API_KEY", value: "fk-settings-env" }],
      });
      expect(await resolveFactoryApiKey()).toBe("fk-settings-env");
      expect(await detectDroidCredential()).toBe(true);
    } finally {
      rmSync(emptyCodexHome, { recursive: true, force: true });
      rmSync(emptyClaudeHome, { recursive: true, force: true });
      rmSync(customDroidHome, { recursive: true, force: true });
    }
  });
});

describe("PR #24 round-3 review fixes", () => {
  test("changing runtime settings while a session is mid-startup cancels the pending start and tears it down", async () => {
    const { AgentService } = await import("./AgentService.js");
    const { StartCancelled } = await import("./types.js");
    let finishConnect: (() => void) | null = null;
    const stoppedThreads: string[] = [];

    const slowStartAdapter = {
      provider: "codex" as const,
      capabilities: {
        sessionModelSwitch: "unsupported" as const,
        streamsText: false,
        supportsToolEvents: false,
        supportsResume: true,
        supportsModelList: false,
        supportsSubagents: false,
      },
      async discover() {
        return {
          provider: "codex" as const,
          label: "Codex",
          available: true,
          authStatus: "authenticated" as const,
          readiness: "ready" as const,
        };
      },
      async listModels() {
        return [];
      },
      async startSession(input: { threadId: string; provider: "codex"; cwd: string }) {
        await new Promise<void>((resolve) => {
          finishConnect = resolve;
        });
        return { threadId: input.threadId, provider: input.provider, cwd: input.cwd, status: "ready" as const };
      },
      async sendTurn(input: { threadId: string }) {
        return { threadId: input.threadId, turnId: "t-1" };
      },
      async interruptTurn() {},
      async stopSession(threadId: string) {
        stoppedThreads.push(threadId);
      },
      async stopAll() {},
      async respondToRequest() {},
      async respondToUserInput() {
        return { owned: false as const };
      },
      async listSessions() {
        return [];
      },
      async hasSession() {
        return true;
      },
    };

    const svc = new AgentService({
      retentionSweepMs: 0,
      stopTotalTimeoutMs: 50,
      adapters: () => [slowStartAdapter],
    });

    // Start connecting a session (not yet in routing):
    const startPromise = svc.startSession({ threadId: "t-pending-start", provider: "codex", cwd: "/tmp" });
    await new Promise((r) => setTimeout(r, 15));

    // Change homeDir while startSession is still connecting:
    svc.patchProviderSettings("codex", { homeDir: "~/.codex-switched" });
    await new Promise((r) => setTimeout(r, 15));

    // Now let the adapter finish connecting:
    finishConnect!();
    await expect(startPromise).rejects.toBeInstanceOf(StartCancelled);
    expect(stoppedThreads).toContain("t-pending-start");

    await svc.stopAll();
  });

  test("providerMaintenance resolves a provider's CLI using its configured env PATH override", async () => {
    const { chmodSync, writeFileSync } = await import("node:fs");
    const { AgentService } = await import("./AgentService.js");
    const binDir = mkdtempSync(path.join(os.tmpdir(), "kone-maint-env-bin-"));
    const fakeCodex = path.join(binDir, "codex");
    writeFileSync(fakeCodex, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeCodex, 0o755);

    try {
      patchProviderSettings("codex", {
        env: [{ name: "PATH", value: binDir }],
      });
      const svc = new AgentService({
        retentionSweepMs: 0,
        stopTotalTimeoutMs: 50,
      });
      const maint = await svc.providerMaintenance({ checkLatest: false });
      const codexMaint = maint.find((m) => m.provider === "codex");
      expect(codexMaint?.resolvedPath).toBe(fakeCodex);
      await svc.stopAll();
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});
