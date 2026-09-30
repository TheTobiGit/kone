<script setup lang="ts">
// Something kone told this thread's agent — its delegator was stopped, a task
// was withdrawn, the user spoke to one of its delegates directly. Not a
// message anybody wrote, so it is not a bubble on either side: a quiet line
// across the thread, the same register as the hand-in and turn-setting marks.

defineProps<{
  text: string;
}>();
</script>

<template>
  <div class="notice-mark" role="note">
    <span class="notice-mark__rule" aria-hidden="true" />
    <p class="notice-mark__text"><span class="notice-mark__from">kone</span>{{ text }}</p>
    <span class="notice-mark__rule" aria-hidden="true" />
  </div>
</template>

<style scoped>
.notice-mark {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  margin: 2px 0;
}
.notice-mark__rule {
  flex: 1 1 24px;
  height: 1px;
  background: color-mix(in oklab, var(--ink) 12%, transparent);
}
.notice-mark__text {
  flex: 0 1 auto;
  max-width: 78%;
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  text-align: center;
  white-space: pre-line;
  color: color-mix(in oklab, var(--ink) 55%, transparent);
}
.notice-mark__from {
  margin-right: 6px;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.02em;
  color: color-mix(in oklab, var(--ink) 40%, transparent);
}
</style>
