// ── Provider quota / usage-limits data model ────────────────────────────────
// kone's "Agents" page can show a live read of how much of a provider's own
// subscription quota is left — but only for a provider the user has
// explicitly opted into per-provider (nothing here is read or fetched until
// then). The mechanism is local-first: read what the provider's own CLI
// already wrote to this machine — an OAuth token, or in OpenCode's case a
// local usage database — and derive the report from that. Same "bring your own
// subscription" stance as the rest of apps/desktop/src/agent, extended from
// "can this CLI run" to "how much quota does it have left".
//
// A window carries *values* with a unit, not a bare percentage. That
// distinction is the whole reason this model was
// rewritten — Claude bills a percentage of a rolling window, OpenCode bills
// dollars against a dollar cap, and Cursor bills credits. A single `percent`
// field could only ever tell one of those three stories honestly.

/** What a number *is*, so the UI can format it without a per-provider special
 *  case: a share of a window, an amount of money, or a plain tally. */
export type MetricKind = "percent" | "dollars" | "count";

/** One number kone is prepared to put on screen.
 *
 *  is strict about this and so is kone: showing `$0.00` when we simply failed
 *  to read a provider is a lie that reads as good news. A null renders as
 *  "No data" and nothing else. */
export type MetricValue = {
  number: number | null;
  kind: MetricKind;
  /** A short unit-ish suffix for `count` values ("credits", "requests"); unused
   *  for percent/dollars, which format themselves. */
  suffix?: string;
  /** True when kone computed this rather than the provider reporting it — e.g.
   *  a cost priced from local token counts. Surfaces as a "~" and a footnote,
   *  because an estimate presented as fact is the same lie in a smaller font. */
  estimated?: boolean;
};

/** Whether a rolling window is actually running.
 *
 *  `notStarted` matters: a rolling 5-hour window with no usage in it hasn't
 *  begun, so it has no reset time. Rendering "resets in 5h 0m" there would be
 *  a fabricated countdown — the window starts when the user's next request
 *  does. */
export type QuotaWindowState = "active" | "notStarted" | "unknown";

/** One usage window inside a provider's report — Claude's 5-hour burst, its
 *  weekly rolling limit, OpenCode's session/week/month caps, Cursor's credits. */
export type QuotaWindow = {
  /** Stable machine id, so the UI can key and order windows without matching
   *  on a human label that may be provider-worded. */
  id: string;
  label: string;
  /** How much of the window is consumed, in the provider's own unit. */
  used: MetricValue;
  /** The cap, when the provider publishes one. Null for an uncapped meter that
   *  only counts up (some plans genuinely have no ceiling to draw). */
  limit: MetricValue | null;
  /** 0..1 fraction consumed, or null when it can't be known (no cap, or no
   *  data). Never synthesised from a null `used` — a null here draws no bar. */
  percent: number | null;
  state: QuotaWindowState;
  resetsAt: string | null;
};

/** A spend figure for a fixed calendar span, as the provider cards show it —
 *  "Today · $4.08 · 1.2M tokens". Money and tokens are separate nullables
 *  because a provider can report one without the other. */
export type SpendTile = {
  id: string;
  label: string;
  dollars: number | null;
  tokens: number | null;
  estimated: boolean;
};

/** One day on a provider card's trend sparkline. Days with no usage are still
 *  present with `dollars: 0` — a gap in a trend line is a different claim from
 *  a zero, and for a daily series the zero is the true one. */
export type TrendPoint = {
  /** `YYYY-MM-DD`, in the user's local time. */
  date: string;
  dollars: number;
  tokens: number;
};

/** How a provider's quota report resolved. `disconnected` = no credential
 *  found (the provider was never connected, or its CLI was never logged in);
 *  `accessDenied` = a credential exists but the OS (Keychain) refused to hand
 *  it over; `stale` = a cached report is being shown while a fresh fetch is
 *  in flight or backed off; `transientFailure` = a retryable error (network,
 *  5xx, a stale token that failed to refresh); `terminalFailure` = a 4xx that
 *  won't resolve on retry (e.g. the account itself was rejected). */
export type QuotaConnection =
  | "connected"
  | "disconnected"
  | "accessDenied"
  | "stale"
  | "transientFailure"
  | "terminalFailure";

/** The provider kinds this module can report on. A subset of kone's full
 *  ProviderKind — quota is only meaningful for a subscription-metered CLI.
 *  Factory Droid publishes nothing to read. */
export type QuotaCapableProvider =
  | "claudeAgent"
  | "codex"
  | "opencode"
  | "cursor"
  | "antigravity";

/** One provider's quota report, as the Agents page renders it. Every path
 *  through fetchProviderQuota resolves to one of these — it never throws. */
export type QuotaProviderReport = {
  provider: QuotaCapableProvider;
  connection: QuotaConnection;
  /** The single most representative window (usually the weekly/rolling one) —
   *  what a compact row shows when there's room for only one number. */
  primary: QuotaWindow | null;
  /** Every window the provider reported, primary included. */
  windows: QuotaWindow[];
  /** Today / Yesterday / Last 30 days, when the provider's data supports it. */
  spend: SpendTile[];
  /** Daily series for the card's sparkline, oldest first. Empty when unknown. */
  trend: TrendPoint[];
  /** The subscription tier/plan label, when the provider's response (or the
   *  credential itself) names one — e.g. "Max 20x", "Plus", "Team". */
  planLabel: string | null;
  /** Models whose cost kone could not price, and therefore left *out* of every
   *  model at zero understates spend and the user never finds out. Naming them
   *  is what makes the exclusion honest. */
  excludedModels: string[];
  /** Set when this report reflects a 429 backoff window rather than a fresh
   *  fetch, so the UI can say so honestly instead of a generic "waiting". */
  rateLimited?: boolean;
  /** ms epoch this report was produced. */
  fetchedAt: number;
  /** Human-readable reason when `connection` isn't `"connected"` — shown as
   *  the row's explanatory line. */
  message?: string;
};

// ── constructors ────────────────────────────────────────────────────────────
// Small helpers so every provider builds the same shapes the same way, and so
// "no data" stays a deliberate `null` rather than a zero someone typed in a
// hurry.

export const dollars = (n: number | null, estimated = false): MetricValue => ({
  number: n,
  kind: "dollars",
  estimated,
});

export const percent = (n: number | null): MetricValue => ({ number: n, kind: "percent" });

export const count = (n: number | null, suffix?: string): MetricValue => ({
  number: n,
  kind: "count",
  suffix,
});

/** A report for a provider that resolved to something other than a live read.
 *  Centralised so no provider forgets a field and quietly ships an empty array
 *  as a meaningful zero. */
export function emptyReport(
  provider: QuotaCapableProvider,
  connection: QuotaConnection,
  message?: string,
): QuotaProviderReport {
  return {
    provider,
    connection,
    primary: null,
    windows: [],
    spend: [],
    trend: [],
    planLabel: null,
    excludedModels: [],
    fetchedAt: Date.now(),
    message,
  };
}
