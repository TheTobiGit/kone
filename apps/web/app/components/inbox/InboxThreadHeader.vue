<script setup lang="ts">
// The header of an inbox thread reading pane.
//
// Shows who is answering (the agent's face, call sign and vendor mark),
// the thread title, and token usage context.

import { computed } from "vue";
import AgentFace from "~/components/agent/AgentFace.vue";
import ProviderLogo from "~/components/provider/ProviderLogo.vue";
import ContextWindowMeter from "~/components/thread/ContextWindowMeter.vue";
import { agentIdentity } from "~/utils/agentIdentity";
import { sessionBrand, type BrandKey } from "~/utils/modelCatalog";
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
        <h2 class="ith__title" :title="title">{{ title }}</h2>
        <p class="ith__sub">{{ identity.name }}</p>
      </div>
    </div>

    <div class="ith__tail">
      <ContextWindowMeter
        v-if="tokenUsage"
        :usage="tokenUsage"
        class="ith__meter"
      />
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
  right: -2px;
  bottom: -2px;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--panel);
  box-shadow: 0 0 0 2.5px var(--panel);
  color: var(--ink);
  transform-origin: center center;
  will-change: transform;
  transition:
    transform 0.34s cubic-bezier(0.22, 1, 0.36, 1),
    background-color 0.34s cubic-bezier(0.22, 1, 0.36, 1),
    box-shadow 0.34s cubic-bezier(0.22, 1, 0.36, 1);
}

.ith__badge :deep(svg) {
  transform-origin: center center;
  transform: scale(0.85);
  will-change: transform;
  transition: transform 0.34s cubic-bezier(0.22, 1, 0.36, 1);
}

.ith:hover .ith__badge,
.ith__lead:hover .ith__badge {
  transform: translate(44px, -8px) scale(1.8);
  background: color-mix(in srgb, var(--ink) 6%, transparent);
  box-shadow: 0 0 0 0px transparent;
}

.ith:hover .ith__badge :deep(svg),
.ith__lead:hover .ith__badge :deep(svg) {
  transform: scale(0.68);
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

@media (prefers-reduced-motion: reduce) {
  .ith__lead,
  .ith__badge,
  .ith__badge :deep(svg) {
    animation: none;
    transition: none;
  }
}
</style>
