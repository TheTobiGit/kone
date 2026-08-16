import { describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";

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
mock.module("node:sqlite", () => ({ DatabaseSync: DatabaseSyncShim }));

// The modules under test must load AFTER the mock is registered — a static
// import would hoist above it and pull the real node:sqlite.
const { parseAntigravityGenMetadataRow } = await import("./antigravityScan.js");
const { totalTokens } = await import("../transcripts/transcripts.js");

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

describe("antigravity token invariant", () => {
  test("thinking tokens are folded into outputTokens so totalTokens keeps them", () => {
    const row = genMetadataRow(
      chatMessage(usageMessage(100, 60, 40, "inv-1"), {
        displayName: "Gemini 3.5 Flash (High)",
      }),
    );
    const parsed = parseAntigravityGenMetadataRow(row, 0);
    expect(parsed?.inputTokens).toBe(100);
    expect(parsed?.outputTokens).toBe(60);
    expect(parsed?.thinkingTokens).toBe(40);
    // The codebase-wide invariant: reasoningTokens is a subset of outputTokens
    // and must not be added again, so the parsed output must already carry the
    // thinking tokens folded in.
    expect(parsed!.outputTokens).toBeGreaterThanOrEqual(parsed!.thinkingTokens);
    expect(
      totalTokens({
        uncachedInputTokens: 100,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: parsed!.outputTokens,
        reasoningTokens: parsed!.thinkingTokens,
      }),
    ).toBe(160);
  });

  test("a pure-response row (no thinking) is unchanged", () => {
    const row = genMetadataRow(
      chatMessage(usageMessage(50, 30, 0, "inv-2"), {
        displayName: "Claude Sonnet 4.6",
      }),
    );
    const parsed = parseAntigravityGenMetadataRow(row, 1);
    expect(parsed?.outputTokens).toBe(30);
    expect(parsed?.thinkingTokens).toBe(0);
  });
});
