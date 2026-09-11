// kone_lsp gateway tool tests: the registry surface plus every action driven
// through real fake-server processes over real pipes — no real language
// server binary anywhere in this file.

import { describe, expect, test } from "bun:test";
import { existsSync as fsExistsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { fakeServerScript, readLogLines } from "../../lsp/fakeLspServer.js";
import type { FakeLspScenario } from "../../lsp/fakeLspServer.js";
import { LspManager } from "../../lsp/manager.js";
import { createRegistry } from "../registry.js";
import type { GatewayRecord, GatewayToolContext, GatewayValue } from "../schemas.js";
import { createLspTools } from "./lsp.js";

interface LspToolProject {
  dir: string;
  log: string;
}

function freshProject(): LspToolProject {
  const dir = mkdtempSync(path.join(tmpdir(), "kone-lsp-tool-"));
  const lines: string[] = [];
  for (let index = 0; index < 14; index += 1) {
    lines.push(`const item${index} = "value${index}";`);
  }
  writeFileSync(path.join(dir, "a.fakets"), `${lines.join("\n")}\n`);
  return { dir, log: path.join(dir, "methods.log") };
}

function fakeManager(log: string, scenario: FakeLspScenario): LspManager {
  return new LspManager({
    defaults: [
      {
        name: "fake",
        command: process.execPath,
        args: ["-e", fakeServerScript(log, scenario)],
        fileTypes: ["fakets"],
        rootMarkers: [],
      },
    ],
    binaryDeps: { existsSync: fsExistsSync, lookupOnPath: () => null },
    readTextFile: () => null,
  });
}

function makeCtx(cwd: string, overrides: Partial<GatewayToolContext> = {}): GatewayToolContext {
  return {
    threadId: "thread-lsp",
    turnId: null,
    provider: "claudeAgent",
    cwd,
    requestId: 1,
    ...overrides,
  };
}

function asRecord(value: GatewayValue | undefined): GatewayRecord | null {
  if (value instanceof Object && !Array.isArray(value)) return value;
  return null;
}

async function waitForText(
  call: () => Promise<string>,
  needle: string,
  timeoutMs = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = await call();
    if (text.includes(needle)) return text;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for "${needle}"`);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

async function callText(
  cwd: string,
  manager: LspManager,
  args: Record<string, string | number>,
  overrides: Partial<GatewayToolContext> = {},
): Promise<string> {
  const registry = createRegistry(createLspTools({ manager }));
  const result = await registry.call(makeCtx(cwd, overrides), "kone_lsp", args);
  expect(result.isError).toBeUndefined();
  return result.content[0]!.text;
}

describe("kone_lsp registration", () => {
  test("lists one turn-less allow tool with the action enum in its JSON schema", async () => {
    const { log } = freshProject();
    const manager = fakeManager(log, "basic");
    try {
      const tools = createLspTools({ manager });
      expect(tools.map((tool) => tool.name)).toEqual(["kone_lsp"]);
      expect(tools[0]!.permission).toBe("allow");
      expect(tools[0]!.requiresActiveTurn).toBe(false);
      expect(tools[0]!.promptSnippet).not.toContain("\n");

      const registry = createRegistry(tools);
      const listed = registry.listTools().find((tool) => tool.name === "kone_lsp")!;
      expect(listed.inputSchema.required).toEqual(["action"]);
      const properties = asRecord(listed.inputSchema.properties);
      const action = properties === null ? null : asRecord(properties.action);
      const actionEnum = action === null ? null : action.enum;
      expect(Array.isArray(actionEnum) ? actionEnum : null).toEqual([
        "definition",
        "references",
        "hover",
        "symbols",
        "diagnostics",
        "rename",
      ]);
    } finally {
      await manager.disposeAll();
    }
  });

  test("the description states the column-free contract and the preview-only rename", async () => {
    const { log } = freshProject();
    const manager = fakeManager(log, "basic");
    try {
      const description = createLspTools({ manager })[0]!.description;
      expect(description).toMatch(/column/i);
      expect(description).toMatch(/preview/i);
      expect(description).toMatch(/never writes/i);
    } finally {
      await manager.disposeAll();
    }
  });

  test("reads work with no live turn", async () => {
    const { dir, log } = freshProject();
    const manager = fakeManager(log, "basic");
    try {
      const text = await callText(dir, manager, {
        action: "hover",
        path: "a.fakets",
        line: 1,
        symbol: "item",
      });
      expect(text).toContain("**fake-hover**");
    } finally {
      await manager.disposeAll();
    }
  });
});

describe("kone_lsp position actions", () => {
  test("definition resolves to the server's location", async () => {
    const { dir, log } = freshProject();
    const manager = fakeManager(log, "basic");
    try {
      const registry = createRegistry(createLspTools({ manager }));
      const result = await registry.call(makeCtx(dir), "kone_lsp", {
        action: "definition",
        path: "a.fakets",
        line: 3,
        symbol: "item",
      });
      expect(result.isError).toBeUndefined();
      expect(result.content[0]!.text).toContain("decl.ts");
      expect(result.content[0]!.text).toContain(":2:3");
      expect(result.structuredContent?.locations).toHaveLength(1);
    } finally {
      await manager.disposeAll();
    }
  });

  test("symbols with a path lists the document's symbols", async () => {
    const { dir, log } = freshProject();
    const manager = fakeManager(log, "basic");
    try {
      const text = await callText(dir, manager, { action: "symbols", path: "a.fakets" });
      expect(text).toContain("fakeSymbol");
      expect(text).toContain("a.fakets");
    } finally {
      await manager.disposeAll();
    }
  });

  test("symbols without a path runs a project-wide search", async () => {
    const { dir, log } = freshProject();
    const manager = fakeManager(log, "basic");
    try {
      const text = await callText(dir, manager, { action: "symbols", query: "fake" });
      expect(text).toBe("No symbols found.");
    } finally {
      await manager.disposeAll();
    }
  });

  test("diagnostics reads a cold cache as clean, then warms", async () => {
    const { dir, log } = freshProject();
    const manager = fakeManager(log, "basic");
    try {
      const registry = createRegistry(createLspTools({ manager }));
      const cold = await registry.call(makeCtx(dir), "kone_lsp", {
        action: "diagnostics",
        path: "a.fakets",
      });
      expect(cold.isError).toBeUndefined();
      expect(cold.content[0]!.text).toBe("No diagnostics found.");

      const warm = await waitForText(async () => {
        const result = await registry.call(makeCtx(dir), "kone_lsp", {
          action: "diagnostics",
          path: "a.fakets",
        });
        return result.content[0]!.text;
      }, "fake diag");
      expect(warm).toContain("[error]");
    } finally {
      await manager.disposeAll();
    }
  });

  test("rename previews the edit and never writes the file", async () => {
    const { dir, log } = freshProject();
    const manager = fakeManager(log, "basic");
    const filePath = path.join(dir, "a.fakets");
    const before = readFileSync(filePath, "utf8");
    try {
      const registry = createRegistry(createLspTools({ manager }));
      const result = await registry.call(makeCtx(dir), "kone_lsp", {
        action: "rename",
        path: "a.fakets",
        line: 1,
        symbol: "item0",
        newName: "thing0",
      });
      expect(result.isError).toBeUndefined();
      expect(result.content[0]!.text).toContain("thing0");
      expect(result.content[0]!.text).toContain("a.fakets");
      expect(result.content[0]!.text).toMatch(/preview only/i);
      expect(result.structuredContent).toMatchObject({ previewOnly: true, editCount: 1 });
      expect(readFileSync(filePath, "utf8")).toBe(before);
    } finally {
      await manager.disposeAll();
    }
  });
});

describe("kone_lsp references", () => {
  test("budgets a long answer with a collapse divider and file context", async () => {
    const { dir, log } = freshProject();
    const manager = fakeManager(log, "manyRefs");
    try {
      const registry = createRegistry(createLspTools({ manager }));
      const result = await registry.call(makeCtx(dir), "kone_lsp", {
        action: "references",
        path: "a.fakets",
        line: 3,
        symbol: "item",
      });
      expect(result.isError).toBeUndefined();
      const text = result.content[0]!.text;
      expect(text).toContain("... 2 more shown without context");
      expect(text).toContain('const item0 = "value0";');
      expect(result.structuredContent?.references).toHaveLength(12);
    } finally {
      await manager.disposeAll();
    }
  });
});

describe("kone_lsp refusals", () => {
  test("a path escaping the project is refused before any server starts", async () => {
    const { dir, log } = freshProject();
    const manager = fakeManager(log, "basic");
    try {
      const registry = createRegistry(createLspTools({ manager }));
      for (const escaped of ["../outside.fakets", "/definitely-outside-proj/x.fakets"]) {
        const result = await registry.call(makeCtx(dir), "kone_lsp", {
          action: "hover",
          path: escaped,
          line: 1,
          symbol: "x",
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent?.error).toMatchObject({ code: "invalid_input" });
        expect(result.content[0]!.text).toMatch(/escapes the project root/);
      }
      expect(readLogLines(log)).toEqual([]);
    } finally {
      await manager.disposeAll();
    }
  });

  test("a line without a symbol is refused, never guessed", async () => {
    const { dir, log } = freshProject();
    const manager = fakeManager(log, "basic");
    try {
      const registry = createRegistry(createLspTools({ manager }));
      const result = await registry.call(makeCtx(dir), "kone_lsp", {
        action: "hover",
        path: "a.fakets",
        line: 1,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.error).toMatchObject({ code: "invalid_input" });
      expect(result.content[0]!.text).toMatch(/symbol/);
    } finally {
      await manager.disposeAll();
    }
  });

  test("a position action without a line is refused", async () => {
    const { dir, log } = freshProject();
    const manager = fakeManager(log, "basic");
    try {
      const registry = createRegistry(createLspTools({ manager }));
      const result = await registry.call(makeCtx(dir), "kone_lsp", {
        action: "hover",
        path: "a.fakets",
        symbol: "item",
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.error).toMatchObject({ code: "invalid_input" });
    } finally {
      await manager.disposeAll();
    }
  });

  test("an action without a path names the missing file", async () => {
    const { dir, log } = freshProject();
    const manager = fakeManager(log, "basic");
    try {
      const registry = createRegistry(createLspTools({ manager }));
      const result = await registry.call(makeCtx(dir), "kone_lsp", {
        action: "hover",
        line: 1,
        symbol: "item",
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.error).toMatchObject({ code: "invalid_input" });
      expect(result.content[0]!.text).toMatch(/"path"/);
    } finally {
      await manager.disposeAll();
    }
  });

  test("rename without newName is refused", async () => {
    const { dir, log } = freshProject();
    const manager = fakeManager(log, "basic");
    try {
      const registry = createRegistry(createLspTools({ manager }));
      const result = await registry.call(makeCtx(dir), "kone_lsp", {
        action: "rename",
        path: "a.fakets",
        line: 1,
        symbol: "item0",
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.error).toMatchObject({ code: "invalid_input" });
    } finally {
      await manager.disposeAll();
    }
  });

  test("newName on any other action is refused", async () => {
    const { dir, log } = freshProject();
    const manager = fakeManager(log, "basic");
    try {
      const registry = createRegistry(createLspTools({ manager }));
      const result = await registry.call(makeCtx(dir), "kone_lsp", {
        action: "hover",
        path: "a.fakets",
        line: 1,
        symbol: "item",
        newName: "thing",
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.error).toMatchObject({ code: "invalid_input" });
    } finally {
      await manager.disposeAll();
    }
  });

  test("an unreadable file is refused", async () => {
    const { dir, log } = freshProject();
    const manager = fakeManager(log, "basic");
    try {
      const registry = createRegistry(createLspTools({ manager }));
      const result = await registry.call(makeCtx(dir), "kone_lsp", {
        action: "hover",
        path: "missing.fakets",
        line: 1,
        symbol: "x",
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.error).toMatchObject({ code: "invalid_input" });
      expect(result.content[0]!.text).toMatch(/Cannot read/);
    } finally {
      await manager.disposeAll();
    }
  });

  test("an unknown action is refused", async () => {
    const { dir, log } = freshProject();
    const manager = fakeManager(log, "basic");
    try {
      const registry = createRegistry(createLspTools({ manager }));
      const result = await registry.call(makeCtx(dir), "kone_lsp", {
        action: "teleport",
        path: "a.fakets",
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.error).toMatchObject({ code: "invalid_input" });
    } finally {
      await manager.disposeAll();
    }
  });
});

describe("kone_lsp abort", () => {
  test("an aborted call rejects with AbortError instead of a tool error", async () => {
    const { dir, log } = freshProject();
    const manager = fakeManager(log, "basic");
    try {
      const registry = createRegistry(createLspTools({ manager }));
      const controller = new AbortController();
      controller.abort();
      await expect(
        registry.call(
          makeCtx(dir, { signal: controller.signal }),
          "kone_lsp",
          { action: "hover", path: "a.fakets", line: 1, symbol: "item" },
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      await manager.disposeAll();
    }
  });

  test("abort propagates through the references warmup path", async () => {
    const { dir, log } = freshProject();
    const manager = fakeManager(log, "manyRefs");
    try {
      const registry = createRegistry(createLspTools({ manager }));
      const controller = new AbortController();
      controller.abort();
      await expect(
        registry.call(
          makeCtx(dir, { signal: controller.signal }),
          "kone_lsp",
          { action: "references", path: "a.fakets", line: 3, symbol: "item" },
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      await manager.disposeAll();
    }
  });
});
