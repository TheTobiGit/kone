import fs from "node:fs";
import path from "node:path";

import { app } from "electron";

import type { ModelDescriptor, ProviderKind, ProviderStatus } from "./types.js";

// A disk-backed snapshot of the last known provider surface: which CLIs were
// installed + logged in, and each one's model catalog.
//
// Why this exists: discovery and `model/list` both shell out to real CLIs
// (`codex app-server` spawns a process, handshakes, answers, exits). Holding
// that only in memory meant every cold launch had to re-pay it before the
// renderer knew a single model id — so the picker showed a provider surface
// that wasn't actually usable yet, and the first send waited on a probe.
//
// The snapshot is a *cache*, never the source of truth: a live probe always
// overwrites it, and a stale entry can only ever cost us one turn on a model
// the CLI has since dropped (the adapters degrade to their own default).
// Written with the same plain best-effort file I/O as providerSettings.ts.

const VERSION = 1;

export interface ProviderCacheSnapshot {
  version: number;
  /** ms epoch of the last write — lets a reader decide how much to trust it. */
  savedAt: number;
  statuses: ProviderStatus[];
  models: Partial<Record<ProviderKind, ModelDescriptor[]>>;
}

function emptySnapshot(): ProviderCacheSnapshot {
  return { version: VERSION, savedAt: 0, statuses: [], models: {} };
}

let cachedPath: string | null = null;
function cacheFilePath(): string {
  cachedPath ??= path.join(app.getPath("userData"), "provider-cache.json");
  return cachedPath;
}

/** Keep only well-shaped entries so a hand-edited or version-skewed file can
 *  never feed junk ids into an adapter or the renderer's picker. */
function sanitize(raw: unknown): ProviderCacheSnapshot {
  const out = emptySnapshot();
  if (!raw || typeof raw !== "object") return out;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== VERSION) return out;
  if (typeof obj.savedAt === "number") out.savedAt = obj.savedAt;
  if (Array.isArray(obj.statuses)) {
    out.statuses = obj.statuses.filter(
      (s): s is ProviderStatus =>
        Boolean(s) && typeof s === "object" && typeof (s as ProviderStatus).provider === "string",
    );
  }
  const models = obj.models;
  if (models && typeof models === "object") {
    for (const [provider, list] of Object.entries(models as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const clean = list.filter(
        (m): m is ModelDescriptor =>
          Boolean(m) && typeof m === "object" && typeof (m as ModelDescriptor).id === "string",
      );
      if (clean.length) out.models[provider as ProviderKind] = clean;
    }
  }
  return out;
}

let cache: ProviderCacheSnapshot | null = null;

/** The last persisted snapshot, read from disk once and held in memory. A
 *  missing or unreadable file is a clean empty snapshot — callers then behave
 *  exactly as they did before this cache existed (probe on demand). */
export function readProviderCache(): ProviderCacheSnapshot {
  if (cache) return cache;
  try {
    cache = sanitize(JSON.parse(fs.readFileSync(cacheFilePath(), "utf8")));
  } catch {
    cache = emptySnapshot();
  }
  return cache;
}

function persist(next: ProviderCacheSnapshot): ProviderCacheSnapshot {
  cache = next;
  try {
    fs.writeFileSync(cacheFilePath(), JSON.stringify(next), "utf8");
  } catch {
    // Best-effort: an I/O failure keeps the in-memory snapshot authoritative
    // for this session rather than crashing the app over a cache write.
  }
  return next;
}

/** Record a fresh discovery result. */
export function cacheStatuses(statuses: ProviderStatus[]): void {
  const current = readProviderCache();
  persist({ ...current, savedAt: Date.now(), statuses });
}

/** Record a fresh model catalog. An empty list is ignored — it means the probe
 *  failed or the CLI wasn't reachable, and dropping a known-good catalog on a
 *  transient failure is strictly worse than serving the slightly stale one. */
export function cacheModels(provider: ProviderKind, models: ModelDescriptor[]): void {
  if (!models.length) return;
  const current = readProviderCache();
  persist({
    ...current,
    savedAt: Date.now(),
    models: { ...current.models, [provider]: models },
  });
}
