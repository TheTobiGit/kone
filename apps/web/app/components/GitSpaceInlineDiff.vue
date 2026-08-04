<script setup lang="ts">
import type { GitFileDiff } from "~/types/desktop";

// A diff, read in place.
//
// The full-page FileDetail is for studying a change; this is for confirming one
// — you clicked a file inside a commit and want to see what it did without
// leaving the history. So it's compact, unified, and tinted rather than boxed:
// the +/− colour lives in the gutter mark and a wash behind the line, with no
// frame drawn around any of it.

defineProps<{
  diff: GitFileDiff | null;
  loading: boolean;
}>();
</script>

<template>
  <div class="idf">
    <p v-if="loading" class="idf__note">Reading…</p>
    <p v-else-if="!diff" class="idf__note">No diff available.</p>
    <p v-else-if="diff.binary" class="idf__note">Binary file — nothing to show.</p>
    <p v-else-if="!diff.hunks.length" class="idf__note">No textual changes.</p>

    <template v-else>
      <div v-for="(h, hi) in diff.hunks" :key="hi" class="idf__hunk">
        <p class="idf__at">
          @@ −{{ h.oldStart }} +{{ h.newStart }} @@
        </p>
        <div
          v-for="(l, li) in h.lines"
          :key="li"
          class="idf__line"
          :class="`idf__line--${l.kind}`"
        >
          <span class="idf__no">{{ l.oldNo ?? "" }}</span>
          <span class="idf__no">{{ l.newNo ?? "" }}</span>
          <span class="idf__sign">{{ l.kind === "add" ? "+" : l.kind === "del" ? "−" : "" }}</span>
          <span class="idf__text">{{ l.text }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.idf {
  padding: 6px 0 10px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.65;
  /* One entrance for the whole diff — the individual lines never animate. */
  animation: idf-in var(--gs-t-enter) var(--gs-ease) backwards;
}
@keyframes idf-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.idf__note {
  padding-left: 8px;
  color: var(--muted);
  font-size: 10.5px;
}
.idf__hunk + .idf__hunk {
  margin-top: 10px;
}
.idf__at {
  padding-left: 8px;
  margin-bottom: 2px;
  font-size: 10px;
  color: var(--muted);
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
}
.idf__line {
  display: flex;
  align-items: baseline;
  gap: 0;
  border-radius: 3px;
  white-space: pre;
}
/* A wash, not a fill — a whole added file shouldn't turn into a green box. */
.idf__line--add {
  background-color: color-mix(in srgb, var(--diff-add) 8%, transparent);
}
.idf__line--del {
  background-color: color-mix(in srgb, var(--diff-del) 8%, transparent);
}
.idf__no {
  flex-shrink: 0;
  width: 34px;
  padding-right: 8px;
  text-align: right;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  opacity: 0.55;
  -webkit-user-select: none;
  user-select: none;
}
.idf__sign {
  flex-shrink: 0;
  width: 14px;
  text-align: center;
  -webkit-user-select: none;
  user-select: none;
}
.idf__line--add .idf__sign {
  color: var(--diff-add);
}
.idf__line--del .idf__sign {
  color: var(--diff-del);
}
.idf__text {
  min-width: 0;
  overflow-x: auto;
  color: var(--ink-soft);
  scrollbar-width: none;
}
.idf__text::-webkit-scrollbar {
  display: none;
}
.idf__line--add .idf__text,
.idf__line--del .idf__text {
  color: var(--ink);
}

@media (prefers-reduced-motion: reduce) {
  .idf {
    animation: none;
  }
}
</style>
