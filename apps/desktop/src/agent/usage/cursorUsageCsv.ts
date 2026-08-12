// CursorUsageCSV.swift). Rows are daily aggregates priced through kone's model
// table — not Cursor's "Included" cost column.

import { priceModel, currentPricingSnapshot } from "./pricing/index.js";
import type { UsageTokenTotals } from "./transcripts/types.js";

const REQUIRED_COLUMNS = [
  "Date",
  "Model",
  "Input (w/ Cache Write)",
  "Input (w/o Cache Write)",
  "Cache Read",
  "Output Tokens",
] as const;

export type CursorCsvRow = {
  timestampMs: number;
  model: string;
  totals: UsageTokenTotals;
  costUsd: number;
  priced: boolean;
};

export type CursorCsvParseResult = {
  rows: CursorCsvRow[];
  rejectedRowCount: number;
};

function parseIntCell(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const normalized = raw.trim();
  if (!normalized) return 0;
  const groups = normalized.split(",");
  if (groups.length > 1) {
    const first = groups[0];
    if (!first || first.length < 1 || first.length > 3 || !/^\d+$/.test(first)) return null;
    for (const g of groups.slice(1)) {
      if (g.length !== 3 || !/^\d+$/.test(g)) return null;
    }
    const joined = groups.join("");
    const n = Number(joined);
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
  }
  if (!/^\d+$/.test(normalized)) return null;
  const n = Number(normalized);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

function parseDateMs(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Minimal RFC-style CSV row splitter (handles quoted fields). */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

function priceRow(model: string, totals: UsageTokenTotals): { costUsd: number; priced: boolean } {
  const outcome = priceModel(currentPricingSnapshot(), model, {
    input: totals.uncachedInputTokens,
    output: totals.outputTokens,
    cacheRead: totals.cachedInputTokens,
    cacheWrite: totals.cacheCreationTokens,
  });
  if (!outcome.priced) return { costUsd: 0, priced: false };
  return { costUsd: outcome.dollars, priced: true };
}

export function parseCursorUsageCsv(csv: string): CursorCsvParseResult {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return { rows: [], rejectedRowCount: 0 };
  }

  const headerLine = lines[0];
  if (!headerLine) {
    return { rows: [], rejectedRowCount: 0 };
  }

  const headerCells = splitCsvLine(headerLine).map((c) => c.trim());
  const headerSet = new Set(headerCells);
  const missing = REQUIRED_COLUMNS.filter((col) => !headerSet.has(col));
  if (missing.length > 0 || headerSet.size !== headerCells.length) {
    return { rows: [], rejectedRowCount: lines.length - 1 };
  }

  const indexOf = (name: string) => headerCells.indexOf(name);
  const dateIdx = indexOf("Date");
  const modelIdx = indexOf("Model");
  const cacheWriteIdx = indexOf("Input (w/ Cache Write)");
  const inputIdx = indexOf("Input (w/o Cache Write)");
  const cacheReadIdx = indexOf("Cache Read");
  const outputIdx = indexOf("Output Tokens");

  const rows: CursorCsvRow[] = [];
  let rejectedRowCount = 0;

  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const get = (idx: number) => cells[idx];

    const dateStr = get(dateIdx)?.trim();
    const model = get(modelIdx)?.trim();
    const cacheWrite = parseIntCell(get(cacheWriteIdx));
    const input = parseIntCell(get(inputIdx));
    const cacheRead = parseIntCell(get(cacheReadIdx));
    const output = parseIntCell(get(outputIdx));

    if (
      !dateStr ||
      !model ||
      cacheWrite === null ||
      input === null ||
      cacheRead === null ||
      output === null
    ) {
      rejectedRowCount += 1;
      continue;
    }

    const timestampMs = parseDateMs(dateStr);
    if (timestampMs === null) {
      rejectedRowCount += 1;
      continue;
    }

    const totals: UsageTokenTotals = {
      uncachedInputTokens: input,
      cachedInputTokens: cacheRead,
      cacheCreationTokens: cacheWrite,
      outputTokens: output,
      reasoningTokens: 0,
    };

    const { costUsd, priced } = priceRow(model, totals);
    rows.push({ timestampMs, model, totals, costUsd, priced });
  }

  return { rows, rejectedRowCount };
}
