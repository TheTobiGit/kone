import type { ConversationDb } from "./ConversationDb.js";
import type { ProfileStats } from "../types.js";
import type { UsageRange } from "../usage/report.js";
import { usageReportFromStore } from "../usage/storeUsage.js";
import { computeStreaks } from "../conversationStoreTypes.js";

export class StatsRepo {
  constructor(private readonly dbh: ConversationDb) {}

  /** Lifetime, fully-local usage stats for the profile board. Every figure is
   *  aggregated in SQL across *all* projects (no project filter) — a handful of
   *  grouped scans over the existing indexes, so it stays cheap even on a large
   *  store. Day/hour buckets use SQLite's `localtime` modifier so the heatmap
   *  and "most active hour" read in the user's own timezone. A "prompt" is one
   *  user block; only threads that carry at least one user prompt are counted,
   *  matching listThreads (archived threads are kept — they are still history). */
  profileStats(): ProfileStats {
    const empty: ProfileStats = {
      generatedAt: Date.now(),
      totals: { threads: 0, prompts: 0, tokens: 0, inputTokens: 0, outputTokens: 0, projects: 0 },
      streak: { current: 0, longest: 0, peakDay: null },
      activity: [],
      hours: [],
      mostActiveHour: null,
      providers: [],
      models: [],
      reasoning: [],
      projects: [],
    };
    const db = this.dbh.handle();
    if (!db) return empty;
    try {
      // Threads with a real user turn — the population every count below rides.
      const REAL = `SELECT thread_id, project_path, provider, model, model_selection_json
        FROM threads t WHERE EXISTS (
          SELECT 1 FROM blocks b WHERE b.thread_id = t.thread_id AND b.role = 'user'
        )`;

      // SAFETY: two aliased COUNT aggregates, exactly the names below.
      const totalsRow = db
        .prepare(
          `SELECT COUNT(*) AS threads, COUNT(DISTINCT project_path) AS projects
            FROM (${REAL})`,
        )
        .get() as { threads: number; projects: number };

      // SAFETY: COUNT(*) aliased to n, as everywhere in this file.
      const prompts = (
        db.prepare(`SELECT COUNT(*) AS n FROM blocks WHERE role = 'user'`).get() as { n: number }
      ).n;

      // Tokens: aggregated from the per-turn audit trail.
      // SAFETY: three COALESCE'd SUM aggregates under the aliases read below.
      const usage = db
        .prepare(
          `SELECT COALESCE(SUM(total_tokens), 0) AS total,
                  COALESCE(SUM(input_tokens), 0) AS input,
                  COALESCE(SUM(output_tokens), 0) AS output
            FROM turn_usage`,
        )
        .get() as { total: number; input: number; output: number };
      const totalTokens = usage.total;

      // Activity + hours by local calendar (user blocks carry the timestamp).
      // SAFETY: the GROUP BY returns exactly the aliased date/count pair.
      const activity = db
        .prepare(
          `SELECT strftime('%Y-%m-%d', at / 1000, 'unixepoch', 'localtime') AS date,
                  COUNT(*) AS count
            FROM blocks WHERE role = 'user'
            GROUP BY date ORDER BY date ASC`,
        )
        .all() as Array<{ date: string; count: number }>;

      // SAFETY: same shape — an aliased hour/count pair per bucket.
      const hours = db
        .prepare(
          `SELECT CAST(strftime('%H', at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
                  COUNT(*) AS count
            FROM blocks WHERE role = 'user'
            GROUP BY hour ORDER BY count DESC`,
        )
        .all() as Array<{ hour: number; count: number }>;

      // SAFETY: GROUP BY returns exactly the aliased provider/count pair
      // ProfileStats["providers"] is declared from.
      const providers = db
        .prepare(
          `SELECT provider, COUNT(*) AS count FROM (${REAL})
            GROUP BY provider ORDER BY count DESC`,
        )
        .all() as ProfileStats["providers"];

      // SAFETY: same — model/provider/count is ProfileStats["models"]'s shape.
      const models = db
        .prepare(
          `SELECT model, provider, COUNT(*) AS count FROM (${REAL})
            WHERE model IS NOT NULL AND model <> ''
            GROUP BY model, provider ORDER BY count DESC`,
        )
        .all() as ProfileStats["models"];

      // SAFETY: same — effort/count is ProfileStats["reasoning"]'s shape.
      const reasoning = db
        .prepare(
          `SELECT json_extract(model_selection_json, '$.effort') AS effort, COUNT(*) AS count
           FROM (${REAL})
           WHERE effort IS NOT NULL AND effort <> ''
           GROUP BY effort ORDER BY count DESC`,
        )
        .all() as ProfileStats["reasoning"];

      // SAFETY: an aliased path/prompts pair per project group.
      const projectRows = db
        .prepare(
          `SELECT t.project_path AS path, COUNT(*) AS prompts
            FROM blocks b JOIN threads t ON t.thread_id = b.thread_id
            WHERE b.role = 'user'
            GROUP BY t.project_path ORDER BY prompts DESC LIMIT 8`,
        )
        .all() as Array<{ path: string; prompts: number }>;
      const projects = projectRows.map((r) => ({
        path: r.path,
        name: r.path.split("/").filter(Boolean).pop() ?? r.path,
        prompts: r.prompts,
      }));

      // Streaks + peak day, walked over the ascending activity dates.
      const peakDay =
        activity.length > 0
          ? activity.reduce((a, b) => (b.count > a.count ? b : a))
          : null;
      const { current, longest } = computeStreaks(activity.map((a) => a.date));

      return {
        generatedAt: Date.now(),
        totals: {
          threads: totalsRow.threads,
          prompts,
          tokens: totalTokens,
          inputTokens: usage.input,
          outputTokens: usage.output,
          projects: totalsRow.projects,
        },
        streak: {
          current,
          longest,
          peakDay: peakDay ? { date: peakDay.date, count: peakDay.count } : null,
        },
        activity,
        hours,
        mostActiveHour: hours.length > 0 ? hours[0]!.hour : null,
        providers,
        models,
        reasoning,
        projects,
      };
    } catch (err) {
      console.error("[conversation-store] profileStats failed:", err);
      return empty;
    }
  }

  /** Store-backed usage rows — supplement for providers without CLI transcript
   *  scanning. Called from buildAgentUsageReport, not the IPC surface directly. */
  readStoreUsageReport(options: {
    range: UsageRange;
    projectPath?: string | null;
    excludeProviders?: string[];
    onlyProviders?: readonly string[];
  }) {
    return usageReportFromStore(this.dbh.handle(), options);
  }
}
