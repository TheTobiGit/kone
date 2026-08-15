<template>
  <header class="app-drag relative z-30 flex w-full items-center justify-between">
    <div class="app-no-drag">
      <slot name="leading" />
    </div>
    <div class="app-no-drag">
      <slot name="trailing" />
    </div>
  </header>
</template>
