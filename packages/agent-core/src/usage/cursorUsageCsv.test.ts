import { describe, expect, test } from "bun:test";
import { parseCursorUsageCsv } from "./cursorUsageCsv.js";

describe("parseCursorUsageCsv", () => {
  test("maps columns and prices known models", () => {
    const csv = `
Date,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Cost
2026-01-01T00:00:00Z,composer-1,No,0,1000,500,2000,Included
,skipped-no-date,No,0,0,0,0,Included
`.trim();

    const parsed = parseCursorUsageCsv(csv);
    expect(parsed.rows.length).toBe(1);
    expect(parsed.rejectedRowCount).toBe(1);
    expect(parsed.rows[0].model).toBe("composer-1");
    expect(parsed.rows[0].totals.uncachedInputTokens).toBe(1000);
    expect(parsed.rows[0].totals.cachedInputTokens).toBe(500);
    expect(parsed.rows[0].totals.outputTokens).toBe(2000);
    expect(parsed.rows[0].priced).toBe(true);
    expect(parsed.rows[0].costUsd).toBeGreaterThan(0);
  });

  test("rejects malformed header", () => {
    const parsed = parseCursorUsageCsv("Date,Model\n2026-01-01T00:00:00Z,foo");
    expect(parsed.rows).toEqual([]);
    expect(parsed.rejectedRowCount).toBe(1);
  });
});
