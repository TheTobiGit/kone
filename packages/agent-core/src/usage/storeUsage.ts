// SQLite slice of the usage report — providers kone recorded in turn_usage
// (OpenCode, Cursor, Droid, and project-scoped rows). Claude/Codex overall
// usage is merged from CLI transcript scanning in buildUsageReport.ts.

import type { DatabaseSync } from "../sqlite.js";

import { priceModel, currentPricingSnapshot } from "./pricing/index.js";
import { rangeStart, type UsageRange } from "./report.js";

export type StoreUsageRow = {
  model: string;
  provider: string;
  project_path: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  reasoning_tokens: number;
  turns: number;
  cost_usd: number;
};

export type StoreUsageDayRow = {
  date: string;
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
};

export type StoreUsageReport = {
  promptsRow: { prompts: number; threads: number };
  usageRows: StoreUsageRow[];
  usageByDayRows: StoreUsageDayRow[];
  promptsByDayRows: Array<{ date: string; prompts: number }>;
};

const EMPTY: StoreUsageReport = {
  promptsRow: { prompts: 0, threads: 0 },
  usageRows: [],
  usageByDayRows: [],
  promptsByDayRows: [],
};

function rowCost(
  model: string,
  input_tokens: number,
  output_tokens: number,
  cache_read_tokens: number,
  cache_creation_tokens: number,
): number {
  const outcome = priceModel(currentPricingSnapshot(), model, {
    input: input_tokens,
    output: output_tokens,
    cacheRead: cache_read_tokens,
    cacheWrite: cache_creation_tokens,
  });
  return outcome.priced ? outcome.dollars : 0;
}

export function usageReportFromStore(
  db: DatabaseSync | null,
  options: {
    range: UsageRange;
    projectPath?: string | null;
    excludeProviders?: string[];
    onlyProviders?: readonly string[];
  },
): StoreUsageReport {
  if (!db) return EMPTY;
  const { range } = options;
  const projectPath = options.projectPath ?? null;
  const exclude = options.excludeProviders ?? [];
  const only = options.onlyProviders;

  try {
    const startMs = rangeStart(range);
    const projectArgs: string[] = projectPath ? [projectPath] : [];
    const projectFilterT = projectPath ? `AND t.project_path = ?` : "";

    let providerFilter = "";
    const providerArgs: string[] = [];
    if (exclude.length > 0) {
      providerFilter += ` AND t.provider NOT IN (${exclude.map(() => "?").join(",")})`;
      providerArgs.push(...exclude);
    }
    if (only && only.length > 0) {
      providerFilter += ` AND t.provider IN (${only.map(() => "?").join(",")})`;
      providerArgs.push(...only);
    }

    const promptsArgs = [...projectArgs, ...providerArgs, ...(startMs !== null ? [startMs] : [])];
    // SAFETY: the SELECT aliases its two columns to exactly these names,
    // and COUNT(*) never returns null.
    const promptsRow = db
      .prepare(
        `SELECT COUNT(*) AS prompts, COUNT(DISTINCT b.thread_id) AS threads
         FROM blocks b JOIN threads t ON t.thread_id = b.thread_id
         WHERE b.role = 'user' ${projectFilterT} ${providerFilter}
         ${startMs !== null ? "AND b.at >= ?" : ""}`,
      )
      .get(...promptsArgs) as { prompts: number; threads: number };

    const usageArgs = [...projectArgs, ...providerArgs, ...(startMs !== null ? [startMs] : [])];
    // SAFETY: every selected column is aliased to the matching field of this
    // row type; SUM/COUNT are non-null and COALESCEd to 0.
    const rawUsageRows = db
      .prepare(
        `SELECT COALESCE(t.model, '') AS model, t.provider AS provider, t.project_path AS project_path,
                COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
                COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
                COALESCE(SUM(u.total_tokens), 0) AS total_tokens,
                COALESCE(SUM(u.cache_read_tokens), 0) AS cache_read_tokens,
                COALESCE(SUM(u.cache_creation_tokens), 0) AS cache_creation_tokens,
                COALESCE(SUM(u.reasoning_tokens), 0) AS reasoning_tokens,
                COUNT(*) AS turns
         FROM turn_usage u JOIN threads t ON t.thread_id = u.thread_id
         WHERE 1 = 1 ${projectFilterT} ${providerFilter}
         ${startMs !== null ? "AND u.at >= ?" : ""}
         GROUP BY t.model, t.provider, t.project_path`,
      )
      .all(...usageArgs) as Array<Omit<StoreUsageRow, "cost_usd">>;

    const usageRows: StoreUsageRow[] = rawUsageRows.map((row) => ({
      ...row,
      cost_usd: rowCost(
        row.model,
        row.input_tokens,
        row.output_tokens,
        row.cache_read_tokens,
        row.cache_creation_tokens,
      ),
    }));

    // SAFETY: every selected column is aliased to the matching field of this
    // row type; strftime yields the date string, SUM is COALESCEd to 0.
    const rawDayRows = db
      .prepare(
        `SELECT strftime('%Y-%m-%d', u.at / 1000, 'unixepoch', 'localtime') AS date,
                COALESCE(t.model, '') AS model,
                t.provider AS provider,
                COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
                COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
                COALESCE(SUM(u.total_tokens), 0) AS total_tokens,
                COALESCE(SUM(u.cache_read_tokens), 0) AS cache_read_tokens,
                COALESCE(SUM(u.cache_creation_tokens), 0) AS cache_creation_tokens,
                COALESCE(SUM(u.reasoning_tokens), 0) AS reasoning_tokens
         FROM turn_usage u JOIN threads t ON t.thread_id = u.thread_id
         WHERE 1 = 1 ${projectFilterT} ${providerFilter}
         ${startMs !== null ? "AND u.at >= ?" : ""}
         GROUP BY date, t.model, t.provider`,
      )
      .all(...usageArgs) as Array<Omit<StoreUsageDayRow, "cost_usd">>;

    const usageByDayRows: StoreUsageDayRow[] = rawDayRows.map((row) => ({
      ...row,
      cost_usd: rowCost(
        row.model,
        row.input_tokens,
        row.output_tokens,
        row.cache_read_tokens,
        row.cache_creation_tokens,
      ),
    }));

    // SAFETY: the SELECT aliases its two columns to exactly these names;
    // strftime yields the date string and COUNT(*) is non-null.
    const promptsByDayRows = db
      .prepare(
        `SELECT strftime('%Y-%m-%d', b.at / 1000, 'unixepoch', 'localtime') AS date,
                COUNT(*) AS prompts
         FROM blocks b JOIN threads t ON t.thread_id = b.thread_id
         WHERE b.role = 'user' ${projectFilterT} ${providerFilter}
         ${startMs !== null ? "AND b.at >= ?" : ""}
         GROUP BY date`,
      )
      .all(...promptsArgs) as Array<{ date: string; prompts: number }>;

    return { promptsRow, usageRows, usageByDayRows, promptsByDayRows };
  } catch (err) {
    console.error("[usage] store report failed:", err);
    return EMPTY;
  }
}
