<script setup lang="ts">
// What a section looks like before its read comes back.
//
// The alternative is what this space used to do: show an empty panel, which is
// indistinguishable from a repository that genuinely has no pull requests. That
// is how you leave a page one beat before it fills. So every section draws its
// own shape in grey first, and the shape is specific enough that you can tell
// which section you're waiting on.
//
// It breathes rather than shimmers. A travelling sweep would be a second moving
// thing on a surface that already has the masthead's progress thread, and two
// of them running at different speeds is the busiest this space ever looks.

withDefaults(
  defineProps<{
    /** `list` for the sections that are rows of people and messages; `prose`
     *  for About, which is a heading, a paragraph and a page of README. */
    variant?: "list" | "prose";
    rows?: number;
    /** Rows that name a person lead with a face. Branches and stashes don't. */
    faces?: boolean;
  }>(),
  { variant: "list", rows: 7, faces: false },
);

// Fixed, uneven widths. Equal bars read as a table rather than as prose, and a
// width randomised per render makes the skeleton twitch whenever anything above
// it re-renders — so the unevenness is a constant, cycled by row.
const TITLE = [84, 62, 75, 55, 90, 68, 71, 59];
const META = [34, 47, 29, 41, 37, 50, 32, 44];

function title(i: number): string {
  return `${TITLE[i % TITLE.length]}%`;
}
function meta(i: number): string {
  return `${META[i % META.length]}%`;
}
</script>

<template>
  <div class="gsk" role="status" aria-label="Loading">
    <template v-if="variant === 'prose'">
      <div class="gsk__head">
        <span class="gsk__logo" />
        <span class="gsk__lines">
          <span class="gsk__bar gsk__bar--title" style="width: 42%" />
          <span class="gsk__bar" style="width: 76%" />
        </span>
      </div>
      <div class="gsk__para">
        <span v-for="i in 5" :key="i" class="gsk__bar" :style="{ width: title(i + 2) }" />
      </div>
      <div class="gsk__para">
        <span v-for="i in 3" :key="i" class="gsk__bar" :style="{ width: title(i) }" />
      </div>
    </template>

    <template v-else>
      <div v-for="i in rows" :key="i" class="gsk__row">
        <span v-if="faces" class="gsk__face" />
        <span class="gsk__lines">
          <span class="gsk__bar gsk__bar--row" :style="{ width: title(i - 1) }" />
          <span class="gsk__bar gsk__bar--meta" :style="{ width: meta(i - 1) }" />
        </span>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* Held back for a beat: a read that lands in 80ms should never have flashed a
   skeleton at all, and a placeholder that appears and vanishes inside a tenth
   of a second is worse than the blank it replaced. */
.gsk {
  display: flex;
  flex-direction: column;
  gap: 26px;
  padding-block: 2px;
  animation:
    gsk-appear var(--gs-t-small, 220ms) var(--gs-ease, ease) var(--gs-hold, 140ms)
      backwards,
    /* Starts where the fade finishes, so the two never overlap and the first
       breath is a full one. */
      gsk-breathe var(--gs-t-breathe, 1700ms) ease-in-out
      calc(var(--gs-hold, 140ms) + var(--gs-t-small, 220ms)) infinite;
}
@keyframes gsk-appear {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
/* One animation on the container, not one per bar: everything breathes in
   unison, which is calmer than a wave, and it's a single compositor job. */
@keyframes gsk-breathe {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.52;
  }
}

.gsk__row,
.gsk__head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.gsk__lines {
  display: flex;
  flex-direction: column;
  gap: 9px;
  flex: 1 1 auto;
  min-width: 0;
}
.gsk__para {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.gsk__bar {
  height: 9px;
  border-radius: 3px;
  background-color: color-mix(in srgb, var(--ink) 7%, transparent);
}
.gsk__bar--row {
  height: 10px;
}
.gsk__bar--title {
  height: 17px;
  border-radius: 4px;
}
.gsk__bar--meta {
  height: 7px;
  background-color: color-mix(in srgb, var(--ink) 5%, transparent);
}

/* The same circle the real rows draw, so the row doesn't reflow sideways when
   the face arrives. */
.gsk__face {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background-color: color-mix(in srgb, var(--ink) 7%, transparent);
}
.gsk__logo {
  flex-shrink: 0;
  width: 44px;
  height: 44px;
  border-radius: 8px;
  background-color: color-mix(in srgb, var(--ink) 7%, transparent);
}

@media (prefers-reduced-motion: reduce) {
  /* The fade and the breathing go; the hold-back stays. It isn't motion — it's
     the rule that a read fast enough to beat it never draws a placeholder at
     all, and that's worth more here than anywhere. */
  .gsk {
    animation: gsk-appear 1ms linear var(--gs-hold, 140ms) backwards;
    opacity: 0.75;
  }
}
</style>
