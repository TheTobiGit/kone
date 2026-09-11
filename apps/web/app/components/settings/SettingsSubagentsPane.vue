<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  Add01Icon,
  ArrowRight01Icon,
  RoboticIcon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/vue";
import CreateSubagentModal from "~/components/presets/CreateSubagentModal.vue";
import SettingsPageShell from "~/components/settings/SettingsPageShell.vue";
import SettingsSubagentDetail from "~/components/settings/SettingsSubagentDetail.vue";
import ToggleSwitch from "~/components/ui/ToggleSwitch.vue";
import { BUILTIN_SUBAGENT_PRESETS } from "@kone/protocol/subagent-presets";
import { useSubagentPresets } from "~/composables/useSubagentPresets";
import { useSound } from "~/composables/useSound";
import { formatModelChain } from "~/utils/detailFormat";
import { nativeSubagentIcon } from "~/utils/subagentIcons";
import type { AgentModelRef, SubagentPresetRecord } from "~/types/desktop";

const props = defineProps<{ open: boolean }>();
defineEmits<{ back: [] }>();

const { presets, nativeConfigs, configureNative } = useSubagentPresets();
const { cue } = useSound();

// One overlay at a time: the list, the create modal, or one preset's detail.
// A union rather than two booleans, so the modal and the detail can't stack.
type Overlay = { kind: "none" } | { kind: "create" } | { kind: "preset"; id: string };
const overlay = ref<Overlay>({ kind: "none" });

watch(
  () => props.open,
  (open) => {
    if (!open) {
      overlay.value = { kind: "none" };
    }
  },
);

function openPreset(id: string) {
  overlay.value = { kind: "preset", id };
  cue("press");
}

function startCreate() {
  overlay.value = { kind: "create" };
  cue("open");
}

function closeOverlay() {
  overlay.value = { kind: "none" };
}

function onCreated(created: SubagentPresetRecord) {
  overlay.value = { kind: "preset", id: created.presetId };
}

// ── Native Subagents ────────────────────────────────────────────────────────
const natives = computed(() =>
  BUILTIN_SUBAGENT_PRESETS.map((preset) => {
    const config = nativeConfigs.value.find((c) => c.presetId === preset.presetId);
    return {
      presetId: preset.presetId,
      name: preset.name,
      instructions: preset.instructions,
      enabled: config?.enabled ?? true,
      model: config?.model ?? null,
      modelFallbacks: config?.modelFallbacks ?? [],
    };
  }),
);

function toggleNative(presetId: string, enabled: boolean) {
  cue("toggle");
  void configureNative(presetId, { enabled });
}

function chainSummary(
  model: AgentModelRef | null,
  fallbacks: readonly AgentModelRef[] | null | undefined,
): string {
  return formatModelChain(model, fallbacks) ?? "Inherits the caller";
}

function snippetText(instructions: string | null | undefined, empty: string): string {
  const first = instructions?.split(/\n{2,}/)[0]?.trim();
  return first || empty;
}
</script>

<template>
  <CreateSubagentModal
    v-if="overlay.kind === 'create'"
    @close="closeOverlay"
    @created="onCreated"
  />

  <SettingsSubagentDetail
    v-else-if="overlay.kind === 'preset'"
    :open="open"
    :preset-id="overlay.id"
    @back="closeOverlay"
    @switched="(id) => (overlay = { kind: 'preset', id })"
  />

  <SettingsPageShell
    v-else
    :open="open"
    breadcrumb="Ecosystem / Sub-agents"
    :breadcrumb-icon="RoboticIcon"
    label="Sub-agents"
    @back="$emit('back')"
  >
    <template #actions>
      <button
        type="button"
        class="sa__new-action-btn"
        :tabindex="open ? 0 : -1"
        @click="startCreate"
      >
        <HugeiconsIcon :icon="Add01Icon" :size="13" :stroke-width="1.8" aria-hidden="true" />
        <span>New sub-agent</span>
      </button>
    </template>

    <div class="sa">
      <!-- Section 1: Built-in native sub-agents -->
      <section class="sa__section" aria-label="Built-in">
        <header class="sa__sectionhead">
          <HugeiconsIcon
            :icon="RoboticIcon"
            :size="12"
            :stroke-width="1.8"
            aria-hidden="true"
            class="sa__sectionglyph"
          />
          <span class="sa__eyebrow">Built-in</span>
          <span class="sa__count">{{ natives.length }}</span>
        </header>

        <div class="sa__grid" role="list" aria-label="Built-in">
          <article
            v-for="native in natives"
            :key="native.presetId"
            role="listitem"
            class="sa__card"
            :class="{ 'sa__card--off': !native.enabled }"
            :tabindex="open ? 0 : -1"
            :aria-label="native.name"
            @click="openPreset(native.presetId)"
            @keydown.enter.prevent="openPreset(native.presetId)"
            @keydown.space.prevent="openPreset(native.presetId)"
          >
            <div class="sa__card-head">
              <span class="sa__glyph" aria-hidden="true">
                <HugeiconsIcon
                  :icon="nativeSubagentIcon(native.presetId)"
                  :size="18"
                  :stroke-width="1.7"
                />
              </span>
              <div class="sa__ident">
                <h4 class="sa__name">{{ native.name }}</h4>
                <p class="sa__model">{{ chainSummary(native.model, native.modelFallbacks) }}</p>
              </div>

              <div class="sa__head-actions" @click.stop>
                <ToggleSwitch
                  :model-value="native.enabled"
                  :aria-label="`Enable ${native.name}`"
                  @update:model-value="toggleNative(native.presetId, $event)"
                />
              </div>
            </div>

            <p class="sa__snippet">
              {{ snippetText(native.instructions, "No standing instructions.") }}
            </p>
          </article>
        </div>
      </section>

      <!-- Section 2: Custom presets -->
      <section class="sa__section" aria-label="Custom">
        <header class="sa__sectionhead">
          <HugeiconsIcon
            :icon="SparklesIcon"
            :size="12"
            :stroke-width="1.8"
            aria-hidden="true"
            class="sa__sectionglyph"
          />
          <span class="sa__eyebrow">Custom</span>
          <span class="sa__count">{{ presets.length }}</span>
        </header>

        <div v-if="!presets.length" class="sa__empty">
          <p>No custom sub-agents yet.</p>
        </div>

        <div v-else class="sa__grid" role="list" aria-label="Custom">
          <article
            v-for="p in presets"
            :key="p.presetId"
            role="listitem"
            class="sa__card"
            :tabindex="open ? 0 : -1"
            :aria-label="p.name"
            @click="openPreset(p.presetId)"
            @keydown.enter.prevent="openPreset(p.presetId)"
            @keydown.space.prevent="openPreset(p.presetId)"
          >
            <div class="sa__card-head">
              <span class="sa__glyph" aria-hidden="true">
                <HugeiconsIcon :icon="RoboticIcon" :size="18" :stroke-width="1.7" />
              </span>
              <div class="sa__ident">
                <h4 class="sa__name">{{ p.name }}</h4>
                <p class="sa__model">{{ chainSummary(p.model, p.modelFallbacks) }}</p>
              </div>
              <span class="sa__open-cue" aria-hidden="true">
                <HugeiconsIcon :icon="ArrowRight01Icon" :size="15" :stroke-width="1.8" />
              </span>
            </div>

            <p class="sa__snippet">
              {{ snippetText(p.instructions, "No standing instructions yet.") }}
            </p>
          </article>
        </div>
      </section>
    </div>

    <template #foot>
      A sub-agent is a lightweight, focused worker spawned by a lead agent to execute an isolated
      task. Built-in presets provide tested patterns for exploration, code review, security, research,
      and execution; custom presets allow tailoring instructions and pinning model preferences.
    </template>
  </SettingsPageShell>
</template>

<style scoped>
.sa {
  --sa-ease: cubic-bezier(0.22, 1, 0.36, 1);
  display: flex;
  flex-direction: column;
  gap: 32px;
  max-width: 56rem;
  padding-block: 4px 3rem;
  container-type: inline-size;
}

/* ── masthead action button ───────────────────────────────────────────────── */
.sa__new-action-btn {
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
    background-color 140ms ease,
    color 140ms ease;
}
.sa__new-action-btn:hover {
  background-color: var(--hover);
  color: var(--ink);
}
.sa__new-action-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

/* ── sections ──────────────────────────────────────────────────────────────── */
.sa__section {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.sa__sectionhead {
  display: flex;
  align-items: center;
  gap: 7px;
  padding-inline: 4px;
}

.sa__sectionglyph {
  flex-shrink: 0;
  color: var(--muted);
}

.sa__eyebrow {
  font-size: 10.5px;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  line-height: 1;
  color: var(--muted);
}

.sa__count {
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  opacity: 0.6;
}

/* ── cards grid ───────────────────────────────────────────────────────────── */
.sa__grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 14px;
}
@container (min-width: 540px) {
  .sa__grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.sa__card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border-radius: 16px;
  background-color: color-mix(in srgb, var(--ink) 3%, transparent);
  cursor: pointer;
  outline: none;
  text-align: start;
  border: 1px solid transparent;
  transition:
    background-color 200ms var(--sa-ease),
    transform 200ms var(--sa-ease),
    border-color 200ms var(--sa-ease),
    opacity 200ms var(--sa-ease);
}
.sa__card:hover {
  background-color: var(--hover);
  transform: translateY(-1px);
}
.sa__card:focus-visible {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.sa__card--off {
  opacity: 0.58;
}

.sa__empty {
  padding: 18px 4px;
  font-size: 13px;
  color: var(--muted);
}
.sa__empty p {
  margin: 0;
}

.sa__card-head {
  display: flex;
  align-items: center;
  gap: 13px;
  min-width: 0;
}

.sa__glyph {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  border-radius: 12px;
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
  color: var(--ink-soft);
  transition:
    color 200ms ease,
    background-color 200ms ease;
}
.sa__card:hover .sa__glyph {
  color: var(--accent);
  background-color: color-mix(in oklab, var(--accent) 14%, transparent);
}

.sa__ident {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1 1 auto;
}
.sa__name {
  margin: 0;
  font-size: 15px;
  font-weight: 500;
  letter-spacing: -0.01em;
  line-height: 1.2;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sa__model {
  margin: 0;
  font-size: 12px;
  line-height: 1.2;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sa__head-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.sa__open-cue {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  opacity: 0;
  transform: translateX(-3px);
  transition:
    opacity 160ms ease,
    transform 160ms var(--sa-ease),
    color 160ms ease;
}
.sa__card:hover .sa__open-cue {
  opacity: 1;
  transform: translateX(0);
  color: var(--ink);
}

.sa__snippet {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--ink-soft);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  line-clamp: 2;
  overflow: hidden;
  text-wrap: pretty;
  min-height: 2.9em;
}

@media (prefers-reduced-motion: reduce) {
  .sa__card,
  .sa__glyph,
  .sa__open-cue {
    transition: none;
    transform: none;
  }
}
</style>
