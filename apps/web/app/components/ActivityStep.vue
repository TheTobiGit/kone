<script setup lang="ts">
import { computed, inject, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { AiBrain01Icon, ArrowRight01Icon, ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import FileChip from "~/components/FileChip.vue";
import SiteChip from "~/components/SiteChip.vue";
import TurnOrb from "~/components/TurnOrb.vue";
import type { ActivityEntry } from "~/utils/conversationSegments";
import { SUBAGENT_OPEN_KEY, subagentTitle } from "~/utils/subagentRuns";
import { stateForToolFamily } from "~/utils/thinkingOrb";
import { THINKING_ORB_HUE } from "~/utils/toolOrbDraw";
import { toolDetailFull, toolMeta, toolPhraseParts, toolStatus } from "~/utils/toolPresentation";

// One row of the Agent Activity feed — a single thinking segment or tool call.
// Icon → label (with inline file/site chips) → status → a chevron that slides a
// body open when there's something to reveal (the model's reasoning text, or a
// tool's result). Rows with nothing to show are inert: no chevron, no cursor.
//
// The container (AgentActivity) owns the turn's timing, so it hands thinking
// rows their streaming flag, text, and duration; tool rows read everything they
// need off the item itself. Reused verbatim in the live sliding window and in
// the expanded chronological list, so a row looks identical wherever it lives.

const props = defineProps<{
  entry: ActivityEntry;
  /** Draw the connector segment above this row (false for the first row). */
  rail?: boolean;
  /** Thinking rows only — precomputed by the container which owns turn timing. */
  streaming?: boolean;
  thinkingText?: string;
  thinkingDuration?: number | null;
}>();

const { cue } = useSound();

// The parent's open-subagent handler, when this row lives inside a kone surface
// that provides it (ProjectView). A subagent's spawning tool row carries the
// nested run (`item.subagent`), so it gets a small "open thread" affordance.
// Absent (tests, embedded renders) → no affordance, rows stay as they are.
const openSubagent = inject(SUBAGENT_OPEN_KEY, null);
const subagentRun = computed(() =>
  props.entry.type === "tool" ? props.entry.item.subagent ?? null : null,
);

const open = ref(false);

const isThinking = computed(() => props.entry.type === "thinking");
const tool = computed(() => (props.entry.type === "tool" ? props.entry.item : null));

const meta = computed(() => (tool.value ? toolMeta(tool.value.name) : null));
const status = computed(() => (tool.value ? toolStatus(tool.value) : "done"));

// A thinking row discloses only when the model actually surfaced reasoning; a
// tool row discloses only when it carries a result body. Otherwise inert.
const hasThinkingBody = computed(() => isThinking.value && !!props.thinkingText?.trim());
const hasToolBody = computed(() => !!tool.value?.detail);
const clickable = computed(() => hasThinkingBody.value || hasToolBody.value);

const hue = computed(() => (isThinking.value ? THINKING_ORB_HUE : meta.value?.hue));

function toggle(): void {
  if (!clickable.value) return;
  open.value = !open.value;
  cue("toggle");
}
</script>

<template>
  <div class="astep" :class="[isThinking ? 'astep--think' : `astep--${status}`, subagentRun ? 'astep--sub' : '']" :style="{ '--hue': hue }">
    <span v-if="rail" class="astep__link" aria-hidden="true" />

    <component
      :is="clickable ? 'button' : 'div'"
      :type="clickable ? 'button' : undefined"
      class="astep__row"
      :class="{ 'astep__row--clickable': clickable }"
      :title="tool ? toolDetailFull(tool) || undefined : undefined"
      @click="toggle"
    >
      <span class="astep__icon">
        <!-- Thinking -->
        <template v-if="isThinking">
          <TurnOrb v-if="streaming" state="thinking" :size="14" aria-label="Thinking" />
          <HugeiconsIcon v-else :icon="AiBrain01Icon" :size="14" :stroke-width="1.8" />
        </template>
        <!-- Tool -->
        <template v-else-if="tool && meta">
          <TurnOrb
            v-if="status === 'running'"
            :state="stateForToolFamily(meta.family)"
            :size="14"
            :aria-label="`${meta.label} running`"
          />
          <HugeiconsIcon v-else :icon="meta.icon" :size="14" :stroke-width="1.8" />
        </template>
      </span>

      <span class="astep__label">
        <!-- Thinking label -->
        <template v-if="isThinking">
          {{ streaming ? "Thinking…" : `Thought for ${thinkingDuration ?? 1}s` }}
        </template>
        <!-- Tool phrase, with inline chips for files / folders / sites -->
        <template v-else-if="tool">
          <template v-for="(part, pi) in toolPhraseParts(tool)" :key="pi">
            <FileChip
              v-if="part.kind === 'file'"
              class="astep__chip"
              :path="part.path"
              :title="toolDetailFull(tool) || part.path"
            />
            <FileChip
              v-else-if="part.kind === 'folder'"
              class="astep__chip"
              folder
              :path="part.path"
              :title="toolDetailFull(tool) || part.path"
            />
            <SiteChip
              v-else-if="part.kind === 'site'"
              class="astep__chip"
              :url="part.url"
              :title="toolDetailFull(tool) || part.url"
            />
            <span v-else-if="part.kind === 'mono'" class="astep__target">{{ part.text }}</span>
            <template v-else>{{ part.text }}</template>
          </template>
        </template>
      </span>

      <span v-if="status === 'error'" class="astep__err">failed</span>
      <HugeiconsIcon
        v-if="clickable"
        :icon="ArrowRight01Icon"
        :size="14"
        :stroke-width="2"
        class="astep__chev"
        :class="{ 'astep__chev--open': open }"
      />
    </component>

    <!-- A subagent's spawning tool row carries its nested run — a small
         "open thread" affordance parks over the row's right edge (the row's
         padding makes room for it) and opens the child's own transcript. -->
    <button
      v-if="subagentRun && openSubagent"
      type="button"
      class="astep__open"
      :title="`Open ${subagentTitle(subagentRun)}'s thread`"
      :aria-label="`Open ${subagentTitle(subagentRun)}'s thread`"
      @click.stop="openSubagent(subagentRun.toolUseId)"
    >
      <HugeiconsIcon :icon="ArrowUpRight01Icon" :size="13" :stroke-width="2" />
    </button>

    <div v-if="clickable" class="astep__body" :class="{ 'astep__body--open': open }">
      <div class="astep__body-inner">
        <p v-if="hasThinkingBody" class="astep__think">{{ thinkingText }}</p>
        <pre v-else-if="hasToolBody" class="astep__output">{{ tool!.detail }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.astep {
  position: relative;
}
/* Connector segment — a short line rising from this row's icon to the row above,
   so a run of steps reads as one thread. 24px covers a collapsed neighbour; the
   icon's opaque ground caps the line so it touches the glyph without crossing it. */
.astep__link {
  position: absolute;
  left: 7px;
  bottom: calc(100% - 12px);
  width: 1.5px;
  height: 22px;
  background: color-mix(in srgb, var(--ink) 12%, transparent);
  z-index: 0;
}
.astep__row {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 4px 0;
  border: 0;
  background: transparent;
  color: var(--ink-soft);
  font-size: 13px;
  letter-spacing: -0.005em;
  text-align: left;
  cursor: default;
}
.astep__row--clickable {
  cursor: pointer;
}
.astep__row--clickable:hover {
  color: var(--ink);
}
.astep__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 16px;
  height: 16px;
  background: var(--ground);
  color: var(--hue, var(--muted));
}
.astep__label {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: 1 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.astep__chip {
  flex: 0 1 auto;
  min-width: 0;
  max-width: min(100%, 16rem);
}
.astep__target {
  font-family: var(--font-mono);
  color: var(--muted);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.astep--error .astep__label {
  color: var(--diff-del);
}
.astep__err {
  flex: none;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--diff-del);
}
.astep__chev {
  flex: none;
  opacity: 0.45;
  transition: transform 0.22s ease;
}
.astep__chev--open {
  transform: rotate(90deg);
}
/* The open-thread affordance reserves the row's right edge and parks there.
   Only present on a spawning subagent's tool row, and only when an opener was
   injected — otherwise the row stays exactly as it was. */
.astep--sub .astep__row {
  padding-right: 26px;
}
.astep__open {
  position: absolute;
  top: 50%;
  right: 0;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  opacity: 0;
  transform: translateY(-50%) translate(-1px, 1px);
  transition: opacity 0.14s ease, transform 0.18s ease, background-color 0.14s ease, color 0.14s ease;
}
.astep:hover .astep__open,
.astep:focus-within .astep__open {
  opacity: 0.85;
  transform: translateY(-50%);
}
.astep__open:hover,
.astep__open:focus-visible {
  background: var(--hover);
  color: var(--ink);
  opacity: 1;
  outline: none;
}
/* Height-animated disclosure (grid 0fr → 1fr) so the body slides open/closed. */
.astep__body {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.28s cubic-bezier(0.22, 1, 0.36, 1);
}
.astep__body--open {
  grid-template-rows: 1fr;
}
.astep__body-inner {
  overflow: hidden;
  min-height: 0;
  padding-left: 24px;
}
.astep__think {
  margin: 0 0 6px;
  font-size: 14px;
  line-height: 1.6;
  color: var(--muted);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  text-wrap: pretty;
}
.astep__output {
  margin: 0 0 6px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--hover);
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ink-soft);
  white-space: pre-wrap;
  overflow-x: auto;
  max-width: 100%;
}
@media (prefers-reduced-motion: reduce) {
  .astep__chev,
  .astep__open,
  .astep__body {
    transition: none;
  }
}
</style>
