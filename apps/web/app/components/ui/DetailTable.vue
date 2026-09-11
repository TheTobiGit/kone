<script setup lang="ts">
import { HugeiconsIcon } from "@hugeicons/vue";

import ProviderLogo from "~/components/provider/ProviderLogo.vue";
import type { DetailTableRow } from "~/utils/detailFormat";

// One card, hairline gaps between rows: the key stays left, the value settles
// right. One home for the card-table markup and its visuals, so a tweak lands
// on every detail page at once.
//
// Plain rows read off the row object — `text` with optional brand marks ahead
// and a muted `aside` behind, `tags` as a wrapping tag list, `emptyText` when
// there is nothing to say. `fluid` is the skill table's reading (the value
// takes the row and wraps underneath long paths); the agent tables stay
// inline. A `value-<id>` slot overrides a cell wholesale for the rare value
// richer than text (the agent's bot chip).
defineProps<{ rows: readonly DetailTableRow[]; fluid?: boolean }>();
</script>

<template>
  <dl class="det__table" :class="{ 'det__table--fluid': fluid }">
    <div v-for="row in rows" :key="row.id" class="det__row">
      <dt class="det__key">
        <HugeiconsIcon
          v-if="row.icon"
          :icon="row.icon"
          :size="14"
          :stroke-width="1.6"
          aria-hidden="true"
        />
        <span>{{ row.label }}</span>
      </dt>
      <dd
        class="det__val"
        :class="{ 'det__val--wrap': row.wrap, 'det__val--mono': row.mono }"
      >
        <slot :name="`value-${row.id}`">
          <template v-if="row.tags && row.tags.length > 0">
            <span v-for="tag in row.tags" :key="tag" class="det__tag">{{ tag }}</span>
            <span v-if="row.aside" class="det__aside">{{ row.aside }}</span>
          </template>
          <template v-else-if="row.text !== undefined">
            <ProviderLogo
              v-for="brand in row.brands ?? []"
              :key="brand"
              :brand="brand"
              :size="14"
            />
            <span>{{ row.text }}</span>
            <span v-if="row.aside" class="det__aside">{{ row.aside }}</span>
          </template>
          <span v-else class="det__none">{{ row.emptyText }}</span>
        </slot>
      </dd>
    </div>
  </dl>
</template>

<style scoped>
.det__table {
  --det-hair: color-mix(in srgb, var(--ink) 7%, transparent);
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 0;
  padding: 0;
  border-radius: 14px;
  background-color: var(--det-hair);
  overflow: hidden;
}

.det__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 14px;
  background-color: var(--panel);
}

.det__key {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--muted);
}

.det__val {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  font-size: 12.5px;
  color: var(--ink-soft);
  text-align: right;
}
.det__val--wrap {
  flex-wrap: wrap;
  justify-content: flex-end;
  row-gap: 6px;
}
.det__val--mono {
  font-family: var(--font-mono);
  font-size: 11px;
}
.det__none {
  color: var(--muted);
}
.det__aside {
  font-size: 11.5px;
  color: var(--muted);
}
/* A name the row carries rather than a control — soft ground, no outline. */
.det__tag {
  padding: 3px 9px;
  border-radius: 8px;
  background-color: color-mix(in srgb, var(--ink) 5%, transparent);
  font-size: 11.5px;
  line-height: 1.35;
  color: var(--ink-soft);
}

/* The skill table's reading: the value takes the row and wraps underneath
   long paths rather than pushing the key out. */
.det__table--fluid .det__key {
  flex: none;
}
.det__table--fluid .det__val {
  flex: 1 1 auto;
  flex-wrap: wrap;
  justify-content: flex-end;
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
