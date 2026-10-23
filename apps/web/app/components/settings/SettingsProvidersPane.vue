<script setup lang="ts">
// Providers settings pane — Fused Card Deck + Two-Column Board:
// 1. Folded-spine Provider Card Deck at the top (ProviderCardDeck)
// 2. Sleek single-line Identity & Provider Control Bar (ProviderIdentityBar)
// 3. Rethought Two-Column Board:
//    - Left: Runtime & Environment (ProviderRuntimeEnvSection)
//    - Right: Limits + Handoff token cap, and Models + Custom models (ProviderModelsSection)
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { onClickOutside } from "@vueuse/core";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  AiChipIcon,
  AlertCircleIcon,
  MoreHorizontalIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import AgentSettingsLimits from "~/components/agent/AgentSettingsLimits.vue";
import { deckReadout } from "~/components/provider/ProviderDeckLimits.vue";
import ProviderSignInModal from "~/components/provider/ProviderSignInModal.vue";
import SettingsPageShell from "~/components/settings/SettingsPageShell.vue";
import ProviderCardDeck from "~/components/settings/providers/ProviderCardDeck.vue";
import ProviderIdentityBar from "~/components/settings/providers/ProviderIdentityBar.vue";
import ProviderModelsSection, {
  type ProviderModelRow,
} from "~/components/settings/providers/ProviderModelsSection.vue";
import ProviderRuntimeEnvSection from "~/components/settings/providers/ProviderRuntimeEnvSection.vue";
import {
  PROVIDER_META,
  hasUpdate,
  type HeroAction,
  type ProviderPaneRow,
  type SpineSignal,
} from "~/components/settings/providers/types";
import type { ProviderEnvVar, ProviderKind, ProviderMaintenance, ProviderStatus } from "~/types/desktop";
import { buildModelCatalog } from "~/utils/modelCatalog";
import { canSignIn } from "~/utils/providerLogin";
import { OFFERED_PROVIDERS, isProviderOffered } from "~/utils/providerOffer";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ back: [] }>();

const { cue } = useSound();
const signIn = useProviderSignIn();
onBeforeUnmount(() => signIn.release("pane"));

const { providerFocus } = useSettingsSurface();
const providers = useAgentProviders();
const providerSettings = useProviderSettings();
const upkeep = useProviderMaintenance();
const limits = useAgentSettings(() => null);

const selected = ref<ProviderKind>("codex");

watch(
  providerFocus,
  (provider) => {
    if (!provider) return;
    selected.value = provider;
    providerFocus.value = null;
  },
  { immediate: true },
);

const orderedProviders = computed(() =>
  providerSettings.orderProviders(OFFERED_PROVIDERS),
);

function spineSignal(
  status: ProviderStatus | null,
  m: ProviderMaintenance | null,
): SpineSignal | null {
  if (status) {
    if (status.readiness === "disabled") return null;
    if (status.readiness === "needs-login") return { tone: "attention", label: "not signed in" };
    if (status.readiness !== "ready" && status.readiness !== "not-installed") {
      return { tone: "problem", label: "unavailable" };
    }
  }
  if (hasUpdate(status, m)) return { tone: "update", label: "update available" };
  return null;
}

const rows = computed<ProviderPaneRow[]>(() =>
  orderedProviders.value.map((provider) => {
    const status = providers.statuses.value.find((s) => s.provider === provider) ?? null;
    const maint = upkeep.forProvider(provider);
    return {
      provider,
      meta: PROVIDER_META[provider],
      status,
      upkeep: maint,
      enabled: providerSettings.isEnabled(provider),
      shownInPicker: providerSettings.isShownInPicker(provider),
      signal: spineSignal(status, maint),
      limits: deckReadout(limits.isReadable(provider) ? limits.quotas.value[provider] : null),
    };
  }),
);

// SAFETY: OFFERED_PROVIDERS is non-empty, so rows always has a first element.
const current = computed<ProviderPaneRow>(
  () => rows.value.find((r) => r.provider === selected.value) ?? (rows.value[0] as ProviderPaneRow),
);

const currentIndex = computed(() =>
  rows.value.findIndex((r) => r.provider === current.value.provider),
);

function select(provider: ProviderKind) {
  if (selected.value === provider) return;
  selected.value = provider;
  cue("select");
}

const readyCount = computed(
  () =>
    providers.statuses.value.filter(
      (s) => s.readiness === "ready" && isProviderOffered(s.provider),
    ).length,
);

const behind = computed(() => upkeep.outdated.value.length);
const attention = computed(
  () => rows.value.filter((r) => r.signal && r.signal.tone !== "update").length,
);

const busy = computed(
  () =>
    providers.loading.value ||
    upkeep.checking.value ||
    Object.values(upkeep.runs.value).some((r) => r?.running),
);

const checkedLabel = computed(() => {
  const at = upkeep.checkedAt.value;
  if (!at) return null;
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes === 1) return "1m ago";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
});

const note = computed(() => {
  const parts: string[] = [];
  if (attention.value) {
    parts.push(`${attention.value} need${attention.value === 1 ? "s" : ""} attention`);
  }
  if (behind.value) {
    parts.push(`${behind.value} update${behind.value === 1 ? "" : "s"} available`);
  } else if (!attention.value && upkeep.checkedAt.value) {
    parts.push("all current");
  }
  if (checkedLabel.value) parts.push(`checked ${checkedLabel.value}`);
  return parts.join(" · ");
});

async function refresh(force: boolean) {
  await providers.discover(force);
  await upkeep.check({ force, checkLatest: force || providerSettings.updateChecks.value });
}

async function recheck() {
  cue("press");
  await Promise.all([refresh(true), limits.loadLimits()]);
}

async function recheckSingleProvider() {
  const provider = current.value.provider;
  cue("press");
  await providers.checkProvider(provider);
  await upkeep.check({ force: true, checkLatest: providerSettings.updateChecks.value });
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    void providerSettings.load();
    void refresh(false);
    void limits.loadLimits();
  },
  { immediate: true },
);

function readinessText(row: ProviderPaneRow): string {
  const status = row.status;
  if (!status) return "Checking this machine…";
  switch (status.readiness) {
    case "ready":
      return status.authLabel ?? "Signed in and ready";
    case "needs-login":
      return "Installed, but not signed in";
    case "not-installed":
      return "Not installed on this machine";
    case "disabled":
      return "Disabled across the app";
    default:
      return "Unavailable";
  }
}

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

const runLine = computed(() => {
  const r = run.value;
  if (!r || r.running) return null;
  if (r.outcome === "succeeded") return { text: "Updated.", bad: false, output: r.output };
  if (r.outcome === "unchanged") {
    return { text: "Already the newest version.", bad: false, output: r.output };
  }
  return {
    text: r.message ?? "The update didn't complete.",
    bad: true,
    output: r.output,
  };
});

const heroAction = computed<HeroAction>(() => {
  const row = current.value;
  const m = row.upkeep;
  if (run.value?.running) return { kind: "busy", label: "Updating…" };
  if (canUpdate.value && row.status?.available && m?.standing === "behind" && m.latestKnowable) {
    return { kind: "update", label: m.latestVersion ? `Update to ${m.latestVersion}` : "Update" };
  }
  if (row.status?.readiness === "needs-login" && canSignIn(row.provider)) {
    return { kind: "signin", label: "Sign in" };
  }
  if (row.status?.readiness === "not-installed") {
    return row.meta.docs
      ? { kind: "docs", label: `Get ${row.meta.label}`, href: row.meta.docs.href }
      : { kind: "idle", label: "Not installed" };
  }
  return row.enabled && row.status?.readiness !== "disabled"
    ? { kind: "toggle", label: "Disable across app" }
    : { kind: "toggle", label: "Enable provider" };
});

const heroStatus = computed(() => {
  const text = readinessText(current.value);
  if (current.value.status?.readiness === "ready" && !current.value.enabled) {
    return `${text} · disabled across app`;
  }
  return text;
});

function heroClick() {
  const a = heroAction.value;
  if (a.kind === "update") return void update();
  if (a.kind === "signin") return signIn.open(current.value.provider, "pane");
  if (a.kind === "toggle") return void toggleEnabled();
}

function openSignInFromBar() {
  signIn.open(current.value.provider, "pane");
}

async function saveBinary(path: string) {
  const provider = current.value.provider;
  await providerSettings.setBinaryPath(provider, path);
  cue("saved");
  void upkeep.check({ force: true, checkLatest: providerSettings.updateChecks.value });
}

async function saveHome(path: string) {
  const provider = current.value.provider;
  await providerSettings.setHomeDir(provider, path);
  cue("saved");
}

async function saveEnv(vars: ProviderEnvVar[]) {
  const provider = current.value.provider;
  await providerSettings.setEnvVars(provider, vars);
  cue("saved");
}

async function toggleEnabled() {
  const provider = current.value.provider;
  cue("toggle", { off: providerSettings.isEnabled(provider) });
  await providerSettings.setEnabled(provider, !providerSettings.isEnabled(provider));
  void providers.refresh().catch(() => {});
}

async function toggleShownInPicker() {
  const provider = current.value.provider;
  const next = !providerSettings.isShownInPicker(provider);
  cue("toggle", { off: !next });
  await providerSettings.setShownInPicker(provider, next);
}

async function moveProvider(delta: -1 | 1) {
  await providerSettings.moveProvider(current.value.provider, delta, OFFERED_PROVIDERS);
}

// ── models & custom models ────────────────────────────────────────────────────

const refreshingModels = ref(false);
const modelRefreshError = ref<string | null>(null);

watch(
  [() => props.open, () => current.value.provider],
  ([open]) => {
    modelRefreshError.value = null;
    if (open) void providers.models(current.value.provider);
  },
  { immediate: true },
);

const modelRows = computed<ProviderModelRow[]>(() => {
  const provider = current.value.provider;
  const customSet = new Set(providerSettings.customModels(provider));
  const descriptors = (providers.modelCache.value[provider] ?? []).filter(
    (d) => !customSet.has(d.id),
  );
  const byId = new Map(descriptors.map((d) => [d.id, d]));
  return buildModelCatalog(descriptors, provider).map((fam) => {
    const rep = fam.efforts[0]?.modelId ? byId.get(fam.efforts[0].modelId) : undefined;
    return {
      key: fam.key,
      label: fam.label,
      brand: fam.brand,
      model: fam,
      contextTokens: rep?.contextWindowTokens,
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

function toggleModel(key: string) {
  const provider = current.value.provider;
  providerSettings.setModelHidden(provider, key, !providerSettings.isModelHidden(provider, key));
  cue("toggle", { off: providerSettings.isModelHidden(provider, key) });
}

async function handleRefreshModels() {
  const provider = current.value.provider;
  refreshingModels.value = true;
  modelRefreshError.value = null;
  try {
    const res = await providers.refreshModels(provider);
    modelRefreshError.value = res.error;
  } finally {
    refreshingModels.value = false;
  }
}

async function handleAddCustomModel(slug: string) {
  await providerSettings.addCustomModel(current.value.provider, slug);
  cue("saved");
}

async function handleRemoveCustomModel(slug: string) {
  await providerSettings.removeCustomModel(current.value.provider, slug);
}

// ── limit behaviour & handoff cap ─────────────────────────────────────────────

function toggleResumeAtReset() {
  const provider = current.value.provider;
  void providerSettings.setResumeAtReset(provider, !providerSettings.resumeAtReset(provider));
  cue("toggle", { off: !providerSettings.resumeAtReset(provider) });
}

function toggleSnoozeWhenLimited() {
  const provider = current.value.provider;
  void providerSettings.setSnoozeWhenLimited(
    provider,
    !providerSettings.snoozeWhenLimited(provider),
  );
  cue("toggle", { off: !providerSettings.snoozeWhenLimited(provider) });
}

const handoffCapDraft = ref("");
watch(
  [() => current.value.provider, () => providerSettings.handoffTokenCap(current.value.provider)],
  ([provider]) => {
    handoffCapDraft.value = String(providerSettings.handoffTokenCap(provider));
  },
  { immediate: true },
);

function commitHandoffCap() {
  const provider = current.value.provider;
  const parsed = Number.parseInt(handoffCapDraft.value.replace(/,/g, "").trim(), 10);
  if (!Number.isFinite(parsed)) {
    handoffCapDraft.value = String(providerSettings.handoffTokenCap(provider));
    return;
  }
  void providerSettings.setHandoffTokenCap(provider, parsed);
  handoffCapDraft.value = String(providerSettings.handoffTokenCap(provider));
  cue("saved");
}

// ── masthead options menu ─────────────────────────────────────────────────────

const optsOpen = ref(false);
const optsWrap = ref<HTMLElement>();
onClickOutside(optsWrap, () => (optsOpen.value = false));

const HEALTH_INTERVAL_CHOICES = [
  { sec: 300, label: "5m" },
  { sec: 900, label: "15m" },
  { sec: 60, label: "1m" },
  { sec: 0, label: "Off" },
] as const;

const healthIntervalLabel = computed(() => {
  const sec = providerSettings.healthCheckIntervalSec.value;
  if (sec <= 0) return "Off";
  if (sec < 60) return `${sec}s`;
  return `${Math.round(sec / 60)}m`;
});

function cycleHealthInterval() {
  const curSec = providerSettings.healthCheckIntervalSec.value;
  const idx = HEALTH_INTERVAL_CHOICES.findIndex((c) => c.sec === curSec);
  const next =
    HEALTH_INTERVAL_CHOICES[(idx + 1) % HEALTH_INTERVAL_CHOICES.length] ??
    HEALTH_INTERVAL_CHOICES[0];
  void providerSettings.setHealthCheckIntervalSec(next.sec);
}

function toggleUpdateChecks() {
  providerSettings.updateChecks.value = !providerSettings.updateChecks.value;
  cue("toggle", { off: !providerSettings.updateChecks.value });
  if (providerSettings.updateChecks.value) void upkeep.check({ force: true });
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") optsOpen.value = false;
}

onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <SettingsPageShell
    :open="open"
    breadcrumb="Ecosystem / Providers"
    :breadcrumb-icon="AiChipIcon"
    label="Providers settings"
    :scroll="false"
    @back="emit('back')"
  >
    <template #actions>
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

        <div ref="optsWrap" class="pp__anchor">
          <button
            type="button"
            class="pp__btn"
            aria-label="Providers options"
            :aria-expanded="optsOpen"
            :tabindex="open ? 0 : -1"
            @click="optsOpen = !optsOpen"
          >
            <HugeiconsIcon
              :icon="MoreHorizontalIcon"
              :size="14"
              :stroke-width="1.9"
              aria-hidden="true"
            />
          </button>

          <div v-if="optsOpen" class="pp__pop">
            <button
              type="button"
              role="switch"
              class="pp__checkrow pp__optrow"
              :aria-checked="providerSettings.updateChecks.value"
              @click="toggleUpdateChecks"
            >
              <span class="pp__checklabel">Check registries on open</span>
              <span
                class="pp__switch"
                :class="{ 'pp__switch--on': providerSettings.updateChecks.value }"
              >
                <i class="pp__knob" />
              </span>
            </button>

            <button
              type="button"
              class="pp__checkrow pp__optrow"
              @click="cycleHealthInterval"
            >
              <span class="pp__checklabel">Health check interval</span>
              <span class="pp__optval">{{ healthIntervalLabel }}</span>
            </button>
          </div>
        </div>
      </div>
    </template>

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

    <div class="pp__body">
      <!-- 1. Folded-spine Provider Card Deck -->
      <ProviderCardDeck
        :rows="rows"
        :selected="selected"
        :open="open"
        :hero-status="heroStatus"
        :hero-action="heroAction"
        @select="select"
        @action="heroClick"
      />

      <!-- 2. Compact Identity & Provider Control Bar -->
      <ProviderIdentityBar
        :row="current"
        :index="currentIndex"
        :total="rows.length"
        :open="open"
        :hero-action="heroAction"
        @signin="openSignInFromBar"
        @toggle-shown-in-picker="toggleShownInPicker"
        @toggle-enabled="toggleEnabled"
        @move="moveProvider"
      />

      <!-- 3. Fused Two-Column Board -->
      <div :key="current.provider" class="pp__board">
        <ProviderRuntimeEnvSection
          :row="current"
          :open="open"
          :checked-label="checkedLabel"
          :binary-override="providerSettings.binaryPath(current.provider)"
          :home-override="providerSettings.homeDir(current.provider)"
          :env-vars="providerSettings.envVars(current.provider)"
          :run-line="runLine"
          @recheck-health="recheckSingleProvider"
          @save-binary="saveBinary"
          @save-home="saveHome"
          @save-env="saveEnv"
          @dismiss-run="upkeep.dismissRun(current.provider)"
        />

        <div class="pp__rightcol">
          <section class="pp__block pp__limits" aria-label="Limits">
            <p class="pp__blocklabel">Limits</p>
            <AgentSettingsLimits :space="limits" :provider="current.provider" :foot="false" />

            <div class="pp__limitrows">
              <button
                type="button"
                role="switch"
                class="pp__checkrow pp__limitrow"
                :aria-checked="providerSettings.resumeAtReset(current.provider)"
                :tabindex="open ? 0 : -1"
                @click="toggleResumeAtReset"
              >
                <span class="pp__checklabel">Auto-resume at reset</span>
                <span
                  class="pp__switch"
                  :class="{ 'pp__switch--on': providerSettings.resumeAtReset(current.provider) }"
                >
                  <i class="pp__knob" />
                </span>
              </button>

              <button
                type="button"
                role="switch"
                class="pp__checkrow pp__limitrow"
                :aria-checked="providerSettings.snoozeWhenLimited(current.provider)"
                :tabindex="open ? 0 : -1"
                @click="toggleSnoozeWhenLimited"
              >
                <span class="pp__checklabel">Snooze limited threads</span>
                <span
                  class="pp__switch"
                  :class="{ 'pp__switch--on': providerSettings.snoozeWhenLimited(current.provider) }"
                >
                  <i class="pp__knob" />
                </span>
              </button>

              <div class="pp__checkrow pp__limitrow pp__caprow">
                <span class="pp__checklabel">Handoff token cap</span>
                <span class="pp__capfield">
                  <input
                    v-model="handoffCapDraft"
                    type="text"
                    class="pp__input pp__capinput"
                    spellcheck="false"
                    aria-label="Handoff token cap"
                    :tabindex="open ? 0 : -1"
                    @change="commitHandoffCap"
                    @blur="commitHandoffCap"
                    @keydown.enter.prevent="commitHandoffCap"
                  />
                  <span class="pp__capunit">tokens</span>
                </span>
              </div>
            </div>
          </section>

          <ProviderModelsSection
            :row="current"
            :open="open"
            :model-rows="modelRows"
            :hidden-count="hiddenCount"
            :custom-models="providerSettings.customModels(current.provider)"
            :refreshing="refreshingModels"
            :refresh-error="modelRefreshError"
            @toggle-model="toggleModel"
            @refresh="handleRefreshModels"
            @add-custom-model="handleAddCustomModel"
            @remove-custom-model="handleRemoveCustomModel"
          />
        </div>
      </div>
    </div>

    <template #foot>
      {{ readyCount }} of {{ rows.length }} ready<template v-if="note"> · {{ note }}</template>
    </template>

    <template #overlay>
      <ProviderSignInModal
        v-if="signIn.target.value && signIn.host.value === 'pane'"
        :key="signIn.target.value"
        :provider="signIn.target.value"
        contained
      />
    </template>
  </SettingsPageShell>
</template>

<style scoped>
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

.pp__act {
  display: flex;
  align-items: center;
  gap: 4px;
}
.pp__lede {
  display: contents;
}
.pp__anchor {
  position: relative;
  display: flex;
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

.pp__body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  padding-inline: 1rem;
  overflow-y: auto;
  scrollbar-width: none;
  container-type: inline-size;
  container-name: ppbody;
}
.pp__body::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.pp__board {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.08fr);
  gap: 32px 48px;
  align-items: start;
  margin-top: 20px;
  padding-bottom: 18px;
  animation: pp-in var(--pp-t-enter) var(--pp-ease) backwards;
}
.pp__rightcol {
  display: flex;
  flex-direction: column;
  gap: 28px;
  min-width: 0;
}

@container ppbody (max-width: 780px) {
  .pp__board {
    grid-template-columns: minmax(0, 1fr);
    gap: 28px;
  }
}

.pp__progress {
  position: relative;
  height: 1px;
  overflow: hidden;
  opacity: 0;
  transition: opacity var(--pp-t-micro) ease;
}
.pp__progress--on {
  opacity: 1;
}
.pp__progress-run {
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, var(--ink-soft), transparent);
  animation: pp-sweep var(--pp-t-sweep) ease-in-out infinite;
}
@keyframes pp-sweep {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(100%);
  }
}

.pp__error {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 1rem 0;
  font-size: 12px;
  color: var(--danger);
}

/* Shared primitives inherited by child sections via :deep */
.pp__act :deep(.pp__btn),
.pp__body :deep(.pp__btn),
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
.pp__act :deep(.pp__btn:hover:not(:disabled)),
.pp__body :deep(.pp__btn:hover:not(:disabled)),
.pp__btn:hover:not(:disabled) {
  background-color: var(--hover);
}
.pp__body :deep(.pp__btn--outline) {
  height: auto;
  padding: 5px 12px;
  border: 1px solid var(--line);
  border-radius: 999px;
  font-size: 12.5px;
  line-height: 1.2;
  color: var(--ink);
}
.pp__act :deep(.pp__spin),
.pp__body :deep(.pp__spin) {
  animation: pp-spin 900ms linear infinite;
}
@keyframes pp-spin {
  to {
    transform: rotate(360deg);
  }
}

.pp__act :deep(.pp__checkrow),
.pp__body :deep(.pp__checkrow),
.pp__checkrow {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  padding: 6px 8px 6px 12px;
  border-radius: 999px;
  cursor: pointer;
  transition: background-color var(--pp-t-micro) ease;
}
.pp__act :deep(.pp__checkrow:hover),
.pp__body :deep(.pp__checkrow:hover),
.pp__checkrow:hover {
  background-color: var(--hover);
}
.pp__act :deep(.pp__checklabel),
.pp__body :deep(.pp__checklabel),
.pp__checklabel {
  font-size: 11.5px;
  line-height: 1.2;
  color: var(--muted);
}

.pp__act :deep(.pp__switch),
.pp__body :deep(.pp__switch),
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
.pp__act :deep(.pp__switch--on),
.pp__body :deep(.pp__switch--on),
.pp__switch--on {
  background-color: var(--ink);
}
.pp__act :deep(.pp__knob),
.pp__body :deep(.pp__knob),
.pp__knob {
  position: absolute;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background-color: var(--ground);
  transform: translateX(2px);
  transition: transform var(--pp-t-small) var(--pp-ease-move);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 10%, transparent);
}
.pp__act :deep(.pp__switch--on .pp__knob),
.pp__body :deep(.pp__switch--on .pp__knob),
.pp__switch--on .pp__knob {
  transform: translateX(16px);
}

.pp__body :deep(.pp__block),
.pp__block {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}
.pp__limits {
  align-items: stretch;
}
.pp__limitrows {
  display: flex;
  flex-direction: column;
  width: 100%;
}
.pp__limitrow {
  justify-content: space-between;
  padding: 7px 2px;
  border-radius: 8px;
}
.pp__caprow {
  cursor: default;
}
.pp__caprow:hover {
  background-color: transparent;
}
.pp__capfield {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.pp__capinput {
  width: 84px;
  padding: 4px 8px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.pp__capunit {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
}

.pp__body :deep(.pp__blocklabel),
.pp__blocklabel {
  font-size: 10px;
  letter-spacing: 0.08em;
  line-height: 1;
  text-transform: uppercase;
  color: var(--muted);
}

.pp__body :deep(.pp__facts) {
  display: flex;
  flex-direction: column;
  width: 100%;
  margin: 0;
}
.pp__body :deep(.pp__factsrow) {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr);
  gap: 12px;
  min-width: 0;
  padding: 7px 0;
  border-top: 1px solid var(--line-soft);
}
.pp__body :deep(.pp__factsrow:first-child) {
  border-top: none;
  padding-top: 2px;
}
.pp__body :deep(.pp__facts dt) {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  font-size: 12.5px;
  line-height: 1.4;
  color: var(--muted);
  min-width: 0;
}
.pp__body :deep(.pp__facts dt svg) {
  flex-shrink: 0;
  color: var(--muted);
}
.pp__body :deep(.pp__facts dd) {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.4;
  font-variant-numeric: tabular-nums;
  color: var(--ink-soft);
}

.pp__body :deep(.pp__input),
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
.pp__body :deep(.pp__input::placeholder),
.pp__input::placeholder {
  color: var(--muted);
}
.pp__body :deep(.pp__input:focus),
.pp__input:focus {
  outline: none;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 22%, transparent);
}

.pp__body :deep(.pp__hint) {
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--muted);
}
.pp__body :deep(.pp__result) {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}
.pp__body :deep(.pp__resulttext) {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--ink-soft);
}
.pp__body :deep(.pp__resulttext--bad) {
  color: var(--diff-del);
}
.pp__body :deep(.pp__dismiss) {
  font-size: 11px;
  line-height: 1;
  color: var(--muted);
  cursor: pointer;
}
.pp__body :deep(.pp__output) {
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
}

.pp__pop {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background-color: var(--panel);
  box-shadow: 0 10px 28px rgb(0 0 0 / 0.14);
  animation: pp-in var(--pp-t-small) var(--pp-ease);
}
.pp__optrow {
  justify-content: space-between;
  gap: 16px;
  width: 100%;
  padding: 5px 8px;
  border-radius: 8px;
  white-space: nowrap;
}
.pp__optval {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink);
}
</style>
