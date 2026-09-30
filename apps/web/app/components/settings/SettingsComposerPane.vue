<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { PencilEdit01Icon } from "@hugeicons/core-free-icons";
import SettingsPageShell from "~/components/settings/SettingsPageShell.vue";
import ModelPickerModal from "~/components/model/ModelPickerModal.vue";
import ProviderLogo from "~/components/provider/ProviderLogo.vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowRight01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import {
  buildModelCatalog,
  describeModelId,
  EFFORT_META,
  isEffortTier,
  type EffortTier,
  type ModelOption,
  type PickerProvider,
} from "~/utils/modelCatalog";
import type { InteractionMode, ProviderKind } from "~/types/desktop";
import InteractionModeIcon from "~/components/icons/InteractionModeIcon.vue";
import ToggleSwitch from "~/components/ui/ToggleSwitch.vue";
import { FALLBACK_MODE, INTERACTION_MODES, isInteractionMode } from "~/utils/interactionModes";
import {
  DEFAULT_COMPOSER_PREFS,
  useComposerPrefs,
  type ComposerPrefs,
  type SendKey,
} from "~/composables/useComposerPrefs";
import {
  DEFAULT_MODE_KEY,
  DEFAULT_MODEL_KEY,
  DEFAULT_PROVIDER_KEY,
  DEFAULT_REASONING_KEY,
  PROVIDER_BRAND,
  PROVIDER_VENDOR,
  setDefaultModel,
} from "~/utils/modelPicker";
import type { ModelPick } from "~/composables/useModelCommit";

// The Composer page, in two halves.
//
// What a new chat starts with — which model answers, and how much it may do
// without asking. Defaults, not live state: this never touches a running
// thread. It writes the keys a project reads at boot (utils/modelPicker), so
// anything that already carries its own choice keeps it and these seed the ones
// that don't.
//
// How the composer behaves under your hands — the send key, waking on a
// keystroke, drafts, folding away. These are live (useComposerPrefs).
//
// Above both sits a still of the composer wearing every choice on the page.
// Its model and mode controls are the real controls, so the page can be set
// from the thing it describes.

defineProps<{ open: boolean }>();
defineEmits<{ back: [] }>();

const { cue } = useSound();
const providers = useAgentProviders();
const providerSettings = useProviderSettings();

// The picker reads live catalogs; prime them once so opening it isn't a cold CLI
// handshake. Shared singleton — cheap if another surface already warmed it.
onMounted(() => void providers.prepare());

// Raw provider lists → the picker's family catalogs. Same transform StudioRow
// runs for the composer's picker, so both offer the same models.
const catalogs = computed<Partial<Record<ProviderKind, ModelOption[]>>>(() => {
  const out: Partial<Record<ProviderKind, ModelOption[]>> = {};
  for (const [prov, list] of Object.entries(providers.modelCache.value)) {
    if (list) {
      // SAFETY: Keys of modelCache correspond to ProviderKind values
      out[prov as ProviderKind] = buildModelCatalog(list, prov as ProviderKind);
    }
  }
  return out;
});

// One rail entry per ready, enabled provider, each filtered through the same
// per-model visibility the providers pane writes. No agent pin narrows it here —
// a default belongs to the app, not to whichever agent the composer points at.
const enabledReady = computed(() =>
  providers.ready.value.filter((s) => providerSettings.isEnabled(s.provider)),
);
const pickerProviders = computed<PickerProvider[]>(() => {
  const visible = providerSettings.modelVisiblePredicate.value;
  return enabledReady.value.map((s) => {
    const models = (catalogs.value[s.provider] ?? []).filter((m) => visible(s.provider, m.key));
    return {
      id: s.provider,
      label: s.label,
      sub: `${PROVIDER_VENDOR[s.provider]} · ${models.length} model${models.length === 1 ? "" : "s"}`,
      brand: PROVIDER_BRAND[s.provider],
      ready: s.readiness === "ready",
      models,
    };
  });
});

// ── the current default (read back from the same keys boot restores) ──────────
const currentProvider = ref<ProviderKind | null>(null);
const currentModel = ref<string | null>(null);
const currentReasoning = ref<EffortTier | null>(null);

onMounted(() => {
  if (!import.meta.client) return;
  // SAFETY: Local storage value is checked at assignment or defaults to null
  currentProvider.value = (localStorage.getItem(DEFAULT_PROVIDER_KEY) as ProviderKind | null) ?? null;
  currentModel.value = localStorage.getItem(DEFAULT_MODEL_KEY);
  const tier = localStorage.getItem(DEFAULT_REASONING_KEY);
  currentReasoning.value = isEffortTier(tier) ? tier : null;
});

// The active provider the modal opens on: the stored default, else the first
// provider that actually has models to offer.
const activeProvider = computed<ProviderKind>(
  () => currentProvider.value ?? pickerProviders.value[0]?.id ?? "claudeAgent",
);

// Name + logomark for the row. describeModelId resolves both from a bare id, and
// reads a richer label when the provider's catalog is loaded.
const modelDesc = computed(() =>
  currentModel.value
    ? describeModelId(currentModel.value, catalogs.value[activeProvider.value])
    : null,
);
const effortLabel = computed(() =>
  currentReasoning.value ? EFFORT_META[currentReasoning.value].label : "",
);

// ── model picker ──────────────────────────────────────────────────────────────
const pickerOpen = ref(false);
function togglePicker() {
  pickerOpen.value = !pickerOpen.value;
  cue(pickerOpen.value ? "expand" : "collapse");
}

// A pick here is a default, not a live commit — there is no session to restart.
// Persist exactly the three keys the boot restore reads (provider/model/effort);
// fast mode and context window ride a session, not the app-wide default.
function persistDefault(picked: ModelPick) {
  currentProvider.value = picked.provider;
  currentModel.value = picked.modelId;
  currentReasoning.value = picked.tier;
  setDefaultModel({
    provider: picked.provider,
    modelId: picked.modelId,
    tier: picked.tier,
  });
}

// `select` commits and dismisses; `apply` is an in-place tweak (effort/fast) the
// modal fires while still open, so it saves without closing.
function onModelSelect(picked: ModelPick) {
  persistDefault(picked);
  pickerOpen.value = false;
  cue("toggle");
}
function onModelApply(picked: ModelPick) {
  persistDefault(picked);
}

// ── default approval ──────────────────────────────────────────────────────────
// The same ladder the composer cycles, laid out whole: the rungs as values on
// the row, and under it what the set one means — what the agent does on its own
// and what it asks you first — so the choice is made reading the consequence.
//
// No stored default reads as the app's own fallback so the pane shows the rung
// a fresh project would actually open on.
const currentMode = ref<InteractionMode>(FALLBACK_MODE);
const currentModeMeta = computed(
  () => INTERACTION_MODES.find((m) => m.id === currentMode.value) ?? INTERACTION_MODES[1]!,
);
onMounted(() => {
  if (!import.meta.client) return;
  const saved = localStorage.getItem(DEFAULT_MODE_KEY);
  if (isInteractionMode(saved)) currentMode.value = saved;
});

function chooseMode(id: InteractionMode) {
  if (currentMode.value === id) return;
  currentMode.value = id;
  if (import.meta.client) localStorage.setItem(DEFAULT_MODE_KEY, id);
  cue("toggle");
}

const modeIndex = computed(() => INTERACTION_MODES.findIndex((m) => m.id === currentMode.value));

/** Arrow keys walk the rungs, as a radiogroup's should; ends don't wrap. */
function onTrackKey(e: KeyboardEvent) {
  const step =
    e.key === "ArrowRight" || e.key === "ArrowDown"
      ? 1
      : e.key === "ArrowLeft" || e.key === "ArrowUp"
        ? -1
        : 0;
  if (!step) return;
  e.preventDefault();
  const next = INTERACTION_MODES[modeIndex.value + step];
  if (!next) return;
  chooseMode(next.id);
  // SAFETY: this handler is bound to the track element, so currentTarget is that HTMLElement.
  const track = e.currentTarget as HTMLElement;
  track.querySelectorAll<HTMLElement>("[role=radio]")[modeIndex.value]?.focus();
}

/** The preview's mode control steps up the ladder, as the composer's does. */
function cycleMode() {
  const idx = INTERACTION_MODES.findIndex((m) => m.id === currentMode.value);
  chooseMode(INTERACTION_MODES[(idx + 1) % INTERACTION_MODES.length]!.id);
}

// ── behaviour ─────────────────────────────────────────────────────────────────
// Live, not defaults: the same module-scope store every composer reads, so a
// switch flipped here is obeyed by the composer behind the drawer at once.
const composer = useComposerPrefs();
const prefs = composer.prefs;

const mod = useShortcuts().isMacPlatform() ? "⌘" : "Ctrl";

type SendOption = { id: SendKey; label: string; keys: string[] };
const SEND_OPTIONS = computed<SendOption[]>(() => [
  { id: "enter", label: "Enter", keys: ["↵"] },
  { id: "mod-enter", label: `${mod} Enter`, keys: [mod, "↵"] },
]);
const sendIndex = computed(() => SEND_OPTIONS.value.findIndex((o) => o.id === prefs.value.sendKey));

/** The key legend under the preview: what sends, and what breaks the line. */
const legend = computed(() =>
  prefs.value.sendKey === "enter"
    ? [
        { keys: ["↵"], label: "Send" },
        { keys: ["⇧", "↵"], label: "New line" },
      ]
    : [
        { keys: [mod, "↵"], label: "Send" },
        { keys: ["↵"], label: "New line" },
      ],
);

function chooseSend(id: SendKey) {
  if (prefs.value.sendKey === id) return;
  composer.set("sendKey", id);
  cue("toggle");
}

type SwitchRow = {
  key: "typeToWake" | "keepDrafts" | "foldOnBlur";
  title: string;
  hint: string;
};
const SWITCHES: SwitchRow[] = [
  {
    key: "typeToWake",
    title: "Type anywhere to start",
    hint: "The first key you press on a project wakes the composer and lands in it.",
  },
  {
    key: "keepDrafts",
    title: "Keep unsent drafts",
    hint: "What you were writing is still there after a reload. Turning this off clears saved drafts.",
  },
  {
    key: "foldOnBlur",
    title: "Fold away on click outside",
    hint: "Clicking off the open composer folds it back to the orb. Off, only Escape does.",
  },
];

const PREF_KEYS: (keyof ComposerPrefs)[] = ["sendKey", "typeToWake", "keepDrafts", "foldOnBlur"];
const isDefault = computed(() =>
  PREF_KEYS.every((k) => prefs.value[k] === DEFAULT_COMPOSER_PREFS[k]),
);
function resetBehaviour() {
  composer.reset();
  cue("toggle");
}
</script>

<template>
  <SettingsPageShell
    :open="open"
    breadcrumb="Personalization / Composer"
    :breadcrumb-icon="PencilEdit01Icon"
    label="Composer settings"
    @back="$emit('back')"
  >
    <!-- Always laid out and only faded, so the masthead keeps its height and
         the page doesn't jump the moment something differs from the default. -->
    <template #actions>
      <button
        type="button"
        class="cp__reset"
        :class="{ 'cp__reset--hidden': isDefault }"
        :tabindex="open && !isDefault ? 0 : -1"
        :aria-hidden="isDefault"
        title="Put the send key and the switches back as they started"
        @click="resetBehaviour"
      >
        Reset
      </button>
    </template>

    <div class="cp">
      <!-- The still — the composer as a new chat will open it, wearing every
           choice below. Model and mode are live controls; the rest is picture. -->
      <figure class="cp__stage" aria-label="Composer preview">
        <div class="cp__card" :style="{ '--mode-hue': currentModeMeta.hue }">
          <p class="cp__text" :class="{ 'cp__text--multi': prefs.sendKey === 'mod-enter' }">
            <span>Tidy the settings drawer and</span>
            <!-- With Enter free for newlines, the draft runs to a second line —
                 the thing the setting is for. -->
            <span v-if="prefs.sendKey === 'mod-enter'" class="cp__br" aria-hidden="true" />
            <span>add a note on each change</span><i class="cp__caret" aria-hidden="true" />
          </p>

          <div class="cp__bar">
            <div class="cp__group">
              <span class="cp__btn cp__btn--still" aria-hidden="true">
                <HugeiconsIcon :icon="PlusSignIcon" :size="16" :stroke-width="2" />
              </span>
              <button
                type="button"
                class="cp__btn cp__mode"
                :tabindex="open ? 0 : -1"
                :aria-label="`Default approval: ${currentModeMeta.label}. Click to step to the next.`"
                :title="currentModeMeta.title"
                @click="cycleMode"
              >
                <Transition name="cp-swap" mode="out-in">
                  <InteractionModeIcon :key="currentMode" class="cp__mode-icon" :mode="currentMode" />
                </Transition>
                <span>{{ currentModeMeta.label }}</span>
              </button>
            </div>

            <div class="cp__group">
              <button
                type="button"
                class="cp__btn cp__model"
                :tabindex="open ? 0 : -1"
                aria-haspopup="dialog"
                aria-label="Change the default model"
                @click="togglePicker"
              >
                <ProviderLogo
                  v-if="modelDesc && modelDesc.brand !== 'generic'"
                  :brand="modelDesc.brand"
                  :size="14"
                />
                <span class="cp__model-name">{{ modelDesc?.name ?? "Provider default" }}</span>
                <span v-if="effortLabel" class="cp__model-effort">{{ effortLabel }}</span>
              </button>
              <span class="cp__seed" aria-hidden="true">
                <svg viewBox="0 0 18 18">
                  <path d="M9 14V4.2M9 4.2L4.3 8.9M9 4.2L13.7 8.9" fill="none" stroke="var(--accent-ink)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </span>
            </div>
          </div>
        </div>

        <!-- The key legend. Re-keyed on the send key so a change replays the
             press on the caps that now send. -->
        <figcaption :key="prefs.sendKey" class="cp__legend">
          <span v-for="(item, i) in legend" :key="i" class="cp__legend-item">
            <span class="cp__caps" :class="{ 'cp__caps--send': i === 0 }">
              <kbd v-for="k in item.keys" :key="k" class="cp__cap">{{ k }}</kbd>
            </span>
            {{ item.label }}
          </span>
        </figcaption>
      </figure>

      <!-- New chats ─────────────────────────────────────────────────────── -->
      <section class="srow__group">
        <h2 class="srow__heading">New chats</h2>
        <div class="srow__rows">
          <div class="srow__row">
            <h3 class="srow__title">Default model</h3>

            <div class="srow__value">
              <button
                type="button"
                class="srow__pick"
                :tabindex="open ? 0 : -1"
                aria-haspopup="dialog"
                aria-label="Change the default model"
                @click="togglePicker"
              >
                <span class="srow__pick-face">
                  <ProviderLogo
                    v-if="modelDesc && modelDesc.brand !== 'generic'"
                    :brand="modelDesc.brand"
                    :size="17"
                  />
                  <span class="srow__pick-name">{{ modelDesc?.name ?? "Provider default" }}</span>
                  <span v-if="effortLabel" class="srow__pick-effort">{{ effortLabel }}</span>
                </span>
                <HugeiconsIcon
                  class="srow__pick-chev"
                  :class="{ 'srow__pick-chev--on': pickerOpen }"
                  :icon="ArrowRight01Icon"
                  :size="15"
                  :stroke-width="1.8"
                  aria-hidden="true"
                />
              </button>
            </div>
          </div>

          <div class="srow__row">
            <!-- The hint is the set rung read out: what it does alone, then what
                 it stops for, so a change of rung is read as its consequence. -->
            <div class="cp__copy">
              <h3 class="srow__title">Default approval</h3>
              <p class="cp__hint" aria-live="polite">
                <span class="cp__hint-alone">{{ currentModeMeta.alone }}</span>;
                {{ currentModeMeta.asks }}.
              </p>
            </div>

            <!-- The send key's segmented control, three wide. -->
            <div
              class="cp__seg"
              role="radiogroup"
              aria-label="Default approval"
              :style="{ '--n': INTERACTION_MODES.length }"
              @keydown="onTrackKey"
            >
              <i class="cp__seg-pill" :style="{ '--i': modeIndex }" aria-hidden="true" />
              <button
                v-for="m in INTERACTION_MODES"
                :key="m.id"
                type="button"
                role="radio"
                class="cp__seg-opt cp__seg-opt--mode"
                :class="{ 'cp__seg-opt--on': m.id === currentMode }"
                :style="{ '--mode-hue': m.hue }"
                :aria-checked="m.id === currentMode"
                :title="m.title"
                :tabindex="open && m.id === currentMode ? 0 : -1"
                @click="chooseMode(m.id)"
              >
                <InteractionModeIcon class="cp__seg-icon" :mode="m.id" />
                {{ m.label }}
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- Writing ───────────────────────────────────────────────────────── -->
      <section class="srow__group">
        <h2 class="srow__heading">Writing</h2>
        <div class="srow__rows">
          <div class="srow__row">
            <div class="cp__copy">
              <h3 class="srow__title">Send with</h3>
              <p class="cp__hint">The other one breaks the line.</p>
            </div>

            <div class="cp__seg" role="radiogroup" aria-label="Which key sends">
              <i class="cp__seg-pill" :style="{ '--i': sendIndex }" aria-hidden="true" />
              <button
                v-for="o in SEND_OPTIONS"
                :key="o.id"
                type="button"
                role="radio"
                class="cp__seg-opt"
                :class="{ 'cp__seg-opt--on': prefs.sendKey === o.id }"
                :aria-checked="prefs.sendKey === o.id"
                :aria-label="o.label"
                :tabindex="open ? 0 : -1"
                @click="chooseSend(o.id)"
              >
                <kbd v-for="k in o.keys" :key="k" class="cp__cap cp__cap--sm">{{ k }}</kbd>
              </button>
            </div>
          </div>

          <div v-for="row in SWITCHES" :key="row.key" class="srow__row cp__switchrow">
            <div class="cp__copy">
              <h3 class="srow__title">{{ row.title }}</h3>
              <p class="cp__hint">{{ row.hint }}</p>
            </div>
            <ToggleSwitch
              :model-value="prefs[row.key]"
              :aria-label="row.title"
              :tabindex="open ? 0 : -1"
              @update:model-value="(on: boolean) => composer.set(row.key, on)"
            />
          </div>
        </div>
      </section>
    </div>

    <!-- Teleported to the body because the drawer's aside is overflow-hidden and
         rides a transformed stage, which would clip a fixed child. The picker is
         pane-anchored, so the shell it opens still lands in the pane's own
         bottom-right corner rather than over the whole app. -->
    <Teleport to="body">
      <ModelPickerModal
        v-if="pickerOpen"
        pane-anchored
        :providers="pickerProviders"
        :active-provider="activeProvider"
        :model-id="currentModel ?? undefined"
        :reasoning="currentReasoning ?? undefined"
        :fast-mode="false"
        @select="onModelSelect"
        @apply="onModelApply"
        @cancel="pickerOpen = false"
      />
    </Teleport>

    <template #foot>
      The model and approval are defaults — changing them never disturbs a chat that's already
      open; each seeds what the next one starts from. The writing settings apply to every composer
      straight away.
    </template>
  </SettingsPageShell>
</template>

<style scoped src="./settingsRows.css"></style>

<style scoped>
.cp {
  --cp-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --cp-ease-move: cubic-bezier(0.65, 0, 0.35, 1);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* ── the still ────────────────────────────────────────────────────────────── */
/* A sunken ground the card stands on, dotted like a work surface, so the
   preview reads as the composer on a page rather than as another row. */
.cp__stage {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  margin: 0 0 14px;
  padding: 34px 28px 20px;
  border-radius: 18px;
  background-color: var(--sunken);
  background-image: radial-gradient(
    color-mix(in srgb, var(--ink) 9%, transparent) 1px,
    transparent 1.2px
  );
  background-size: 14px 14px;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 5%, transparent);
}

/* Dressed as the open composer card (components/composer/composer.css): the
   field colour, the hairline, the 26px corners and the soft low lift. */
.cp__card {
  display: flex;
  flex-direction: column;
  width: min(100%, 520px);
  border: 1px solid var(--line);
  border-radius: 26px;
  background: var(--field);
  box-shadow:
    rgb(0 0 0 / 0.07) 0 10px 26px -12px,
    rgb(0 0 0 / 0.05) 0 2px 6px -3px;
}
.cp__text {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  column-gap: 0.28em;
  padding: 16px 20px 10px;
  font-size: 14.5px;
  line-height: 1.5;
  color: var(--ink);
}
.cp__br {
  flex-basis: 100%;
  height: 0;
}
.cp__caret {
  align-self: center;
  width: 1.5px;
  height: 1.05em;
  margin-left: -0.2em;
  background: var(--accent);
  animation: cp-blink 1.1s steps(1) infinite;
}
@keyframes cp-blink {
  50% {
    opacity: 0;
  }
}

.cp__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 8px 9px;
}
.cp__group {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
}
/* The composer's bar clothes: a bare 30px slot whose ink lifts on hover. */
.cp__btn {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 7px;
  border-radius: 9px;
  font-size: 12.5px;
  color: var(--ink-soft);
  opacity: 0.78;
  cursor: pointer;
  transition:
    opacity 0.2s ease,
    background-color 0.2s ease,
    transform 0.15s ease;
}
.cp__btn:not(.cp__btn--still):hover {
  opacity: 1;
  background: color-mix(in srgb, var(--ink) 6%, transparent);
}
.cp__btn:not(.cp__btn--still):active {
  transform: scale(0.95);
}
.cp__btn--still {
  cursor: default;
}
.cp__btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.cp__mode {
  color: var(--mode-hue);
  opacity: 0.95;
  transition:
    color 0.24s ease,
    opacity 0.2s ease,
    background-color 0.2s ease,
    transform 0.15s ease;
}
.cp__mode-icon {
  width: 15px;
  height: 15px;
}
.cp__model {
  min-width: 0;
}
.cp__model-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cp__model-effort {
  font-size: 11px;
  color: var(--muted);
}
.cp__seed {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  margin-left: 4px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: rgb(var(--chrome-ring) / 0.16) 0 0 0 4px;
}
.cp__seed svg {
  width: 15px;
  height: 15px;
}

/* ── the key legend ───────────────────────────────────────────────────────── */
.cp__legend {
  display: flex;
  align-items: center;
  gap: 22px;
  font-size: 12px;
  color: var(--muted);
}
.cp__legend-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.cp__caps {
  display: inline-flex;
  gap: 3px;
}
/* A change of send key presses the caps that now send, once. */
.cp__caps--send .cp__cap {
  animation: cp-press 420ms var(--cp-ease) both;
}
.cp__caps--send .cp__cap + .cp__cap {
  animation-delay: 60ms;
}
@keyframes cp-press {
  0% {
    transform: translateY(0);
  }
  35% {
    transform: translateY(1.5px);
    box-shadow: inset 0 -0.5px 0 color-mix(in srgb, var(--ink) 16%, transparent);
  }
  100% {
    transform: translateY(0);
  }
}

.cp__cap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 22px;
  padding: 0 6px;
  border-radius: 6px;
  font-family: inherit;
  font-size: 11.5px;
  line-height: 1;
  color: var(--ink-soft);
  background: var(--field);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--ink) 10%, transparent),
    inset 0 -1.5px 0 color-mix(in srgb, var(--ink) 12%, transparent);
}
.cp__cap--sm {
  min-width: 20px;
  height: 20px;
  font-size: 11px;
}

/* ── writing ──────────────────────────────────────────────────────────────── */
.cp__copy {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.cp__hint {
  max-width: 44ch;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--muted);
}
.cp__hint-alone {
  color: var(--ink-soft);
}
.cp__switchrow {
  align-items: center;
}

/* A segmented control whose pill glides to the set option — two wide for the
   send key, three for the approval rungs (--n). */
.cp__seg {
  position: relative;
  display: grid;
  grid-template-columns: repeat(var(--n, 2), 1fr);
  align-self: center;
  padding: 3px;
  border-radius: 11px;
  background-color: color-mix(in srgb, var(--ink) 5%, transparent);
}
.cp__seg-pill {
  position: absolute;
  top: 3px;
  bottom: 3px;
  left: 3px;
  width: calc((100% - 6px) / var(--n, 2));
  border-radius: 8px;
  background-color: var(--ground);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--ink) 7%, transparent),
    0 1px 3px color-mix(in srgb, var(--ink) 10%, transparent);
  transform: translateX(calc(100% * var(--i)));
  transition: transform 320ms var(--cp-ease-move);
}
.cp__seg-opt {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  min-width: 78px;
  padding: 5px 12px;
  border-radius: 8px;
  cursor: pointer;
  opacity: 0.6;
  transition: opacity 220ms ease;
}
.cp__seg-opt:hover {
  opacity: 0.85;
}
.cp__seg-opt--on {
  opacity: 1;
}
/* A rung's option: its glyph and name, the glyph in its hue once it's set. */
.cp__seg-opt--mode {
  gap: 6px;
  font-size: 12.5px;
  white-space: nowrap;
  color: var(--ink);
}
.cp__seg-icon {
  width: 14px;
  height: 14px;
  transition: color 220ms ease;
}
.cp__seg-opt--on .cp__seg-icon {
  color: var(--mode-hue);
}
.cp__seg-opt:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

/* ── reset + transitions ──────────────────────────────────────────────────── */
.cp__reset {
  padding: 5px 10px;
  border-radius: 8px;
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;
  transition:
    opacity 220ms ease,
    background-color 140ms ease,
    color 140ms ease;
}
.cp__reset:hover {
  background-color: var(--hover);
  color: var(--ink);
}
.cp__reset--hidden {
  opacity: 0;
  pointer-events: none;
}
.cp-swap-enter-active,
.cp-swap-leave-active {
  transition:
    opacity 140ms ease,
    transform 180ms var(--cp-ease);
}
.cp-swap-enter-from {
  opacity: 0;
  transform: translateY(4px) scale(0.85);
}
.cp-swap-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.85);
}

@media (prefers-reduced-motion: reduce) {
  .cp__caret,
  .cp__caps--send .cp__cap {
    animation: none;
  }
  .cp__seg-pill,
  .cp-swap-enter-active,
  .cp-swap-leave-active {
    transition: none;
  }
}
</style>
