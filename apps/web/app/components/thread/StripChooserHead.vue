<script setup lang="ts">
import { computed, ref } from "vue";

// The bare-board chooser's identity header: the project's own folder tile,
// centred over the pick list, with where it lives captioned underneath so two
// same-named projects still read apart.
//
// Owns everything the header needs — the live git summary subscription, the
// hover state for the tile, and the shortened parent-dir line — so the strip
// just names the project and the chooser composable stays about the pick
// itself. Mounted only while the chooser shows (the strip's `v-if`), so the
// folder's git watch runs exactly while the header is visible and a board
// with panes pays nothing for it.

const props = defineProps<{
  /** The project's absolute path — the dir line and the summary watch key. */
  projectPath?: string;
  /** The project's folder name — the tile's title. Absent hides the header. */
  repo?: string;
  /** The checked-out branch, if known — the tile's instant value until the
   *  live summary's first read lands. */
  branch?: string;
}>();

const hovered = ref(false);

// The folder the project lives in, for the quiet line under the tile — the
// home prefix folded to "~" so the part that tells projects apart isn't
// buried behind "/Users/<name>". Null for a root-level project.
const chooserDir = computed(() => {
  const full = props.projectPath;
  if (!full) return null;
  const cut = full.lastIndexOf("/");
  if (cut <= 0) return null;
  return full.slice(0, cut).replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
});

// The same live summary (branch, ±, the peeking changed files) the projects
// list draws, so the bare board shows the project exactly as you picked it.
// Null before the first status read — the static props below are the instant
// value, the summary the live one, so the tile never flashes empty.
const { summaries, subscribe } = useProjectSummaries();
subscribe(() => (props.projectPath ? [props.projectPath] : []));
const chooserSummary = computed(() =>
  props.projectPath ? (summaries[props.projectPath] ?? null) : null,
);
</script>

<template>
  <div
    v-if="repo"
    class="chooser__head"
    :title="projectPath"
    @mouseenter="hovered = true"
    @mouseleave="hovered = false"
  >
    <ProjectFolder
      :name="repo"
      :repo="chooserSummary?.repo ?? Boolean(branch)"
      :branch="chooserSummary?.branch ?? branch ?? null"
      :added="chooserSummary?.added ?? 0"
      :removed="chooserSummary?.removed ?? 0"
      :files="chooserSummary?.files ?? []"
      :scale="0.9"
      :hovered="hovered"
    />
    <p v-if="chooserDir" class="chooser__path">
      <bdi dir="ltr">{{ chooserDir }}</bdi>
    </p>
  </div>
</template>

<style scoped>
/* The board's identity: the project's own folder tile, centred over the pick
   list, with where it lives captioned underneath so two same-named projects
   still read apart. */
.chooser__head {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.6rem;
  min-width: 0;
  margin-bottom: 1.25rem;
}
.chooser__path {
  overflow: hidden;
  max-width: 100%;
  margin: 0;
  color: var(--muted);
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: 450;
  letter-spacing: -0.005em;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* Truncate from the front: the segments nearest the project are the ones
     that say where it is. rtl moves the ellipsis to the left edge; the ltr
     <bdi> inside keeps the path itself in order, or the leading "~/" (neutral
     characters) would be flipped to the far end. */
  direction: rtl;
}
</style>
