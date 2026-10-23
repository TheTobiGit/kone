<script setup lang="ts">
// The Models section from SettingsProvidersPane, as it is: every model family the
// open provider offers, each with its own show-in-picker switch. The #actions
// slot sits in the head beside the count, for actions that belong to the list.
import ProviderModelMeta from "~/components/provider/ProviderModelMeta.vue";
import { useEdgeFade } from "~/composables/useEdgeFade";
import type { MockProvidersPane } from "./useMockProvidersPane";
import { ref } from "vue";

defineProps<{ pane: MockProvidersPane }>();

const scroller = ref<HTMLElement>();
const { measure, maskStyle } = useEdgeFade(scroller);
</script>

<template>
  <section class="pp__models" aria-label="Models">
    <div class="pp__modelshead">
      <p class="pp__blocklabel">Models</p>
      <div class="pp__modelsend">
        <p v-if="pane.modelRows.value.length" class="pp__modelscount">
          {{ pane.modelRows.value.length }} offered<template v-if="pane.hiddenCount.value">
            · {{ pane.hiddenCount.value }} hidden</template
          >
        </p>
        <slot name="actions" />
      </div>
    </div>

    <ul
      v-if="pane.modelRows.value.length"
      ref="scroller"
      class="pp__modellist"
      :style="maskStyle"
      @scroll.passive="measure"
    >
      <li
        v-for="row in pane.modelRows.value"
        :key="row.key"
        class="pp__model"
        :class="{ 'pp__model--off': row.hidden }"
      >
        <ProviderLogo :brand="row.brand" :size="16" class="pp__modelmark" />
        <span class="pp__modeltext">
          <span class="pp__modelname">{{ row.label }}</span>
          <ProviderModelMeta :model="row.model" :fallback-tokens="row.contextTokens" :show-vendor="pane.showVendor.value" />
        </span>
        <button
          type="button"
          role="switch"
          class="pp__switch pp__modelswitch"
          :class="{ 'pp__switch--on': !row.hidden }"
          :aria-checked="!row.hidden"
          :aria-label="`Show ${row.label} in the picker`"
          @click="pane.toggleModel(row.key)"
        >
          <i class="pp__knob" />
        </button>
      </li>
      <slot name="after" />
    </ul>

    <p v-else class="pp__hint">
      {{
        pane.current.value.status?.readiness === "ready"
          ? "No models to list — this provider reported none."
          : "Sign this provider in to read the models it offers."
      }}
    </p>
  </section>
</template>

<style scoped>
.pp__modelsend {
  display: flex;
  align-items: center;
  gap: 6px;
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
  border-top: 1px solid var(--line-soft);
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

</style>
