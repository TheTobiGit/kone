<script setup lang="ts">
import { computed } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { AiBrain01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import ProviderLogo from "~/components/provider/ProviderLogo.vue";
import { useAgentProviders } from "~/composables/useAgentProviders";
import { buildModelCatalog } from "~/utils/modelCatalog";
import { brainStack } from "~/utils/subagentRuns";
import {
  turnSettingChangeLabel,
  turnSettingLeg,
  type TurnSettingChange,
} from "~/utils/turnSettingMarkers";

// One switch in what the thread runs with, as a quiet centered line: what the
// previous request ran with, an arrow, and what the new one runs with — each
// model named with its own logomark and each tier badged with its own brain
// cluster in its own hue, so the marker and the composer never disagree about
// what changed. The two legs with an arrow between them already say "this
// became that", so no verb is spelled out on screen; the accessible name still
// carries one, because a screen reader gets no arrow.
//
// A turn that changes both shows both inside the same two legs rather than
// stacking a second row: the user made one decision at the picker, and two
// lines above one request would read as two.
//
// Centered like the date/compaction dividers, but purely presentational —
// this owns its root because `thread-date` is pointer-events: none and these
// legs carry colour worth selecting against.

const props = defineProps<{
  mark: TurnSettingChange;
}>();

// Every provider's models as one catalog, so a stamped id resolves to the same
// name the composer shows it under ("Gemini 3.7 Flash", not a prettified
// "Gemini 3.7 flash"). Flattened rather than picked by provider because the
// stamp is an id and nothing else — the block does not record which engine ran
// it, and ids are distinct enough across catalogs for the lookup to be safe.
//
// A miss is expected and fine: history names models this build may no longer
// offer, and the resolver falls back to prettifying the id, so an old marker
// renders a reasonable name instead of going blank.
const { modelCache } = useAgentProviders();
const catalog = computed(() =>
  buildModelCatalog(Object.values(modelCache.value).flat()),
);

// The same resolver the accessible name is built from, over the same catalog:
// what is read aloud is what is on screen.
const label = computed(() => turnSettingChangeLabel(props.mark, catalog.value));
const legs = computed(() =>
  (["from", "to"] as const).map((side) => ({
    side,
    ...turnSettingLeg(props.mark, side, catalog.value),
  })),
);
</script>

<template>
  <div class="thread-mark setting-mark" :aria-label="label">
    <template v-for="(leg, i) in legs" :key="leg.side">
      <span v-if="i > 0" class="setting-arrow" aria-hidden="true"><HugeiconsIcon
        :icon="ArrowRight01Icon"
        :size="13"
        :stroke-width="2"
      /></span>
      <span class="setting-leg">
        <template v-if="leg.model">
          <ProviderLogo :brand="leg.model.brand" :size="13" />
          <span>{{ leg.model.name }}</span>
        </template>
        <template v-if="leg.effort">
          <span class="setting-brains" aria-hidden="true">
            <HugeiconsIcon
              v-for="n in brainStack(leg.effort.brains)"
              :key="`${leg.side}-${n}`"
              :icon="AiBrain01Icon"
              :size="13"
              :stroke-width="2"
              class="setting-brain"
              :style="{ color: leg.effort.hue }"
            />
          </span>
          <span>{{ leg.effort.label }}</span>
        </template>
      </span>
    </template>
  </div>
</template>

<style scoped>
.setting-mark {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 6px;
  width: 100%;
  font-size: 12px;
  line-height: 16px;
  color: var(--muted);
  user-select: none;
}
.setting-leg {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-weight: 550;
  line-height: 16px;
  color: var(--ink-soft);
  white-space: nowrap;
}
.setting-brains {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  line-height: 0;
}
.setting-brain {
  flex: none;
}
.setting-arrow {
  display: inline-flex;
  align-items: center;
  color: var(--muted);
  flex: none;
  line-height: 0;
}
</style>
