<script setup lang="ts">
import { computed } from "vue";
import TrailBranch from "~/components/conversation/trail/TrailBranch.vue";
import type { DiffSummary } from "~/utils/codeToolResult";

// An edit, shown as the lines it changed, grown off the rail under its step:
// the first few added and removed lines, tinted the way the diff view tints
// them, and how many more there are. The whole diff stays one click away on the
// step's own disclosure.

const props = defineProps<{
  diff: DiffSummary;
  /** Draw the branch in: the edit landed while the reader watched. */
  enter: boolean;
}>();

const more = computed(() => props.diff.added + props.diff.removed - props.diff.preview.length);
</script>

<template>
  <div class="cdiff">
    <TrailBranch last :enter="enter">
      <div class="cdiff__lines" role="group" aria-label="First changed lines">
        <div
          v-for="(l, i) in diff.preview"
          :key="i"
          class="cdiff__line"
          :class="l.sign === '+' ? 'cdiff__line--add' : 'cdiff__line--del'"
        >
          <span class="cdiff__sign" aria-hidden="true">{{ l.sign === "+" ? "+" : "−" }}</span>
          <span class="sr-only">{{ l.sign === "+" ? "Added: " : "Removed: " }}</span>
          <span class="cdiff__text">{{ l.text || " " }}</span>
        </div>
      </div>
      <p v-if="more > 0" class="cdiff__more">{{ more }} more changed {{ more === 1 ? "line" : "lines" }}</p>
    </TrailBranch>
  </div>
</template>

<style scoped>
.cdiff {
  padding-bottom: 4px;
}
/* The first line sits where the elbow turns in (13px down). */
.cdiff__lines {
  display: grid;
  gap: 1px;
  padding-top: 3px;
  min-width: 0;
}
.cdiff__line {
  display: flex;
  gap: 8px;
  height: 20px;
  align-items: center;
  min-width: 0;
  padding: 0 8px 0 6px;
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  white-space: pre;
}
.cdiff__line--add {
  background: color-mix(in oklab, var(--diff-add) 7%, transparent);
}
.cdiff__line--del {
  background: color-mix(in oklab, var(--diff-del) 7%, transparent);
}
.cdiff__sign {
  flex: none;
  width: 1ch;
  font-weight: 600;
}
.cdiff__line--add .cdiff__sign {
  color: var(--diff-add);
}
.cdiff__line--del .cdiff__sign {
  color: var(--diff-del);
}
.cdiff__text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--ink-soft);
}
.cdiff__more {
  margin: 4px 0 4px 6px;
  color: var(--muted);
  font-size: 12px;
}
</style>
