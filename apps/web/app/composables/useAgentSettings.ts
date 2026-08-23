import { computed, ref } from "vue";
import type {
  AgentInventory,
  AgentUsageReport,
  ProviderKind,
  QuotaProviderReport,
  UsageRange,
} from "~/types/desktop";

// The Agents space reads three independent sources, each behind its own bridge
// call and its own loading flag, so a slow inventory scan never holds up the
// usage report the page opens on. Nothing here is mocked: in `nuxt dev` (no
// desktop bridge) each read simply resolves to null and the sections render
// their own empty states — the same honesty rule the profile board follows.

/** Providers whose own usage kone knows how to read. Everything else in the
 *  picker is a CLI with nothing to ask, and the Limits section says so rather
 *  than inventing a meter. Deliberately narrower than ProviderKind — the bridge
 *  accepts exactly these, so the narrowing belongs in the type. OpenCode leads
 *  because it is the only one that is useful with no network and no consent;
 *  Antigravity needs no consent either — its "credential" is the language
 *  server the app/CLI already runs, never a stored token. Droid reads through
 *  Factory's billing/usage APIs with the user's own Factory API key. */
export type QuotaProvider = QuotaProviderReport["provider"];
const QUOTA_CAPABLE: QuotaProvider[] = ["opencode", "claudeAgent", "codex", "cursor", "antigravity", "droid"];

/** Installed providers the Limits section still shows a card for, even though
 *  kone cannot read a single number from them. A card with the honest "nothing
 *  to read" note beats no card at all — the absence of a meter should be
 *  explained, not silent. Never added to QUOTA_CAPABLE: the quota bridge
 *  accepts exactly that list, and these must not reach it. (Empty today — every
 *  provider kone offers has a quota path.) */
const UNREADABLE: ProviderKind[] = [];
const READABLE: ReadonlySet<string> = new Set(QUOTA_CAPABLE);

/** Every provider the Limits section can render a card for. */
const LIMITS_PROVIDERS: ProviderKind[] = [...QUOTA_CAPABLE, ...UNREADABLE];

/** Providers that need no opt-in, because the question the toggle asks —
 *  "may kone spend your stored credential on a call to this provider?" — simply
 *  does not apply to them. OpenCode touches no credential and makes no network
 *  call; it reads a cost figure OpenCode itself already wrote to a local file.
 *  Antigravity likewise: its "credential" is the language server the app/CLI
 *  already runs, and the quota read is loopback-only. Gating either behind
 *  consent would be ceremony without a decision behind it. */
const NO_CONSENT_NEEDED: QuotaProvider[] = ["opencode", "antigravity"];

/** The per-provider opt-in for everyone else. Reading a provider's local CLI
 *  token and calling its usage API on the user's behalf is a thing they turn on
 *  deliberately, once, per provider — never a side effect of opening the page.
 *  Kept client-side because it is a UI consent, not a capability the main
 *  process should assume. */
const CONNECTED_KEY = "kone:quota:connected";

// ── stale-while-revalidate caches ────────────────────────────────────────────
// Every pane that shows agent data (usage settings, provider limits, the agents
// space) makes its own useAgentSettings, and Vue tears that state down the moment
// the pane closes — so without this, every reopen is a cold scan and the
// skeleton reflashes while the disk is walked again. These module-level maps
// outlive any single instance: a reopen (or a range/scope flip we've seen
// before) paints the last-good report immediately and revalidates in the
// background, so the skeleton is only ever paid once, on the very first cold
// read. Keyed finely enough that project vs. global and 7d vs. 30d never bleed
// into each other. Cleared implicitly by a forceRefresh, which always refetches.
const usageReportCache = new Map<string, AgentUsageReport>();
const inventoryCache = new Map<string, AgentInventory>();
/** Every range the pane offers — the warmer walks this to pre-fill the ones the
 *  user hasn't clicked yet. */
const USAGE_RANGES: readonly UsageRange[] = ["1d", "7d", "30d", "all"];
/** Scopes whose sibling ranges have already been warmed, so the background pull
 *  fires once per scope rather than on every load. Module-level to survive a
 *  pane reopen; a forced refresh clears the relevant tag to re-arm it. */
const warmedScopes = new Set<string>();
const credentialProbeCache: Partial<Record<QuotaProvider, boolean>> = {};
const quotaReportCache: Partial<Record<QuotaProvider, QuotaProviderReport>> = {};

function readConnected(): Set<QuotaProvider> {
  if (!import.meta.client) return new Set();
  try {
    const raw = localStorage.getItem(CONNECTED_KEY);
    const list: string[] = raw ? JSON.parse(raw) : [];
    return new Set(list.filter((p): p is QuotaProvider => READABLE.has(p)));
  } catch {
    return new Set();
  }
}

function writeConnected(set: ReadonlySet<QuotaProvider>): void {
  if (!import.meta.client) return;
  try {
    localStorage.setItem(CONNECTED_KEY, JSON.stringify([...set]));
  } catch {
    // A full or blocked localStorage costs the user the remembered opt-in, not
    // the session — the toggle still works for as long as the page is open.
  }
}

export function useAgentSettings(projectPath: () => string | null) {
  const bridge = () => (import.meta.client ? window.koneDesktop?.agent : undefined);

  // ── usage ──────────────────────────────────────────────────────────────────
  const range = ref<UsageRange>("1d");
  const usage = ref<AgentUsageReport | null>(null);
  const usageLoading = ref(false);
  const usageLoaded = ref(false);
  /** Project-scoped by default — this page lives inside a project, so "what have
   *  the agents spent" means *here* until the user widens it. */
  const usageScope = ref<"project" | "global">("project");

  /** The cache key for a given range under the current scope — the exact triplet
   *  that changes the numbers, so 7d-project and 30d-global keep their own
   *  last-good copy. */
  function keyFor(forRange: UsageRange): string {
    const scoped = usageScope.value === "project" ? projectPath() ?? "" : "";
    return `${usageScope.value}:${forRange}:${scoped}`;
  }
  function usageKey(): string {
    return keyFor(range.value);
  }

  async function loadUsage(options?: { forceRefresh?: boolean }): Promise<void> {
    const api = bridge()?.usage;
    if (!api?.report) {
      usageLoaded.value = true;
      return;
    }
    // Stale-while-revalidate: if we've drawn this exact view before, paint it at
    // once and skip the skeleton — the refetch below quietly reconciles. Only a
    // genuinely cold key (or a forced refresh) still shows the loading state.
    const key = usageKey();
    const cached = usageReportCache.get(key);
    if (cached && !options?.forceRefresh) {
      usage.value = cached;
      usageLoaded.value = true;
    }
    usageLoading.value = true;
    try {
      const fresh = await api.report({
        range: range.value,
        projectPath: usageScope.value === "project" ? projectPath() : null,
        forceRefresh: options?.forceRefresh,
      });
      // Guard against a slow response for a key the user has since navigated
      // away from — only commit if this read is still the one on screen.
      if (usageKey() === key) usage.value = fresh;
      usageReportCache.set(key, fresh);
    } catch (err) {
      console.error("[useAgentSettings] usage report failed:", err);
    } finally {
      usageLoading.value = false;
      usageLoaded.value = true;
    }
    // With the visible range settled, quietly pull the other three so their
    // first click paints from cache instead of paying a cold scan. Kept off the
    // critical path and to one pass per scope, so flipping ranges feels instant
    // without turning every open into four disk walks.
    void warmOtherRanges();
  }

  /** Prime the sibling ranges' caches in the background. Best-effort and serial
   *  — it reuses the same per-file scan cache the visible read just warmed, so
   *  each sibling is mostly aggregation, and a failure only costs that range its
   *  head start. Runs once per scope; a forced refresh re-arms it. */
  async function warmOtherRanges(): Promise<void> {
    const api = bridge()?.usage;
    if (!api?.report) return;
    const scopeTag = keyFor(range.value).replace(`:${range.value}:`, "::");
    if (warmedScopes.has(scopeTag)) return;
    warmedScopes.add(scopeTag);
    for (const sibling of USAGE_RANGES) {
      if (sibling === range.value) continue;
      const key = keyFor(sibling);
      if (usageReportCache.has(key)) continue;
      try {
        const report = await api.report({
          range: sibling,
          projectPath: usageScope.value === "project" ? projectPath() : null,
        });
        usageReportCache.set(key, report);
      } catch {
        // A warm miss just means that range pays its own scan when first opened.
      }
    }
  }

  /** Re-scan transcripts / Cursor CSV and bypass usage memoization. */
  async function refreshUsage(): Promise<void> {
    // A manual refresh nukes the backend scan caches, so every range's last-good
    // copy is now stale — drop the sibling entries and re-arm warming so they
    // reprime from fresh data rather than serving the pre-refresh numbers.
    const scopeTag = keyFor(range.value).replace(`:${range.value}:`, "::");
    warmedScopes.delete(scopeTag);
    for (const sibling of USAGE_RANGES) {
      if (sibling !== range.value) usageReportCache.delete(keyFor(sibling));
    }
    await loadUsage({ forceRefresh: true });
  }

  function setRange(next: UsageRange): void {
    if (next === range.value) return;
    range.value = next;
    void loadUsage();
  }
  function setUsageScope(next: "project" | "global"): void {
    if (next === usageScope.value) return;
    usageScope.value = next;
    void loadUsage();
  }

  // ── limits ─────────────────────────────────────────────────────────────────
  // Two separate facts per provider: whether a credential is sitting on disk at
  // all (a local check, no network), and the live quota report (network, and
  // only for a provider the user has connected).
  const connected = ref<Set<QuotaProvider>>(readConnected());
  // Seed from the cross-instance cache so a reopened Limits pane shows its last
  // known credential presence and meters at once, then revalidates underneath.
  const credentialPresent = ref<Partial<Record<QuotaProvider, boolean>>>({ ...credentialProbeCache });
  const quotas = ref<Partial<Record<QuotaProvider, QuotaProviderReport>>>({ ...quotaReportCache });
  const quotaLoading = ref<Partial<Record<QuotaProvider, boolean>>>({});
  /** The card list: quota-capable providers plus the "nothing to read" ones
   *  (droid, antigravity) the Limits section still explains. */
  const limitsProviders = computed(() => LIMITS_PROVIDERS);
  /** True when the quota bridge actually answers for this provider — gates
   *  every quota call and the card states that depend on them. */
  const isReadable = (p: ProviderKind): p is QuotaProvider => READABLE.has(p);
  /** Consent-free providers read as connected the moment their local data is
   *  there — there is nothing for the user to agree to. */
  const isConnected = (p: QuotaProvider) =>
    NO_CONSENT_NEEDED.includes(p) ? credentialPresent.value[p] === true : connected.value.has(p);
  /** Whether this provider has an opt-in to offer at all — drives whether the
   *  card shows a Connect/Disconnect pair. Disconnecting OpenCode would be a
   *  control with nothing behind it. */
  const needsConsent = (p: QuotaProvider) => !NO_CONSENT_NEEDED.includes(p);

  /** Cheap, offline: does this provider's CLI have a credential we could read?
   *  Drives whether the row offers "Connect" or explains there's nothing to
   *  connect to. Never touches the network. */
  async function detectCredentials(): Promise<void> {
    const api = bridge()?.quota;
    if (!api?.detect) return;
    const found: Partial<Record<QuotaProvider, boolean>> = {};
    await Promise.all(
      QUOTA_CAPABLE.map(async (p) => {
        try {
          found[p] = await api.detect(p);
        } catch {
          found[p] = false;
        }
      }),
    );
    credentialPresent.value = found;
    Object.assign(credentialProbeCache, found);
  }

  /** `userInitiated` gates `allowKeychain`: only a click may risk a surprise
   *  macOS Keychain prompt. The page's own opening read must never trigger one,
   *  so it asks without it and accepts a `accessDenied` report if that's the
   *  answer — *unless* the offline probe already found this provider's
   *  credential (a probe that succeeded inside its short timeout has already
   *  read the item without prompting, so re-reading it on load cannot prompt
   *  either — and without this, a keychain-only login like Claude Code 2.x or
   *  the Cursor CLI reports "run claude login" on every page load). */
  async function loadQuota(provider: QuotaProvider, userInitiated = false): Promise<void> {
    const api = bridge()?.quota;
    if (!api?.fetch || !isConnected(provider)) return;
    // Assign the property rather than replacing the whole object. These run
    // concurrently, one per provider, and a read-spread-write would have each
    // call snapshot the map *before* its siblings wrote to it — so the last one
    // to finish silently reverts the others, leaving cards stuck at `true`
    // forever and dropping reports on the floor. `ref({})` is deep-reactive, so
    // a plain property write is seen just the same.
    quotaLoading.value[provider] = true;
    try {
      const allowKeychain = userInitiated || credentialPresent.value[provider] === true;
      const report = await api.fetch(provider, { allowKeychain });
      quotas.value[provider] = report;
      quotaReportCache[provider] = report;
    } catch (err) {
      console.error(`[useAgentSettings] quota fetch failed for ${provider}:`, err);
    } finally {
      quotaLoading.value[provider] = false;
    }
  }

  /** Turning a provider on fetches it immediately (the user just asked for it);
   *  turning it off drops the report so no stale meter lingers on screen. */
  async function connect(provider: QuotaProvider): Promise<void> {
    const next = new Set(connected.value);
    next.add(provider);
    connected.value = next;
    writeConnected(next);
    await loadQuota(provider, true);
  }
  function disconnect(provider: QuotaProvider): void {
    const next = new Set(connected.value);
    next.delete(provider);
    connected.value = next;
    writeConnected(next);
    delete quotas.value[provider];
    delete quotaReportCache[provider];
  }

  /** Everything currently readable: the providers the user opted in, plus the
   *  consent-free ones whose local data was just detected. */
  async function loadConnectedQuotas(): Promise<void> {
    await Promise.all(QUOTA_CAPABLE.filter(isConnected).map((p) => loadQuota(p)));
  }

  // ── inventory ──────────────────────────────────────────────────────────────
  const inventory = ref<AgentInventory | null>(null);
  const inventoryLoading = ref(false);
  const inventoryLoaded = ref(false);

  async function loadInventory(): Promise<void> {
    const api = bridge()?.inventory;
    if (!api?.scan) {
      inventoryLoaded.value = true;
      return;
    }
    const key = projectPath() ?? "";
    const cached = inventoryCache.get(key);
    if (cached) {
      inventory.value = cached;
      inventoryLoaded.value = true;
    }
    inventoryLoading.value = true;
    try {
      const fresh = await api.scan(projectPath());
      if ((projectPath() ?? "") === key) inventory.value = fresh;
      if (fresh) inventoryCache.set(key, fresh);
    } catch (err) {
      console.error("[useAgentSettings] inventory scan failed:", err);
    } finally {
      inventoryLoading.value = false;
      inventoryLoaded.value = true;
    }
  }

  // ── entry ──────────────────────────────────────────────────────────────────
  // First reveal fans out: usage (what the page opens on), the offline
  // credential probe, any already-connected quotas, and the inventory scan. They
  // are independent, so none of them waits on another.
  let entered = false;
  async function load(): Promise<void> {
    if (entered) return;
    entered = true;
    await Promise.all([loadUsage(), detectCredentials().then(loadConnectedQuotas), loadInventory()]);
  }

  /** The masthead's refresh — re-reads everything currently on screen. */
  async function refresh(): Promise<void> {
    await Promise.all([loadUsage(), detectCredentials().then(loadConnectedQuotas), loadInventory()]);
  }

  const busy = computed(() => usageLoading.value || inventoryLoading.value);

  return {
    usage: usage,
    usageLoading: usageLoading,
    usageLoaded: usageLoaded,
    range: range,
    usageScope: usageScope,
    setRange,
    setUsageScope,
    refreshUsage,
    // limits
    limitsProviders,
    isReadable,
    quotas: quotas,
    quotaLoading: quotaLoading,
    credentialPresent: credentialPresent,
    isConnected,
    needsConsent,
    connect,
    disconnect,
    loadQuota,
    // inventory
    inventory: inventory,
    inventoryLoading: inventoryLoading,
    inventoryLoaded: inventoryLoaded,
    /** Re-walk the skills/MCP/instruction roots and nothing else. A pane that
     *  only shows inventory (settings' Skills page) must not drag a usage scan
     *  and a round of quota reads along with its own refresh button. */
    refreshInventory: loadInventory,
    // shell
    busy,
    load,
    refresh,
  };
}
