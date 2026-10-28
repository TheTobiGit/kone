import {
  invalidateProviderQuotaCache,
  isQuotaCapableProvider,
} from "./quota/index.js";
import {
  cacheModels,
  cacheStatuses,
  readProviderCache,
  type ProviderSurfaceSnapshot,
} from "./providerCache.js";
import {
  disabledProviderStatus,
  providerStatusesEqual,
  stabilizeProviderStatuses,
  statusEnabled,
} from "./providerHealth.js";
import {
  customModelsFor,
  isProviderEnabled,
  readProviderSettings,
} from "./providerSettings.js";
import { isCompactionSupported, PROVIDER_KIND_VALUES } from "./types.js";
import type {
  ModelDescriptor,
  ProviderAdapter,
  ProviderConfig,
  ProviderEnvVar,
  ProviderKind,
  ProviderModelsRefreshResult,
  ProviderSettingsMap,
  ProviderStatus,
} from "./types.js";

// The runtime owner for the provider surface: the adapters themselves, the
// catalogs derived from them, and the discovery rounds the UI reads.
//
// Two kinds of change invalidate everything derived from a provider — its
// quota reads, its model catalog, and the sessions already running on it:
//
//   • install settings that move the runtime (binary, home, env, enabled), and
//   • a completed in-app sign-in.
//
// They both go through `retireProviderRuntime` here, so a settings write and a
// sign-in cannot drift apart. A plain health check never retires anything: it
// observes the CLI, and observing is not a reason to tear down work in flight.

export type ProviderRuntimeOptions = {
  /** The adapters to own, already wired to the service's event stream. */
  adapters: Iterable<ProviderAdapter>;
  /** Hand each adapter the service's liveness callback. */
  livenessHook?: (threadId: string) => void;
  /** Stop every session bound to the provider's current runtime and resolve
   *  once they are gone. The provider's own session bookkeeping lives with
   *  the service, so it supplies this half. */
  retireSessions: (provider: ProviderKind) => Promise<number>;
  /** Drop the provider's cached quota reads. Defaults to the quota module's
   *  own invalidation; tests substitute a recorder. */
  invalidateQuota?: (provider: ProviderKind) => void;
};

export class ProviderRuntime {
  private readonly adaptersByKind = new Map<ProviderKind, ProviderAdapter>();
  /** Last known catalog per provider — seeded from disk at construction, so a
   *  cold launch can validate a model id without spawning a probe CLI. */
  private readonly catalogs = new Map<ProviderKind, ModelDescriptor[]>();
  private readonly listeners = new Set<(statuses: ProviderStatus[]) => void>();
  /** The discovery round in flight, so concurrent callers share one set of CLI
   *  spawns instead of racing their own. */
  private discovering: Promise<ProviderStatus[]> | null = null;
  /** Tail of the provider-probe queue. Discovery probes every CLI and a check
   *  probes one; running them at once would race two handshakes for the same
   *  CLI and two writers for one disk snapshot, so each round starts when the
   *  previous one settles. */
  private rounds: Promise<unknown> = Promise.resolve();
  /** A probe started before retirement cannot publish the old runtime's row. */
  private runtimeGeneration = 0;
  private warming: Promise<void> | null = null;
  private readonly invalidateQuota: (provider: ProviderKind) => void;

  constructor(private readonly options: ProviderRuntimeOptions) {
    this.invalidateQuota =
      options.invalidateQuota ??
      ((provider) => {
        if (isQuotaCapableProvider(provider)) invalidateProviderQuotaCache(provider);
      });

    for (const adapter of options.adapters) {
      this.adaptersByKind.set(adapter.provider, adapter);
      adapter.setLivenessHook?.(options.livenessHook ?? (() => {}));
    }

    // Point each adapter at the user's persisted install settings (custom
    // binary path, …) before anything probes or spawns. Unset providers keep
    // their built-in default, so a fresh install behaves exactly as before.
    const settings = readProviderSettings();
    for (const [provider, adapter] of this.adaptersByKind) {
      adapter.setConfig?.(settings[provider] ?? {});
    }
    for (const [provider, models] of Object.entries(readProviderCache().models)) {
      if (models?.length) {
        // SAFETY: the provider cache is keyed by ProviderKind at write time.
        this.catalogs.set(provider as ProviderKind, models);
      }
    }
  }

  /** The adapter registry, for the service's thread routing. */
  get adapters(): ReadonlyMap<ProviderKind, ProviderAdapter> {
    return this.adaptersByKind;
  }

  adapter(provider: ProviderKind): ProviderAdapter {
    const adapter = this.adaptersByKind.get(provider);
    if (!adapter) throw new Error(`Unsupported agent provider: ${provider}`);
    return adapter;
  }

  /** The last known provider surface, straight off the disk cache — no CLI is
   *  spawned, so this answers in microseconds. The renderer hydrates its picker
   *  from this at app open and refreshes in the background, which is what makes
   *  a cold launch present a provider list that's actually usable rather than
   *  one that only *looks* populated. Empty on a first-ever run. */
  cachedSurface(): ProviderSurfaceSnapshot {
    const surface = readProviderCache();
    const settings = readProviderSettings();
    // Manual-compaction support derives at read time from the live adapter
    // union — the disk snapshot carries no copy, so a stale flag can never
    // linger past the adapter that owns it.
    const statuses = surface.statuses.map((status) => {
      const supportsThreadCompaction = isCompactionSupported(
        this.adaptersByKind.get(status.provider)?.capabilities.compaction,
      );
      return isProviderEnabled(status.provider, settings)
        ? { ...status, enabled: statusEnabled(status), supportsThreadCompaction }
        : { ...disabledProviderStatus(status.provider, status.label), supportsThreadCompaction };
    });
    const models = { ...surface.models };
    for (const provider of PROVIDER_KIND_VALUES) {
      const merged = this.withCustomModels(provider, models[provider] ?? []);
      if (merged.length > 0) models[provider] = merged;
    }
    return { ...surface, statuses, models };
  }

  /** Queue one provider-probe round behind the previous one. Success or
   *  failure both release the queue: a failed round published nothing, and the
   *  next one still deserves to run. */
  private queueRound<T>(round: () => Promise<T>): Promise<T> {
    const result = this.rounds.then(round, round);
    this.rounds = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Probe every provider on the user's machine — what's installed + logged in.
   *
   *  Folded over the previous round before it is published or persisted: a probe
   *  that timed out reports no verdict, and letting one slow CLI overwrite a
   *  known-good row would put that wrong answer on disk, where the next cold
   *  launch hydrates it as fact. */
  async discover(): Promise<ProviderStatus[]> {
    // Single-flight: discovery spawns a CLI per provider, and two surfaces
    // asking at once (the picker opening while warmup is still running) would
    // otherwise pay for that twice and race each other to the disk snapshot.
    this.discovering ??= this.queueRound(async () => {
      try {
        for (;;) {
          const generation = this.runtimeGeneration;
          const settings = readProviderSettings();
          const cached = readProviderCache().statuses;
          const probed = await Promise.all(
            [...this.adaptersByKind.values()].map((adapter) =>
              this.probeProvider(adapter, settings, cached),
            ),
          );
          if (generation !== this.runtimeGeneration) {
            // An old probe may have refilled its adapter cache AFTER retirement
            // cleared it. Drop that result before probing the new configuration.
            for (const adapter of this.adaptersByKind.values()) {
              adapter.invalidateDiscoveryCaches?.();
            }
            continue;
          }
          const statuses = stabilizeProviderStatuses(cached, probed);
          this.publishStatuses(statuses);
          return statuses;
        }
      } finally {
        this.discovering = null;
      }
    });
    return this.discovering;
  }

  /** One provider's fresh row, with the disabled and manual-compaction rules
   *  applied — the shared half of a full discovery and a single check. The
   *  input adapter must already have had its discovery caches dropped when the
   *  caller is re-probing after a login. */
  private async probeProvider(
    adapter: ProviderAdapter,
    settings: ProviderSettingsMap,
    cached: readonly ProviderStatus[],
  ): Promise<ProviderStatus> {
    // Manual-compaction support is adapter code truth — derived from the
    // adapter's compaction union here, never probed or persisted.
    const supportsThreadCompaction = isCompactionSupported(adapter.capabilities.compaction);
    if (!isProviderEnabled(adapter.provider, settings)) {
      const prev = cached.find((status) => status.provider === adapter.provider);
      return {
        ...disabledProviderStatus(adapter.provider, prev?.label ?? adapter.provider),
        supportsThreadCompaction,
      };
    }
    const status = await adapter.discover();
    return {
      ...status,
      enabled: statusEnabled(status),
      supportsThreadCompaction,
    };
  }

  /** Re-probe exactly ONE provider and fold its fresh row into the cached
   *  surface. This is what a health check runs: drop that adapter's cached
   *  handshake, ask only that adapter, then publish the merged round so the
   *  corrected row reaches every renderer.
   *
   *  Observing a provider never retires work: a check that finds the same
   *  account still signed in must leave its sessions alone, and one that finds
   *  a broken CLI has no business killing turns the provider may still be
   *  running. Credential changes retire through `confirmProviderSignIn` or the
   *  install-settings path, both of which know what actually changed.
   *
   *  The check runs in the same single-flight slot as a full discovery — a
   *  later discovery waits for it, and a discovery already queued runs first —
   *  so two handshakes for one CLI are never in flight at once. The cache is
   *  re-read after the probe resolves: whatever round is on disk then is what
   *  the checked row is folded into. */
  async checkProvider(provider: ProviderKind): Promise<ProviderStatus> {
    const result = await this.inspectProvider(provider);
    return result.published;
  }

  /** An inconclusive probe may keep the last healthy surface for display.
   *  Authentication decisions need the fresh observation as well, so retaining
   *  cached health cannot turn a timeout into a successful login. */
  private async inspectProvider(
    provider: ProviderKind,
  ): Promise<{ observed: ProviderStatus; published: ProviderStatus }> {
    const adapter = this.adapter(provider);
    return this.queueRound(async () => {
      for (;;) {
        const generation = this.runtimeGeneration;
        adapter.invalidateDiscoveryCaches?.();
        const probed = await this.probeProvider(
          adapter, readProviderSettings(), readProviderCache().statuses,
        );
        if (generation !== this.runtimeGeneration) continue;

        // Fold into the cache AFTER the probe, preserving newer unrelated rows.
        const cached = readProviderCache().statuses;
        const [folded] = stabilizeProviderStatuses(cached, [probed]);
        if (!folded) throw new Error(`No provider status for ${provider}.`);
        const merged = cached.some((status) => status.provider === provider)
          ? cached.map((status) => (status.provider === provider ? folded : status))
          : [...cached, folded];
        this.publishStatuses(merged);
        return { observed: probed, published: folded };
      }
    });
  }

  /** Confirm that an in-app sign-in just succeeded, then retire everything
   *  bound to the credentials that were there before it.
   *
   *  A completed sign-in is the explicit event here. A provider row cannot name
   *  the account behind it, and a ready → ready round trip is exactly what
   *  switching from account A to account B looks like; comparing readiness or
   *  auth labels would either miss that swap or tear down sessions on every
   *  ordinary check. The sign-in dialog's check is the one caller that marks the
   *  end of a login attempt, so it is the only one that retires — and it does so
   *  even for a re-auth of the same account, whose credentials were rewritten.
   *
   *  A still-not-ready verdict is a failed attempt: nothing on disk changed, so
   *  the old sessions and quota stay valid. */
  async confirmProviderSignIn(provider: ProviderKind): Promise<ProviderStatus> {
    const { observed: status } = await this.inspectProvider(provider);
    if (status.readiness !== "ready") return status;

    this.retireProviderRuntime(provider);
    await this.options.retireSessions(provider);
    // A different account can expose a different set of models.
    void this.refreshProviderModels(provider);
    return status;
  }

  /** Subscribe to provider-surface changes. Returns an unsubscribe fn. */
  onProvidersChanged(listener: (statuses: ProviderStatus[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Persist a discovery round and announce it — but only when something the
   *  user could see actually moved. Every probe writes a `checkedAt`-free row,
   *  so an unchanged surface compares equal and stays silent rather than waking
   *  every renderer on a timer. */
  private publishStatuses(statuses: ProviderStatus[]): void {
    const changed = !providerStatusesEqual(readProviderCache().statuses, statuses);
    cacheStatuses(statuses);
    if (!changed) return;
    for (const listener of this.listeners) {
      try {
        listener(statuses);
      } catch (error) {
        // One bad subscriber must not strand the others or the probe round.
        console.error("[agent] provider status listener failed:", error);
      }
    }
  }

  /** Merge user-configured custom model slugs into a provider's model list. */
  private withCustomModels(
    provider: ProviderKind,
    models: readonly ModelDescriptor[],
  ): ModelDescriptor[] {
    const slugs = customModelsFor(provider);
    if (slugs.length === 0) return [...models];
    const seen = new Set(models.map((m) => m.id));
    const extras: ModelDescriptor[] = [];
    for (const slug of slugs) {
      if (seen.has(slug)) continue;
      seen.add(slug);
      extras.push({ id: slug, label: slug, custom: true });
    }
    return [...models, ...extras];
  }

  /** Both model-fetch paths commit through this guard. A retired probe may
   *  refill the adapter's own cache on completion, so clear it before retrying. */
  private async loadModels(provider: ProviderKind): Promise<ModelDescriptor[]> {
    const adapter = this.adapter(provider);
    for (;;) {
      const generation = this.runtimeGeneration;
      try {
        const models = await adapter.listModels();
        if (generation === this.runtimeGeneration) {
          if (models.length) {
            this.catalogs.set(provider, models);
            cacheModels(provider, models);
          }
          return models;
        }
      } catch (error) {
        if (generation === this.runtimeGeneration) throw error;
      }
      adapter.invalidateDiscoveryCaches?.();
    }
  }

  async listModels(provider: ProviderKind): Promise<ModelDescriptor[]> {
    const models = await this.loadModels(provider);
    return this.withCustomModels(provider, models);
  }

  /** Force a fresh model catalog probe for `provider`, keeping the last
   *  known non-empty catalog when the probe fails or returns empty, and
   *  surfacing any discovery error string to the UI. */
  async refreshProviderModels(provider: ProviderKind): Promise<ProviderModelsRefreshResult> {
    const adapter = this.adapter(provider);
    adapter.invalidateDiscoveryCaches?.();
    try {
      const probed = await this.loadModels(provider);
      if (probed.length > 0) {
        return { provider, models: this.withCustomModels(provider, probed) };
      }
      return {
        provider,
        models: this.withCustomModels(
          provider, this.catalogs.get(provider) ?? readProviderCache().models[provider] ?? [],
        ),
        error: "Provider returned no models.",
      };
    } catch (error) {
      return {
        provider,
        models: this.withCustomModels(
          provider, this.catalogs.get(provider) ?? readProviderCache().models[provider] ?? [],
        ),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Refresh the whole surface in the background at app open: discover, then
   *  pull each installed provider's catalog, writing both through to disk. The
   *  point is that by the time the user sends anything, `catalogFor` is warm —
   *  validation on the send path must never be the thing that spawns a CLI.
   *  Deduped, and never rejects: a missing or broken CLI just leaves the
   *  previous snapshot in place. */
  warm(): Promise<void> {
    this.warming ??= (async () => {
      try {
        const found = await this.discover();
        await Promise.all(
          found
            .filter((status) => status.available)
            .map((status) => this.listModels(status.provider).catch(() => [])),
        );
      } catch {
        // Warming is opportunistic — the cached snapshot stays valid.
      } finally {
        this.warming = null;
      }
    })();
    return this.warming;
  }

  /** The catalog we already know for `provider`, or undefined if we've never
   *  successfully read one. Deliberately non-spawning: the validators below run
   *  on the send path, and `listModels()` there would stall the user's turn
   *  behind a fresh `codex app-server` handshake. Unknown catalog → no
   *  validation, which is the same permissive behaviour as a failed probe. */
  catalogFor(provider: ProviderKind): ModelDescriptor[] | undefined {
    const known = this.catalogs.get(provider);
    if (known?.length) return known;
    // Nothing in memory yet — kick off a refresh so the *next* turn is guarded,
    // but don't make this one wait for it.
    void this.listModels(provider).catch(() => []);
    return undefined;
  }

  /** The catalog already in memory, without starting a probe — for snapshots
   *  that must stay synchronous. */
  knownCatalog(provider: ProviderKind): ModelDescriptor[] | undefined {
    return this.catalogs.get(provider);
  }

  /** Apply one provider's persisted install settings to its live adapter. When
   *  the change moves how the CLI is launched (enabled, binary, home, env), the
   *  runtime it was using is retired and the surface re-probed; a cosmetic
   *  field (hidden models, handoff cap) only re-points the adapter. */
  async applyProviderSettings(
    provider: ProviderKind,
    before: ProviderConfig | undefined,
    after: ProviderConfig | undefined,
  ): Promise<void> {
    // A settings write can name a provider this runtime has no adapter for
    // (an embedder with a subset, or a provider dropped from the build); it
    // persists fine and simply has no live runtime to reconfigure.
    this.adaptersByKind.get(provider)?.setConfig?.(after ?? {});
    if (!runtimeSettingsChanged(before, after)) return;
    this.retireProviderRuntime(provider);
    await this.options.retireSessions(provider);
    void this.discover();
  }

  /** Drop every cache derived from the provider's current runtime: quota reads,
   *  adapter discovery state, and the in-memory model catalog. */
  private retireProviderRuntime(provider: ProviderKind): void {
    this.runtimeGeneration += 1;
    this.invalidateQuota(provider);
    this.adaptersByKind.get(provider)?.invalidateDiscoveryCaches?.();
    this.catalogs.delete(provider);
  }
}

function envPairsEqual(
  before: readonly ProviderEnvVar[] | undefined,
  after: readonly ProviderEnvVar[] | undefined,
): boolean {
  const a = before ?? [];
  const b = after ?? [];
  if (a.length !== b.length) return false;
  // `secret` is not presentation metadata: a secret entry inherits the
  // same-named variable from the parent environment instead of carrying its
  // stored value, so flipping it changes what the child process receives.
  return a.every(
    (item, i) =>
      item.name === b[i]?.name &&
      item.value === b[i]?.value &&
      (item.secret === true) === (b[i]?.secret === true),
  );
}

/** Whether this settings write changes the process a provider launches (and so
 *  invalidates every session and cache derived from the old one). Presentation
 *  fields — hidden/custom models, handoff budget, picker visibility — do not. */
function runtimeSettingsChanged(
  before: ProviderConfig | undefined,
  after: ProviderConfig | undefined,
): boolean {
  if ((before?.enabled ?? true) !== (after?.enabled ?? true)) return true;
  if ((before?.binaryPath ?? "") !== (after?.binaryPath ?? "")) return true;
  if ((before?.homeDir ?? "") !== (after?.homeDir ?? "")) return true;
  return !envPairsEqual(before?.env, after?.env);
}
