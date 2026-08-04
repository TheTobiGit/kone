<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  AlertCircleIcon,
  ArrowTurnBackwardIcon,
  CheckmarkCircle02Icon,
  Copy01Icon,
  LinkSquare02Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import type { BrandKey } from "~/utils/modelCatalog";
import type { ProviderKind, ProviderMaintenance, ProviderStatus } from "~/types/desktop";

// The agent-provider surface, as a place rather than a drawer pane.
//
// It sits inside the settings drawer, but the drawer widens for it (see
// useSettingsSurface) precisely so this can be laid out as a page: a masthead
// that speaks for the whole surface, a rail of the providers kone can drive, and
// one panel that is that provider's own page. Nothing here is a card and nothing
// is boxed — the same borderless, low-contrast surface the rest of the app uses.
//
// Three things live on a provider's page, in the order someone actually needs
// them: is it usable (readiness + sign-in), is it current (version, channel, the
// one command that updates it), and how does kone reach it (executable path,
// whether it's offered in the picker).
//
// "Bring your own subscription" still governs everything: no credential ever
// passes through here. The most this page does is name the command the user
// should run in their own terminal, and — for a CLI whose install channel kone
// recognises — run that channel's update for them.

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ back: [] }>();

const { cue } = useSound();
const providers = useAgentProviders();
const providerSettings = useProviderSettings();
const upkeep = useProviderMaintenance();

// Static per-provider facts no probe carries: what to call it, whose it is, its
// logomark, the command that signs it in, and where its own docs live. The
// sign-in commands match the adapters' own not-ready messages verbatim — two
// places telling the user two different commands is worse than one place.
type ProviderMeta = {
  label: string;
  vendor: string;
  brand: BrandKey;
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
    blurb: "OpenAI's coding agent, driven through its app-server protocol.",
    binary: "codex",
    signIn: "codex login",
    docs: { href: "https://platform.openai.com/usage", label: "OpenAI usage" },
  },
  claudeAgent: {
    label: "Claude",
    vendor: "Anthropic",
    brand: "claude",
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
    blurb: "Cursor's agent CLI, driven over ACP.",
    binary: "cursor-agent",
    signIn: "cursor-agent login",
    docs: { href: "https://cursor.com/dashboard", label: "Cursor dashboard" },
  },
  opencode: {
    label: "OpenCode",
    vendor: "OpenCode",
    brand: "opencode",
    blurb: "A house of providers — one gateway onto many model vendors.",
    binary: "opencode",
    signIn: "opencode auth login",
    docs: { href: "https://opencode.ai/docs", label: "OpenCode docs" },
  },
  droid: {
    label: "Factory Droid",
    vendor: "Factory",
    brand: "droid",
    blurb: "Factory's Droid CLI, driven over ACP.",
    binary: "droid",
    // Droid pairs a device on first run rather than taking a login subcommand.
    signIn: null,
    docs: null,
  },
};

const ORDER: ProviderKind[] = ["codex", "claudeAgent", "cursor", "opencode", "droid"];

// ── the rail ──────────────────────────────────────────────────────────────────

const selected = ref<ProviderKind>("codex");

type Row = {
  provider: ProviderKind;
  meta: ProviderMeta;
  status: ProviderStatus | null;
  upkeep: ProviderMaintenance | null;
  enabled: boolean;
};

const rows = computed<Row[]>(() =>
  ORDER.map((provider) => ({
    provider,
    meta: PROVIDER_META[provider],
    status: providers.statuses.value.find((s) => s.provider === provider) ?? null,
    upkeep: upkeep.forProvider(provider),
    enabled: providerSettings.isEnabled(provider),
  })),
);

const current = computed<Row>(
  () => rows.value.find((r) => r.provider === selected.value) ?? (rows.value[0] as Row),
);

const activeIndex = computed(() => Math.max(0, ORDER.indexOf(selected.value)));

function select(provider: ProviderKind) {
  if (selected.value === provider) return;
  selected.value = provider;
  cue("toggle");
}

/** The one word a rail row owes the user: what this provider needs from them.
 *  A ready, current provider says nothing at all — the calm default. */
function railHint(row: Row): { text: string; tone: "bad" | "ink" | "muted" } | null {
  if (!row.status) return { text: "checking", tone: "muted" };
  if (row.status.readiness === "needs-login") return { text: "sign in", tone: "bad" };
  if (row.status.readiness === "not-installed") return { text: "missing", tone: "muted" };
  if (row.status.readiness === "error") return { text: "unavailable", tone: "bad" };
  const run = upkeep.runFor(row.provider);
  if (run?.running) return { text: "updating", tone: "ink" };
  if (row.upkeep?.standing === "behind" && row.upkeep.latestKnowable) {
    return { text: "update", tone: "ink" };
  }
  if (!row.enabled) return { text: "hidden", tone: "muted" };
  return null;
}

// ── the masthead ──────────────────────────────────────────────────────────────

const readyCount = computed(
  () => providers.statuses.value.filter((s) => s.readiness === "ready").length,
);

/** Providers kone can honestly call out of date (see useProviderMaintenance). */
const behind = computed(() => upkeep.outdated.value.length);

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
  if (behind.value) {
    parts.push(`${behind.value} update${behind.value === 1 ? "" : "s"} available`);
  } else if (upkeep.checkedAt.value) parts.push("all current");
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

/** The update button's own label, which doubles as the state readout — a button
 *  that says "Update to 0.52.1" needs no separate sentence next to it. */
const updateLabel = computed(() => {
  const m = current.value.upkeep;
  if (run.value?.running) return "Updating…";
  if (m?.standing === "behind" && m.latestVersion) return `Update to ${m.latestVersion}`;
  return "Update";
});

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

function toggleUpdateChecks() {
  providerSettings.updateChecks.value = !providerSettings.updateChecks.value;
  cue("toggle");
  if (providerSettings.updateChecks.value) void upkeep.check({ force: true });
}

// ── models ────────────────────────────────────────────────────────────────────
// Read from the catalog the picker already uses, never re-fetched here: this is a
// settings page reporting on state, not a second place that spawns CLIs.
const models = computed(() => providers.modelCache.value[current.value.provider] ?? []);

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
  <section class="pp" aria-label="Agent providers">
    <!-- ── masthead ─────────────────────────────────────────────────────────── -->
    <header class="pp__mast">
      <div class="pp__identity">
        <p class="pp__eyebrow">
          <button
            type="button"
            class="pp__back"
            :tabindex="open ? 0 : -1"
            aria-label="Back to settings"
            @click="emit('back')"
          >
            <HugeiconsIcon
              :icon="ArrowTurnBackwardIcon"
              :size="13"
              :stroke-width="2"
              aria-hidden="true"
            />
          </button>
          AGENT PROVIDERS
        </p>
        <h1 class="pp__title">{{ readyCount }} of {{ ORDER.length }} ready</h1>
        <p class="pp__note">
          <template v-if="note">{{ note }}</template>
          <template v-else>kone drives the agent CLIs you've already signed into.</template>
        </p>
      </div>

      <div class="pp__actions">
        <!-- Never the primary: when something is behind, the action worth
             promoting is the update on the provider's own page, and two filled
             buttons on one screen means neither of them is the answer. -->
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
    </header>

    <!-- A running probe or update reads as a thread of light under the masthead,
         the same as the git space — never a spinner over the content. -->
    <div class="pp__progress" :class="{ 'pp__progress--on': busy }" aria-hidden="true">
      <i class="pp__progress-run" />
    </div>

    <p v-if="upkeep.error.value" class="pp__error" role="alert">
      <HugeiconsIcon :icon="AlertCircleIcon" :size="13" :stroke-width="1.8" aria-hidden="true" />
      {{ upkeep.error.value }}
    </p>

    <!-- ── body ─────────────────────────────────────────────────────────────── -->
    <div class="pp__body">
      <nav class="pp__rail" aria-label="Providers">
        <div class="pp__railrows">
          <i class="pp__railmark" :style="{ '--at': activeIndex }" aria-hidden="true" />
          <button
            v-for="row in rows"
            :key="row.provider"
            type="button"
            class="pp__railrow"
            :class="{
              'pp__railrow--on': selected === row.provider,
              'pp__railrow--off': !row.enabled,
            }"
            :aria-current="selected === row.provider ? 'true' : undefined"
            :tabindex="open ? 0 : -1"
            @click="select(row.provider)"
          >
            <ProviderLogo :brand="row.meta.brand" :size="15" class="pp__raillogo" />
            <span class="pp__raillabel">{{ row.meta.label }}</span>
            <span
              v-if="railHint(row)"
              class="pp__railhint"
              :class="`pp__railhint--${railHint(row)!.tone}`"
            >
              {{ railHint(row)!.text }}
            </span>
          </button>
        </div>

        <!-- The foot of the rail carries the one setting that isn't about a
             single provider: whether this page may look versions up at all. -->
        <div class="pp__railfoot">
          <button
            type="button"
            role="switch"
            class="pp__checkrow"
            :aria-checked="providerSettings.updateChecks.value"
            :tabindex="open ? 0 : -1"
            @click="toggleUpdateChecks"
          >
            <span class="pp__checkbody">
              <span class="pp__checklabel">Check for updates</span>
              <span class="pp__checkhint">Ask registries when this page opens.</span>
            </span>
            <span
              class="pp__switch"
              :class="{ 'pp__switch--on': providerSettings.updateChecks.value }"
            >
              <i class="pp__knob" />
            </span>
          </button>
        </div>
      </nav>

      <!-- The selected provider's own page. Keyed so switching providers
           re-runs the entrance rather than swapping text under a settled view. -->
      <div :key="current.provider" class="pp__panel">
        <header class="pp__head">
          <ProviderLogo :brand="current.meta.brand" :size="26" class="pp__headlogo" />
          <div class="pp__headtext">
            <h2 class="pp__name">{{ current.meta.label }}</h2>
            <p class="pp__vendor">{{ current.meta.vendor }}</p>
          </div>

          <!-- Whether the picker offers this provider at all. The one switch on
               the page, so it doesn't need a label explaining which switch. -->
          <button
            type="button"
            role="switch"
            class="pp__enable"
            :aria-label="`Offer ${current.meta.label} in the model picker`"
            :aria-checked="current.enabled"
            :tabindex="open ? 0 : -1"
            @click="toggleEnabled"
          >
            <span class="pp__enablelabel">
              {{ current.enabled ? "Offered in the picker" : "Hidden from the picker" }}
            </span>
            <span class="pp__switch" :class="{ 'pp__switch--on': current.enabled }">
              <i class="pp__knob" />
            </span>
          </button>
        </header>

        <p class="pp__blurb">{{ current.meta.blurb }}</p>

        <!-- Two columns once there's room for two: what the provider's state is
             on the left, how kone reaches it on the right. They collapse to one
             column on a narrow window, so the page never sets a 30ch measure. -->
        <div class="pp__cols">
        <div class="pp__col">

        <!-- ── standing ─────────────────────────────────────────────────────── -->
        <section class="pp__block" aria-label="Status">
          <p class="pp__label">Status</p>
          <p
            class="pp__status"
            :class="{
              'pp__status--ready': readinessLine(current).ready,
              'pp__status--bad': readinessLine(current).bad,
            }"
          >
            <HugeiconsIcon
              :icon="readinessLine(current).ready ? CheckmarkCircle02Icon : AlertCircleIcon"
              :size="13"
              :stroke-width="1.9"
              aria-hidden="true"
            />
            {{ readinessLine(current).text }}
          </p>
          <p
            v-if="current.status?.message && current.status.readiness !== 'ready'"
            class="pp__hint"
          >
            {{ current.status.message }}
          </p>

          <!-- The sign-in command, shown only while it's the thing standing in
               the way. kone never runs it: a login is interactive and
               credential-bearing, so it belongs in the user's own terminal. -->
          <div
            v-if="current.meta.signIn && current.status?.readiness !== 'ready'"
            class="pp__cmd"
          >
            <code class="pp__cmdtext">{{ current.meta.signIn }}</code>
            <button
              type="button"
              class="pp__copy"
              :tabindex="open ? 0 : -1"
              :aria-label="`Copy ${current.meta.signIn}`"
              @click="copy(current.meta.signIn!)"
            >
              <HugeiconsIcon :icon="Copy01Icon" :size="12" :stroke-width="1.9" aria-hidden="true" />
              {{ copied === current.meta.signIn ? "Copied" : "Copy" }}
            </button>
          </div>

          <a
            v-if="current.meta.docs"
            class="pp__link"
            :href="current.meta.docs.href"
            target="_blank"
            rel="noreferrer"
            :tabindex="open ? 0 : -1"
          >
            {{ current.meta.docs.label }}
            <HugeiconsIcon
              :icon="LinkSquare02Icon"
              :size="11"
              :stroke-width="1.9"
              aria-hidden="true"
            />
          </a>
        </section>

        <!-- ── version ──────────────────────────────────────────────────────── -->
        <section class="pp__block" aria-label="Version">
          <p class="pp__label">Version</p>

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

          <!-- Nothing to update when there's nothing installed: the row would
               offer a command that can only fail. -->
          <div
            v-if="current.upkeep?.canUpdate && current.status?.available"
            class="pp__update"
          >
            <button
              type="button"
              class="pp__btn"
              :class="{
                'pp__btn--primary':
                  current.upkeep.standing === 'behind' && current.upkeep.latestKnowable,
              }"
              :disabled="!canUpdate"
              :tabindex="open ? 0 : -1"
              @click="update"
            >
              <HugeiconsIcon
                :icon="RefreshIcon"
                :size="13"
                :stroke-width="1.8"
                :class="{ 'pp__spin': run?.running }"
                aria-hidden="true"
              />
              {{ updateLabel }}
            </button>

            <!-- The exact command kone would run. Shown before it runs, not
                 after it fails: an update through the wrong package manager is
                 the classic way to end up with two installs. -->
            <div v-if="current.upkeep.updateCommand" class="pp__cmd pp__cmd--inline">
              <code class="pp__cmdtext">{{ current.upkeep.updateCommand }}</code>
              <button
                type="button"
                class="pp__copy"
                :tabindex="open ? 0 : -1"
                aria-label="Copy the update command"
                @click="copy(current.upkeep.updateCommand!)"
              >
                <HugeiconsIcon
                  :icon="Copy01Icon"
                  :size="12"
                  :stroke-width="1.9"
                  aria-hidden="true"
                />
                {{ copied === current.upkeep.updateCommand ? "Copied" : "Copy" }}
              </button>
            </div>
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

        </div>
        <div class="pp__col">

        <!-- ── executable ───────────────────────────────────────────────────── -->
        <section class="pp__block" aria-label="Executable">
          <p class="pp__label">Executable</p>

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

        <!-- ── models ───────────────────────────────────────────────────────── -->
        <section v-if="models.length" class="pp__block" aria-label="Models">
          <p class="pp__label">Models</p>
          <p class="pp__count">
            {{ models.length }} model{{ models.length === 1 ? "" : "s" }} offered
          </p>
          <p class="pp__models">
            {{ models.slice(0, 8).map((m) => m.label).join(" · ")
            }}<template v-if="models.length > 8"> · +{{ models.length - 8 }} more</template>
          </p>
        </section>

        </div>
        </div>

        <!-- The standing rule this whole surface rests on, said once at the foot
             of the page rather than repeated as a reassurance on every block. -->
        <p class="pp__foot">
          kone never stores provider credentials. It drives the CLI you already
          signed into, with your own subscription.
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* One motion vocabulary for the page, the same shape the git space uses: things
   that arrive decelerate, things that move in place ease at both ends. */
.pp {
  --pp-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --pp-ease-move: cubic-bezier(0.65, 0, 0.35, 1);
  --pp-t-micro: 140ms;
  --pp-t-small: 220ms;
  --pp-t-enter: 320ms;
  --pp-t-sweep: 1100ms;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  padding: 4.5rem 2.5rem 2rem;
  overflow: hidden;
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

/* ── masthead ─────────────────────────────────────────────────────────────── */
.pp__mast {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  flex-shrink: 0;
  animation: pp-in var(--pp-t-enter) var(--pp-ease) backwards;
}
.pp__identity {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
}
/* A category label, so it keeps the uppercase micro-label treatment (unlike the
   identifiers further down the page, which are mono in their natural case). */
.pp__eyebrow {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 10px;
  letter-spacing: 0.08em;
  line-height: 1;
  text-transform: uppercase;
  color: var(--muted);
}
/* The same corner-return glyph the drawer's other panes use: the return arrow
   turned upside down, then mirrored. */
.pp__back {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-left: -4px;
  border-radius: 6px;
  color: var(--muted);
  cursor: pointer;
  transition:
    background-color var(--pp-t-micro) ease,
    color var(--pp-t-micro) ease;
}
.pp__back:hover {
  background-color: var(--hover);
  color: var(--ink);
}
.pp__back:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.pp__back :deep(svg) {
  transform: rotate(180deg) scaleX(-1);
}
.pp__title {
  font-size: 28px;
  letter-spacing: -0.5px;
  line-height: 1.1;
  color: var(--ink);
  font-variant-numeric: tabular-nums;
}
.pp__note {
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.3;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}

.pp__actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  padding-top: 4px;
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
.pp__btn--primary {
  background-color: var(--ink);
  color: var(--ground);
}
.pp__btn--primary:hover:not(:disabled) {
  background-color: var(--ink);
  opacity: 0.88;
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
  flex: 1 1 auto;
  min-height: 0;
  margin-top: 30px;
}

.pp__rail {
  display: flex;
  flex-direction: column;
  width: 210px;
  flex-shrink: 0;
  animation: pp-in var(--pp-t-enter) var(--pp-ease) 60ms backwards;
}
.pp__railrows {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
/* One pill that slides between rows, rather than a wash that appears on the row
   you picked. The rail is a fixed ladder — 34px rows on a 2px gap — so its
   position is arithmetic and can't fall out of step on a resize. */
.pp__railmark {
  position: absolute;
  inset-inline: 0;
  top: 0;
  height: 34px;
  border-radius: 8px;
  background-color: color-mix(in srgb, var(--ink) 6.5%, transparent);
  transform: translateY(calc(var(--at, 0) * 36px));
  transition: transform var(--pp-t-small) var(--pp-ease-move);
  pointer-events: none;
}
.pp__railrow {
  position: relative;
  display: flex;
  align-items: center;
  gap: 9px;
  height: 34px;
  padding-inline: 10px;
  border-radius: 8px;
  font-size: 12.5px;
  letter-spacing: -0.1px;
  color: var(--muted);
  cursor: pointer;
  text-align: left;
  transition:
    background-color var(--pp-t-micro) ease,
    color var(--pp-t-micro) ease,
    opacity var(--pp-t-micro) ease;
}
.pp__railrow:not(.pp__railrow--on):hover {
  background-color: var(--hover);
}
.pp__railrow:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.pp__railrow--on {
  color: var(--ink);
}
/* A provider the user has hidden from the picker still belongs on the rail —
   it just stops asking for attention. */
.pp__railrow--off {
  opacity: 0.55;
}
.pp__raillogo {
  flex-shrink: 0;
}
.pp__raillabel {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pp__railhint {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1;
  color: var(--muted);
}
.pp__railhint--ink {
  color: var(--ink);
}
.pp__railhint--bad {
  color: var(--diff-del);
}

.pp__railfoot {
  margin-top: auto;
  padding-top: 16px;
}
.pp__checkrow {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border-radius: 8px;
  text-align: left;
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
.pp__checkbody {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.pp__checklabel {
  font-size: 11.5px;
  line-height: 1.2;
  color: var(--ink-soft);
}
.pp__checkhint {
  font-size: 10.5px;
  line-height: 1.35;
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
  margin-top: 1px;
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

/* ── the provider's page ──────────────────────────────────────────────────── */
.pp__panel {
  /* A query container, so the two-column split below responds to the panel's own
     width rather than the window's — the drawer's width is derived from the
     window but isn't the window, and a media query would get it wrong. */
  container-type: inline-size;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  padding-left: 40px;
  padding-right: 6px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--ink) 14%, transparent) transparent;
  animation: pp-in var(--pp-t-small) var(--pp-ease) backwards;
}
.pp__panel::-webkit-scrollbar {
  width: 4px;
}
.pp__panel::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--ink) 16%, transparent);
  border-radius: 999px;
}

.pp__head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.pp__headlogo {
  flex-shrink: 0;
}
.pp__headtext {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1 1 auto;
}
.pp__name {
  font-size: 19px;
  letter-spacing: -0.3px;
  line-height: 1.1;
  color: var(--ink);
}
.pp__vendor {
  font-size: 11px;
  line-height: 1;
  color: var(--muted);
}
.pp__enable {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-shrink: 0;
  padding: 5px 6px 5px 9px;
  border-radius: 8px;
  cursor: pointer;
  transition: background-color var(--pp-t-micro) ease;
}
.pp__enable:hover {
  background-color: var(--hover);
}
.pp__enable:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.pp__enablelabel {
  font-size: 11px;
  line-height: 1;
  color: var(--muted);
  white-space: nowrap;
}

.pp__blurb {
  margin-top: 10px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--ink-soft);
  max-width: 54ch;
}

/* The columns are the page's measure. Each holds its own stack of blocks, and
   the gutter between them is wide enough that the two read as separate columns
   rather than one wrapped one. */
.pp__cols {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0 56px;
  align-items: start;
}
@container (min-width: 700px) {
  .pp__cols {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
}
.pp__col {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  min-width: 0;
}

.pp__block {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  margin-top: 28px;
  width: 100%;
}
.pp__label {
  font-size: 10px;
  letter-spacing: 0.08em;
  line-height: 1;
  text-transform: uppercase;
  color: var(--muted);
}

.pp__status {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  line-height: 1.3;
  color: var(--muted);
}
.pp__status--ready {
  color: var(--ink);
}
.pp__status--bad {
  color: var(--diff-del);
}
.pp__hint {
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--muted);
}
.pp__hint code {
  font-family: var(--font-mono);
  font-size: 11px;
}

/* Identifiers — versions, paths, package names, commands — are mono in their
   natural case, set as a two-column definition list so the values align. */
.pp__def {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr);
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

.pp__update {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  margin-top: 2px;
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
  font-size: 10.5px;
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

.pp__link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  line-height: 1;
  color: var(--muted);
  text-decoration: none;
  transition: color var(--pp-t-micro) ease;
}
.pp__link:hover {
  color: var(--ink);
}
.pp__link:focus-visible {
  outline: none;
  color: var(--ink);
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
  font-size: 10.5px;
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

.pp__foot {
  margin-top: 44px;
  padding-bottom: 8px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--muted);
  opacity: 0.8;
  max-width: 52ch;
}

.pp__count {
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.3;
  font-variant-numeric: tabular-nums;
  color: var(--ink-soft);
}
.pp__models {
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--muted);
}

@media (prefers-reduced-motion: reduce) {
  .pp__mast,
  .pp__rail,
  .pp__panel {
    animation: none;
  }
  .pp__railmark,
  .pp__knob,
  .pp__btn,
  .pp__railrow,
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
