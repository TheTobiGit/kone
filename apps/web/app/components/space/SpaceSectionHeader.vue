<script setup lang="ts">
defineProps<{
  title: string;
  description?: string;
}>();
</script>

<template>
  <header class="sec-head">
    <div class="sec-head__title-row">
      <h2 class="sec-head__title">
        <span>{{ title }}</span>
        <span class="sec-head__arrow" aria-hidden="true">›</span>
      </h2>
      <slot name="aside" />
    </div>
    <p v-if="description" class="sec-head__desc">
      {{ description }}
    </p>
  </header>
</template>

<style scoped>
.sec-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0 4px 6px;
}
.sec-head__title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.sec-head__title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.2px;
  color: var(--ink);
}
.sec-head__arrow {
  font-size: 16px;
  font-weight: 400;
  color: var(--muted);
  transform: translateY(-0.5px);
  user-select: none;
}
.sec-head__desc {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--muted);
  max-width: 52ch;
}
</style>
