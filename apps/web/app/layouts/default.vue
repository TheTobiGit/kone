<script setup lang="ts">
const isDesktop = computed(() => Boolean(import.meta.client && window.koneDesktop?.isDesktop));
</script>

<template>
    <div class="bg-[#fafafa] dark:bg-[#070708] transition-colors duration-700">
        <div
            v-if="isDesktop"
            class="desktop-drag-region fixed inset-x-0 top-0 z-50 h-7"
            aria-hidden="true"
        />
        <slot />
    </div>
</template>

<style scoped>
.desktop-drag-region {
    -webkit-app-region: drag;
}
</style>
