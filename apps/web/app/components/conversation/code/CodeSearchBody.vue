<script setup lang="ts">
import { computed, ref } from "vue";
import FileIcon from "~/components/file/FileIcon.vue";
import TrailBranch from "~/components/conversation/trail/TrailBranch.vue";
import { matchCount, type SearchFile } from "~/utils/codeToolResult";

// A search through the code, grown off the rail like the web trail: each file
// it landed in is a branch with its own face and how many lines matched, and
// the first of them underneath with the query lit up, so you can see where the
// agent is about to look without opening the step.

const props = defineProps<{
  files: SearchFile[];
  /** What was searched for, to light up in the matched line. */
  query: string;
  /** Draw the branches in: the search landed while the reader watched. */
  enter: boolean;
}>();

const SHOWN = 3;
const { cue } = useSound();
const expanded = ref(false);

const visible = computed(() => (expanded.value ? props.files : props.files.slice(0, SHOWN)));
const hidden = computed(() => props.files.length - visible.value.length);
const hasTail = computed(() => hidden.value > 0 || expanded.value);

function split(path: string): { dir: string; name: string } {
  // Windows paths separate with backslashes.
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash === -1 ? { dir: "", name: path } : { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

/** The matched line in three pieces, so the query can be drawn lit. */
function lit(text: string): [string, string, string] {
  const q = props.query.trim();
  const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (at < 0) return [text, "", ""];
  return [text.slice(0, at), text.slice(at, at + q.length), text.slice(at + q.length)];
}

function toggleMore(): void {
  expanded.value = !expanded.value;
  cue(expanded.value ? "expand" : "collapse");
}
</script>

<template>
  <div class="csrch">
    <TrailBranch
      v-for="(f, i) in visible"
      :key="f.path"
      :last="!hasTail && i === visible.length - 1"
      :enter="enter"
      :delay="Math.min(i, 6) * 0.1"
    >
      <div class="csrch__file" :title="f.path">
        <FileIcon class="csrch__face" :path="f.path" :size="14" />
        <span class="csrch__name">{{ split(f.path).name }}</span>
        <span v-if="split(f.path).dir" class="csrch__dir">{{ split(f.path).dir }}</span>
        <span v-if="matchCount(f)" class="csrch__count">
          {{ matchCount(f) }} {{ matchCount(f) === 1 ? "match" : "matches" }}
        </span>
      </div>
      <p v-if="f.matches[0]" class="csrch__hit">
        <span v-if="f.matches[0].line !== null" class="csrch__ln">{{ f.matches[0].line }}</span>
        <span class="csrch__code"
          >{{ lit(f.matches[0].text)[0] }}<mark class="csrch__mark">{{ lit(f.matches[0].text)[1] }}</mark
          >{{ lit(f.matches[0].text)[2] }}</span
        >
      </p>
    </TrailBranch>
    <TrailBranch v-if="hasTail" last :enter="enter" :delay="Math.min(visible.length, 6) * 0.1">
      <button type="button" class="csrch__more" :aria-expanded="expanded ? 'true' : 'false'" @click="toggleMore">
        {{ expanded ? "Show fewer" : `Show ${hidden} more ${hidden === 1 ? "file" : "files"}` }}
      </button>
    </TrailBranch>
  </div>
</template>

<style scoped>
.csrch {
  padding-bottom: 4px;
}
.csrch__file {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  min-width: 0;
  font-size: 13px;
  letter-spacing: -0.005em;
  white-space: nowrap;
}
.csrch__face {
  flex: none;
}
/* The directory gives way first; a long basename then truncates too, so the
   count always stays in the row. */
.csrch__name {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--ink);
}
.csrch__dir {
  flex: 0 1000 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--muted);
  font-size: 12px;
}
.csrch__count {
  flex: none;
  padding-left: 4px;
  color: var(--muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.csrch__hit {
  display: flex;
  gap: 10px;
  margin: -3px 0 6px 20px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.6;
  white-space: nowrap;
  min-width: 0;
}
.csrch__ln {
  flex: none;
  min-width: 3ch;
  text-align: right;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.csrch__code {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--ink-soft);
}
.csrch__mark {
  padding: 0 1px;
  border-radius: 3px;
  background: color-mix(in oklab, var(--hue, var(--ink)) 22%, transparent);
  color: var(--ink);
}
.csrch__more {
  display: inline-flex;
  align-items: center;
  height: 26px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ink-soft);
  font-size: 12.5px;
  cursor: pointer;
  transition: color 0.15s ease-out;
}
.csrch__more:hover {
  color: var(--ink);
}
.csrch__more:focus-visible {
  outline-offset: 2px;
  border-radius: 6px;
}
</style>
