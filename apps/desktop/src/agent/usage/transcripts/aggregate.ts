// Folds parsed transcript records into (day, provider, model) buckets — same
// three-layer engine (cache-aware) instead of LiteLLM-only.

import { priceModel, currentPricingSnapshot } from "../pricing/index.js";
import { addTotals, EMPTY_TOTALS, totalTokens, type UsageRecord } from "./transcripts.js";
import type { TranscriptProviderKind } from "./types.js";

export function makeDayFormatter(timeZone: string): (timestampMs: number) => string {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  return (timestampMs) => format.format(new Date(timestampMs));
}

export type TranscriptBucket = {
  day: string;
  provider: TranscriptProviderKind;
  model: string;
  totals: typeof EMPTY_TOTALS;
  costUsd: number;
  records: number;
  sessions: number;
  unpricedRecords: number;
  providerReportedRecords: number;
};

interface MutableBucket {
  totals: typeof EMPTY_TOTALS;
  costUsd: number;
  records: number;
  unpricedRecords: number;
  providerReportedRecords: number;
  sessions: Set<string>;
}

export interface TranscriptAggregateOptions {
  timeZone: string;
  sinceDay: string;
  untilDay: string;
}

export class TranscriptAggregator {
  readonly #buckets = new Map<string, MutableBucket>();
  readonly #seen = new Set<string>();
  readonly #toDay: (timestampMs: number) => string;
  readonly #options: TranscriptAggregateOptions;
  #duplicatesDropped = 0;
  #outOfWindow = 0;

  constructor(options: TranscriptAggregateOptions) {
    this.#options = options;
    this.#toDay = makeDayFormatter(options.timeZone);
  }

  add(record: UsageRecord): boolean {
    if (record.dedupeKey !== null) {
      if (this.#seen.has(record.dedupeKey)) {
        this.#duplicatesDropped += 1;
        return false;
      }
      this.#seen.add(record.dedupeKey);
    }

    const day = this.#toDay(record.timestampMs);
    if (day < this.#options.sinceDay || day > this.#options.untilDay) {
      this.#outOfWindow += 1;
      return false;
    }

    const key = `${day}\0${record.provider}\0${record.model}`;
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        totals: EMPTY_TOTALS,
        costUsd: 0,
        records: 0,
        unpricedRecords: 0,
        providerReportedRecords: 0,
        sessions: new Set<string>(),
      };
      this.#buckets.set(key, bucket);
    }

    const priced = priceTranscriptRecord(record);
    bucket.totals = addTotals(bucket.totals, record.totals);
    bucket.costUsd += priced.costUsd;
    bucket.records += 1;
    if (!priced.priced) bucket.unpricedRecords += 1;
    if (priced.providerReported) bucket.providerReportedRecords += 1;
    if (record.sessionId.length > 0) bucket.sessions.add(record.sessionId);
    return true;
  }

  finish(): { buckets: TranscriptBucket[]; duplicatesDropped: number; outOfWindow: number } {
    const buckets: TranscriptBucket[] = [];
    for (const [key, bucket] of this.#buckets) {
      const [day = "", provider = "", model = ""] = key.split("\0");
      buckets.push({
        day,
        provider: provider as TranscriptProviderKind,
        model,
        totals: bucket.totals,
        costUsd: bucket.costUsd,
        records: bucket.records,
        sessions: bucket.sessions.size,
        unpricedRecords: bucket.unpricedRecords,
        providerReportedRecords: bucket.providerReportedRecords,
      });
    }
    buckets.sort(
      (a, b) =>
        a.day.localeCompare(b.day) ||
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model),
    );
    return {
      buckets,
      duplicatesDropped: this.#duplicatesDropped,
      outOfWindow: this.#outOfWindow,
    };
  }
}

function priceTranscriptRecord(record: UsageRecord): {
  costUsd: number;
  priced: boolean;
  providerReported: boolean;
} {
  if (record.reportedCostUsd !== null && Number.isFinite(record.reportedCostUsd)) {
    return { costUsd: record.reportedCostUsd, priced: true, providerReported: true };
  }
  const snapshot = currentPricingSnapshot();
  const outcome = priceModel(snapshot, record.model, {
    input: record.totals.uncachedInputTokens,
    output: record.totals.outputTokens,
    cacheRead: record.totals.cachedInputTokens,
    cacheWrite: record.totals.cacheCreationTokens,
  });
  if (!outcome.priced) return { costUsd: 0, priced: false, providerReported: false };
  return { costUsd: outcome.dollars, priced: true, providerReported: false };
}

export function bucketTotalTokens(totals: typeof EMPTY_TOTALS): number {
  return totalTokens(totals);
}

export function bucketInputTokens(totals: typeof EMPTY_TOTALS): number {
  return (
    totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheCreationTokens
  );
}
