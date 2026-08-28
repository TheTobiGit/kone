<script setup lang="ts">
import { computed } from "vue";
import { diffLines } from "diff";

const props = defineProps<{
  file?: string;
  targetContent?: string;
  replacementContent?: string;
  rawDiff?: string;
  codeContent?: string;
}>();

type DiffLine = {
  kind: "add" | "del" | "context" | "hunk";
  text: string;
  oldNo?: number;
  newNo?: number;
};

const lines = computed<DiffLine[]>(() => {
  if (props.targetContent !== undefined && props.replacementContent !== undefined) {
    const changes = diffLines(props.targetContent, props.replacementContent);
    const out: DiffLine[] = [];
    let oldNo = 1;
    let newNo = 1;
    for (const c of changes) {
      const chunkLines = c.value.replace(/\n$/, "").split("\n");
      const kind = c.added ? "add" : c.removed ? "del" : "context";
      for (const text of chunkLines) {
        if (kind === "add") {
          out.push({ kind: "add", text, newNo: newNo++ });
        } else if (kind === "del") {
          out.push({ kind: "del", text, oldNo: oldNo++ });
        } else {
          out.push({ kind: "context", text, oldNo: oldNo++, newNo: newNo++ });
        }
      }
    }
    return out;
  }

  if (props.rawDiff) {
    const rawLines = props.rawDiff.split("\n");
    const out: DiffLine[] = [];
    let oldNo = 1;
    let newNo = 1;
    for (const line of rawLines) {
      if (
        line.startsWith("diff --git") ||
        line.startsWith("index ") ||
        line.startsWith("---") ||
        line.startsWith("+++")
      ) {
        continue;
      }
      if (line.startsWith("@@")) {
        out.push({ kind: "hunk", text: line });
      } else if (line.startsWith("+")) {
        out.push({ kind: "add", text: line.slice(1), newNo: newNo++ });
      } else if (line.startsWith("-")) {
        out.push({ kind: "del", text: line.slice(1), oldNo: oldNo++ });
      } else if (line.startsWith(" ")) {
        out.push({ kind: "context", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
      } else {
        out.push({ kind: "context", text: line, oldNo: oldNo++, newNo: newNo++ });
      }
    }
    return out;
  }

  if (props.codeContent) {
    const chunkLines = props.codeContent.replace(/\n$/, "").split("\n");
    return chunkLines.map((text, i) => ({
      kind: "add",
      text,
      newNo: i + 1,
    }));
  }

  return [];
});

const stats = computed(() => {
  let adds = 0;
  let dels = 0;
  for (const l of lines.value) {
    if (l.kind === "add") adds++;
    if (l.kind === "del") dels++;
  }
  return { adds, dels };
});

defineExpose({
  stats,
});
</script>

<template>
  <div class="tdiff">
    <div class="tdiff__lines">
      <div
        v-for="(l, i) in lines"
        :key="i"
        class="tdiff__line"
        :class="`tdiff__line--${l.kind}`"
      >
        <span class="tdiff__no tdiff__no--old">{{ l.oldNo ?? "" }}</span>
        <span class="tdiff__no tdiff__no--new">{{ l.newNo ?? "" }}</span>
        <span class="tdiff__sign">{{ l.kind === "add" ? "+" : l.kind === "del" ? "−" : "" }}</span>
        <span class="tdiff__text">{{ l.text }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tdiff {
  display: flex;
  flex-direction: column;
  border-radius: 8px;
  background: color-mix(in srgb, var(--ink) 2.5%, var(--ground));
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.6;
}
.tdiff__lines {
  display: flex;
  flex-direction: column;
  overflow-x: auto;
  padding: 4px 0;
}
.tdiff__line {
  display: flex;
  align-items: baseline;
  padding: 0 8px;
  min-height: 19px;
  white-space: pre;
}
.tdiff__line--hunk {
  padding: 4px 8px;
  font-size: 10px;
  color: var(--muted);
  background: color-mix(in srgb, var(--ink) 3%, transparent);
}
.tdiff__line--add {
  background-color: color-mix(in srgb, var(--diff-add, #10b981) 12%, transparent);
}
.tdiff__line--del {
  background-color: color-mix(in srgb, var(--diff-del, #ef4444) 12%, transparent);
}
.tdiff__no {
  flex-shrink: 0;
  width: 28px;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  opacity: 0.55;
  text-align: right;
  padding-right: 6px;
  user-select: none;
}
.tdiff__sign {
  flex-shrink: 0;
  width: 14px;
  text-align: center;
  font-weight: 600;
  user-select: none;
}
.tdiff__line--add .tdiff__sign {
  color: var(--diff-add, #10b981);
}
.tdiff__line--del .tdiff__sign {
  color: var(--diff-del, #ef4444);
}
.tdiff__text {
  flex: 1;
  color: var(--ink-soft);
  tab-size: 2;
}
.tdiff__line--add .tdiff__text {
  color: var(--ink);
}
.tdiff__line--del .tdiff__text {
  color: color-mix(in srgb, var(--ink) 65%, var(--diff-del, #ef4444));
}
</style>
