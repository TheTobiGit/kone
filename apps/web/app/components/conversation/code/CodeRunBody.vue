<script setup lang="ts">
import { computed } from "vue";
import TrailBranch from "~/components/conversation/trail/TrailBranch.vue";
import { errorLines, outputTail, parseTestTally } from "~/utils/codeToolResult";

// A shell command, shown as how it came out, grown off the rail under its step.
// A test run becomes its tally (a bar split between what passed and what
// failed, and the counts); a command that failed shows the lines that say why;
// anything else shows the last thing it printed. While it runs, whatever it has
// printed so far (where the provider streams it) ticks over in the same place.
// The step only mounts this when one of those has something to show.

const props = defineProps<{
  output: string;
  state: "running" | "done" | "error";
  /** Draw the branch in: the run landed while the reader watched. */
  enter: boolean;
}>();

const tally = computed(() => (props.state === "running" ? null : parseTestTally(props.output)));
const lines = computed(() => {
  if (tally.value) return [];
  return props.state === "error" ? errorLines(props.output) : outputTail(props.output);
});
const total = computed(() => (tally.value ? tally.value.passed + tally.value.failed + tally.value.skipped : 0));

const share = (n: number): string => `${total.value ? (n / total.value) * 100 : 0}%`;
</script>

<template>
  <div class="crun" :class="`crun--${state}`">
    <TrailBranch last :enter="enter">
      <div v-if="tally" class="crun__tally">
        <span class="crun__bar" aria-hidden="true">
          <span class="crun__seg crun__seg--pass" :style="{ width: share(tally.passed) }" />
          <span class="crun__seg crun__seg--fail" :style="{ width: share(tally.failed) }" />
        </span>
        <span class="crun__count crun__count--pass">{{ tally.passed }} passed</span>
        <span v-if="tally.failed" class="crun__count crun__count--fail">{{ tally.failed }} failed</span>
        <span v-if="tally.skipped" class="crun__count">{{ tally.skipped }} skipped</span>
        <span v-if="tally.time" class="crun__count">{{ tally.time }}</span>
      </div>
      <div v-else class="crun__out">
        <p v-for="(l, i) in lines" :key="`${i}${l}`" class="crun__line">{{ l }}</p>
      </div>
    </TrailBranch>
  </div>
</template>

<style scoped>
.crun {
  padding-bottom: 4px;
}
.crun__tally {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 26px;
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.crun__bar {
  display: flex;
  flex: none;
  width: 72px;
  height: 6px;
  overflow: hidden;
  border-radius: 3px;
  background: color-mix(in srgb, var(--ink) 8%, transparent);
}
.crun__seg {
  height: 100%;
}
.crun__seg--pass {
  background: var(--diff-add);
}
.crun__seg--fail {
  background: var(--diff-del);
}
.crun__count {
  color: var(--muted);
}
.crun__count--pass {
  color: var(--ink-soft);
}
.crun__count--fail {
  color: var(--diff-del);
}
/* The first printed line sits where the elbow turns in (13px down). */
.crun__out {
  padding-top: 3px;
  min-width: 0;
}
.crun__line {
  margin: 0;
  height: 20px;
  line-height: 20px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: pre;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--ink-soft);
}
.crun--error .crun__line {
  /* Pulled toward ink: the bare diff red is under 4.5:1 as small text. */
  color: color-mix(in srgb, var(--diff-del) 80%, var(--ink));
}
</style>
