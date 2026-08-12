<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  AlertCircleIcon,
  Copy01Icon,
  LinkSquare02Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import SettingsPageShell from "~/components/SettingsPageShell.vue";
import { useEdgeFade } from "~/composables/useEdgeFade";
import { buildModelCatalog, type BrandKey } from "~/utils/modelCatalog";
import type { ProviderKind, ProviderMaintenance, ProviderStatus } from "~/types/desktop";

// The agent-provider surface, as a place rather than a drawer pane.
//
// It sits inside the settings drawer, but the drawer widens for it (see
// useSettingsSurface) precisely so this can be laid out as a page. The selector
// is a deck of brand-tinted cards — one open, the rest folded to a spine — so the
// provider you're on *is* the hero, its logomark ghosted large across its own
// gradient. The old side-rail and the models readout are gone; what's left is the
// state that actually changes: is it usable, is it current, how does kone reach it.
//
// "Bring your own subscription" still governs everything: no credential ever
// passes through here. The most this page does is name the command the user
// should run in their own terminal, and — for a CLI whose install channel kone
// recognises — run that channel's update for them.

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ back: [] }>();

// The detail beneath the deck scrolls; it carries the shared edge-fade smoke
// rather than a visible bar (see useEdgeFade). It's keyed per provider, so the
// composable re-attaches when the element is replaced.
const scroller = ref<HTMLElement>();
const { measure, maskStyle } = useEdgeFade(scroller);

const { cue } = useSound();
const providers = useAgentProviders();
const providerSettings = useProviderSettings();
const upkeep = useProviderMaintenance();

// Static per-provider facts no probe carries: what to call it, whose it is, its
// logomark, the gradient its card wears, the command that signs it in, and where
// its own docs live. The sign-in commands match the adapters' own not-ready
// messages verbatim — two places telling the user two different commands is worse
// than one place.
type ProviderMeta = {
  label: string;
  vendor: string;
  brand: BrandKey;
  /** The two-stop wash the provider's card wears, brand-hued. */
  grad: string;
  /** One line on what this provider actually is. */
  blurb: string;
  /** External CLI the user installs, or null when kone bundles the runtime. */
  binary: string | null;
  signIn: string | null;
  docs: { href: string; label: string } | null;
};

const PROVIDER_META: Record<ProviderKind, ProviderMeta> = {
  codex: {
    label: "Codex",
    vendor: "OpenAI",
    brand: "codex",
    grad: "linear-gradient(152deg, #14b98d 0%, #0c8a68 100%)",
    blurb: "OpenAI's coding agent, driven through its app-server protocol.",
    binary: "codex",
    signIn: "codex login",
    docs: { href: "https://platform.openai.com/usage", label: "OpenAI usage" },
  },
  claudeAgent: {
    label: "Claude",
    vendor: "Anthropic",
    brand: "claude",
    grad: "linear-gradient(152deg, #e79269 0%, #cf6238 100%)",
    blurb: "Claude Code, driven through the Agent SDK kone ships.",
    binary: null,
    signIn: "claude login",
    docs: {
      href: "https://docs.anthropic.com/en/docs/about-claude/models#rate-limits",
      label: "Anthropic limits",
    },
  },
  cursor: {
    label: "Cursor",
    vendor: "Cursor",
    brand: "cursor",
    grad: "linear-gradient(152deg, #4c4c55 0%, #191920 100%)",
    blurb: "Cursor's agent CLI, driven over ACP.",
    binary: "cursor-agent",
    signIn: "cursor-agent login",
    docs: { href: "https://cursor.com/dashboard", label: "Cursor dashboard" },
  },
  opencode: {
    label: "OpenCode",
    vendor: "OpenCode",
    brand: "opencode",
    grad: "linear-gradient(152deg, #8b7cf6 0%, #5942d6 100%)",
    blurb: "A house of providers — one gateway onto many model vendors.",
    binary: "opencode",
    signIn: "opencode auth login",
    docs: { href: "https://opencode.ai/docs", label: "OpenCode docs" },
  },
  droid: {
    label: "Factory Droid",
    vendor: "Factory",
    brand: "droid",
    grad: "linear-gradient(152deg, #f3a259 0%, #e2653f 100%)",
    blurb: "Factory's Droid CLI, driven over ACP.",
    binary: "droid",
    // Droid pairs a device on first run rather than taking a login subcommand.
    signIn: null,
    docs: null,
  },
  antigravity: {
    label: "Antigravity",
    vendor: "Google",
    brand: "antigravity",
    grad: "linear-gradient(152deg, #6ea8fe 0%, #4285f4 100%)",
    blurb: "Google's agent CLI, driven in print mode with capture hooks.",
    binary: "agy",
    signIn: "agy login",
    docs: { href: "https://antigravity.google", label: "Antigravity" },
  },
};

const ORDER: ProviderKind[] = ["codex", "claudeAgent", "cursor", "opencode", "droid", "antigravity"];

// ── the deck ────────────────────────────────────────────────────────────────

const selected = ref<ProviderKind>("codex");

// The one mark a folded spine may wear. Colour carries the meaning, the shape
// stays constant — a calm dot, never a glyph — so the deck reads at a glance
// without turning into a row of competing icons.
//  • problem   — installed but broken/unavailable: red, the only one that alarms.
//  • attention — installed, not signed in: amber, an ask rather than a fault.
//  • update    — a newer, knowable version is out for an install that's here.
type SpineTone = "problem" | "attention" | "update";
type SpineSignal = { tone: SpineTone; label: string };

type Row = {
  provider: ProviderKind;
  meta: ProviderMeta;
  status: ProviderStatus | null;
  upkeep: ProviderMaintenance | null;
  enabled: boolean;
  /** What this provider's spine is asking for, or null when it's quiet. */
  signal: SpineSignal | null;
};

const rows = computed<Row[]>(() =>
  ORDER.map((provider) => {
    const status = providers.statuses.value.find((s) => s.provider === provider) ?? null;
    const maint = upkeep.forProvider(provider);
    return {
      provider,
      meta: PROVIDER_META[provider],
      status,
      upkeep: maint,
      enabled: providerSettings.isEnabled(provider),
      signal: spineSignal(status, maint),
    };
  }),
);

const current = computed<Row>(
  () => rows.value.find((r) => r.provider === selected.value) ?? (rows.value[0] as Row),
);

function select(provider: ProviderKind) {
  if (selected.value === provider) return;
  selected.value = provider;
  cue("toggle");
}

// ── the masthead ──────────────────────────────────────────────────────────────

const readyCount = computed(
  () => providers.statuses.value.filter((s) => s.readiness === "ready").length,
);

/** Providers kone can honestly call out of date (see useProviderMaintenance). */
const behind = computed(() => upkeep.outdated.value.length);

/** How many installed providers are asking for something the user can act on:
 *  a sign-in that's missing, or a CLI that's here but unreachable. Counted off
 *  the same signal the folded spines wear, so the masthead's summary and the
 *  dots never disagree. */
const attention = computed(
  () => rows.value.filter((r) => r.signal && r.signal.tone !== "update").length,
);

const busy = computed(
  () =>
    providers.loading.value ||
    upkeep.checking.value ||
    Object.values(upkeep.runs.value).some((r) => r?.running),
);

/** "Checked 4 minutes ago" — coarse on purpose. A settings pane that counts
 *  seconds invites you to watch it. */
const checkedLabel = computed(() => {
  const at = upkeep.checkedAt.value;
  if (!at) return null;
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) return "checked just now";
  if (minutes === 1) return "checked a minute ago";
  if (minutes < 60) return `checked ${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? "checked an hour ago" : `checked ${hours} hours ago`;
});

const note = computed(() => {
  const parts: string[] = [];
  if (attention.value) {
    parts.push(`${attention.value} need${attention.value === 1 ? "s" : ""} attention`);
  }
  if (behind.value) {
    parts.push(`${behind.value} update${behind.value === 1 ? "" : "s"} available`);
  } else if (!attention.value && upkeep.checkedAt.value) parts.push("all current");
  if (checkedLabel.value) parts.push(checkedLabel.value);
  return parts.join(" · ");
});

/** Read the whole surface: the probe first, then the install facts.
 *
 *  The order matters and isn't incidental — maintenance takes the *installed*
 *  version from what discovery last wrote, so running the two concurrently would
 *  compare a freshly-probed CLI against a version from before the probe. */
async function refresh(force: boolean) {
  await providers.discover(force);
  await upkeep.check({ force, checkLatest: force || providerSettings.updateChecks.value });
}

/** The masthead's single action, so the page never presents a row of
 *  equal-weight buttons. Asking explicitly overrides the update-checks
 *  preference: pressing Check is itself the consent. */
async function recheck() {
  cue("press");
  await refresh(true);
}

// On entry, the version lookup happens only if the user left it on: it's a
// network call about software they may have pinned deliberately.
watch(
  () => props.open,
  (open) => {
    if (!open) return;
    void providerSettings.load();
    void refresh(false);
  },
  { immediate: true },
);

// ── the provider's page ───────────────────────────────────────────────────────

/** Readiness as a sentence, not a badge. */
function readinessLine(row: Row): { text: string; ready: boolean; bad: boolean } {
  const status = row.status;
  if (!status) return { text: "Checking this machine…", ready: false, bad: false };
  switch (status.readiness) {
    case "ready":
      return { text: status.authLabel ?? "Signed in and ready", ready: true, bad: false };
    case "needs-login":
      return { text: "Installed, but not signed in", ready: false, bad: true };
    case "not-installed":
      return { text: "Not installed on this machine", ready: false, bad: false };
    default:
      return { text: "Unavailable", ready: false, bad: true };
  }
}

const INSTALL_SOURCE_LABEL: Record<string, string> = {
  npm: "npm (global)",
  bun: "bun (global)",
  pnpm: "pnpm (global)",
  homebrew: "Homebrew",
  native: "the CLI's own channel",
  bundled: "bundled with kone",
  unknown: "unrecognised",
};

/** What the version block should say about standing, in words. The distinction
 *  that matters: a CLI kone *can't* look up is not "up to date" and not "behind"
 *  — it's simply not knowable, and saying so is more useful than a guess. */
const standingLine = computed<{ text: string; tone: "ink" | "muted" }>(() => {
  const m = current.value.upkeep;
  if (!m) return { text: "Reading the install…", tone: "muted" };
  if (m.installSource === "bundled") {
    return { text: "Updates arrive with kone itself.", tone: "muted" };
  }
  if (!current.value.status?.available) {
    return { text: "Nothing installed to compare.", tone: "muted" };
  }
  if (m.standing === "behind" && m.latestVersion) {
    return { text: `Version ${m.latestVersion} is available.`, tone: "ink" };
  }
  if (m.standing === "current") return { text: "Up to date.", tone: "muted" };
  if (!m.latestKnowable) {
    return {
      text: "This CLI updates itself and publishes no version kone can read.",
      tone: "muted",
    };
  }
  return { text: "Couldn't reach the registry to compare.", tone: "muted" };
});

const run = computed(() => upkeep.runFor(current.value.provider));

const canUpdate = computed(
  () => Boolean(current.value.upkeep?.canUpdate) && !run.value?.running && !busy.value,
);

async function update() {
  const provider = current.value.provider;
  if (!canUpdate.value) return;
  cue("press");
  const result = await upkeep.update(provider, (statuses) => {
    providers.statuses.value = statuses;
  });
  cue(result.outcome === "failed" ? "error" : "success");
}

/** What became of the last run. Kept on screen until dismissed — an installer's
 *  own words are the only useful thing to read when an update fails. */
const runLine = computed(() => {
  const r = run.value;
  if (!r || r.running) return null;
  if (r.outcome === "succeeded") {
    return { text: "Updated.", bad: false, output: r.output };
  }
  if (r.outcome === "unchanged") {
    return { text: "Already the newest version.", bad: false, output: r.output };
  }
  return {
    text: r.message ?? "The update didn't complete.",
    bad: true,
    output: r.output,
  };
});

// ── the card's single action ──────────────────────────────────────────────────
// The open card carries one pill, at the foot on the right — the inspo's
// Disconnect/Switch slot. It resolves to the one thing this provider is actually
// asking for: an update it's behind on, a sign-in it's missing, a way to reach a
// CLI that isn't here yet — and, when none of those, the picker-visibility toggle
// (kone's parallel to "connected": a ready provider offered in the picker).
type HeroAction =
  | { kind: "update"; label: string }
  | { kind: "signin"; label: string; copy: string }
  | { kind: "docs"; label: string; href: string }
  | { kind: "toggle"; label: string }
  | { kind: "busy" | "idle"; label: string };

const heroAction = computed<HeroAction>(() => {
  const row = current.value;
  const m = row.upkeep;
  if (run.value?.running) return { kind: "busy", label: "Updating…" };
  if (canUpdate.value && row.status?.available && m?.standing === "behind" && m.latestKnowable) {
    return { kind: "update", label: m.latestVersion ? `Update to ${m.latestVersion}` : "Update" };
  }
  if (row.status?.readiness === "needs-login" && row.meta.signIn) {
    return { kind: "signin", label: "Sign in", copy: row.meta.signIn };
  }
  if (row.status?.readiness === "not-installed") {
    return row.meta.docs
      ? { kind: "docs", label: `Get ${row.meta.label}`, href: row.meta.docs.href }
      : { kind: "idle", label: "Not installed" };
  }
  return row.enabled
    ? { kind: "toggle", label: "Hide from picker" }
    : { kind: "toggle", label: "Offer in picker" };
});

/** Whether an honest, knowable newer version is out for an install that's here. */
function hasUpdate(status: ProviderStatus | null, m: ProviderMaintenance | null): boolean {
  return Boolean(m?.standing === "behind" && m.latestKnowable && status?.available);
}

/** The single mark a provider's folded spine wears, resolved once per row (see
 *  Row.signal). Priority runs problem → attention → update: a provider that's
 *  both unreachable and behind is asking to be reached first, and one that needs
 *  signing in wants that before it wants a newer version. Not-installed is
 *  deliberately silent — the card can't act on it, and a dot on every CLI the
 *  user simply hasn't got would be noise, not signal. The open card never wears a
 *  pip; it says all of this in full through its foot pill and status line. */
function spineSignal(
  status: ProviderStatus | null,
  m: ProviderMaintenance | null,
): SpineSignal | null {
  if (status) {
    if (status.readiness === "needs-login") {
      return { tone: "attention", label: "not signed in" };
    }
    if (status.readiness !== "ready" && status.readiness !== "not-installed") {
      return { tone: "problem", label: "unavailable" };
    }
  }
  if (hasUpdate(status, m)) return { tone: "update", label: "update available" };
  return null;
}

/** The line under the name on the open card: where this provider stands, plus a
 *  note when it's ready but the user has folded it out of the picker. */
const heroStatus = computed(() => {
  const r = readinessLine(current.value);
  if (r.ready && !current.value.enabled) return `${r.text} · hidden from the picker`;
  return r.text;
});

function heroClick() {
  const a = heroAction.value;
  if (a.kind === "update") return void update();
  if (a.kind === "signin") return void copy(a.copy);
  if (a.kind === "toggle") return toggleEnabled();
}

// ── the executable ────────────────────────────────────────────────────────────
// A local draft so typing doesn't write through on every keystroke; committed on
// blur / Enter, which is when the adapter gets re-pointed.
const binaryDraft = ref("");
watch(
  [() => current.value.provider, () => providerSettings.binaryPaths.value],
  () => {
    binaryDraft.value = providerSettings.binaryPath(current.value.provider);
  },
  { immediate: true, deep: true },
);

function commitBinary() {
  const provider = current.value.provider;
  if (binaryDraft.value.trim() === providerSettings.binaryPath(provider)) return;
  void providerSettings.setBinaryPath(provider, binaryDraft.value);
  cue("toggle");
  // A different binary is a different install: everything this page says about
  // channel, version and standing has to be re-read.
  void upkeep.check({ force: true, checkLatest: providerSettings.updateChecks.value });
}

function toggleEnabled() {
  const provider = current.value.provider;
  providerSettings.setEnabled(provider, !providerSettings.isEnabled(provider));
  cue("toggle");
}

// ── models ────────────────────────────────────────────────────────────────────
// The right column of the detail: every model family the open provider offers,
// each with its own show/hide toggle. Hiding one writes the same visibility rule
// ProjectView filters the picker through (useProviderSettings.setModelHidden), so
// a model switched off here vanishes from the picker without touching the CLI.
//
// The families are grouped exactly the way the picker groups them — buildModelCatalog
// over the shared modelCache — so a toggle keyed by family core lines up on both
// sides. We ask the catalog for the open provider on entry and on every switch;
// modelCache is a module-scoped singleton, so a list already probed elsewhere is
// served instantly and only a cold provider actually spawns a lookup.
watch(
  [() => props.open, () => current.value.provider],
  ([open]) => {
    if (open) void providers.models(current.value.provider);
  },
  { immediate: true },
);

type ModelRow = {
  key: string;
  label: string;
  brand: BrandKey;
  vendor: string;
  meta: string;
  hidden: boolean;
};

/** Turn a native context capacity into a compact badge — "200K", "1M". */
function contextLabel(tokens: number | undefined): string | null {
  if (!tokens || tokens <= 0) return null;
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M context`;
  }
  return `${Math.round(tokens / 1000)}K context`;
}

/** The model families of the open provider, each with a one-line summary of what
 *  it can do and whether it's currently shown in the picker. */
const modelRows = computed<ModelRow[]>(() => {
  const provider = current.value.provider;
  const descriptors = providers.modelCache.value[provider] ?? [];
  const byId = new Map(descriptors.map((d) => [d.id, d]));
  return buildModelCatalog(descriptors).map((fam) => {
    const rep = fam.efforts[0]?.modelId ? byId.get(fam.efforts[0].modelId) : undefined;
    const tokens =
      fam.contextWindows?.find((w) => w.isDefault)?.tokens ??
      fam.contextWindows?.[0]?.tokens ??
      rep?.contextWindowTokens;

    const bits: string[] = [];
    const ctx = contextLabel(tokens);
    if (ctx) bits.push(ctx);
    // Reasoning breadth as a span — "low → max" — rather than a rung count.
    const real = fam.efforts.filter((e) => e.tier !== "base");
    if (real.length > 1) {
      bits.push(`${real[0]!.label} → ${real[real.length - 1]!.label} reasoning`);
    } else if (real.length === 1) {
      bits.push(`${real[0]!.label} reasoning`);
    }
    if (fam.fastTier) bits.push("fast tier");

    return {
      key: fam.key,
      label: fam.label,
      brand: fam.brand,
      vendor: fam.vendor,
      meta: bits.join(" · "),
      hidden: providerSettings.isModelHidden(provider, fam.key),
    };
  });
});

const hiddenCount = computed(() =>
  providerSettings.hiddenModelCount(
    current.value.provider,
    modelRows.value.map((r) => r.key),
  ),
);

/** Whether the open provider's brand is a harness (opencode/cursor) — then a
 *  model's own vendor is worth naming, since the catalog spans many vendors. */
const showVendor = computed(() =>
  current.value.provider === "opencode" || current.value.provider === "cursor",
);

function toggleModel(key: string) {
  const provider = current.value.provider;
  providerSettings.setModelHidden(provider, key, !providerSettings.isModelHidden(provider, key));
  cue("toggle");
}

function toggleUpdateChecks() {
  providerSettings.updateChecks.value = !providerSettings.updateChecks.value;
  cue("toggle");
  if (providerSettings.updateChecks.value) void upkeep.check({ force: true });
}

// ── copying a command ─────────────────────────────────────────────────────────
// Every command this page names is also copyable, because the honest answer to
// "can kone do this for me?" is sometimes no — and then the user needs the exact
// string, not a paraphrase of it.
const copied = ref<string | null>(null);
let copyTimer: ReturnType<typeof setTimeout> | null = null;

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = text;
    cue("success");
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copied.value = null;
    }, 1_600);
  } catch {
    // A denied clipboard is not worth an error state — the text is on screen.
  }
}
</script>

<template>
  <SettingsPageShell
    :open="open"
    breadcrumb="Agents / Providers"
    label="Providers settings"
    :scroll="false"
    @back="emit('back')"
  >
    <template #actions>
      <!-- Never the primary: when something is behind, the action worth promoting
           is the update on the provider's own card, and two filled buttons on one
           screen means neither of them is the answer. -->
      <div class="pp__act">
        <button
          type="button"
          class="pp__btn"
          :disabled="busy"
          :tabindex="open ? 0 : -1"
          @click="recheck"
        >
          <HugeiconsIcon
            :icon="RefreshIcon"
            :size="13"
            :stroke-width="1.8"
            :class="{ 'pp__spin': busy }"
            aria-hidden="true"
          />
          {{ busy ? "Checking…" : "Check again" }}
        </button>
      </div>
    </template>

    <!-- A running probe or update reads as a thread of light under the masthead,
         the same as the git space — never a spinner over the content. -->
    <template #lede>
      <div class="pp__lede">
        <div class="pp__progress" :class="{ 'pp__progress--on': busy }" aria-hidden="true">
          <i class="pp__progress-run" />
        </div>

        <p v-if="upkeep.error.value" class="pp__error" role="alert">
          <HugeiconsIcon :icon="AlertCircleIcon" :size="13" :stroke-width="1.8" aria-hidden="true" />
          {{ upkeep.error.value }}
        </p>
      </div>
    </template>

    <!-- ── body ─────────────────────────────────────────────────────────────── -->
    <div class="pp__body">
      <!-- The deck: one card open, the rest folded to a brand-hued spine. -->
      <div class="pp__deck" role="tablist" aria-label="Providers">
        <div
          v-for="row in rows"
          :key="row.provider"
          class="pp__card"
          :class="{ 'pp__card--on': selected === row.provider, 'pp__card--off': !row.enabled }"
          :style="{ '--grad': row.meta.grad }"
          role="tab"
          :aria-selected="selected === row.provider ? 'true' : 'false'"
          :aria-label="row.signal ? `${row.meta.label} — ${row.signal.label}` : row.meta.label"
          :tabindex="open ? 0 : -1"
          @click="select(row.provider)"
          @keydown.enter.prevent="select(row.provider)"
          @keydown.space.prevent="select(row.provider)"
        >
          <!-- The logomark, ghosted large across the card's own gradient. -->
          <ProviderLogo :brand="row.meta.brand" tone="mono" :size="228" class="pp__ghost" />

          <!-- The spine mark, shown while the card is folded. -->
          <ProviderLogo :brand="row.meta.brand" tone="mono" :size="19" class="pp__spinemark" />

          <!-- Signal pip: a folded provider that needs something still gets to
               ask — a fault, a sign-in, or an update — the tone carrying which.
               The card's aria-label already speaks it, so the dot is decorative. -->
          <span
            v-if="row.signal"
            class="pp__pip"
            :class="[`pp__pip--${row.signal.tone}`, { 'pp__pip--show': selected !== row.provider }]"
            aria-hidden="true"
          />

          <!-- The open card's foot: name + standing on the left, one pill right. -->
          <div class="pp__foot">
            <div class="pp__ident">
              <ProviderLogo :brand="row.meta.brand" tone="mono" :size="19" class="pp__identmark" />
              <span class="pp__identtext">
                <span class="pp__cardname">{{ row.meta.label }}</span>
                <span class="pp__cardstatus">{{ heroStatus }}</span>
              </span>
            </div>

            <a
              v-if="heroAction.kind === 'docs'"
              class="pp__pill"
              :href="heroAction.href"
              target="_blank"
              rel="noreferrer"
              :tabindex="open ? 0 : -1"
              @click.stop
            >
              {{ heroAction.label }}
              <HugeiconsIcon :icon="LinkSquare02Icon" :size="12" :stroke-width="2" aria-hidden="true" />
            </a>
            <button
              v-else
              type="button"
              class="pp__pill"
              :class="{ 'pp__pill--busy': heroAction.kind === 'busy' }"
              :disabled="heroAction.kind === 'busy' || heroAction.kind === 'idle'"
              :tabindex="open ? 0 : -1"
              @click.stop="heroClick"
            >
              <HugeiconsIcon
                v-if="heroAction.kind === 'busy'"
                :icon="RefreshIcon"
                :size="12"
                :stroke-width="2"
                class="pp__spin"
                aria-hidden="true"
              />
              {{
                heroAction.kind === "signin" && copied === heroAction.copy
                  ? "Copied"
                  : heroAction.label
              }}
            </button>
          </div>
        </div>
      </div>

      <!-- The one setting that isn't about a single provider: whether this page
           may look versions up at all. -->
      <div class="pp__deckfoot">
        <button
          type="button"
          role="switch"
          class="pp__checkrow"
          :aria-checked="providerSettings.updateChecks.value"
          :tabindex="open ? 0 : -1"
          @click="toggleUpdateChecks"
        >
          <span class="pp__checklabel">Check registries for updates when this page opens</span>
          <span
            class="pp__switch"
            :class="{ 'pp__switch--on': providerSettings.updateChecks.value }"
          >
            <i class="pp__knob" />
          </span>
        </button>
      </div>

      <!-- The open provider's detail. Keyed so switching re-runs the entrance
           rather than swapping text under a settled view. -->
      <div :key="current.provider" class="pp__detail">
        <div class="pp__cols">
          <!-- Left: the executable and its standing. -->
          <div class="pp__side">
          <!-- ── version ──────────────────────────────────────────────────── -->
          <section class="pp__block" aria-label="Version">
            <p class="pp__blocklabel">Version</p>

            <dl class="pp__def">
              <dt>Current</dt>
              <dd>{{ current.upkeep?.currentVersion ?? current.status?.version ?? "—" }}</dd>

              <template v-if="current.upkeep?.latestKnowable">
                <dt>Latest</dt>
                <dd>{{ current.upkeep?.latestVersion ?? "—" }}</dd>
              </template>

              <dt>Channel</dt>
              <dd>{{ INSTALL_SOURCE_LABEL[current.upkeep?.installSource ?? "unknown"] }}</dd>

              <template v-if="current.upkeep?.packageName">
                <dt>Package</dt>
                <dd>{{ current.upkeep.packageName }}</dd>
              </template>
            </dl>

            <p class="pp__standing" :class="`pp__standing--${standingLine.tone}`">
              {{ standingLine.text }}
            </p>

            <!-- The exact command kone would run for the card's Update pill,
                 shown before it runs, not after it fails: an update through the
                 wrong package manager is the classic way to end up with two
                 installs. -->
            <div
              v-if="current.upkeep?.canUpdate && current.status?.available && current.upkeep.updateCommand"
              class="pp__cmd pp__cmd--inline"
            >
              <code class="pp__cmdtext">{{ current.upkeep.updateCommand }}</code>
              <button
                type="button"
                class="pp__copy"
                :tabindex="open ? 0 : -1"
                aria-label="Copy the update command"
                @click="copy(current.upkeep.updateCommand!)"
              >
                <HugeiconsIcon :icon="Copy01Icon" :size="12" :stroke-width="1.9" aria-hidden="true" />
                {{ copied === current.upkeep.updateCommand ? "Copied" : "Copy" }}
              </button>
            </div>

            <div v-if="runLine" class="pp__result">
              <p class="pp__resulttext" :class="{ 'pp__resulttext--bad': runLine.bad }">
                {{ runLine.text }}
                <button
                  type="button"
                  class="pp__dismiss"
                  :tabindex="open ? 0 : -1"
                  @click="upkeep.dismissRun(current.provider)"
                >
                  Dismiss
                </button>
              </p>
              <pre v-if="runLine.output" class="pp__output">{{ runLine.output }}</pre>
            </div>
          </section>

          <!-- ── executable ───────────────────────────────────────────────── -->
          <section class="pp__block" aria-label="Executable">
            <p class="pp__blocklabel">Executable</p>

            <template v-if="current.meta.binary">
              <input
                :id="`pp-bin-${current.provider}`"
                v-model="binaryDraft"
                type="text"
                spellcheck="false"
                autocapitalize="off"
                autocorrect="off"
                :placeholder="current.meta.binary"
                :tabindex="open ? 0 : -1"
                class="pp__input"
                :aria-label="`${current.meta.label} CLI path`"
                @change="commitBinary"
                @blur="commitBinary"
                @keydown.enter.prevent="commitBinary"
              />
              <p class="pp__hint">
                Leave blank to use <code>{{ current.meta.binary }}</code> from your PATH.
              </p>

              <dl v-if="current.upkeep?.resolvedPath" class="pp__def">
                <dt>Resolved</dt>
                <dd>{{ current.upkeep.resolvedPath }}</dd>
                <template v-if="current.upkeep.realPath">
                  <dt>Points at</dt>
                  <dd>{{ current.upkeep.realPath }}</dd>
                </template>
              </dl>
            </template>

            <p v-else class="pp__hint">
              kone runs the Claude Code CLI bundled with the Agent SDK, so there's no path to
              set and nothing on your machine to keep current.
            </p>
          </section>
          </div>

          <!-- Right: every model this provider offers, each with its own switch
               for whether the picker shows it. -->
          <section class="pp__models" aria-label="Models">
            <div class="pp__modelshead">
              <p class="pp__blocklabel">Models</p>
              <p v-if="modelRows.length" class="pp__modelscount">
                {{ modelRows.length }} offered<template v-if="hiddenCount">
                  · {{ hiddenCount }} hidden</template
                >
              </p>
            </div>

            <ul
              v-if="modelRows.length"
              ref="scroller"
              class="pp__modellist"
              :style="maskStyle"
              @scroll.passive="measure"
            >
              <li v-for="row in modelRows" :key="row.key" class="pp__model" :class="{ 'pp__model--off': row.hidden }">
                <ProviderLogo :brand="row.brand" :size="16" class="pp__modelmark" />
                <span class="pp__modeltext">
                  <span class="pp__modelname">{{ row.label }}</span>
                  <span v-if="row.meta || showVendor" class="pp__modelmeta">
                    <template v-if="showVendor && row.vendor">{{ row.vendor }}</template
                    ><template v-if="showVendor && row.vendor && row.meta"> · </template
                    >{{ row.meta }}
                  </span>
                </span>
                <button
                  type="button"
                  role="switch"
                  class="pp__switch pp__modelswitch"
                  :class="{ 'pp__switch--on': !row.hidden }"
                  :aria-checked="!row.hidden"
                  :aria-label="`Show ${row.label} in the picker`"
                  :tabindex="open ? 0 : -1"
                  @click="toggleModel(row.key)"
                >
                  <i class="pp__knob" />
                </button>
              </li>
            </ul>

            <p v-else class="pp__hint">
              {{
                current.status?.readiness === "ready"
                  ? "No models to list — this provider reported none."
                  : "Sign this provider in to read the models it offers."
              }}
            </p>
          </section>
        </div>
      </div>
    </div>

    <!-- The standing rule this whole surface rests on, said once at the foot of
         the page rather than repeated as a reassurance on every block — the
         masthead's state line and note folded in beside it. -->
    <template #foot>
      {{ readyCount }} of {{ ORDER.length }} ready<template v-if="note"> · {{ note }}</template> —
      kone drives the agent CLIs you've already signed into, with your own subscription, and never
      stores your credentials.
    </template>
  </SettingsPageShell>
</template>

<style scoped>
/* One motion vocabulary for the page, the same shape the git space uses: things
   that arrive decelerate, things that move in place ease at both ends. */
.pp__act,
.pp__lede,
.pp__body {
  --pp-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --pp-ease-move: cubic-bezier(0.65, 0, 0.35, 1);
  --pp-t-micro: 140ms;
  --pp-t-small: 220ms;
  --pp-t-enter: 320ms;
  --pp-t-fold: 460ms;
  --pp-t-sweep: 1100ms;
}
/* Thin wrappers that only carry the tokens (and, for the lede, the progress
   thread + error line) — display:contents so their children sit directly in the
   shell's masthead-action slot and its flow beneath the masthead. */
.pp__act,
.pp__lede {
  display: contents;
}

@keyframes pp-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* The app's one button recipe: bare until hovered, then a soft pill. */
.pp__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 27px;
  padding-inline: 11px;
  border-radius: 8px;
  font-size: 11px;
  color: var(--ink-soft);
  cursor: pointer;
  white-space: nowrap;
  transition:
    background-color var(--pp-t-micro) ease,
    opacity var(--pp-t-micro) ease;
}
.pp__btn:hover:not(:disabled) {
  background-color: var(--hover);
}
.pp__btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.pp__btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.pp__spin {
  animation: pp-spin 900ms linear infinite;
}
@keyframes pp-spin {
  to {
    transform: rotate(360deg);
  }
}

.pp__progress {
  position: relative;
  height: 2px;
  margin-top: 18px;
  overflow: hidden;
  border-radius: 1px;
  opacity: 0;
  transition: opacity var(--pp-t-small) ease;
  flex-shrink: 0;
}
.pp__progress--on {
  opacity: 1;
}
.pp__progress-run {
  position: absolute;
  inset-block: 0;
  width: 38%;
  border-radius: 1px;
  background: linear-gradient(
    90deg,
    transparent,
    color-mix(in srgb, var(--accent) 70%, transparent),
    transparent
  );
  transform: translateX(-100%);
}
.pp__progress--on .pp__progress-run {
  animation: pp-sweep var(--pp-t-sweep) linear infinite;
}
@keyframes pp-sweep {
  to {
    transform: translateX(365%);
  }
}

.pp__error {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 10px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--diff-del);
  flex-shrink: 0;
}

/* ── body ─────────────────────────────────────────────────────────────────── */
.pp__body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  padding-inline: 1rem;
}

/* ── the deck ───────────────────────────────────────────────────────────────
   A row of cards: the open one grows to fill, the rest fold to a spine. The fold
   is a flex-grow transition — Chromium (this is Electron) animates it — so the
   cards ease open and shut rather than jumping. */
.pp__deck {
  display: flex;
  gap: 10px;
  height: 196px;
  flex-shrink: 0;
  animation: pp-in var(--pp-t-enter) var(--pp-ease) 40ms backwards;
}
.pp__card {
  position: relative;
  flex-grow: 0;
  flex-basis: 64px;
  min-width: 64px;
  border-radius: 20px;
  overflow: hidden;
  cursor: pointer;
  background: var(--grad);
  transition:
    flex-grow var(--pp-t-fold) var(--pp-ease),
    filter var(--pp-t-micro) ease;
  will-change: flex-grow;
}
.pp__card--on {
  flex-grow: 1;
  cursor: default;
}
.pp__card:not(.pp__card--on):hover {
  filter: brightness(1.06);
}
.pp__card:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 45%, transparent);
}
/* A folded provider the user has hidden from the picker still keeps its place —
   it just reads quieter. */
.pp__card--off:not(.pp__card--on) {
  filter: saturate(0.55) brightness(0.92);
}

/* The oversized logomark, bled off the card's trailing edge. */
.pp__ghost {
  position: absolute;
  top: 50%;
  right: -34px;
  transform: translateY(-50%);
  opacity: 0;
  color: #fff;
  pointer-events: none;
  transition: opacity var(--pp-t-fold) var(--pp-ease);
}
.pp__card--on .pp__ghost {
  opacity: 0.14;
}

/* The spine mark, centred low while the card is folded; it fades as the card
   opens and its own foot mark takes over. */
.pp__spinemark {
  position: absolute;
  left: 50%;
  bottom: 20px;
  transform: translateX(-50%);
  color: #fff;
  opacity: 0.94;
  transition: opacity var(--pp-t-small) ease;
  pointer-events: none;
}
.pp__card--on .pp__spinemark {
  opacity: 0;
}

/* Signal pip: a single quiet dot near the top of a folded spine — no motion, no
   halo, just a mark that's there when you look. Colour carries the meaning; a
   hairline ring keeps that colour legible on any brand gradient without a heavy
   shadow. It fades out as its card opens (the open card speaks in full). */
.pp__pip {
  position: absolute;
  top: 15px;
  left: 50%;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  opacity: 0;
  transform: translateX(-50%);
  transition: opacity var(--pp-t-small) ease;
  pointer-events: none;
  box-shadow: 0 0 0 1px color-mix(in srgb, #000 22%, transparent);
}
.pp__pip--show {
  opacity: 1;
}
/* An update is neutral news — the same light the open card's pill wears. */
.pp__pip--update {
  background-color: rgba(255, 255, 255, 0.95);
}
/* A sign-in is an ask, not a fault — a warm amber that reads on every wash. */
.pp__pip--attention {
  background-color: #f5c15a;
}
/* Unreachable is the one state that alarms — the app's own delete/red. */
.pp__pip--problem {
  background-color: #f0685a;
}

.pp__foot {
  position: absolute;
  inset: auto 20px 18px 20px;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  opacity: 0;
  transform: translateY(6px);
  transition:
    opacity var(--pp-t-small) var(--pp-ease),
    transform var(--pp-t-small) var(--pp-ease);
  /* The folded card is 64px wide — its foot must not reflow while collapsed. */
  pointer-events: none;
}
.pp__card--on .pp__foot {
  opacity: 1;
  transform: none;
  transition-delay: 120ms;
  pointer-events: auto;
}
.pp__ident {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.pp__identmark {
  flex-shrink: 0;
  color: #fff;
}
.pp__identtext {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.pp__cardname {
  font-size: 14px;
  letter-spacing: -0.2px;
  line-height: 1.1;
  color: #fff;
  white-space: nowrap;
}
.pp__cardstatus {
  font-size: 11.5px;
  line-height: 1.2;
  color: rgba(255, 255, 255, 0.78);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* The card's one pill: a solid light chip, dark ink — the Disconnect/Switch
   slot from the inspo, doubling as the state readout. */
.pp__pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  height: 32px;
  padding-inline: 15px;
  border-radius: 999px;
  background-color: rgba(255, 255, 255, 0.94);
  color: #17171a;
  font-size: 12px;
  letter-spacing: -0.1px;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  text-decoration: none;
  transition:
    background-color var(--pp-t-micro) ease,
    transform var(--pp-t-micro) var(--pp-ease-move);
}
.pp__pill:hover:not(:disabled) {
  background-color: #fff;
  transform: translateY(-1px);
}
.pp__pill:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.7);
}
.pp__pill:disabled {
  cursor: default;
}
.pp__pill--busy {
  background-color: rgba(255, 255, 255, 0.78);
}

/* ── the check-for-updates setting ──────────────────────────────────────────── */
.pp__deckfoot {
  display: flex;
  justify-content: flex-end;
  flex-shrink: 0;
  margin-top: 12px;
}
.pp__checkrow {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  padding: 6px 8px 6px 12px;
  border-radius: 999px;
  cursor: pointer;
  transition: background-color var(--pp-t-micro) ease;
}
.pp__checkrow:hover {
  background-color: var(--hover);
}
.pp__checkrow:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.pp__checklabel {
  font-size: 11.5px;
  line-height: 1.2;
  color: var(--muted);
}

/* ── the switch ───────────────────────────────────────────────────────────── */
.pp__switch {
  position: relative;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  width: 34px;
  height: 20px;
  border-radius: 999px;
  background-color: color-mix(in srgb, var(--ink) 14%, transparent);
  transition: background-color var(--pp-t-small) ease;
}
.pp__switch--on {
  background-color: var(--ink);
}
.pp__knob {
  position: absolute;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background-color: var(--ground);
  transform: translateX(2px);
  transition: transform var(--pp-t-small) var(--pp-ease-move);
  /* A hairline keeps the knob legible on either track without a shadow. */
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 10%, transparent);
}
.pp__switch--on .pp__knob {
  transform: translateX(16px);
}

/* ── the open provider's detail ─────────────────────────────────────────────── */
.pp__detail {
  /* A query container so the two columns respond to the panel's own width, not
     the window's — the drawer is derived from the window but isn't it. */
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  margin-top: 22px;
  /* The detail itself doesn't scroll — the left column is pinned and the model
     roster carries its own scroll (below), so the executable never drifts. */
  overflow: hidden;
  animation: pp-in var(--pp-t-small) var(--pp-ease) backwards;
}

/* Two columns once there's room: the executable and its standing on the left,
   the model roster on the right. They stack on a narrow panel. The cols fill the
   detail's height so the roster column has a height to scroll within. */
.pp__cols {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  gap: 34px 56px;
  align-items: stretch;
  flex: 1 1 auto;
  min-height: 0;
}
@container (min-width: 660px) {
  .pp__cols {
    grid-template-columns: minmax(240px, 320px) minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
  }
}
.pp__side {
  display: flex;
  flex-direction: column;
  gap: 30px;
  min-width: 0;
  min-height: 0;
}
.pp__block {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}
.pp__blocklabel {
  font-size: 10px;
  letter-spacing: 0.08em;
  line-height: 1;
  text-transform: uppercase;
  color: var(--muted);
}

/* ── the model roster ───────────────────────────────────────────────────────── */
.pp__models {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  min-height: 0;
}
.pp__modelshead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-shrink: 0;
}
.pp__modelscount {
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
.pp__modellist {
  display: flex;
  flex-direction: column;
  list-style: none;
  margin: 0;
  /* Its own scroll, independent of the pinned left column. The edge-fade smoke
     (bound from useEdgeFade) stands in for a visible bar. */
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 8px 0 0;
  scrollbar-width: none;
}
.pp__modellist::-webkit-scrollbar {
  width: 0;
  height: 0;
}
.pp__model {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 9px 4px;
  min-width: 0;
  /* A hairline divider, not a boxed row — the same low-contrast register the
     rest of the app keeps to. */
  border-top: 1px solid color-mix(in srgb, var(--ink) 6%, transparent);
}
.pp__model:first-child {
  border-top: none;
}
.pp__modelmark {
  flex-shrink: 0;
  transition: opacity var(--pp-t-micro) ease;
}
.pp__modeltext {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1 1 auto;
}
.pp__modelname {
  font-size: 12.5px;
  line-height: 1.25;
  letter-spacing: -0.1px;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pp__modelmeta {
  font-size: 11px;
  line-height: 1.3;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pp__modelswitch {
  cursor: pointer;
}
.pp__modelswitch:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
/* A hidden model reads back but doesn't shout — its mark and name dim, the switch
   stays fully legible so the way back is obvious. */
.pp__model--off .pp__modelmark {
  opacity: 0.4;
}
.pp__model--off .pp__modelname {
  color: var(--muted);
}

.pp__hint {
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--muted);
  text-wrap: pretty;
}
.pp__hint code {
  font-family: var(--font-mono);
  font-size: 11px;
}

/* Identifiers — versions, paths, package names, commands — are mono in their
   natural case, set as a two-column definition list so the values align. */
.pp__def {
  display: grid;
  grid-template-columns: 78px minmax(0, 1fr);
  gap: 5px 16px;
  width: 100%;
}
.pp__def dt {
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--muted);
}
.pp__def dd {
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.4;
  font-variant-numeric: tabular-nums;
  color: var(--ink-soft);
  overflow-wrap: anywhere;
}

.pp__standing {
  font-size: 12px;
  line-height: 1.4;
}
.pp__standing--ink {
  color: var(--ink);
}
.pp__standing--muted {
  color: var(--muted);
}

/* A command, on the surface rather than in a box: a soft fill, the text mono in
   its own case, and a copy affordance that only colours up on hover. */
.pp__cmd {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  padding: 6px 6px 6px 10px;
  border-radius: 8px;
  background-color: var(--hover);
}
.pp__cmdtext {
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--ink-soft);
  overflow-wrap: anywhere;
}
.pp__copy {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  height: 22px;
  padding-inline: 7px;
  border-radius: 6px;
  font-size: 11px;
  line-height: 1;
  color: var(--muted);
  cursor: pointer;
  transition:
    color var(--pp-t-micro) ease,
    background-color var(--pp-t-micro) ease;
}
.pp__copy:hover {
  color: var(--ink);
  background-color: color-mix(in srgb, var(--ink) 8%, transparent);
}
.pp__copy:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

.pp__result {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}
.pp__resulttext {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--ink-soft);
}
.pp__resulttext--bad {
  color: var(--diff-del);
}
.pp__dismiss {
  font-size: 11px;
  line-height: 1;
  color: var(--muted);
  cursor: pointer;
  transition: color var(--pp-t-micro) ease;
}
.pp__dismiss:hover {
  color: var(--ink);
}
/* The installer's own words. Scrollable and small, because it's evidence rather
   than reading — and it's the thing that actually names a failed update's cause. */
.pp__output {
  max-height: 132px;
  overflow: auto;
  padding: 9px 11px;
  border-radius: 8px;
  background-color: var(--hover);
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--muted);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  scrollbar-width: thin;
}

.pp__input {
  width: 100%;
  padding: 7px 10px;
  border-radius: 8px;
  background-color: var(--hover);
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--ink-soft);
  transition: box-shadow var(--pp-t-micro) ease;
}
.pp__input::placeholder {
  color: var(--muted);
}
.pp__input:focus {
  outline: none;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 22%, transparent);
}

@media (prefers-reduced-motion: reduce) {
  .pp__deck,
  .pp__detail {
    animation: none;
  }
  .pp__card,
  .pp__ghost,
  .pp__spinemark,
  .pp__foot,
  .pp__knob,
  .pp__btn,
  .pp__pill,
  .pp__progress {
    transition: none;
  }
  .pp__spin,
  .pp__progress--on .pp__progress-run {
    animation: none;
  }
  .pp__progress--on .pp__progress-run {
    transform: none;
    width: 100%;
  }
}
</style>
