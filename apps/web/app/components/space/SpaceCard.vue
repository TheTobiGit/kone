<script setup lang="ts">
// The chrome every card on the Space board shares: the rounded wash, the 13px
// title and the row beside it. A card supplies its title, a slot for whatever
// sits at the right of that row (and an `icon` slot for a mark ahead of the
// title), and its body — so the board keeps one rhythm and a card only styles
// what is its own.

defineProps<{
  title: string;
  /** Read out for the section when it differs from the visible title. */
  label?: string;
  /** A tally set quietly beside the title. Zero hides it: a card with nothing
   *  in it has nothing to count. */
  count?: number;
}>();
</script>

<template>
  <section class="card" :aria-label="label ?? title">
    <header class="card__head">
      <h2 class="card__title">
        <span v-if="$slots.icon" class="card__icon"><slot name="icon" /></span>
        {{ title }}
        <span v-if="count" class="card__count">{{ count }}</span>
      </h2>
      <slot name="aside" />
    </header>
    <slot />
  </section>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  padding: 16px 18px 14px;
  border-radius: 16px;
  background-color: color-mix(in srgb, var(--ink) 3.5%, transparent);
}
.card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
}
.card__title {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
}
.card__icon {
  display: inline-flex;
  align-self: center;
  color: var(--ink-soft);
}
.card__count {
  font-size: 11px;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
</style>
