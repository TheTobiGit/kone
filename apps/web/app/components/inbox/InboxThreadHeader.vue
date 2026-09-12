<script setup lang="ts">
// The header of an inbox thread reading pane.
//
// Shows who is answering (the agent's face, call sign and vendor mark),
// the thread title, and token usage context.

import { computed } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Archive02Icon, BubbleChatTemporaryIcon } from "@hugeicons/core-free-icons";
import AgentFace from "~/components/agent/AgentFace.vue";
import ProviderLogo from "~/components/provider/ProviderLogo.vue";
import ContextWindowMeter from "~/components/thread/ContextWindowMeter.vue";
import { agentIdentity } from "~/utils/agentIdentity";
import { sessionBrand, type BrandKey } from "~/utils/modelCatalog";
import type { MeterCompactProps } from "~/utils/compactAvailability";
import type { ProviderKind, TokenUsage } from "~/types/desktop";

const props = defineProps<{
  /** Thread title displayed as the prominent heading. */
  title: string;
  /** Seed used to derive deterministic or assigned agent identity. */
  seed?: string | null;
  /** CLI provider running the thread (e.g. codex, claudeAgent, etc.). */
  provider?: ProviderKind;
  /** Explicit brand key override if known. */
  brand?: BrandKey;
  /** Context window token consumption breakdown when available. */
  tokenUsage?: TokenUsage;
  /** The meter's Compact control — absent hides the actions card (stored
   *  threads have no live session to compact). */
  compact?: MeterCompactProps;
  /** Forked throwaway conversation — wears the temporary mark beside the title. */
  sideChat?: boolean;
  /** Show the archive action (the studio column header's own control). */
  archivable?: boolean;
  /** Make the title open the thread info panel (the studio column header's
   *  read-out — rename lives there, so the header itself stays a read-out). */
  infoClickable?: boolean;
  /** Whether the info panel is currently open for this thread. */
  infoOpen?: boolean;
  /** The directory this conversation works in, when it is not the project's own
   *  checkout. Absent is the ordinary case and wears no mark. */
  worktreePath?: string | null;
  /** A worktree was chosen for this conversation and does not exist yet. */
  workspacePending?: boolean;
}>();

const emit = defineEmits<{
  /** Archive this thread (the studio column header's own control). */
  archive: [];
  /** Title asked for its info panel — carries the DOM event so the caller can
   *  anchor the panel to the title that opened it. */
  "open-info": [event: Event];
}>();

const identity = computed(() => agentIdentity(props.seed));
// The header tolerates a thread whose provider is not yet known; without one
// there is no model vendor to resolve, so the explicit brand (or generic) wins.
const effectiveBrand = computed(() =>
  props.provider
    ? sessionBrand(props.provider, props.brand ?? "generic", undefined)
    : (props.brand ?? "generic"),
);
</script>

<template>
  <header class="ith">
    <div class="ith__main">
      <div class="ith__lead">
        <div class="ith__avatar-wrap">
          <AgentFace :seed="seed" :size="36" class="ith__face" />
          <span
            class="ith__badge"
            :title="effectiveBrand !== 'generic' ? effectiveBrand : undefined"
          >
            <ProviderLogo :brand="effectiveBrand" :size="20" />
          </span>
        </div>
      </div>

      <div class="ith__body">
        <div class="ith__title-row">
          <span v-if="sideChat" class="ith__sidechat" title="Side chat — forked from a conversation">
            <HugeiconsIcon :icon="BubbleChatTemporaryIcon" :size="11" :stroke-width="2" aria-hidden="true" />
          </span>
          <h2
            v-if="infoClickable"
            class="ith__title ith__title--btn"
            :class="{ 'ith__title--sidechat': sideChat }"
            :title="title"
            role="button"
            tabindex="0"
            :aria-expanded="infoOpen"
            @click.stop="emit('open-info', $event)"
            @keydown.enter.prevent="emit('open-info', $event)"
            @keydown.space.prevent="emit('open-info', $event)"
          >{{ title }}</h2>
          <h2
            v-else
            class="ith__title"
            :class="{ 'ith__title--sidechat': sideChat }"
            :title="title"
          >{{ title }}</h2>
        </div>
        <p class="ith__sub">{{ identity.name }}</p>
      </div>
    </div>

    <div class="ith__tail">
      <ContextWindowMeter
        v-if="tokenUsage"
        :usage="tokenUsage"
        v-bind="compact"
        class="ith__meter"
      />
      <button
        v-if="archivable"
        type="button"
        class="ith__tool"
        aria-label="Archive conversation"
        title="Archive conversation"
        @click.stop="emit('archive')"
      >
        <HugeiconsIcon :icon="Archive02Icon" :size="14" :stroke-width="1.9" aria-hidden="true" />
      </button>
    </div>
  </header>
</template>

<style scoped>
.ith {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 20px 12px;
  background: var(--panel);
}

.ith__main {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  flex: 1;
}

.ith__lead {
  position: relative;
  display: flex;
  align-items: center;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  transition: width 0.34s cubic-bezier(0.22, 1, 0.36, 1);
}

.ith:hover .ith__lead,
.ith__lead:hover {
  width: 78px;
}

.ith__avatar-wrap {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
  height: 36px;
}

.ith__face {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  flex-shrink: 0;
}

.ith__badge {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--panel);
  box-shadow: 0 0 0 3px var(--panel);
  color: var(--ink);
  transform-origin: center center;
  transform: translate(11px, 11px) scale(0.52);
  will-change: transform;
  transition:
    transform 0.34s cubic-bezier(0.22, 1, 0.36, 1),
    background-color 0.34s cubic-bezier(0.22, 1, 0.36, 1),
    box-shadow 0.34s cubic-bezier(0.22, 1, 0.36, 1);
}

.ith__badge :deep(svg) {
  transform-origin: center center;
  transform: scale(1.22);
  will-change: transform;
  transition: transform 0.34s cubic-bezier(0.22, 1, 0.36, 1);
}

.ith:hover .ith__badge,
.ith__lead:hover .ith__badge {
  transform: translate(42px, 0) scale(1);
  background: color-mix(in srgb, var(--ink) 6%, transparent);
  box-shadow: 0 0 0 0px transparent;
}

.ith:hover .ith__badge :deep(svg),
.ith__lead:hover .ith__badge :deep(svg) {
  transform: scale(1);
}

.ith__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ith__title {
  margin: 0;
  font-family: var(--font-sans);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 19px;
  color: var(--ink-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ith__title-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.ith__title--btn {
  cursor: pointer;
}

.ith__title--btn:hover {
  color: var(--ink);
}

.ith__title--btn:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ink) 30%, transparent);
  outline-offset: 2px;
  border-radius: 6px;
}

.ith__sidechat {
  display: inline-flex;
  flex: none;
  align-items: center;
  color: color-mix(in srgb, var(--accent) 72%, var(--ink-soft));
}

.ith__title--sidechat {
  color: color-mix(in srgb, var(--accent) 58%, var(--muted));
  font-style: italic;
}

.ith__sub {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 14px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ith__tail {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
}

/* Muted and mono, the same register the inbox row uses for it — a statement
   about the thread, not a control. */
.ith__workspace {
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 14px;
  color: var(--faint);
  max-width: 18ch;
}

.ith__tool {
  display: grid;
  place-items: center;
  cursor: pointer;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
  transition:
    color 0.2s ease,
    background-color 0.2s ease;
}

.ith__tool:hover {
  background: var(--hover);
  color: var(--ink);
}

@media (prefers-reduced-motion: reduce) {
  .ith__lead,
  .ith__badge,
  .ith__badge :deep(svg) {
    animation: none;
    transition: none;
  }
}
</style>
