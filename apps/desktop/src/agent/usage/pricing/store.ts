// Owns the two catalogs' lifecycle: bundled snapshot for first launch and
// offline use, an on-disk cache refreshed from the live feeds at most once
// ModelPricingStore.swift, minus the parts that don't apply to kone (there's
// no gh-pages supplement to also refresh — see supplement.ts).
//
// The one rule everything else here serves: `currentPricingSnapshot()` never
// blocks on the network. It loads the bundled+cached data synchronously
// (plain disk I/O, same as providerCache.ts) and returns immediately; a
// refresh that's due gets kicked off in the background and simply updates
// what the *next* call sees. A price lookup mid-refresh always answers from
// whatever was already loaded, never waits, and never throws for a network
// problem — a failed fetch just means the existing data (cache or bundled)
// keeps serving until the next attempt.

import fs from "node:fs";
import { writeFileAtomicSync } from "../../../atomicWrite.js";

import litellmSnapshot from "./snapshots/litellm.snapshot.json" with { type: "json" };
import modelsDevSnapshot from "./snapshots/models-dev.snapshot.json" with { type: "json" };
import { decodeCompact, encodeCompact, parseCompactJson, type CompactFile } from "./compact.js";
import { parseLiteLLM } from "./litellmCodec.js";
import { parseModelsDev } from "./modelsDevCodec.js";
import { mergeTables } from "./catalog.js";
import type { PricingSnapshot } from "./resolver.js";
import type { PricingTable } from "./types.js";
import { userDataPath } from "../../userDataDir.js";

type SourceId = "litellm" | "modelsDev";

const SOURCE_URLS: Record<SourceId, string> = {
  litellm: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
  modelsDev: "https://models.dev/api.json",
};

const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
/** Don't hammer a source that just failed — retry sooner than the normal
 *  hourly cadence, but not on every single pricing lookup in between. */
const FAILURE_RETRY_INTERVAL_MS = 30 * 60 * 1000;

interface SourceState {
  etag?: string;
  fetchedAtMs?: number;
  failedAtMs?: number;
}

export interface StoreDeps {
  fetch: typeof fetch;
  now: () => number;
}

const defaultDeps: StoreDeps = { fetch: (...args) => globalThis.fetch(...args), now: () => Date.now() };

// `userDataPath` throws when the host never called `setUserDataDir` — correct
// for code that genuinely needs to persist, but wrong here. Pricing's whole
// contract is that it degrades instead of failing, and the bundled snapshot is
// a complete answer on its own; the disk cache only ever makes it fresher. So a
// missing userData dir means "no cache this run", not "no pricing" — which also
// keeps the engine usable from a plain script or test with no Electron around.
function cacheFile(source: SourceId): string | undefined {
  try {
    return userDataPath("pricing", `${source === "litellm" ? "litellm" : "models-dev"}-cache.json`);
  } catch {
    return undefined;
  }
}

function stateFile(): string | undefined {
  try {
    return userDataPath("pricing", "state.json");
  } catch {
    return undefined;
  }
}

function readJsonFile<T>(path: string | undefined): T | undefined {
  if (path === undefined) return undefined;
  try {
    return JSON.parse(fs.readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJsonFile(path: string | undefined, data: unknown): void {
  if (path === undefined) return;
  try {
    writeFileAtomicSync(path, JSON.stringify(data));
  } catch {
    // Best-effort: a disk-write failure keeps the in-memory snapshot
    // authoritative for this session rather than crashing pricing over it.
  }
}

let loaded = false;
let snapshot: PricingSnapshot = { primary: { entries: {} }, secondary: { entries: {} } };
let sourceStates: Record<SourceId, SourceState> = { litellm: {}, modelsDev: {} };
let refreshInFlight: Promise<void> | null = null;

function loadTable(source: SourceId): PricingTable {
  const bundled = decodeCompact((source === "litellm" ? litellmSnapshot : modelsDevSnapshot) as CompactFile);
  let table = bundled;
  const cached = readJsonFile<string>(cacheFile(source));
  if (cached !== undefined) {
    try {
      table = mergeTables(bundled, parseCompactJson(typeof cached === "string" ? cached : JSON.stringify(cached)));
    } catch {
      // Corrupt cache file — keep serving the bundled snapshot.
    }
  }
  return table;
}

function rebuildSnapshot(): void {
  snapshot = { primary: loadTable("litellm"), secondary: loadTable("modelsDev") };
}

function loadIfNeeded(): void {
  if (loaded) return;
  loaded = true;
  sourceStates = readJsonFile<Record<SourceId, SourceState>>(stateFile()) ?? { litellm: {}, modelsDev: {} };
  rebuildSnapshot();
}

function isDue(source: SourceId, deps: StoreDeps): boolean {
  const state = sourceStates[source];
  if (state.failedAtMs !== undefined && deps.now() - state.failedAtMs < FAILURE_RETRY_INTERVAL_MS) return false;
  if (state.fetchedAtMs === undefined) return true;
  return deps.now() - state.fetchedAtMs >= REFRESH_INTERVAL_MS;
}

/** The pricing snapshot to price against right now. Synchronous and
 *  side-effect-light by design (see file header) — safe to call on every
 *  usage report without any caller having to think about caching. */
export function currentPricingSnapshot(deps: Partial<StoreDeps> = {}): PricingSnapshot {
  loadIfNeeded();
  const resolvedDeps = { ...defaultDeps, ...deps };
  if (!refreshInFlight && (isDue("litellm", resolvedDeps) || isDue("modelsDev", resolvedDeps))) {
    refreshInFlight = refreshDueSources(resolvedDeps).finally(() => {
      refreshInFlight = null;
    });
  }
  return snapshot;
}

/** Runs any due refreshes to completion and returns the resulting snapshot —
 *  for tests and any deterministic offline-tooling use, where "kick a
 *  background task and don't wait" isn't what's wanted. */
export async function refreshPricingNow(deps: Partial<StoreDeps> = {}): Promise<PricingSnapshot> {
  loadIfNeeded();
  const resolvedDeps = { ...defaultDeps, ...deps };
  if (!refreshInFlight) {
    refreshInFlight = refreshDueSources(resolvedDeps, /* force */ true).finally(() => {
      refreshInFlight = null;
    });
  }
  await refreshInFlight;
  return snapshot;
}

async function refreshDueSources(deps: StoreDeps, force = false): Promise<void> {
  let changed = false;
  for (const source of ["litellm", "modelsDev"] as const) {
    if (!force && !isDue(source, deps)) continue;
    if (await fetchSource(source, deps)) changed = true;
  }
  if (changed) rebuildSnapshot();
  writeJsonFile(stateFile(), sourceStates);
}

/** Fetches one source with If-None-Match revalidation and updates its cache
 *  file on a real change. Never throws — a network failure, a non-200/304
 *  status, or a feed that fails to parse all fall into the same "keep the
 *  cached data, remember we failed, try again later" path, because a
 *  refresh gone wrong must never be worse than not refreshing at all. */
async function fetchSource(source: SourceId, deps: StoreDeps): Promise<boolean> {
  const state = sourceStates[source];
  const headers: Record<string, string> = {};
  if (state.etag) headers["If-None-Match"] = state.etag;
  try {
    const response = await deps.fetch(SOURCE_URLS[source], { headers });
    if (response.status === 304) {
      sourceStates[source] = { ...state, fetchedAtMs: deps.now(), failedAtMs: undefined };
      return false;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const table = source === "litellm" ? parseLiteLLM(body, todayIso(deps)) : parseModelsDev(body, todayIso(deps));
    const compact = encodeCompact(table, SOURCE_URLS[source]);
    writeJsonFile(cacheFile(source), JSON.stringify(compact));
    sourceStates[source] = {
      etag: response.headers.get("etag") ?? undefined,
      fetchedAtMs: deps.now(),
      failedAtMs: undefined,
    };
    return true;
  } catch (error) {
    sourceStates[source] = { ...state, failedAtMs: deps.now() };
    console.warn(`[pricing] ${source} refresh failed, keeping cached data:`, error);
    return false;
  }
}

function todayIso(deps: StoreDeps): string {
  return new Date(deps.now()).toISOString().slice(0, 10);
}
