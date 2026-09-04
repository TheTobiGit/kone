import fs from "node:fs";
import { writeFileAtomicSync } from "@kone/agent-core/lib-atomicWrite.js";

import type {
  AuthStatus,
  ModelDescriptor,
  ProviderKind,
  ProviderReadiness,
  ProviderStatus,
} from "./types.js";
import { userDataPath } from "./userDataDir.js";

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

import { z } from "zod";

import type { JsonValue } from "@kone/agent-core/lib-jsonValue.js";

const VERSION = 1;

export interface ProviderSurfaceSnapshot {
  version: number;
  /** ms epoch of the last write — lets a reader decide how much to trust it. */
  savedAt: number;
  statuses: ProviderStatus[];
  models: Partial<Record<ProviderKind, ModelDescriptor[]>>;
}

function emptySnapshot(): ProviderSurfaceSnapshot {
  return { version: VERSION, savedAt: 0, statuses: [], models: {} };
}

const ModelDescriptorWire = z.object({
  id: z.string(),
  label: z.string().optional(),
  description: z.string().optional(),
  contextWindow: z.number().optional(),
  maxOutputTokens: z.number().optional(),
  isDefault: z.boolean().optional(),
}).passthrough();

// Spelling these unions out a second time in wire form is what let them drift:
// the enum below once listed a `readiness` set that shared only two members with
// the real one, so every row for a provider awaiting login failed validation —
// and since one bad element rejects the whole array, a single logged-out CLI
// discarded the entire snapshot on every launch. Each map is keyed by its union
// and `satisfies` its own value type, so adding or renaming a member breaks this
// file at compile time instead of silently emptying the cache.
const PROVIDERS = {
  codex: "codex",
  claudeAgent: "claudeAgent",
  opencode: "opencode",
  cursor: "cursor",
  droid: "droid",
  antigravity: "antigravity",
} as const satisfies Record<ProviderKind, ProviderKind>;

const AUTH_STATUSES = {
  authenticated: "authenticated",
  unauthenticated: "unauthenticated",
  unknown: "unknown",
} as const satisfies Record<AuthStatus, AuthStatus>;

const READINESS = {
  ready: "ready",
  "needs-login": "needs-login",
  "not-installed": "not-installed",
  error: "error",
  disabled: "disabled",
} as const satisfies Record<ProviderReadiness, ProviderReadiness>;

const ProviderStatusWire = z.object({
  provider: z.enum(PROVIDERS),
  label: z.string(),
  available: z.boolean(),
  authStatus: z.enum(AUTH_STATUSES),
  readiness: z.enum(READINESS),
  enabled: z.boolean().optional(),
  message: z.string().optional(),
}).passthrough();

const WireSnapshotSchema = z.object({
  version: z.number(),
  savedAt: z.number().optional(),
  statuses: z.array(ProviderStatusWire).optional(),
  models: z.record(z.string(), z.array(ModelDescriptorWire)).optional(),
});

let cachedPath: string | null = null;
function cacheFilePath(): string {
  cachedPath ??= userDataPath("provider-cache.json");
  return cachedPath;
}

/** Keep only well-shaped entries so a hand-edited or version-skewed file can
 *  never feed junk ids into an adapter or the renderer's picker. `enabled`
 *  decodes to true when absent — snapshots written before the toggle existed
 *  read as fully enabled, so downstream rows always carry a definite flag. */
function sanitize(raw: JsonValue | null | undefined): ProviderSurfaceSnapshot {
  const out = emptySnapshot();
  const parsed = WireSnapshotSchema.safeParse(raw);
  if (!parsed.success || parsed.data.version !== VERSION) return out;
  if (parsed.data.savedAt !== undefined) out.savedAt = parsed.data.savedAt;
  if (parsed.data.statuses) {
    out.statuses = parsed.data.statuses.map((status) => ({
      // SAFETY: ProviderStatusWire validates the structure of each status entry.
      ...(status as ProviderStatus),
      enabled: status.enabled ?? true,
    }));
  }
  if (parsed.data.models) {
    for (const [provider, list] of Object.entries(parsed.data.models)) {
      if (list.length > 0) {
        // SAFETY: ModelDescriptorWire validates each model descriptor.
        out.models[provider as ProviderKind] = list as ModelDescriptor[];
      }
    }
  }
  return out;
}

let cache: ProviderSurfaceSnapshot | null = null;

/** The last persisted snapshot, read from disk once and held in memory. A
 *  missing or unreadable file is a clean empty snapshot — callers then behave
 *  exactly as they did before this cache existed (probe on demand). */
export function readProviderCache(): ProviderSurfaceSnapshot {
  if (cache) return cache;
  try {
    cache = sanitize(JSON.parse(fs.readFileSync(cacheFilePath(), "utf8")));
  } catch {
    cache = emptySnapshot();
  }
  return cache;
}

function persist(next: ProviderSurfaceSnapshot): ProviderSurfaceSnapshot {
  cache = next;
  try {
    writeFileAtomicSync(cacheFilePath(), JSON.stringify(next));
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
