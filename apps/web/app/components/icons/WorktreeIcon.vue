<script setup lang="ts">
// The mark for a thread that works in a worktree of its own: one line that
// splits into two, both carrying on. Sized in pixels like the rest of the icon
// set; the colour is whatever encloses it.
withDefaults(defineProps<{ size?: number }>(), { size: 12 });
</script>

<template>
  <!-- Codicons by Microsoft Corporation, CC BY 4.0:
       https://github.com/microsoft/vscode-codicons/blob/main/LICENSE -->
  <svg
    xmlns="http://www.w3.org/2000/svg"
    :width="size"
    :height="size"
    viewBox="0 0 10 10"
    aria-hidden="true"
    class="worktree-icon"
  >
    <path
      fill="currentColor"
      d="M8.854 7.146a.5.5 0 0 0-.707.707l.146.146H5.75a.75.75 0 0 1-.75-.75v-3.5a.75.75 0 0 1 .75-.75h2.543l-.146.146a.5.5 0 0 0 .708.707l1-1a.5.5 0 0 0 0-.707l-1-1a.5.5 0 0 0-.707.707l.146.146H5.751c-.965 0-1.75.785-1.75 1.75v1.25H.5a.5.5 0 0 0 0 1H4v1.25c0 .965.785 1.75 1.75 1.75h2.543l-.146.146a.5.5 0 0 0 .708.707l1-1a.5.5 0 0 0 0-.707l-1-1z"
    />
  </svg>
</template>

<style scoped>
.worktree-icon {
  flex: none;
}
</style>
