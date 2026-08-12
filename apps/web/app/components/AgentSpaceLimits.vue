<script setup lang="ts">
import { computed } from "vue";
import ProviderLogo from "~/components/ProviderLogo.vue";
import SmoothResize from "~/components/SmoothResize.vue";
import { SESSION_BRAND } from "~/types/session";
import type {
  MetricValue,
  ProviderKind,
  QuotaProviderReport,
  QuotaWindow,
  SpendTile,
  TrendPoint,
} from "~/types/desktop";
import type { QuotaProvider, useAgentSpace } from "~/composables/useAgentSpace";

// The Limits section: one card per provider the picker offers, so a provider is
// never silently missing from the page. Every *number* on a card comes from
// that provider's own accounting — either its usage API, read with the token
// its CLI stored locally, or (for OpenCode) the per-message cost it wrote to a
// local database itself.
//
// the version this replaces: **never draw a number kone did not read.** A value
// we failed to fetch is "No data", not `$0.00`; a rolling window with no usage
// in it says "Not started", not a fabricated countdown; and a model kone cannot
// price is excluded from the totals and named, rather than silently counted as
// free. Zero and unknown look identical on a meter and mean opposite things.

const props = withDefaults(
  defineProps<{ space: ReturnType<typeof useAgentSpace>; foot?: boolean }>(),
  { foot: true },
);

const PROVIDER_LABEL: Record<ProviderKind, string> = {
  codex: "Codex",
  claudeAgent: "Claude",
  opencode: "OpenCode",
  cursor: "Cursor",
  droid: "Factory Droid",
  antigravity: "Antigravity",
};
const providerLabel = (p: ProviderKind) => PROVIDER_LABEL[p] ?? p;
const providerBrand = (p: ProviderKind) => SESSION_BRAND[p] ?? "generic";

/** Why each provider is worth connecting, in its own terms — the generic
 *  sentence the old version used ("kone can read the token…") was true of every
 *  row and therefore told the user nothing about the one in front of them. */
const CONNECT_COPY: Record<QuotaProvider, string> = {
  opencode: "OpenCode records what each request cost to a database on this machine. kone can read it directly — no network call, no credential.",
  claudeAgent: "Ask Anthropic for your remaining 5-hour and weekly limits, using the token Claude's CLI already stored on this machine.",
  codex: "Ask OpenAI for your remaining Codex limits, using the token the Codex CLI already stored on this machine.",
  cursor: "Ask Cursor for your remaining credits and included usage, using the session Cursor already stored on this machine.",
  antigravity: "Ask the language server the Antigravity app (or `agy`) is running for your Session and Weekly pool quotas — no network, and kone never stores a credential.",
  droid: "Ask Factory for your 5-hour, weekly and monthly token-rate limits, using a Factory API key you already hold (FACTORY_API_KEY or ~/.factory/.env) — kone never stores it.",
};

/** Why there is no meter at all — per provider, in its own terms. The point is
 *  to explain the *absence* honestly, so a user who expects a Limits card here
 *  learns the CLI simply keeps no readable figures, not that kone forgot them. */
const UNREADABLE_COPY: Partial<Record<ProviderKind, string>> = {};

// ── per-card state ───────────────────────────────────────────────────────────
// One provider resolves to exactly one of these — the template picks its body
// by kind rather than re-deriving the same branches in every block.
type CardState =
  | { kind: "connected"; report: QuotaProviderReport }
  | { kind: "error"; report: QuotaProviderReport }
  | { kind: "loading" }
  | { kind: "connectable" }
  | { kind: "none" }
  | { kind: "unreadable" };

function stateFor(p: ProviderKind): CardState {
  // A provider kone cannot read a figure from gets the honest note, never a
  // meter and never the quota machinery.
  if (!props.space.isReadable(p)) return { kind: "unreadable" };
  if (props.space.isConnected(p)) {
    if (props.space.quotaLoading.value[p]) return { kind: "loading" };
    const report = props.space.quotas.value[p];
    // No report yet and nothing in flight (the sliver before the first fetch
    // starts) reads the same as loading — there's nothing to show either way.
    if (!report) return { kind: "loading" };
    if (report.connection === "connected") return { kind: "connected", report };
    return { kind: "error", report };
  }
  // In `nuxt dev` there's no desktop bridge, so `credentialPresent` never gets
  // populated and this stays false for every provider — which is exactly right:
  // every card correctly explains there's nothing local to read.
  if (props.space.credentialPresent.value[p] === true) return { kind: "connectable" };
  return { kind: "none" };
}

const cards = computed(() =>
  props.space.limitsProviders.value.map((p) => {
    const state = stateFor(p);
    return {
      provider: p,
      /** The narrowed quota handle — present exactly when the quota machinery
       *  answers for this provider (the unreadable card state never reaches it). */
      quotaProvider: props.space.isReadable(p) ? p : undefined,
      label: providerLabel(p),
      brand: providerBrand(p),
      connectCopy: props.space.isReadable(p) ? CONNECT_COPY[p] : undefined,
      unreadableCopy: state.kind === "unreadable" ? UNREADABLE_COPY[p] ?? "" : undefined,
      state,
      planLabel: state.kind === "connected" || state.kind === "error" ? state.report.planLabel : null,
    };
  }),
);

// ── two tiers ────────────────────────────────────────────────────────────────
// Six providers in one flat column meant scrolling past four paragraphs of "no
// sign-in found" to reach the two meters you opened the page for. So the page
// splits by whether a provider is *reporting a number* at all: the ones that are
// keep the full card (meters, spend, trend) and sit two-up in a grid; the ones
// that aren't collapse to a single ruled line each — same words, a fraction of
// the height, and still every provider present and accounted for.
const reporting = computed(() =>
  cards.value.filter((c) => c.state.kind === "connected" || c.state.kind === "loading"),
);
const quiet = computed(() =>
  cards.value.filter((c) => c.state.kind !== "connected" && c.state.kind !== "loading"),
);

/** The one word that says why a quiet row is quiet, so the column of rows can be
 *  read down its right edge without parsing four different sentences. */
function quietStatus(kind: CardState["kind"]): string {
  if (kind === "error") return "Unreadable";
  if (kind === "connectable") return "Not connected";
  if (kind === "unreadable") return "No figures";
  return "No sign-in";
}

/** The tightest window a provider is reporting, promoted into the card's head as
 *  a percentage — the number you'd otherwise have to find by comparing bars.
 *  Null when nothing is measurable, which is a fact the head then simply omits. */
function peakPercent(report: QuotaProviderReport): number | null {
  const measured = report.windows
    .filter((w) => w.state !== "notStarted" && w.percent !== null)
    .map((w) => w.percent as number);
  return measured.length ? Math.max(...measured) : null;
}

// ── formatting ───────────────────────────────────────────────────────────────
// Compact to three significant figures with a unit suffix, so a column of
// numbers lines up at a glance (`1.94M`, `804K`) instead of forcing the eye to
function formatTokens(value: number | null): string {
  if (value === null) return "No data";
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${trim(value / 1e12)}T`;
  if (abs >= 1e9) return `${trim(value / 1e9)}B`;
  if (abs >= 1e6) return `${trim(value / 1e6)}M`;
  if (abs >= 1e3) return `${trim(value / 1e3)}K`;
  return String(Math.round(value));
}
function trim(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return value.toFixed(digits).replace(/\.0+$/, "");
}

/** Money to the cent, except that sub-cent amounts round to `$0.00` and read as
 *  nothing at all — so anything above zero but below a cent says `<$0.01`. */
function formatDollars(value: number | null): string {
  if (value === null) return "No data";
  if (value > 0 && value < 0.005) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

const INTEGER = new Intl.NumberFormat("en-US");

/** The bare number, without its unit — so a "used of limit" pair can print the
 *  unit once at the end instead of twice ("1,204 of 5,000 credits", never
 *  "1,204 credits of 5,000 credits"). Counts stay exact: compacting 1204 to
 *  "1.20K" would throw away precision the user is entitled to on a credit
 *  balance, which is why token compaction is reserved for token figures. */
function formatBare(m: MetricValue): string {
  if (m.number === null) return "No data";
  const tilde = m.estimated ? "~" : "";
  if (m.kind === "dollars") return tilde + formatDollars(m.number);
  if (m.kind === "percent") return `${tilde}${Math.round(m.number * 100)}%`;
  return tilde + INTEGER.format(Math.round(m.number));
}

/** The one formatter that knows every unit, so a card never needs to branch on
 *  provider to print a number. A null is "No data" — always, everywhere. */
function formatMetric(m: MetricValue | null): string {
  if (!m || m.number === null) return "No data";
  return formatBare(m) + (m.kind === "count" && m.suffix ? ` ${m.suffix}` : "");
}

/** The headline for a window: "used of limit" when there is a cap to measure
 *  against, just the used figure when there isn't, and an honest "Not started"
 *  for a rolling window that has no usage in it yet — a 0% there would look
 *  like a measurement rather than the absence of one. */
function windowValue(w: QuotaWindow): string {
  if (w.state === "notStarted") return "Not started";
  const used = formatBare(w.used);
  if (!w.limit || w.limit.number === null || used === "No data") return formatMetric(w.used);
  const suffix = w.limit.kind === "count" && w.limit.suffix ? ` ${w.limit.suffix}` : "";
  return `${used} of ${formatBare(w.limit)}${suffix}`;
}

/** Whether the meter's foot should repeat the percentage. It shouldn't when the
 *  headline already *is* that percentage — the old card printed "12%" twice on
 *  the same row, which reads as two different facts that happen to agree. */
function showsPercentFoot(w: QuotaWindow): boolean {
  return w.percent !== null && w.state !== "notStarted" && w.used.kind !== "percent";
}

/** A window with nothing in it yet has no bar to draw — an empty track would
 *  claim a measurement of zero rather than the absence of a window. */
function showsBar(w: QuotaWindow): boolean {
  return w.percent !== null && w.state !== "notStarted";
}

/** `resetsAt` is an ISO timestamp; read as "resets in 3h 12m" without a date
 *  library. Two units at most, and "resets shortly" under a minute. A window
 *  that hasn't begun gets no countdown at all — it starts with the next
 *  request, and inventing a figure for it would be fabrication. */
function resetLine(w: QuotaWindow): string | null {
  // The headline already says "Not started"; repeating it here would dress one
  // fact up as two.
  if (w.state === "notStarted") return null;
  if (!w.resetsAt) return null;
  const ms = new Date(w.resetsAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return null;
  if (ms < 60_000) return "resets shortly";
  const totalMinutes = Math.round(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  // Two units at most, and never a zero one — "resets in 5d 0h" spends a word
  // on nothing.
  if (days > 0) return hours > 0 ? `resets in ${days}d ${hours}h` : `resets in ${days}d`;
  if (hours > 0) return minutes > 0 ? `resets in ${hours}h ${minutes}m` : `resets in ${hours}h`;
  return `resets in ${minutes}m`;
}

// Both take a nullable fraction: the template only reaches them behind
// `showsBar(w)`, but that guard lives in a helper the compiler can't narrow
// through, and threading a non-null assertion through four call sites in the
// markup would be noisier than accepting the null here.
const pct = (n: number | null) => Math.round((n ?? 0) * 100);

/** The one place colour carries meaning on this page: comfortable accent until
 *  a window gets tight, amber past three-quarters, the destructive red only
 *  once a window is nearly exhausted. */
function fillColor(percent: number | null): string {
  if (percent === null) return "var(--accent)";
  if (percent > 0.9) return "var(--diff-del)";
  if (percent > 0.75) return "color-mix(in srgb, #d98324 82%, var(--accent))";
  return "var(--accent)";
}

// ── sparkline ────────────────────────────────────────────────────────────────
// A 30-day trend drawn small enough to read as texture rather than a chart —
// the meters above carry the actual numbers, this only answers "is my burn
// rising or falling". Points are normalised against the series' own peak, so
// every provider's line uses the full height regardless of scale.
const SPARK_W = 168;
const SPARK_H = 30;

function sparkPoints(trend: TrendPoint[]): string {
  if (trend.length < 2) return "";
  const peak = Math.max(...trend.map((p) => p.dollars));
  // A flat series at zero has no shape to show; draw it along the floor rather
  // than dividing by zero and scattering points across the middle.
  const scale = peak > 0 ? peak : 1;
  const step = SPARK_W / (trend.length - 1);
  return trend
    .map((p, i) => {
      const x = (i * step).toFixed(1);
      const y = (SPARK_H - 1 - (p.dollars / scale) * (SPARK_H - 2)).toFixed(1);
      return `${x},${y}`;
    })
    .join(" ");
}

/** The same series closed into a shape, so the line can sit on a soft wash
 *  instead of floating — kone's charts read as material, not wireframe. */
function sparkArea(trend: TrendPoint[]): string {
  const pts = sparkPoints(trend);
  if (!pts) return "";
  return `${pts} ${SPARK_W},${SPARK_H} 0,${SPARK_H}`;
}

function sparkSummary(trend: TrendPoint[]): string {
  const total = trend.reduce((sum, p) => sum + p.dollars, 0);
  return `Daily spend over the last ${trend.length} days, ${formatDollars(total)} in total`;
}

function tileTokens(t: SpendTile): string {
  return t.tokens === null ? "" : formatTokens(t.tokens);
}

const ERROR_FALLBACK = "Couldn't read this provider's limits.";
</script>

<template>
  <section class="limits" aria-label="Limits">
    <!-- ══ tier 1 — providers reporting a number ═══════════════════════════ -->
    <div v-if="reporting.length" class="group">
      <div class="cards">
      <article v-for="card in reporting" :key="card.provider" class="card">
        <!-- ── head ─────────────────────────────────────────────────────────── -->
        <header class="card__head">
          <div class="card__id">
            <ProviderLogo :brand="card.brand" :size="16" />
            <span class="card__name">{{ card.label }}</span>
            <span v-if="card.planLabel" class="chip">{{ card.planLabel }}</span>
            <span
              v-if="card.state.kind === 'connected' && peakPercent(card.state.report) !== null"
              class="card__peak"
              :style="{ color: fillColor(peakPercent(card.state.report)) }"
              :title="`Tightest window at ${pct(peakPercent(card.state.report))}%`"
            >{{ pct(peakPercent(card.state.report)) }}%</span>
          </div>

          <div class="card__actions">
            <button
              v-if="card.state.kind === 'connected'"
              type="button"
              class="btn"
              @click="card.quotaProvider && space.loadQuota(card.quotaProvider, true)"
            >
              Refresh
            </button>
            <button
              v-if="
                card.state.kind === 'connected' &&
                card.quotaProvider &&
                space.needsConsent(card.quotaProvider)
              "
              type="button"
              class="btn"
              @click="card.quotaProvider && space.disconnect(card.quotaProvider)"
            >
              Disconnect
            </button>
          </div>
        </header>

        <!-- The head stays put; the body resolves under it. SmoothResize eases the
             card's *height* from the short placeholder to its full content, so a
             card that lands late grows open and the cards below glide down instead
             of jumping — that height snap was the page-shifting. The incoming body
             fades in over the growing box (opacity only, no blur, no rise). -->
        <SmoothResize>
        <!-- ── 1. connected ─────────────────────────────────────────────────── -->
        <div v-if="card.state.kind === 'connected'" :key="'connected'" class="card__body card__reveal">
          <!-- meters, one per window the provider reported -->
          <div v-if="card.state.report.windows.length" class="meters">
            <div v-for="w in card.state.report.windows" :key="w.id" class="meter">
              <div class="meter__head">
                <span class="meter__label">{{ w.label }}</span>
                <span v-if="resetLine(w)" class="meter__when">{{ resetLine(w) }}</span>
                <span class="meter__value">{{ windowValue(w) }}</span>
              </div>
              <div
                v-if="showsBar(w)"
                class="meter__track"
                role="progressbar"
                :aria-valuenow="pct(w.percent)"
                aria-valuemin="0"
                aria-valuemax="100"
                :aria-label="`${card.label} ${w.label} usage, ${pct(w.percent)} percent`"
              >
                <div
                  class="meter__fill"
                  :style="{ width: `${pct(w.percent)}%`, backgroundColor: fillColor(w.percent) }"
                />
              </div>
              <div v-if="showsPercentFoot(w)" class="meter__foot">
                <span class="meter__pct">{{ pct(w.percent) }}%</span>
              </div>
            </div>
          </div>

          <!-- spend tiles + trend, side by side; either half may be absent -->
          <div v-if="card.state.report.spend.length || card.state.report.trend.length" class="strip">
            <dl v-if="card.state.report.spend.length" class="tiles">
              <div v-for="t in card.state.report.spend" :key="t.id" class="tile">
                <dt class="tile__label">{{ t.label }}</dt>
                <dd class="tile__value">{{ t.estimated && (t.dollars ?? 0) > 0 ? "~" : "" }}{{ formatDollars(t.dollars) }}</dd>
                <dd v-if="tileTokens(t)" class="tile__sub">{{ tileTokens(t) }}</dd>
              </div>
            </dl>

            <figure v-if="card.state.report.trend.length > 1" class="spark">
              <svg
                :viewBox="`0 0 ${SPARK_W} ${SPARK_H}`"
                :width="SPARK_W"
                :height="SPARK_H"
                preserveAspectRatio="none"
                role="img"
                :aria-label="sparkSummary(card.state.report.trend)"
              >
                <polygon :points="sparkArea(card.state.report.trend)" class="spark__area" />
                <polyline :points="sparkPoints(card.state.report.trend)" class="spark__line" />
              </svg>
              <figcaption class="spark__cap">30 days</figcaption>
            </figure>
          </div>

          <p v-if="card.state.report.excludedModels.length" class="card__note">
            Left out of these figures because kone has no price for them:
            {{ card.state.report.excludedModels.join(", ") }}.
          </p>

          <p v-if="card.state.report.rateLimited" class="card__note">
            {{ card.label }}'s own usage endpoint is rate-limiting us right now — these figures may be stale.
          </p>

          <!-- A connected read can legitimately carry no windows (a provider
               build that exposes no pools) — say so rather than leaving the
               body blank next to a meterless header. -->
          <p
            v-if="card.state.report.message && !card.state.report.windows.length"
            class="card__note"
          >
            {{ card.state.report.message }}
          </p>
        </div>

        <!-- ── 2. loading: a calm placeholder, never a spinner ───────────────── -->
        <div v-else :key="'loading'" class="meters card__reveal" aria-hidden="true">
          <span v-for="n in 3" :key="n" class="placeholder" :style="{ animationDelay: `${n * 180}ms` }" />
        </div>
        </SmoothResize>
      </article>
      </div>
    </div>

    <!-- ══ tier 2 — everything with no number to draw, one line each ════════ -->
    <div v-if="quiet.length" class="group">
      <ul class="rows">
        <li v-for="card in quiet" :key="card.provider" class="row">
          <div class="row__head">
            <ProviderLogo :brand="card.brand" :size="15" />
            <span class="row__name">{{ card.label }}</span>
            <span class="row__status">{{ quietStatus(card.state.kind) }}</span>

            <button
              v-if="card.state.kind === 'connectable'"
              type="button"
              class="btn btn--go row__btn"
              @click="card.quotaProvider && space.connect(card.quotaProvider)"
            >
              Connect
            </button>
            <button
              v-else-if="card.state.kind === 'error'"
              type="button"
              class="btn row__btn"
              @click="card.quotaProvider && space.loadQuota(card.quotaProvider, true)"
            >
              Try again
            </button>
          </div>

          <p class="row__note">
            <template v-if="card.state.kind === 'error'">{{ card.state.report.message || ERROR_FALLBACK }}</template>
            <template v-else-if="card.state.kind === 'connectable'">{{ card.connectCopy }}</template>
            <template v-else-if="card.state.kind === 'unreadable'">{{ card.unreadableCopy }}</template>
            <template v-else>
              {{
                card.provider === "opencode"
                  ? "OpenCode has written no usage database on this machine, so there is nothing to report."
                  : card.provider === "antigravity"
                    ? "Antigravity isn't signed in on this machine yet — run `agy` once to sign in, then start the app to read your limits."
                    : `No local sign-in found for ${card.label}'s CLI, so there are no limits to report.`
              }}
            </template>
          </p>
        </li>
      </ul>
    </div>

    <p v-if="foot" class="limits__foot">
      Every number is read locally — a provider's own usage API, or OpenCode's cost log — never stored or sent.
      A <span class="tilde">~</span> marks spend kone estimated from token counts.
    </p>
  </section>
</template>

<style scoped>
.limits {
  --limits-ease: cubic-bezier(0.22, 1, 0.36, 1);
  display: flex;
  flex-direction: column;
  gap: 2rem;
  padding-bottom: 2rem;
}

/* ── groups ───────────────────────────────────────────────────────────────── */
/* Two tiers — providers with a number, then providers without — but unlabelled.
   The distinction is already obvious from the shape of what's in each (meters
   versus a single line), and a heading over each was two more things to read on
   a page whose whole problem was having too much to read. */
.group {
  display: flex;
  flex-direction: column;
}

/* Cards run two-up once there's room for a full-width meter in each column —
   the drawer widens to 1040px for this page, which the single column was
   spending on whitespace. Flowed columns rather than a grid on purpose: cards
   differ wildly in height (OpenCode has no meters, Claude has three), and grid
   rows would leave a card-sized hole beside every short one. `columns: 310px 2`
   is its own breakpoint — one column when there isn't room for two. */
.cards {
  columns: 310px 2;
  column-gap: 64px;
}
.cards > * {
  break-inside: avoid;
}

/* No entrance choreography on the cards — they're present the moment the pane
   opens, heads and all. The old blur-rise stagger fired once per card at mount,
   and because each card's quota lands async it turned every late arrival into
   its own little animation; the equivalent has none and reads as instant.
   The only motion left on this page is the body fade below and the meter width. */

/* Body resolve — as the card's height eases open (SmoothResize), the incoming
   content fades in over it. Opacity only, so it reads as one soft reveal rather
   than a separate animation; fires once per state change, not on a refresh (the
   connected element stays mounted, so only its meter widths glide). */
.card__reveal {
  animation: limits-fade-in 0.28s ease both;
}
@keyframes limits-fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

/* ── card ─────────────────────────────────────────────────────────────────── */
/* A hairline rule, not a box — kone separates with air and a single line. */
/* Every card carries its rule, first one included: in a grid the two cells of a
   row have to agree, and the rule under the caption reads as that group's header
   line rather than an orphan. */
.card {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 26px 0 34px;
  border-top: 1px solid color-mix(in srgb, var(--ink) 6%, transparent);
  min-width: 0;
}

.card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.card__id {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.card__name {
  font-size: 14.5px;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The tightest window, promoted into the head and carrying the same colour its
   bar does — so a column of cards can be triaged by glancing down the heads
   without reading a single meter. */
.card__peak {
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  transition: color 140ms ease;
}

.card__actions {
  display: flex;
  align-items: center;
  gap: 4px;
  /* Controls are for the card you're reading, not the whole column. */
  opacity: 0;
  transition: opacity 140ms ease;
}
.card:hover .card__actions,
.card:focus-within .card__actions {
  opacity: 1;
}

.card__body {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.card__note {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--muted);
  max-width: 58ch;
}

/* ── quiet rows ───────────────────────────────────────────────────────────── */
/* A provider with no number to draw costs one ruled line and its sentence — the
   full card it used to get spent a meter's worth of height saying "there is no
   meter". Two-up as well, so four of them read as a short block. */
.rows {
  columns: 310px 2;
  column-gap: 44px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.rows > * {
  break-inside: avoid;
}
.row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 0 14px;
  border-top: 1px solid color-mix(in srgb, var(--ink) 6%, transparent);
  min-width: 0;
}
.row__head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.row__name {
  font-size: 13.5px;
  color: var(--ink);
  white-space: nowrap;
}
/* Why it's quiet, in one word, on the same x-position down the whole column —
   the thing you scan instead of reading four sentences. */
.row__status {
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: color-mix(in srgb, var(--ink) 38%, transparent);
  white-space: nowrap;
}
.row__btn {
  margin-left: auto;
  flex-shrink: 0;
}
.row__note {
  margin: 0;
  padding-left: 23px; /* clears the logo, so the sentence hangs off the name */
  font-size: 12px;
  line-height: 1.5;
  color: var(--muted);
  max-width: 52ch;
}

/* ── meters ───────────────────────────────────────────────────────────────── */
.meters {
  display: flex;
  flex-direction: column;
  gap: 22px;
}
.meter {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.meter__head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 2px 10px;
}
.meter__label {
  font-size: 13px;
  color: var(--ink);
  white-space: nowrap;
}
/* The countdown rides beside its label rather than on a line of its own — three
   lines per meter meant a provider with four windows spent twelve lines saying
   four things. It's the quietest thing on the row, so it sets no rhythm. */
.meter__when {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: color-mix(in srgb, var(--ink) 34%, transparent);
  white-space: nowrap;
}
.meter__value {
  margin-left: auto;
}
/* The number is the point of the row, so it gets the mono treatment and the
   full ink — the label beside it is only a handle for finding it. */
.meter__value {
  font-family: var(--font-mono);
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  color: var(--ink);
  white-space: nowrap;
}
.meter__track {
  height: 5px;
  border-radius: 999px;
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
  overflow: hidden;
}
.meter__fill {
  height: 100%;
  border-radius: 999px;
  transition:
    width 0.5s var(--limits-ease),
    background-color 140ms ease;
}
.meter__foot {
  display: flex;
  align-items: baseline;
  gap: 12px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}

/* ── spend strip ──────────────────────────────────────────────────────────── */
.strip {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px 28px;
  flex-wrap: wrap;
}
.tiles {
  display: flex;
  gap: 28px;
  margin: 0;
  min-width: 0;
  flex-wrap: wrap;
}
.tile {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.tile__label {
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
}
.tile__value {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 17px;
  font-variant-numeric: tabular-nums;
  color: var(--ink);
  line-height: 1.15;
}
.tile__sub {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}

/* ── sparkline ────────────────────────────────────────────────────────────── */
.spark {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  margin: 0;
  /* In a two-up column the trend gives way to the tiles (which carry numbers)
     rather than forcing a wrap; it's texture, and texture can be narrower. */
  flex: 1 1 92px;
  min-width: 92px;
}
.spark svg {
  width: 100%;
  max-width: 168px;
  height: 30px;
}
.spark__area {
  fill: color-mix(in srgb, var(--accent) 10%, transparent);
}
.spark__line {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.25;
  stroke-linejoin: round;
  stroke-linecap: round;
  /* preserveAspectRatio="none" would otherwise stretch the stroke with the box. */
  vector-effect: non-scaling-stroke;
}
.spark__cap {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
}

/* ── loading placeholder — at rest, breathing, never a spinner ─────────────── */
.placeholder {
  height: 5px;
  border-radius: 999px;
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
  animation: limits-breathe 1700ms ease-in-out infinite;
}
@keyframes limits-breathe {
  0%,
  100% {
    opacity: 0.5;
  }
  50% {
    opacity: 1;
  }
}

/* ── chip ─────────────────────────────────────────────────────────────────── */
.chip {
  padding: 2px 7px;
  border-radius: 6px;
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--muted);
  white-space: nowrap;
}

/* ── buttons ──────────────────────────────────────────────────────────────── */
.btn {
  padding: 5px 11px;
  border-radius: 8px;
  font-size: 11.5px;
  color: var(--ink-soft);
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 140ms ease;
}
.btn:hover {
  background-color: var(--hover);
}
.btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
/* The one affordance on this page that asks for a decision, so it's the one
   that carries the accent. */
.btn--go {
  background-color: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--ink);
}
.btn--go:hover {
  background-color: color-mix(in srgb, var(--accent) 18%, transparent);
}

/* ── footer note ──────────────────────────────────────────────────────────── */
.limits__foot {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--muted);
  max-width: 78ch;
}
.limits__foot .tilde {
  font-family: var(--font-mono);
  color: var(--ink-soft);
}

@media (prefers-reduced-motion: reduce) {
  .meter__fill,
  .placeholder,
  .card__actions,
  .card__reveal {
    transition: none;
    animation: none;
  }
  .placeholder {
    opacity: 0.75;
  }
  .card__actions {
    opacity: 1;
  }
}
</style>
