<script setup lang="ts">
// Live date, SSR-safe (seeded once via useState so server & client agree).
const now = useState("kone:now", () => Date.now());

const stamp = computed(() => {
  const d = new Date(now.value);
  const weekday = d
    .toLocaleDateString("en-US", { weekday: "short" })
    .toUpperCase();
  const month = d.toLocaleDateString("en-US", { month: "short" }).toUpperCase();
  return `${weekday} · ${d.getDate()} ${month}`;
});
</script>

<template>
  <header class="flex w-full items-center justify-between">
    <div class="flex items-center gap-2.5">
      <span
        class="font-mono text-xs text-muted"
        style="letter-spacing: 0.16em"
      >
        {{ stamp }}
      </span>
    </div>
    <slot name="trailing" />
  </header>
</template>
