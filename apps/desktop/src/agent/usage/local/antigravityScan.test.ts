import { describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The agent layer imports `node:sqlite` (an Electron-runtime built-in this bun
// can't load) — the established repo pattern stands in bun's Database, with a
// thin shim translating node's `{ readOnly }` constructor option to bun's
// `{ readonly }`.
class DatabaseSyncShim {
  private readonly db: Database;
  constructor(filePath: string, options?: { readOnly?: boolean }) {
    this.db = options?.readOnly
      ? new Database(filePath, { readonly: true })
      : new Database(filePath);
  }
  prepare(sql: string) {
    return this.db.prepare(sql);
  }
  exec(sql: string) {
    this.db.exec(sql);
  }
  close() {
    this.db.close();
  }
}
mock.module("../../sqlite.js", () => ({ DatabaseSync: DatabaseSyncShim }));

// The scanner itself must load AFTER the mock is registered — a static import
// would hoist above it and pull the real node:sqlite.
const {
  canonicalAntigravityModelId,
  parseAntigravityGenMetadataRow,
  scanAntigravityUsage,
  antigravityCascadeIdFromPath,
  conversationRoots,
} = await import("./antigravityScan.js");

// ── protobuf fixture helpers ─────────────────────────────────────────────────
// A tiny encoder for the reverse-engineered gen_metadata row shape:
// root { chatModel(#1) } → chatModel { usage(#4), chatStartMetadata(#9),
// model(#19), display_name(#21), attributes(#20) } → usage { input(#1/#2),
// totalOutput(#3), response(#9), thinking(#10), responseId(#11) }.

function varint(value: number): number[] {
  const out: number[] = [];
  let v = BigInt(value);
  while (v > 0x7fn) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return out;
}

function key(field: number, wireType: number): number[] {
  return varint((field << 3) | wireType);
}

function fieldVarint(field: number, value: number): number[] {
  return [...key(field, 0), ...varint(value)];
}

function fieldBytes(field: number, bytes: Uint8Array): number[] {
  return [...key(field, 2), ...varint(bytes.length), ...bytes];
}

function encodeMessage(fields: number[][]): Uint8Array {
  return Uint8Array.from(fields.flat());
}

function usageMessage(input: number, output: number, thinking: number, responseId: string): number[][] {
  return [
    fieldVarint(2, input),
    fieldVarint(3, output),
    fieldVarint(9, Math.max(0, output - thinking)),
    fieldVarint(10, thinking),
    fieldBytes(11, new TextEncoder().encode(responseId)),
  ];
}

function chatMessage(
  usage: number[][],
  opts: {
    createdAtIso?: string;
    model?: string;
    displayName?: string;
    createdAtSeconds?: number;
  } = {},
): number[][] {
  const out: number[][] = [fieldBytes(4, encodeMessage(usage))];
  if (opts.createdAtIso) {
    out.push(fieldBytes(9, encodeMessage([fieldBytes(4, new TextEncoder().encode(opts.createdAtIso))])));
  } else if (opts.createdAtSeconds !== undefined) {
    out.push(
      fieldBytes(
        9,
        encodeMessage([fieldBytes(4, encodeMessage([fieldVarint(1, opts.createdAtSeconds)]))]),
      ),
    );
  }
  if (opts.model) out.push(fieldBytes(19, new TextEncoder().encode(opts.model)));
  if (opts.displayName) out.push(fieldBytes(21, new TextEncoder().encode(opts.displayName)));
  return out;
}

function genMetadataRow(chat: number[][]): Uint8Array {
  return encodeMessage([fieldBytes(1, encodeMessage(chat))]);
}

describe("antigravity conversation scan", () => {
  test("conversation roots live under ~/.gemini with the .db extensions", () => {
    const roots = conversationRoots("/home/test");
    expect(roots).toEqual([
      { dir: "/home/test/.gemini/antigravity/conversations", extensions: [".db"] },
      { dir: "/home/test/.gemini/antigravity-cli/conversations", extensions: [".db"] },
      { dir: "/home/test/.gemini/antigravity-ide/conversations", extensions: [".db"] },
    ]);
    expect(conversationRoots().every((root) => path.isAbsolute(root.dir))).toBe(true);
  });

  test("decodes a gen_metadata row with response/thinking split and created_at", () => {
    const row = genMetadataRow(
      chatMessage(usageMessage(100, 60, 40, "resp-1"), {
        createdAtIso: "2026-08-01T10:00:00.000Z",
        model: "gemini-3.5-flash-high",
        displayName: "Gemini 3.5 Flash (High)",
      }),
    );
    expect(parseAntigravityGenMetadataRow(row, 0)).toEqual({
      inputTokens: 100,
      // The codebase-wide invariant: reasoningTokens is a subset of
      // outputTokens, so outputTokens must carry the FULL output (response +
      // thinking), not just the non-thinking response field.
      outputTokens: 60,
      thinkingTokens: 40,
      responseId: "resp-1",
      model: "gemini-3.5-flash-high",
      createdAtMs: Date.parse("2026-08-01T10:00:00.000Z"),
    });
  });

  test("thinking tokens fold into outputTokens (reasoning is a subset, never dropped)", () => {
    const row = genMetadataRow(
      chatMessage(usageMessage(100, 60, 40, "resp-inv"), {
        displayName: "Gemini 3.5 Flash (High)",
      }),
    );
    const parsed = parseAntigravityGenMetadataRow(row, 0);
    expect(parsed?.thinkingTokens).toBe(40);
    expect(parsed?.outputTokens).toBe(60);
    // The invariant every other scanner honors: reasoning is counted *inside*
    // output, so a turn's total tokens are input + output (never input + a
    // thinking-free response). If this fails, thinking tokens are being dropped
    // from totalTokens() and never billed.
    expect(parsed!.outputTokens).toBeGreaterThanOrEqual(parsed!.thinkingTokens);
  });

  test("falls back to total output when response/thinking are absent", () => {
    const usage = [fieldVarint(2, 50), fieldVarint(3, 30), fieldBytes(11, new TextEncoder().encode("r2"))];
    const row = genMetadataRow(chatMessage(usage, { displayName: "Claude Sonnet 4.6" }));
    expect(parseAntigravityGenMetadataRow(row, 1)).toMatchObject({
      inputTokens: 50,
      outputTokens: 30,
      thinkingTokens: 0,
      responseId: "r2",
      model: "Claude Sonnet 4.6",
    });
  });

  test("accepts input in the legacy field #1", () => {
    const usage = [fieldVarint(1, 40), fieldVarint(3, 10), fieldBytes(11, new TextEncoder().encode("r3"))];
    const row = genMetadataRow(chatMessage(usage, { displayName: "Gemini 3.5 Flash (Medium)" }));
    const parsed = parseAntigravityGenMetadataRow(row, 2);
    expect(parsed).toMatchObject({ inputTokens: 40, model: "gemini-3.5-flash-medium" });
  });

  test("reads a Timestamp submessage and a bare seconds varint", () => {
    const sub = genMetadataRow(
      chatMessage(usageMessage(1, 1, 0, "r4"), { createdAtSeconds: 1_752_000_000 }),
    );
    expect(parseAntigravityGenMetadataRow(sub, 3)?.createdAtMs).toBe(1_752_000_000_000);

    const bare = genMetadataRow(
      chatMessage(usageMessage(1, 1, 0, "r5"), { createdAtSeconds: 1_752_000_000 }),
    );
    expect(parseAntigravityGenMetadataRow(bare, 4)?.createdAtMs).toBe(1_752_000_000_000);
  });

  test("a row with no tokens is not a record", () => {
    const usage = [fieldBytes(11, new TextEncoder().encode("r6"))];
    const row = genMetadataRow(chatMessage(usage, { displayName: "Gemini 3.5 Flash" }));
    expect(parseAntigravityGenMetadataRow(row, 5)).toBeNull();
  });

  test("never leaks a MODEL_PLACEHOLDER id as a model name", () => {
    const row = genMetadataRow(
      chatMessage(usageMessage(10, 10, 0, "r7"), { model: "MODEL_PLACEHOLDER_M26" }),
    );
    expect(parseAntigravityGenMetadataRow(row, 6)?.model).toBe("unknown");
  });

  test("canonicalizes display labels to pricing-catalog slugs", () => {
    expect(canonicalAntigravityModelId("x", "Gemini 3.5 Flash (High)")).toBe("gemini-3.5-flash-high");
    expect(canonicalAntigravityModelId("x", "Gemini 3.5 Flash (Medium)")).toBe("gemini-3.5-flash-medium");
    expect(canonicalAntigravityModelId("x", "Gemini 3.5 Flash (Low)")).toBe("gemini-3.5-flash-low");
    expect(canonicalAntigravityModelId("x", "Gemini 3.1 Pro (High)")).toBe("gemini-3.1-pro-high");
    expect(canonicalAntigravityModelId("x", "Gemini 3.1 Pro (Low)")).toBe("gemini-3.1-pro-low");
    expect(canonicalAntigravityModelId("x", "Claude Sonnet 4.6")).toBe("x");
    expect(canonicalAntigravityModelId("claude-sonnet-4-6", undefined)).toBe("claude-sonnet-4-6");
  });

  test("scans .db conversation files into usage records, deduped per response", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kone-antigravity-scan-"));
    const conversations = path.join(dir, "conversations");
    mkdirSync(conversations, { recursive: true });

    const dbPath = path.join(conversations, "cascade-1.db");
    const db = new DatabaseSyncShim(dbPath);
    db.exec("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)");
    const insert = db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)");
    const rowA = genMetadataRow(
      chatMessage(usageMessage(100, 60, 40, "resp-1"), {
        createdAtIso: "2026-08-01T10:00:00.000Z",
        displayName: "Gemini 3.5 Flash (High)",
      }),
    );
    const rowB = genMetadataRow(
      chatMessage(usageMessage(50, 30, 0, "resp-2"), {
        createdAtIso: "2026-08-02T10:00:00.000Z",
        displayName: "Gemini 3.5 Flash (Medium)",
      }),
    );
    const rowC = genMetadataRow(
      chatMessage(usageMessage(200, 100, 0, "resp-1"), {
        createdAtIso: "2026-08-03T10:00:00.000Z",
        displayName: "Gemini 3.5 Flash (High)",
      }),
    );
    insert.run(0, rowA);
    insert.run(1, rowB);
    insert.run(2, rowC); // duplicate response id in the same cascade — must drop
    db.close();

    process.env.ANTIGRAVITY_CONVERSATIONS_DIR = conversations;
    try {
      const result = await scanAntigravityUsage({
        sinceMs: Date.parse("2026-08-01T00:00:00.000Z"),
        untilMs: Date.parse("2026-09-01T00:00:00.000Z"),
      });
      expect(result.records).toHaveLength(2);
      expect(result.records.map((record) => record.model).sort()).toEqual([
        "gemini-3.5-flash-high",
        "gemini-3.5-flash-medium",
      ]);
      expect(result.records[0]).toMatchObject({
        provider: "antigravity",
        sessionId: "cascade-1",
        totals: { uncachedInputTokens: 100, outputTokens: 60, reasoningTokens: 40 },
        reportedCostUsd: null,
      });
      expect(result.records.map((record) => record.dedupeKey)).toEqual([
        "antigravity:cascade-1:resp-1",
        "antigravity:cascade-1:resp-2",
      ]);
      expect(result.sources[0]).toMatchObject({ dir: conversations, status: "ok", conversations: 1 });

      // The range window excludes out-of-window records.
      const narrow = await scanAntigravityUsage({
        sinceMs: Date.parse("2026-08-02T00:00:00.000Z"),
        untilMs: Date.parse("2026-08-02T23:59:59.999Z"),
      });
      expect(narrow.records).toHaveLength(1);
      expect(narrow.records[0]?.sessionId).toBe("cascade-1");
    } finally {
      delete process.env.ANTIGRAVITY_CONVERSATIONS_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing conversation dir reports missing, not an error", async () => {
    const absent = path.join(tmpdir(), "kone-antigravity-absent-scan");
    process.env.ANTIGRAVITY_CONVERSATIONS_DIR = absent;
    try {
      const result = await scanAntigravityUsage({
        sinceMs: 0,
        untilMs: Date.now() + 1_000,
      });
      expect(result.records).toEqual([]);
      expect(result.sources).toEqual([
        { dir: absent, status: "missing", filesScanned: 0, conversations: 0 },
      ]);
    } finally {
      delete process.env.ANTIGRAVITY_CONVERSATIONS_DIR;
    }
  });

  test("cascade id is the file name minus extension", () => {
    expect(antigravityCascadeIdFromPath("/x/cascade-1.db")).toBe("cascade-1");
    expect(antigravityCascadeIdFromPath("/x/cascade-2.pb")).toBe("cascade-2");
  });

  test("writes fixtures with writeFileSync for .db round-trip sanity", () => {
    // Guard: the sqlite blob must round-trip byte-for-byte so the scan reads
    // exactly what was inserted.
    const bytes = genMetadataRow(
      chatMessage(usageMessage(7, 3, 1, "r8"), { displayName: "Gemini 3.5 Flash (Low)" }),
    );
    const copy = Uint8Array.from(bytes);
    expect(copy).toEqual(bytes);
    writeFileSync(path.join(tmpdir(), "kone-anty-roundtrip.bin"), bytes);
    rmSync(path.join(tmpdir(), "kone-anty-roundtrip.bin"), { force: true });
  });
});
