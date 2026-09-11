import { describe, expect, test } from "bun:test";
import { existsSync as fsExistsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { LspAbortError } from "./client.js";
import { countLogLines, fakeServerScript, readLogLines } from "./fakeLspServer.js";
import type { FakeLspScenario } from "./fakeLspServer.js";
import {
  LspManager,
  LspManagerError,
  LspNoServerError,
  LspServerStartError,
} from "./manager.js";
import { projectLspConfigPath } from "./serverRegistry.js";
import type { ServerBinaryDeps } from "./serverRegistry.js";
import type { LspJsonObject, LspJsonValue, ServerConfig } from "./types.js";

// The manager pools fake servers over real pipes: resolution, startup,
// retry, and reaping all run against real processes, never a real binary.

const MARKER = "kone-fake-root.json";

function freshDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function fakeServerConfig(script: string, overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    name: "fake",
    command: process.execPath,
    args: ["-e", script],
    fileTypes: ["fakets"],
    rootMarkers: [MARKER],
    ...overrides,
  };
}

function binaryDeps(): ServerBinaryDeps {
  // Real filesystem for the absolute runtime path and marker files; PATH
  // always misses, so binary absence is deterministic.
  return { existsSync: fsExistsSync, lookupOnPath: () => null };
}

function noConfigs(): (filePath: string) => string | null {
  return () => null;
}

function mapReader(files: ReadonlyMap<string, string>): (filePath: string) => string | null {
  return (filePath) => files.get(filePath) ?? null;
}

function refsParams(): LspJsonObject {
  return {
    textDocument: { uri: "file:///decl.ts" },
    position: { line: 1, character: 3 },
    context: { includeDeclaration: true },
  };
}

function refsCount(result: LspJsonValue): number {
  return Array.isArray(result) ? result.length : -1;
}

async function waitForLog(log: string, lines: number, timeoutMs = 5000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const seen = readLogLines(log);
    if (seen.length >= lines) return seen;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${lines} log lines`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

describe("LspManager pooling", () => {
  test("two callers share one process, concurrent starts join", async () => {
    const proj = freshDir("kone-lsp-pool-");
    const log = path.join(proj, "methods.log");
    const manager = new LspManager({
      defaults: [fakeServerConfig(fakeServerScript(log, "basic"))],
      binaryDeps: binaryDeps(),
      readTextFile: noConfigs(),
    });
    try {
      const asked = { cwd: proj, filePath: path.join(proj, "src", "main.fakets") };
      const [first, second] = await Promise.all([manager.getClient(asked), manager.getClient(asked)]);
      expect(second).toBe(first);
      const third = await manager.getClient(asked);
      expect(third).toBe(first);
      // One server means one initialize plus its initialized reply; the
      // reply trails by a turn, so wait for both lines before counting.
      const seen = await waitForLog(log, 2);
      expect(countLogLines(seen, "in:initialize")).toBe(1);
    } finally {
      await manager.disposeAll();
    }
  });

  test("different directories get different processes", async () => {
    const firstDir = freshDir("kone-lsp-pool-a-");
    const secondDir = freshDir("kone-lsp-pool-b-");
    const log = path.join(firstDir, "methods.log");
    const manager = new LspManager({
      defaults: [fakeServerConfig(fakeServerScript(log, "basic"))],
      binaryDeps: binaryDeps(),
      readTextFile: noConfigs(),
    });
    try {
      const first = await manager.getClient({ cwd: firstDir, filePath: path.join(firstDir, "a.fakets") });
      const second = await manager.getClient({ cwd: secondDir, filePath: path.join(secondDir, "b.fakets") });
      expect(second).not.toBe(first);
      // Both servers share this log: two initializes plus two replies.
      const seen = await waitForLog(log, 4);
      expect(countLogLines(seen, "in:initialize")).toBe(2);
    } finally {
      await manager.disposeAll();
    }
  });

  test("the project root follows root markers, falling back to cwd", async () => {
    const proj = freshDir("kone-lsp-root-");
    const log = path.join(proj, "methods.log");
    writeFileSync(path.join(proj, MARKER), "{}\n");
    const manager = new LspManager({
      defaults: [fakeServerConfig(fakeServerScript(log, "basic"))],
      binaryDeps: binaryDeps(),
      readTextFile: noConfigs(),
    });
    try {
      const nested = await manager.getClient({
        cwd: proj,
        filePath: path.join(proj, "src", "deep", "main.fakets"),
      });
      expect(nested.rootPath).toBe(proj);
    } finally {
      await manager.disposeAll();
    }
  });

  test("no marker means the cwd is the root", async () => {
    const proj = freshDir("kone-lsp-noroot-");
    const log = path.join(proj, "methods.log");
    const manager = new LspManager({
      defaults: [fakeServerConfig(fakeServerScript(log, "basic"))],
      binaryDeps: binaryDeps(),
      readTextFile: noConfigs(),
    });
    try {
      const client = await manager.getClient({ cwd: proj, filePath: path.join(proj, "a.fakets") });
      expect(client.rootPath).toBe(proj);
    } finally {
      await manager.disposeAll();
    }
  });
});

describe("LspManager resolution errors", () => {
  test("a missing binary names the binary and where it was looked for", async () => {
    const proj = freshDir("kone-lsp-missing-");
    const missing = "kone-missing-lsp-binary-xyz";
    const manager = new LspManager({
      defaults: [fakeServerConfig("never-spawned", { command: missing })],
      binaryDeps: binaryDeps(),
      readTextFile: noConfigs(),
    });
    try {
      let failure: Error | null = null;
      try {
        await manager.getClient({ cwd: proj, filePath: path.join(proj, "a.fakets") });
      } catch (error) {
        if (error instanceof Error) failure = error;
      }
      expect(failure).toBeInstanceOf(LspServerStartError);
      if (!(failure instanceof LspServerStartError)) throw new Error("expected an LspServerStartError");
      expect(failure.message).toContain(missing);
      expect(failure.message).toContain("PATH");
      expect(failure.searchedPaths.length).toBeGreaterThan(0);
      expect(failure.searchedPaths.some((candidate) => candidate.includes("node_modules"))).toBe(true);
    } finally {
      await manager.disposeAll();
    }
  });

  test("an unowned extension reports the file", async () => {
    const proj = freshDir("kone-lsp-nofile-");
    const manager = new LspManager({
      defaults: [fakeServerConfig("never-spawned")],
      binaryDeps: binaryDeps(),
      readTextFile: noConfigs(),
    });
    try {
      const filePath = path.join(proj, "notes.md");
      let failure: Error | null = null;
      try {
        await manager.getClient({ cwd: proj, filePath });
      } catch (error) {
        if (error instanceof Error) failure = error;
      }
      expect(failure).toBeInstanceOf(LspNoServerError);
      if (!(failure instanceof LspNoServerError)) throw new Error("expected an LspNoServerError");
      expect(failure.filePath).toBe(filePath);
      expect(failure.disabledNames).toEqual([]);
    } finally {
      await manager.disposeAll();
    }
  });

  test("a disabled server reads as no server, naming the disabled one", async () => {
    const proj = freshDir("kone-lsp-disabled-");
    const manager = new LspManager({
      defaults: [fakeServerConfig("never-spawned", { disabled: true })],
      binaryDeps: binaryDeps(),
      readTextFile: noConfigs(),
    });
    try {
      let failure: Error | null = null;
      try {
        await manager.getClient({ cwd: proj, filePath: path.join(proj, "a.fakets") });
      } catch (error) {
        if (error instanceof Error) failure = error;
      }
      expect(failure).toBeInstanceOf(LspNoServerError);
      if (!(failure instanceof LspNoServerError)) throw new Error("expected an LspNoServerError");
      expect(failure.disabledNames).toEqual(["fake"]);
    } finally {
      await manager.disposeAll();
    }
  });
});

describe("LspManager config layers", () => {
  test("the project file overrides the default command", async () => {
    const proj = freshDir("kone-lsp-projcfg-");
    const log = path.join(proj, "methods.log");
    const script = fakeServerScript(log, "basic");
    const files = new Map<string, string>([
      [
        projectLspConfigPath(proj),
        JSON.stringify({ servers: { fake: { command: process.execPath, args: ["-e", script] } } }),
      ],
    ]);
    const manager = new LspManager({
      defaults: [fakeServerConfig("never-spawned", { command: "kone-missing-lsp-binary-xyz" })],
      binaryDeps: binaryDeps(),
      readTextFile: mapReader(files),
    });
    try {
      const client = await manager.getClient({ cwd: proj, filePath: path.join(proj, "a.fakets") });
      expect(client.isRunning()).toBe(true);
    } finally {
      await manager.disposeAll();
    }
  });

  test("the global file can disable a server", async () => {
    const proj = freshDir("kone-lsp-globcfg-");
    const userData = freshDir("kone-lsp-userdata-");
    const log = path.join(proj, "methods.log");
    const files = new Map<string, string>([
      [path.join(userData, "lsp.json"), JSON.stringify({ servers: { fake: { disabled: true } } })],
    ]);
    const manager = new LspManager({
      defaults: [fakeServerConfig(fakeServerScript(log, "basic"))],
      binaryDeps: binaryDeps(),
      readTextFile: mapReader(files),
      userDataPathFn: (...segments) => path.join(userData, ...segments),
    });
    try {
      let failure: Error | null = null;
      try {
        await manager.getClient({ cwd: proj, filePath: path.join(proj, "a.fakets") });
      } catch (error) {
        if (error instanceof Error) failure = error;
      }
      expect(failure).toBeInstanceOf(LspNoServerError);
    } finally {
      await manager.disposeAll();
    }
  });

  test("a corrupt global file falls back to defaults", async () => {
    const proj = freshDir("kone-lsp-badcfg-");
    const userData = freshDir("kone-lsp-userdata-bad-");
    const log = path.join(proj, "methods.log");
    const files = new Map<string, string>([[path.join(userData, "lsp.json"), "{{{not json"]]);
    const manager = new LspManager({
      defaults: [fakeServerConfig(fakeServerScript(log, "basic"))],
      binaryDeps: binaryDeps(),
      readTextFile: mapReader(files),
      userDataPathFn: (...segments) => path.join(userData, ...segments),
    });
    try {
      const client = await manager.getClient({ cwd: proj, filePath: path.join(proj, "a.fakets") });
      expect(client.isRunning()).toBe(true);
    } finally {
      await manager.disposeAll();
    }
  });
});

describe("LspManager ensureProjectLoaded", () => {
  async function loadedManager(
    scenario: FakeLspScenario,
    log: string,
  ): Promise<{ manager: LspManager; proj: string }> {
    const proj = freshDir("kone-lsp-ensure-");
    const manager = new LspManager({
      defaults: [fakeServerConfig(fakeServerScript(log, scenario))],
      binaryDeps: binaryDeps(),
      readTextFile: noConfigs(),
    });
    return { manager, proj };
  }

  test("a settling server resolves the wait", async () => {
    const log = path.join(freshDir("kone-lsp-ensure-ok-"), "methods.log");
    const { manager, proj } = await loadedManager("basic", log);
    try {
      const client = await manager.getClient({ cwd: proj, filePath: path.join(proj, "a.fakets") });
      await manager.ensureProjectLoaded(client, { timeoutMs: 5000 });
      expect(countLogLines(readLogLines(log), "in:workspace/symbol")).toBe(1);
    } finally {
      await manager.disposeAll();
    }
  });

  test("a slow server delays but never fails the wait", async () => {
    const log = path.join(freshDir("kone-lsp-ensure-slow-"), "methods.log");
    const { manager, proj } = await loadedManager("quietSymbol", log);
    try {
      const client = await manager.getClient({ cwd: proj, filePath: path.join(proj, "a.fakets") });
      const started = Date.now();
      await manager.ensureProjectLoaded(client, { timeoutMs: 400 });
      // One probe ran its course instead of short-circuiting, then the wait
      // proceeded: slowness delayed, never false-negatived.
      expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    } finally {
      await manager.disposeAll();
    }
  });

  test("an aborted wait rejects", async () => {
    const log = path.join(freshDir("kone-lsp-ensure-abort-"), "methods.log");
    const { manager, proj } = await loadedManager("quietSymbol", log);
    try {
      const client = await manager.getClient({ cwd: proj, filePath: path.join(proj, "a.fakets") });
      const controller = new AbortController();
      controller.abort();
      let failure: Error | null = null;
      try {
        await manager.ensureProjectLoaded(client, { timeoutMs: 5000, signal: controller.signal });
      } catch (error) {
        if (error instanceof Error) failure = error;
      }
      expect(failure).toBeInstanceOf(LspAbortError);
    } finally {
      await manager.disposeAll();
    }
  });
});

describe("LspManager referencesWithRetry", () => {
  test("a declaration-only first answer waits and retries to the full list", async () => {
    const proj = freshDir("kone-lsp-refs-");
    const log = path.join(proj, "methods.log");
    const manager = new LspManager({
      defaults: [fakeServerConfig(fakeServerScript(log, "flakyRefs"))],
      binaryDeps: binaryDeps(),
      readTextFile: noConfigs(),
    });
    try {
      const client = await manager.getClient({ cwd: proj, filePath: path.join(proj, "a.fakets") });
      const result = await manager.referencesWithRetry(
        client,
        refsParams(),
        { uri: "file:///decl.ts", line: 1, character: 2 },
        { timeoutMs: 5000, delayMs: 20 },
      );
      expect(refsCount(result)).toBe(2);
      expect(countLogLines(readLogLines(log), "in:textDocument/references")).toBe(2);
    } finally {
      await manager.disposeAll();
    }
  });

  test("a complete first answer returns without retrying", async () => {
    const proj = freshDir("kone-lsp-refs-full-");
    const log = path.join(proj, "methods.log");
    const manager = new LspManager({
      defaults: [fakeServerConfig(fakeServerScript(log, "basic"))],
      binaryDeps: binaryDeps(),
      readTextFile: noConfigs(),
    });
    try {
      const client = await manager.getClient({ cwd: proj, filePath: path.join(proj, "a.fakets") });
      const result = await manager.referencesWithRetry(
        client,
        refsParams(),
        { uri: "file:///decl.ts", line: 1, character: 2 },
        { timeoutMs: 5000, delayMs: 20 },
      );
      expect(refsCount(result)).toBe(2);
      expect(countLogLines(readLogLines(log), "in:textDocument/references")).toBe(1);
    } finally {
      await manager.disposeAll();
    }
  });

  test("a single answer elsewhere is already complete", async () => {
    const proj = freshDir("kone-lsp-refs-else-");
    const log = path.join(proj, "methods.log");
    const manager = new LspManager({
      defaults: [fakeServerConfig(fakeServerScript(log, "flakyRefs"))],
      binaryDeps: binaryDeps(),
      readTextFile: noConfigs(),
    });
    try {
      const client = await manager.getClient({ cwd: proj, filePath: path.join(proj, "a.fakets") });
      const result = await manager.referencesWithRetry(
        client,
        refsParams(),
        { uri: "file:///elsewhere.ts", line: 0, character: 0 },
        { timeoutMs: 5000, delayMs: 20 },
      );
      expect(refsCount(result)).toBe(1);
      expect(countLogLines(readLogLines(log), "in:textDocument/references")).toBe(1);
    } finally {
      await manager.disposeAll();
    }
  });
});

describe("LspManager idle reap", () => {
  test("sweepIdle collects only clients past the timeout", async () => {
    const proj = freshDir("kone-lsp-reap-");
    const log = path.join(proj, "methods.log");
    let now = 1_000_000;
    const manager = new LspManager({
      defaults: [fakeServerConfig(fakeServerScript(log, "basic"))],
      binaryDeps: binaryDeps(),
      readTextFile: noConfigs(),
      clock: () => now,
      idleTimeoutMs: 1000,
    });
    try {
      const client = await manager.getClient({ cwd: proj, filePath: path.join(proj, "a.fakets") });
      now += 500;
      await manager.sweepIdle();
      expect(client.isRunning()).toBe(true);
      now += 600;
      await manager.sweepIdle();
      expect(client.isRunning()).toBe(false);
      // The pool dropped the entry: the next caller starts a new process.
      const replacement = await manager.getClient({ cwd: proj, filePath: path.join(proj, "a.fakets") });
      expect(replacement).not.toBe(client);
      // First start (2 lines) + shutdown/exit of the reaped client (2) +
      // replacement start (2).
      const seen = await waitForLog(log, 6);
      expect(countLogLines(seen, "in:initialize")).toBe(2);
    } finally {
      await manager.disposeAll();
    }
  });

  test("reap with zero disables collection", async () => {
    const proj = freshDir("kone-lsp-reapoff-");
    const log = path.join(proj, "methods.log");
    let now = 2_000_000;
    const manager = new LspManager({
      defaults: [fakeServerConfig(fakeServerScript(log, "basic"))],
      binaryDeps: binaryDeps(),
      readTextFile: noConfigs(),
      clock: () => now,
      idleTimeoutMs: 1000,
    });
    try {
      const client = await manager.getClient({ cwd: proj, filePath: path.join(proj, "a.fakets") });
      manager.reap(0);
      now += 60_000;
      await manager.sweepIdle();
      expect(client.isRunning()).toBe(true);
    } finally {
      await manager.disposeAll();
    }
  });

  test("the reap timer collects idle clients on its own", async () => {
    const proj = freshDir("kone-lsp-reaptimer-");
    const log = path.join(proj, "methods.log");
    const manager = new LspManager({
      defaults: [fakeServerConfig(fakeServerScript(log, "basic"))],
      binaryDeps: binaryDeps(),
      readTextFile: noConfigs(),
    });
    try {
      const client = await manager.getClient({ cwd: proj, filePath: path.join(proj, "a.fakets") });
      manager.reap(50);
      await new Promise<void>((resolve) => setTimeout(resolve, 600));
      expect(client.isRunning()).toBe(false);
    } finally {
      await manager.disposeAll();
    }
  });

  test("disposeAll closes every client and refuses new ones", async () => {
    const firstDir = freshDir("kone-lsp-dispose-a-");
    const secondDir = freshDir("kone-lsp-dispose-b-");
    const log = path.join(firstDir, "methods.log");
    const manager = new LspManager({
      defaults: [fakeServerConfig(fakeServerScript(log, "basic"))],
      binaryDeps: binaryDeps(),
      readTextFile: noConfigs(),
    });
    const first = await manager.getClient({ cwd: firstDir, filePath: path.join(firstDir, "a.fakets") });
    const second = await manager.getClient({ cwd: secondDir, filePath: path.join(secondDir, "b.fakets") });
    await manager.disposeAll();
    expect(first.isRunning()).toBe(false);
    expect(second.isRunning()).toBe(false);
    let failure: Error | null = null;
    try {
      await manager.getClient({ cwd: firstDir, filePath: path.join(firstDir, "a.fakets") });
    } catch (error) {
      if (error instanceof Error) failure = error;
    }
    expect(failure).toBeInstanceOf(LspManagerError);
  });
});

describe("LspManager workspace client", () => {
  test("a project-wide client starts with no files on disk and shares the pool", async () => {
    const proj = freshDir("kone-lsp-workspace-");
    const log = path.join(proj, "methods.log");
    const manager = new LspManager({
      defaults: [fakeServerConfig(fakeServerScript(log, "basic"))],
      binaryDeps: binaryDeps(),
      readTextFile: noConfigs(),
    });
    try {
      const workspace = await manager.getWorkspaceClient(proj);
      expect(workspace.isRunning()).toBe(true);
      // Same command plus directory means the same process a file client gets.
      const filed = await manager.getClient({ cwd: proj, filePath: path.join(proj, "a.fakets") });
      expect(filed).toBe(workspace);
      const seen = await waitForLog(log, 2);
      expect(countLogLines(seen, "in:initialize")).toBe(1);
    } finally {
      await manager.disposeAll();
    }
  });

  test("no enabled server reads as no server", async () => {
    const proj = freshDir("kone-lsp-workspace-none-");
    const manager = new LspManager({
      defaults: [fakeServerConfig("never-spawned", { disabled: true })],
      binaryDeps: binaryDeps(),
      readTextFile: noConfigs(),
    });
    try {
      let failure: Error | null = null;
      try {
        await manager.getWorkspaceClient(proj);
      } catch (error) {
        if (error instanceof Error) failure = error;
      }
      expect(failure).toBeInstanceOf(LspNoServerError);
    } finally {
      await manager.disposeAll();
    }
  });

  test("languageIdForFile follows the registry's extension ownership", async () => {
    const proj = freshDir("kone-lsp-langid-");
    const manager = new LspManager({
      defaults: [fakeServerConfig("never-spawned")],
      binaryDeps: binaryDeps(),
      readTextFile: noConfigs(),
    });
    try {
      // The fake server names no tags, so its files open under the extension.
      expect(manager.languageIdForFile(proj, path.join(proj, "a.fakets"))).toBe("fakets");
      expect(manager.languageIdForFile(proj, path.join(proj, "notes.md"))).toBe("md");
    } finally {
      await manager.disposeAll();
    }
  });
});
