<script setup lang="ts">
// The band at the head of an ecosystem page: what the page is about, a line on
// why it matters, a few counts, and a small drawing of the relationship the
// page manages. The drawing is decorative — the copy and the counts carry the
// same facts in words — so it's hidden from assistive tech and dropped where
// the band is too narrow to give it room beside the copy.

defineProps<{
  title: string;
  lede: string;
  /** Counts under the lede. An entry left out is a count that doesn't apply yet,
   *  not a zero worth showing. */
  stats: readonly { label: string; value: number | string }[];
}>();
</script>

<template>
  <header class="sb">
    <div class="sb__copy">
      <h2 class="sb__title">{{ title }}</h2>
      <p class="sb__lede">{{ lede }}</p>
      <dl v-if="stats.length" class="sb__stats">
        <div v-for="s in stats" :key="s.label" class="sb__stat">
          <dt>{{ s.label }}</dt>
          <dd>{{ s.value }}</dd>
        </div>
      </dl>
    </div>

    <div v-if="$slots.art" class="sb__art" aria-hidden="true">
      <slot name="art" />
    </div>
  </header>
</template>

<style scoped>
/* The band measures itself, so whether the drawing fits depends on the room
   the band has, not on the window. */
.sb {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 28px;
  padding: 22px 24px;
  border-radius: 22px;
  overflow: hidden;
  isolation: isolate;
  container-type: inline-size;
  background:
    radial-gradient(120% 140% at 100% 0%, color-mix(in oklab, var(--accent) 9%, transparent), transparent 55%),
    color-mix(in srgb, var(--ink) 3%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 5%, transparent);
}
/* A faint dot field in the corner the light comes from — texture enough that
   the band reads as a surface, not a tinted rectangle. */
.sb::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  background-image: radial-gradient(color-mix(in srgb, var(--ink) 16%, transparent) 0.8px, transparent 1px);
  background-size: 12px 12px;
  mask-image: radial-gradient(70% 90% at 100% 20%, #000, transparent 70%);
  opacity: 0.55;
}

.sb__copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.sb__title {
  margin: 0;
  font-size: 26px;
  font-weight: 500;
  letter-spacing: -0.025em;
  line-height: 1.1;
  color: var(--ink);
}
.sb__lede {
  margin: 8px 0 0;
  max-width: 40ch;
  font-size: 13px;
  line-height: 1.5;
  color: var(--ink-soft);
  text-wrap: pretty;
}

.sb__stats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 22px;
  margin: 18px 0 0;
}
.sb__stat {
  display: flex;
  flex-direction: column-reverse;
  gap: 3px;
}
.sb__stat dt {
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  line-height: 1;
  color: var(--muted);
}
.sb__stat dd {
  margin: 0;
  font-size: 20px;
  font-weight: 500;
  letter-spacing: -0.02em;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--ink);
}

.sb__art {
  display: none;
  flex-shrink: 0;
}
@container (min-width: 528px) {
  .sb__art {
    display: flex;
  }
}
</style>
