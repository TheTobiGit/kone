import { useProviderSettings } from "~/composables/useProviderSettings";
import { computed, ref } from "vue";
import type { ModelDescriptor, ProviderKind, ProviderStatus } from "~/types/desktop";
import { resolveProviderSendAvailability } from "~/utils/providerAvailability";
import { isProviderOffered } from "~/utils/providerOffer";
import { peelIpcError } from "~/utils/ipcError";
import { desktopBridge } from "~/utils/desktopBridge";

// Which agent CLIs the user has installed + logged into on this machine. This is
// the "bring your own subscription" surface: kone only *detects* a ready CLI, it
// never holds provider credentials. With no bridge there are no CLIs to find.
//
// Module-scope state so every surface that asks about providers shares one probe
// result — discovery shells out to real CLIs, so we don't want it running once
// per component.

const statuses = ref<ProviderStatus[]>([]);
const loading = ref(false);
const loadError = ref<string | null>(null);
let probed = false;

// Prettified model lists, cached per provider at module scope. Populated on the
// first `models()` call (or eagerly by `prepare()` at app open) so entering a
// project reads a warm list instead of re-shelling out to the CLI.
const rawModelCache = ref<Partial<Record<ProviderKind, ModelDescriptor[]>>>({});
// A pushed catalog wins over an IPC response captured before it arrived.
const modelPushRevisions = new Map<ProviderKind, number>();
const ALL_PROVIDERS: ProviderKind[] = [
  "codex",
  "claudeAgent",
  "cursor",
  "opencode",
  "droid",
  "antigravity",
  "cline",
];

function stripCustom(list: readonly ModelDescriptor[]): ModelDescriptor[] {
  return list.filter((d) => !d.custom);
}

const modelCache = computed<Partial<Record<ProviderKind, ModelDescriptor[]>>>({
  get() {
    const ps = useProviderSettings();
    const out: Partial<Record<ProviderKind, ModelDescriptor[]>> = {};
    for (const p of ALL_PROVIDERS) {
      const base = stripCustom(rawModelCache.value[p] ?? []);
      const merged = ps.withCustomModels(p, base);
      if (merged.length) out[p] = merged;
    }
    return out;
  },
  set(next) {
    const clean: Partial<Record<ProviderKind, ModelDescriptor[]>> = {};
    for (const [k, v] of Object.entries(next)) {
      if (v) {
        // SAFETY: next is keyed by ProviderKind.
        clean[k as ProviderKind] = stripCustom(v);
      }
    }
    rawModelCache.value = clean;
  },
});
let preparing: Promise<void> | null = null;
let refreshing: Promise<void> | null = null;
let hydrating: Promise<void> | null = null;
let hydrated = false;
/** True once a live probe (not just the disk snapshot) has answered. Surfaces
 *  can use this to tell "these are last-known models" from "these are
 *  confirmed" — the snapshot is trustworthy enough to type against, but a
 *  provider the user logged out of since last launch still reads as ready. */
const confirmed = ref(false);

const bridge = () => desktopBridge()?.agent;

/** Don't re-probe more often than this on a focus/visibility change — coming
 *  back to the app is a good moment to re-check, but alt-tabbing is not a
 *  reason to spawn a CLI per provider. */
const MIN_FOCUS_REFRESH_MS = 30_000;
let lastRefreshAt = 0;
let watching = false;

/** Attach the app-lifetime listeners that keep `statuses` honest without anyone
 *  asking. Installed once — the state above is module-scope, so one subscription
 *  serves every surface, and it lives as long as the renderer does (there is no
 *  point at which kone stops caring what its providers are doing). `refreshNow`
 *  is the composable's own `refresh`, which dedupes itself; every instance
 *  closes over the same module state, so whichever one gets here first is as
 *  good as any other. Called from the composable body, not from `prepare()`:
 *  Settings can be reached straight from the home screen without anything having
 *  asked to prepare the surface, and an in-app sign-in there still has to move
 *  the row it just verified. */
function watch(refreshNow: () => Promise<void>): void {
  if (watching || typeof window === "undefined") return;
  watching = true;
  // The cheap path: the main process announces a discovery round only when it
  // actually differs, so a status corrected in the background lands here with
  // no polling — a CLI signed into in another window stops reading as
  // signed-out without a reload.
  bridge()?.onProvidersChanged((next) => {
    statuses.value = next;
    probed = true;
    confirmed.value = true;
  });
  bridge()?.onModelsChanged((provider, models) => {
    modelPushRevisions.set(provider, (modelPushRevisions.get(provider) ?? 0) + 1);
    rawModelCache.value = { ...rawModelCache.value, [provider]: stripCustom(models) };
  });
  // Returning to the app is when a stale row is both most likely and most
  // visible: the user usually left to go run `codex login`.
  const recheck = () => {
    if (document.visibilityState !== "visible") return;
    if (Date.now() - lastRefreshAt < MIN_FOCUS_REFRESH_MS) return;
    void refreshNow().catch(() => {});
  };
  window.addEventListener("focus", recheck);
  document.addEventListener("visibilitychange", recheck);
}

export function useAgentProviders() {
  // The installed, ready providers the app may actually offer. `statuses` below
  // stays raw so an existing thread on a provider kone no longer offers can
  // still report its health; every picker and boot path reads `ready`.
  const ready = computed(() =>
    statuses.value.filter((s) => s.readiness === "ready" && isProviderOffered(s.provider)),
  );
  const byProvider = (provider: ProviderKind) =>
    computed(() => statuses.value.find((s) => s.provider === provider) ?? null);

  /** Whether a turn can go to this provider right now, and if not, the sentence
   *  to show. Reactive, so a pushed correction un-blocks the composer on its own
   *  — the user runs `codex login` in a terminal and comes back to a live one. */
  const sendAvailability = (provider: ProviderKind | null) =>
    computed(() => resolveProviderSendAvailability({ provider, statuses: statuses.value }));

  /** Probe the machine. Cached after the first successful run unless `force`. */
  async function discover(force = false): Promise<ProviderStatus[]> {
    if (probed && !force) return statuses.value;
    loading.value = true;
    loadError.value = null;
    try {
      const api = bridge();
      statuses.value = api ? await api.discover() : [];
      probed = true;
      confirmed.value = true;
      return statuses.value;
    } catch (error) {
      loadError.value = peelIpcError(error, "Could not check your agent tools");
      return statuses.value;
    } finally {
      loading.value = false;
    }
  }

  /** Models a provider offers (its own `list models` surface). The label is
   *  whatever the CLI's own response called it (Codex's `model/list` returns a
   *  real `displayName` per model) — kone shows that verbatim rather than
   *  re-guessing a name from the id. Cached at module scope after the first
   *  fetch (bypass with `force`). */
  async function models(provider: ProviderKind, force = false): Promise<ModelDescriptor[]> {
    const ps = useProviderSettings();
    const cached = rawModelCache.value[provider];
    if (cached?.length && !force) return ps.withCustomModels(provider, cached);
    const api = bridge();
    const revision = modelPushRevisions.get(provider) ?? 0;
    let raw: ModelDescriptor[];
    if (!api) raw = [];
    else {
      try {
        raw = await api.models(provider);
      } catch {
        raw = [];
      }
    }
    if (revision !== (modelPushRevisions.get(provider) ?? 0)) {
      return ps.withCustomModels(provider, rawModelCache.value[provider] ?? []);
    }
    // Only cache a real list — an empty result means the CLI errored or wasn't
    // reachable, and we want the next call to retry rather than serve the miss.
    const base = stripCustom(raw);
    if (base.length) {
      rawModelCache.value = { ...rawModelCache.value, [provider]: base };
    }
    return ps.withCustomModels(provider, base.length ? base : (rawModelCache.value[provider] ?? []));
  }

  /** Seed statuses + catalogs from the main process's disk snapshot. This spawns
   *  no CLI, so it settles in about the time of one IPC round-trip — the whole
   *  point being that a cold launch has real provider and model ids in hand
   *  before the user can finish reaching for the composer. A first-ever run has
   *  nothing cached and resolves to a no-op. Deduped. */
  async function hydrate(): Promise<void> {
    if (hydrated) return;
    if (hydrating) return hydrating;
    hydrating = (async () => {
      const api = bridge();
      if (!api) {
        // No bridge, no providers to find: settle on the empty surface.
        probed = true;
        hydrated = true;
        return;
      }
      try {
        const snapshot = await api.surface();
        if (snapshot.statuses.length) {
          statuses.value = snapshot.statuses;
          // Serve the snapshot rather than re-probing on demand; `refresh()`
          // corrects it in the background.
          probed = true;
        }
        const seeded = Object.entries(snapshot.models)
          .map(([k, list]) => [k, stripCustom(list ?? [])] as const)
          .filter(([, list]) => list.length > 0);
        if (seeded.length) {
          rawModelCache.value = { ...Object.fromEntries(seeded), ...rawModelCache.value };
        }
      } catch {
        // No snapshot is a soft failure — `refresh()` still has to run.
      } finally {
        hydrated = true;
      }
    })();
    try {
      await hydrating;
    } finally {
      hydrating = null;
    }
  }

  /** Re-probe the machine for real and refresh every installed provider's
   *  catalog, overwriting whatever the snapshot said. Deduped. */
  async function refresh(): Promise<void> {
    if (refreshing) return refreshing;
    // Stamped on entry, not on completion: the focus throttle is there to space
    // out CLI spawns, and a probe that takes ten seconds has already spent them.
    lastRefreshAt = Date.now();
    refreshing = (async () => {
      const api = bridge();
      if (!api) {
        const found = await discover(true);
        await Promise.all(found.filter((s) => s.available).map((s) => models(s.provider, true)));
        return;
      }
      // Let the main process do the probing: it dedupes its own warm run (which
      // already started at app launch), so asking here never doubles the CLI
      // spawns, and it writes the result through to the snapshot for next time.
      await api.warm();
      const revisions = new Map(modelPushRevisions);
      const snapshot = await api.surface();
      if (snapshot.statuses.length) {
        statuses.value = snapshot.statuses;
        probed = true;
        confirmed.value = true;
      }
      const fresh = Object.entries(snapshot.models)
        .map(([k, list]) => [k, stripCustom(list ?? [])] as const)
        .filter(([key, list]) => {
          // SAFETY: snapshot.models is keyed by ProviderKind.
          const provider = key as ProviderKind;
          return list.length > 0 &&
            (revisions.get(provider) ?? 0) === (modelPushRevisions.get(provider) ?? 0);
        });
      if (fresh.length) rawModelCache.value = { ...rawModelCache.value, ...Object.fromEntries(fresh) };
    })();
    try {
      await refreshing;
    } finally {
      refreshing = null;
    }
  }

  // Any surface that asks about providers is enough to keep them live — this
  // is the app's one provider store, and the listener is what makes a sign-in
  // completed elsewhere (the modal, another window) land here without a reload.
  watch(refresh);

  /** Make the provider surface usable. Hydrates from disk first and returns as
   *  soon as that lands, kicking the live re-probe off behind it — callers that
   *  `await prepare()` are gating UI on it, and a cold CLI handshake is not
   *  something the user should be made to watch. Only a first-ever run (nothing
   *  cached) actually waits for the probe, because there's nothing else to
   *  show. Deduped — concurrent callers await the same run. */
  async function prepare(): Promise<void> {
    if (preparing) return preparing;
    preparing = (async () => {
      await hydrate();
      if (statuses.value.length) void refresh().catch(() => {});
      else await refresh();
    })();
    try {
      await preparing;
    } finally {
      preparing = null;
    }
  }

  /** Force a fresh model catalog probe for `provider`, updating `modelCache`
   *  and returning any discovery error string for the pane. */
  async function refreshModels(
    provider: ProviderKind,
  ): Promise<{ models: ModelDescriptor[]; error: string | null }> {
    const revision = modelPushRevisions.get(provider) ?? 0;
    const preload = typeof window !== "undefined" ? window.koneDesktop?.agent : undefined;
    if (preload?.refreshModels) {
      try {
        const res = await preload.refreshModels(provider);
        if (revision !== (modelPushRevisions.get(provider) ?? 0)) {
          return { models: modelCache.value[provider] ?? [], error: null };
        }
        const base = stripCustom(res.models);
        if (base.length) {
          rawModelCache.value = { ...rawModelCache.value, [provider]: base };
        }
        return { models: res.models, error: res.error ?? null };
      } catch (error) {
        return {
          models: modelCache.value[provider] ?? [],
          error: revision === (modelPushRevisions.get(provider) ?? 0)
            ? peelIpcError(error, "Could not refresh models") : null,
        };
      }
    }
    const list = await models(provider, true);
    return { models: list, error: null };
  }

  /** Re-probe a single provider's health immediately. */
  async function checkProvider(provider: ProviderKind): Promise<ProviderStatus | null> {
    const preload = typeof window !== "undefined" ? window.koneDesktop?.agent : undefined;
    if (preload?.checkProvider) {
      try {
        const next = await preload.checkProvider(provider);
        statuses.value = statuses.value.some((s) => s.provider === provider)
          ? statuses.value.map((s) => (s.provider === provider ? next : s))
          : [...statuses.value, next];
        return next;
      } catch {
        return byProvider(provider).value;
      }
    }
    await discover(true);
    return byProvider(provider).value;
  }

  return {
    statuses,
    modelCache,
    ready,
    loading,
    loadError,
    confirmed,
    byProvider,
    sendAvailability,
    discover,
    models,
    refreshModels,
    checkProvider,
    hydrate,
    refresh,
    prepare,
  };
}
