// kone_ast_find_calls + kone_ast_preview gateway tool tests: registry surface
// plus tool runs against tmpdir projects — no real user checkout anywhere.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { AST_MAX_MATCHES } from "../../ast/format.js";
import { createRegistry } from "../registry.js";
import type { GatewayToolContext, GatewayValue } from "../schemas.js";
import {
  AST_FIND_CALLS_JSON_SCHEMA,
  AST_PREVIEW_JSON_SCHEMA,
  AstFindCallsInputSchema,
  AstPreviewInputSchema,
  createAstTools,
} from "./ast.js";

function makeCtx(cwd: string, overrides: Partial<GatewayToolContext> = {}): GatewayToolContext {
  return {
    threadId: "thread-ast",
    turnId: null,
    provider: "claudeAgent",
    cwd,
    requestId: 1,
    ...overrides,
  };
}

function fixtureProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "kone-ast-tool-"));
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "a.ts"), 'foo(1, 2);\nbar("x");\n');
  writeFileSync(path.join(dir, "src", "b.ts"), "nothing here\n");
  return dir;
}

describe("kone_ast_find_calls registration", () => {
  test("lists both turn-less allow tools for all targets with names required", () => {
    const tools = createAstTools();
    expect(tools.map((tool) => tool.name)).toEqual(["kone_ast_find_calls", "kone_ast_preview"]);
    for (const tool of tools) {
      expect(tool.permission).toBe("allow");
      expect(tool.requiresActiveTurn).toBe(false);
      expect(tool.target).toBe("all");
      expect(tool.promptSnippet).not.toContain("\n");
    }

    const registry = createRegistry(tools);
    const listed = registry.listTools().find((tool) => tool.name === "kone_ast_find_calls");
    expect(listed?.inputSchema).toEqual(AST_FIND_CALLS_JSON_SCHEMA);
    const required = listed?.inputSchema.required;
    expect(Array.isArray(required) ? required : null).toEqual(["name"]);
    const preview = registry.listTools().find((tool) => tool.name === "kone_ast_preview");
    expect(preview?.inputSchema).toEqual(AST_PREVIEW_JSON_SCHEMA);
    const previewRequired = preview?.inputSchema.required;
    expect(Array.isArray(previewRequired) ? previewRequired : null).toEqual(["op"]);
  });

  test("the description states plain names, cross-line matching, and never-matches", () => {
    const description = createAstTools()[0]?.description ?? "";
    expect(description).toMatch(/plain/i);
    expect(description).toMatch(/comment/i);
    expect(description).toMatch(/partial identifier/i);
  });

  test("the zod schema refuses patterns while the tool file stays turn-less", () => {
    expect(AstFindCallsInputSchema.safeParse({ name: "foo" }).success).toBe(true);
    expect(AstFindCallsInputSchema.safeParse({ name: "foo($$$ARGS)" }).success).toBe(false);
    expect(AstFindCallsInputSchema.safeParse({ name: "foo*" }).success).toBe(false);
    expect(AstFindCallsInputSchema.safeParse({}).success).toBe(false);
    expect(AstFindCallsInputSchema.safeParse({ name: "foo" }).data?.path).toBe(".");
  });
});

describe("kone_ast_find_calls runs", () => {
  test("a turn-less call finds matches with anchors and counts", async () => {
    const dir = fixtureProject();
    try {
      const registry = createRegistry(createAstTools());
      const result = await registry.call(makeCtx(dir), "kone_ast_find_calls", { name: "foo" });
      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.text).toContain("src/a.ts:1");
      expect(result.content[0]?.text).toContain("[2 args]");
      expect(result.structuredContent?.["matchCount"]).toBe(1);
      expect(result.structuredContent?.["fileCount"]).toBe(1);
      expect(result.structuredContent?.["limitReached"]).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a scoped path searches only that subtree", async () => {
    const dir = fixtureProject();
    try {
      const registry = createRegistry(createAstTools());
      const result = await registry.call(makeCtx(dir), "kone_ast_find_calls", {
        name: "foo",
        path: "src/b.ts",
      });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent?.["matchCount"]).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty search reads as neutral copy, not an error", async () => {
    const dir = fixtureProject();
    try {
      const registry = createRegistry(createAstTools());
      const result = await registry.call(makeCtx(dir), "kone_ast_find_calls", { name: "zzz" });
      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.text).toContain('No calls to "zzz" found.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a pattern-like name is refused as invalid input", async () => {
    const dir = fixtureProject();
    try {
      const registry = createRegistry(createAstTools());
      const result = await registry.call(makeCtx(dir), "kone_ast_find_calls", {
        name: "foo($$$ARGS)",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/invalid_input/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an escaping path is refused as invalid input", async () => {
    const dir = fixtureProject();
    try {
      const registry = createRegistry(createAstTools());
      const result = await registry.call(makeCtx(dir), "kone_ast_find_calls", {
        name: "foo",
        path: "../outside",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/invalid_input/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unknown path is refused as invalid input", async () => {
    const dir = fixtureProject();
    try {
      const registry = createRegistry(createAstTools());
      const result = await registry.call(makeCtx(dir), "kone_ast_find_calls", {
        name: "foo",
        path: "nope/missing.ts",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/invalid_input/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("kone_ast_preview registration", () => {
  test("the description states preview-only, caller applies, and re-verification", () => {
    const description = createAstTools()[1]?.description ?? "";
    expect(description).toMatch(/preview only/i);
    expect(description).toMatch(/never writes/i);
    expect(description).toMatch(/own edit tools/i);
    expect(description).toMatch(/re-verify/i);
  });

  test("the zod schema requires fields per op with identifier checks", () => {
    expect(
      AstPreviewInputSchema.safeParse({ op: "rename-call", from: "foo", to: "bar" }).success,
    ).toBe(true);
    expect(AstPreviewInputSchema.safeParse({ op: "rename-call", from: "foo" }).success).toBe(false);
    expect(
      AstPreviewInputSchema.safeParse({ op: "rename-call", from: "foo", to: "a b" }).success,
    ).toBe(false);
    expect(
      AstPreviewInputSchema.safeParse({ op: "rename-call", from: "foo($$$ARGS)", to: "bar" })
        .success,
    ).toBe(false);
    expect(
      AstPreviewInputSchema.safeParse({ op: "add-argument", name: "foo", argText: "ctx" }).success,
    ).toBe(true);
    expect(AstPreviewInputSchema.safeParse({ op: "add-argument", name: "foo" }).success).toBe(false);
    expect(
      AstPreviewInputSchema.safeParse({ op: "add-argument", name: "foo", argText: "  " }).success,
    ).toBe(false);
    expect(
      AstPreviewInputSchema.safeParse({ op: "add-argument", name: "foo", argText: "ctx", position: "middle" })
        .success,
    ).toBe(false);
    expect(AstPreviewInputSchema.safeParse({ from: "foo", to: "bar" }).success).toBe(false);
    const add = AstPreviewInputSchema.safeParse({ op: "add-argument", name: "foo", argText: "ctx" });
    expect(add.success && add.data.position).toBe("last");
    expect(add.success && add.data.path).toBe(".");
  });
});

function previewFixtureProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "kone-ast-preview-"));
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "a.ts"), 'foo(1, 2);\nbar("x");\n');
  writeFileSync(path.join(dir, "src", "multi.ts"), 'foo(\n  "a",\n);\n');
  writeFileSync(path.join(dir, "src", "nested.ts"), "foo(foo(1));\n");
  writeFileSync(path.join(dir, "src", "broken.ts"), "const = = = broken (((\nfoo(1);\n");
  return dir;
}

// Plain-object guard so the caps test can count shown rows without
// assertions: structured file rows are records by handler construction.
function isGatewayRecord(value: GatewayValue): value is { [key: string]: GatewayValue } {
  return value instanceof Object && !Array.isArray(value);
}

function shownReplacementCount(files: GatewayValue | undefined): number {
  if (!Array.isArray(files)) return -1;
  let count = 0;
  for (const file of files) {
    if (!isGatewayRecord(file)) continue;
    const replacements = file["replacements"];
    if (Array.isArray(replacements)) count += replacements.length;
  }
  return count;
}

function snapshotFiles(dir: string): Map<string, string> {  const hashes = new Map<string, string>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      hashes.set(
        path.relative(dir, abs),
        createHash("sha256").update(readFileSync(abs)).digest("hex"),
      );
    }
  };
  walk(dir);
  return hashes;
}

describe("kone_ast_preview runs", () => {
  test("a turn-less rename previews before→after rows with counts, leaving disk alone", async () => {
    const dir = previewFixtureProject();
    const before = snapshotFiles(dir);
    try {
      const registry = createRegistry(createAstTools());
      const result = await registry.call(makeCtx(dir), "kone_ast_preview", {
        op: "rename-call",
        from: "foo",
        to: "bar",
        path: "src/a.ts",
      });
      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.text).toContain("src/a.ts:1 - foo(1, 2); → bar(1, 2);");
      expect(result.content[0]?.text).toMatch(/preview only/);
      expect(result.structuredContent?.["op"]).toBe("rename-call");
      expect(result.structuredContent?.["from"]).toBe("foo");
      expect(result.structuredContent?.["to"]).toBe("bar");
      expect(result.structuredContent?.["filesTouched"]).toBe(1);
      expect(result.structuredContent?.["totalReplacements"]).toBe(1);
      expect(result.structuredContent?.["filesSearched"]).toBe(1);
      expect(result.structuredContent?.["previewOnly"]).toBe(true);
      expect(result.structuredContent?.["limitReached"]).toBe(false);
      expect(snapshotFiles(dir)).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a multi-line rename splices only the callee line", async () => {
    const dir = previewFixtureProject();
    const before = snapshotFiles(dir);
    try {
      const registry = createRegistry(createAstTools());
      const result = await registry.call(makeCtx(dir), "kone_ast_preview", {
        op: "rename-call",
        from: "foo",
        to: "bar",
        path: "src/multi.ts",
      });
      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.text).toContain("src/multi.ts:1 - foo( → bar(");
      expect(result.structuredContent?.["totalReplacements"]).toBe(1);
      expect(snapshotFiles(dir)).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("add-argument previews last by default and first on request", async () => {
    const dir = previewFixtureProject();
    const before = snapshotFiles(dir);
    try {
      const registry = createRegistry(createAstTools());
      const last = await registry.call(makeCtx(dir), "kone_ast_preview", {
        op: "add-argument",
        name: "foo",
        argText: "ctx",
        path: "src/a.ts",
      });
      expect(last.isError).toBeUndefined();
      expect(last.content[0]?.text).toContain("src/a.ts:1 - foo(1, 2); → foo(1, 2, ctx);");
      expect(last.structuredContent?.["position"]).toBe("last");
      const first = await registry.call(makeCtx(dir), "kone_ast_preview", {
        op: "add-argument",
        name: "foo",
        argText: "ctx",
        position: "first",
        path: "src/a.ts",
      });
      expect(first.isError).toBeUndefined();
      expect(first.content[0]?.text).toContain("src/a.ts:1 - foo(1, 2); → foo(ctx, 1, 2);");
      expect(snapshotFiles(dir)).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a multi-line add keeps formatting with a point edit at the paren", async () => {
    const dir = previewFixtureProject();
    const before = snapshotFiles(dir);
    try {
      const registry = createRegistry(createAstTools());
      const result = await registry.call(makeCtx(dir), "kone_ast_preview", {
        op: "add-argument",
        name: "foo",
        argText: '"b"',
        path: "src/multi.ts",
      });
      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.text).toContain('src/multi.ts:3 - ); → , "b");');
      expect(snapshotFiles(dir)).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty preview reads as neutral copy with zero counts", async () => {
    const dir = previewFixtureProject();
    const before = snapshotFiles(dir);
    try {
      const registry = createRegistry(createAstTools());
      const result = await registry.call(makeCtx(dir), "kone_ast_preview", {
        op: "rename-call",
        from: "zzz",
        to: "yyy",
        path: "src/a.ts",
      });
      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.text).toContain('No calls to "zzz" found — nothing to preview.');
      expect(result.structuredContent?.["filesTouched"]).toBe(0);
      expect(result.structuredContent?.["totalReplacements"]).toBe(0);
      expect(result.structuredContent?.["previewOnly"]).toBe(true);
      expect(snapshotFiles(dir)).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("invalid op combos are refused as invalid input", async () => {
    const dir = previewFixtureProject();
    const before = snapshotFiles(dir);
    try {
      const registry = createRegistry(createAstTools());
      const cases: Array<Record<string, string>> = [
        { op: "rename-call", from: "foo" },
        { op: "rename-call", from: "foo", to: "a b" },
        { op: "rename-call", from: "foo($$$ARGS)", to: "bar" },
        { op: "add-argument", name: "foo" },
        { op: "add-argument", name: "foo", argText: "   " },
        { op: "add-argument", name: "foo", argText: "1); evil(" },
        { op: "add-argument", argText: "ctx" },
      ];
      for (const args of cases) {
        const result = await registry.call(makeCtx(dir), "kone_ast_preview", args);
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toMatch(/invalid_input/);
      }
      expect(snapshotFiles(dir)).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("overlapping matches abort the file as an error result, disk untouched", async () => {
    const dir = previewFixtureProject();
    const before = snapshotFiles(dir);
    try {
      const registry = createRegistry(createAstTools());
      const result = await registry.call(makeCtx(dir), "kone_ast_preview", {
        op: "rename-call",
        from: "foo",
        to: "bar",
        path: "src/nested.ts",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/invalid_input/);
      expect(result.content[0]?.text).toMatch(/overlap/i);
      expect(snapshotFiles(dir)).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unparseable file is a counted skip, not an error", async () => {
    const dir = previewFixtureProject();
    const before = snapshotFiles(dir);
    try {
      const registry = createRegistry(createAstTools());
      const result = await registry.call(makeCtx(dir), "kone_ast_preview", {
        op: "rename-call",
        from: "foo",
        to: "bar",
        path: "src/broken.ts",
      });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent?.["totalReplacements"]).toBe(0);
      expect(result.structuredContent?.["parseIssuesTotal"]).toBe(1);
      expect(result.content[0]?.text).toContain("could not be parsed");
      expect(snapshotFiles(dir)).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an escaping or unknown path is refused as invalid input", async () => {
    const dir = previewFixtureProject();
    try {
      const registry = createRegistry(createAstTools());
      const escaped = await registry.call(makeCtx(dir), "kone_ast_preview", {
        op: "rename-call",
        from: "foo",
        to: "bar",
        path: "../outside",
      });
      expect(escaped.isError).toBe(true);
      expect(escaped.content[0]?.text).toMatch(/invalid_input/);
      const unknown = await registry.call(makeCtx(dir), "kone_ast_preview", {
        op: "add-argument",
        name: "foo",
        argText: "ctx",
        path: "nope/missing.ts",
      });
      expect(unknown.isError).toBe(true);
      expect(unknown.content[0]?.text).toMatch(/invalid_input/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("replacements cap at 50 with exact totals and untouched disk", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kone-ast-preview-cap-"));
    try {
      const lines: string[] = [];
      for (let index = 0; index < AST_MAX_MATCHES + 10; index += 1) {
        lines.push(`foo(${index});`);
      }
      writeFileSync(path.join(dir, "big.ts"), `${lines.join("\n")}\n`);
      const before = snapshotFiles(dir);
      const registry = createRegistry(createAstTools());
      const result = await registry.call(makeCtx(dir), "kone_ast_preview", {
        op: "rename-call",
        from: "foo",
        to: "bar",
      });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent?.["totalReplacements"]).toBe(AST_MAX_MATCHES + 10);
      expect(result.structuredContent?.["limitReached"]).toBe(true);
      expect(shownReplacementCount(result.structuredContent?.["files"])).toBe(AST_MAX_MATCHES);
      expect(result.content[0]?.text).toContain("limit reached");
      expect(snapshotFiles(dir)).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
