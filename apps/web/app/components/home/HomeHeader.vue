<template>
  <header class="home-header relative z-30 flex w-full items-center justify-between">
    <div>
      <slot name="leading" />
    </div>
    <div>
      <slot name="trailing" />
    </div>
  </header>
</template>

<style scoped>
/* Overlay chrome (Windows): clear the fixed caption cluster (`--caption-inset`)
   from the trailing controls, and make the empty header row a window drag
   surface — it is in-flow with nothing beneath, so dragging is safe. Inputs
   opt out so text selection never moves the window. */
[data-chrome="overlay"] .home-header {
  padding-right: var(--caption-inset);
  -webkit-app-region: drag;
}
[data-chrome="overlay"] .home-header button,
[data-chrome="overlay"] .home-header input,
[data-chrome="overlay"] .home-header label {
  -webkit-app-region: no-drag;
}
</style>
