<script setup lang="ts">
import { computed, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { AiBrain01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import FileChip from "~/components/git-space/FileChip.vue";
import SiteChip from "~/components/site/SiteChip.vue";
import TurnOrb from "~/components/turn/TurnOrb.vue";
import ActivityStepDetail from "~/components/conversation/ActivityStepDetail.vue";
import ActivityThemeReceipt from "~/components/conversation/ActivityThemeReceipt.vue";
import ThemeSwatch from "~/components/theme/ThemeSwatch.vue";
import MarkdownMessage from "~/components/markdown/MarkdownMessage.vue";
import { useThemeSummaryReading } from "~/composables/useThemeSummaryReading";
import type { ActivityEntry } from "~/utils/conversationSegments";
import { stateForToolFamily } from "~/utils/thinkingOrb";
import { thinkingOrbHue } from "~/utils/toolOrbDraw";
import {
  toolDetailFull,
  toolMeta,
  toolPhraseParts,
  toolStatus,
} from "~/utils/toolPresentation";

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

const open = ref(false);
const everOpened = ref(false);

const isThinking = computed(() => props.entry.type === "thinking");
const tool = computed(() => (props.entry.type === "tool" ? props.entry.item : null));

const meta = computed(() => (tool.value ? toolMeta(tool.value.name) : null));
const status = computed(() => (tool.value ? toolStatus(tool.value) : "done"));

// ── appearance rows ─────────────────────────────────────────────────────────
// A theme tool's whole effect lands on the window, so the row shows the palette
// it left behind, read back out of the call's own stored record. That is the
// reading that survives a reload; the announcement beside the turn's reply
// (components/turn/ThemeChangeLine.vue) is the same change drawn as the theme.

const {
  toTheme,
  fromTheme,
  toColors,
  fromColors,
  has: namedTheme,
} = useThemeSummaryReading(tool);

/** A failed call changed nothing, so it has no palette to wear however well its
 *  summary reads. One guard, here, rather than one per place that draws. */
const hasThemeBody = computed(() => namedTheme.value && status.value === "done");

/** The palette the row wears inline: where the window ended up. */
const rowColors = computed(() => (hasThemeBody.value ? toColors.value : null));

// A thinking row discloses only when the model actually surfaced reasoning; a
// tool row discloses only when it carries a result body — or a change of its own
// to show, which is a body no provider sends.
const hasThinkingBody = computed(() => isThinking.value && !!props.thinkingText?.trim());
// An appearance call's own body replaces its result text rather than joining it:
// the detail IS the record the palette was read from, so showing both would
// print the data under the picture of itself.
const hasToolBody = computed(() => !!tool.value?.detail && !hasThemeBody.value);
const clickable = computed(() => hasThinkingBody.value || hasToolBody.value || hasThemeBody.value);

const hue = computed(() => (isThinking.value ? thinkingOrbHue() : meta.value?.hue));

function toggle(): void {
  if (!clickable.value) return;
  open.value = !open.value;
  if (open.value) everOpened.value = true;
  cue("toggle");
}
</script>

<template>
  <div class="astep" :class="isThinking ? 'astep--think' : `astep--${status}`" :style="{ '--hue': hue }">
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
        <template v-if="isThinking">
          <TurnOrb
            v-if="streaming"
            state="thinking"
            :icon="AiBrain01Icon"
            :size="16"
            aria-label="Thinking"
          />
          <HugeiconsIcon v-else :icon="AiBrain01Icon" :size="14" :stroke-width="1.8" />
        </template>
        <template v-else-if="tool && meta">
          <TurnOrb
            v-if="status === 'running'"
            :state="stateForToolFamily(meta.family)"
            :icon="meta.icon"
            :size="16"
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

      <ThemeSwatch
        v-if="rowColors"
        class="astep__swatch"
        :colors="rowColors"
        :label="toTheme?.label"
      />

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

    <div v-if="clickable" class="astep__body" :class="{ 'astep__body--open': open }">
      <div class="astep__body-inner">
        <template v-if="everOpened">
          <div v-if="hasThinkingBody" class="astep__think-wrap">
            <MarkdownMessage :source="thinkingText!" :historical="true" />
          </div>
          <ActivityThemeReceipt
            v-else-if="hasThemeBody && toColors"
            :to-label="toTheme?.label ?? ''"
            :to-colors="toColors"
            :from-label="fromTheme?.label"
            :from-colors="fromColors"
          />
          <ActivityStepDetail
            v-else-if="hasToolBody"
            :detail="tool!.detail!"
            :tool-name="tool!.name"
            :tool-text="tool!.text"
          />
        </template>
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
/* The row's own palette, pushed to the end of the line so a run of rows lines
   its swatches up against the chevron rather than against ragged label ends. */
.astep__swatch {
  flex: none;
  margin-left: auto;
  padding-left: 8px;
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
/* Height-animated disclosure (grid 0fr → 1fr) so the body slides open/closed. */
.astep__body {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.32s cubic-bezier(0.22, 1, 0.36, 1);
}
.astep__body--open {
  grid-template-rows: 1fr;
}
.astep__body-inner {
  overflow: hidden;
  min-height: 0;
  padding-left: 24px;
}
.astep__think-wrap {
  margin: 2px 0 8px;
  padding: 8px 12px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--ink) 2.5%, transparent);
  border: 1px solid color-mix(in srgb, var(--ink) 6%, transparent);
  font-size: 13px;
  line-height: 1.6;
  color: var(--muted);
}
.astep__think-wrap :deep(p) {
  margin: 0 0 6px;
}
.astep__think-wrap :deep(p:last-child) {
  margin-bottom: 0;
}
@media (prefers-reduced-motion: reduce) {
  .astep__chev,
  .astep__body {
    transition: none;
  }
}
</style>
