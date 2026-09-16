<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { motion } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Cancel01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { useModalExit } from "~/composables/useModalExit";
import { useAllRecentSessions } from "~/composables/useAllRecentSessions";
import type { ConversationSearchHit } from "~/types/desktop";
import { timeAgo } from "~/utils/timeAgo";
import {
  SEARCH_RESULT_LIMIT,
  createSearchController,
  groupSearchHits,
  hitKindLabel,
  isSearchableQuery,
  plainSnippetText,
  sanitizeSearchSnippet,
  scrollBlockIdForHit,
} from "~/utils/conversationSearch";

// The conversation-search palette — the store's full-text index with a way in.
//
// The backend (FTS5 over user prompts + turn items, ranked with a snippet per
// hit) answers queries but has no caller; this is the caller. The shell is the
// same scrim + card the branch and folder pickers wear, stood top-centre the
// way a command palette stands: the query stays pinned on top and the matches
// read underneath it, grouped under the thread each came from.
//
// Selecting a row resolves the thread first. A hit whose thread has since been
// deleted reports that inline and drops the thread's group instead of
// navigating nowhere; anything else emits `jump` and the host opens the thread
// and reveals the matched row there.

export type SearchJumpRequest = {
  projectPath: string;
  projectName: string;
  threadId: string;
  blockId: string | null;
};

const emit = defineEmits<{
  jump: [request: SearchJumpRequest];
  close: [];
}>();

const { cue } = useSound();
const { shown, closing, close } = useModalExit();
function dismiss(): void {
  close(() => emit("close"));
}

// ── query + results ─────────────────────────────────────────────────────────
const query = ref("");
const hits = ref<ConversationSearchHit[]>([]);
const searching = ref(false);
const queryError = ref<string | null>(null);
const notice = ref<string | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);
const listEl = ref<HTMLElement | null>(null);

const bridgeSearch = (q: string, limit: number): Promise<ConversationSearchHit[]> => {
  const api = import.meta.client ? window.koneDesktop?.agent?.history : undefined;
  if (!api) return Promise.resolve([]);
  return api.search(q, { limit });
};

const controller = createSearchController({
  limit: SEARCH_RESULT_LIMIT,
  search: bridgeSearch,
  onResults: (_q, next) => {
    searching.value = false;
    queryError.value = null;
    hits.value = next;
    activeIndex.value = 0;
  },
  onError: () => {
    searching.value = false;
    queryError.value = "Search failed — try again";
  },
});

function onInput(): void {
  notice.value = null;
  const q = query.value;
  if (!isSearchableQuery(q)) {
    controller.cancel();
    searching.value = false;
    queryError.value = null;
    hits.value = [];
    activeIndex.value = 0;
    return;
  }
  searching.value = true;
  controller.submit(q);
}

const groups = computed(() => groupSearchHits(hits.value));
const flatHits = computed(() => groups.value.flatMap((g) => g.hits));
const hasQuery = computed(() => isSearchableQuery(query.value));

// ── thread labels ───────────────────────────────────────────────────────────
// Titles and project names come from the cross-project recent list — the same
// rows the launcher reads, so a result is named exactly as it is everywhere
// else. A thread the list doesn't know (archived, or pruned from recents)
// falls back to a bare id rather than a guessed title.
const sessions = useAllRecentSessions();
const metaByThread = computed(() => {
  const map = new Map<string, { title: string; projectName: string | null }>();
  for (const row of [...sessions.pinned.value, ...sessions.recent.value]) {
    if (!map.has(row.threadId)) {
      map.set(row.threadId, { title: row.title, projectName: row.projectName ?? null });
    }
  }
  return map;
});

function threadTitle(threadId: string): string {
  return metaByThread.value.get(threadId)?.title || "Untitled thread";
}

function projectNameOf(threadId: string, fallbackPath: string | null): string | null {
  const known = metaByThread.value.get(threadId)?.projectName;
  if (known) return known;
  if (!fallbackPath) return null;
  const base = fallbackPath.split("/").filter(Boolean).pop();
  return base || null;
}

// ── keyboard + mouse ────────────────────────────────────────────────────────
const activeIndex = ref(0);

function scrollActiveIntoView(): void {
  void nextTick(() => {
    // SAFETY: querySelector reads the row this render just painted; the index
    // is clamped to the flat list, so the selector always names a live row.
    const el = listEl.value?.querySelector(`[data-hit-index="${activeIndex.value}"]`);
    el?.scrollIntoView({ block: "nearest" });
  });
}

function move(delta: number): void {
  const total = flatHits.value.length;
  if (total === 0) return;
  activeIndex.value = (activeIndex.value + delta + total) % total;
  scrollActiveIntoView();
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.preventDefault();
    // The palette owns this press — see the capture registration on mount.
    e.stopPropagation();
    dismiss();
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    move(1);
    return;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    move(-1);
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    const hit = flatHits.value[activeIndex.value];
    if (hit) void selectHit(hit);
  }
}

async function selectHit(hit: ConversationSearchHit): Promise<void> {
  const api = import.meta.client ? window.koneDesktop?.agent?.history : undefined;
  const stored = await api?.thread(hit.threadId).catch(() => null);
  if (!stored) {
    // The thread went away between the index read and the pick — say so where
    // the row was, and drop its group so the list stops offering it.
    notice.value = "That conversation was deleted.";
    hits.value = hits.value.filter((h) => h.threadId !== hit.threadId);
    activeIndex.value = 0;
    cue("collapse");
    return;
  }
  const projectPath = stored.projectPath;
  const projectName =
    metaByThread.value.get(hit.threadId)?.projectName ??
    projectPath.split("/").filter(Boolean).pop() ??
    projectPath;
  const blockId = scrollBlockIdForHit(hit);
  cue("open");
  dismiss();
  emit("jump", { projectPath, projectName, threadId: hit.threadId, blockId });
}

function hoverIndex(index: number): void {
  activeIndex.value = index;
}

// ── lifecycle ───────────────────────────────────────────────────────────────
let opener: HTMLElement | null = null;

onMounted(() => {
  // SAFETY: activeElement is the element focused just before open; null is allowed by the type.
  opener = document.activeElement as HTMLElement | null;
  // Capture, so Escape is consumed here before any surface underneath (the
  // inbox, the studio, the drawer) can dismiss itself behind the palette —
  // one press closes exactly this.
  window.addEventListener("keydown", onKeydown, { capture: true });
  requestAnimationFrame(() => {
    shown.value = true;
  });
  void nextTick(() => inputEl.value?.focus());
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown, { capture: true });
  controller.dispose();
  opener?.focus();
});

const cardSpring = {
  type: "spring",
  stiffness: 380,
  damping: 32,
  mass: 0.9,
} as const;
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-start justify-center overflow-hidden px-4 pt-[12vh]">
    <motion.div
      class="modal-scrim absolute inset-0"
      :initial="{ opacity: 0, backdropFilter: 'blur(0px)' }"
      :animate="{
        opacity: shown ? 1 : 0,
        backdropFilter: shown ? 'blur(4px)' : 'blur(0px)',
      }"
      :transition="{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }"
      @click="dismiss"
    />

    <motion.div
      class="modal-card relative z-20 flex w-full max-w-lg flex-col overflow-hidden"
      :initial="{ opacity: 0, y: -10, scale: 0.98 }"
      :animate="{
        opacity: shown && !closing ? 1 : 0,
        y: shown && !closing ? 0 : -10,
        scale: shown && !closing ? 1 : 0.98,
      }"
      :transition="cardSpring"
      role="dialog"
      aria-modal="true"
      aria-label="Search conversations"
    >
      <!-- Query row: the icon, the field, and the way out. -->
      <div class="search-query">
        <HugeiconsIcon :icon="Search01Icon" :size="16" :stroke-width="2" aria-hidden="true" />
        <input
          ref="inputEl"
          v-model="query"
          type="text"
          class="search-input"
          placeholder="Search across all conversations…"
          aria-label="Search conversations"
          autocomplete="off"
          spellcheck="false"
          @input="onInput"
        />
        <button type="button" class="picker-action text-muted" aria-label="Close search" @click="dismiss">
          <HugeiconsIcon :icon="Cancel01Icon" :size="14" :stroke-width="2" aria-hidden="true" />
        </button>
      </div>

      <!-- Results: grouped under their thread, in rank order. -->
      <div ref="listEl" class="search-list" role="listbox" aria-label="Matching messages">
        <p v-if="!hasQuery" class="search-note">Type to search every conversation — prompts and replies.</p>
        <p v-else-if="searching && flatHits.length === 0" class="search-note">Searching…</p>
        <p v-else-if="queryError" class="search-note search-note--err">{{ queryError }}</p>
        <p v-else-if="flatHits.length === 0" class="search-note">
          No matches for “{{ query.trim() }}”.
        </p>

        <template v-else>
          <template v-for="group in groups" :key="group.threadId">
            <div class="search-group">
              <span class="search-thread">{{ threadTitle(group.threadId) }}</span>
              <span
                v-if="projectNameOf(group.threadId, null)"
                class="search-chip"
                >{{ projectNameOf(group.threadId, null) }}</span
              >
            </div>
            <button
              v-for="hit in group.hits"
              :key="`${hit.threadId}:${hit.entryKind}:${hit.itemId ?? hit.blockId}`"
              type="button"
              role="option"
              :aria-selected="flatHits[activeIndex] === hit"
              :data-hit-index="flatHits.indexOf(hit)"
              class="search-row"
              :class="{ 'is-active': flatHits[activeIndex] === hit }"
              :title="plainSnippetText(hit.snippet)"
              @click="selectHit(hit)"
              @mouseenter="hoverIndex(flatHits.indexOf(hit))"
            >
              <span class="search-kind">{{ hitKindLabel(hit) }}</span>
              <!-- SAFETY: the snippet is escaped with only <mark> restored (see
                   sanitizeSearchSnippet) — no other markup can survive it. -->
              <span class="search-snippet" v-html="sanitizeSearchSnippet(hit.snippet)" />
              <span class="search-when">{{ timeAgo(hit.at) }}</span>
            </button>
          </template>
        </template>

        <p v-if="notice" class="search-note search-note--err" role="status">{{ notice }}</p>
      </div>

      <div class="search-foot">
        <span>↑↓ navigate</span>
        <span>↵ open</span>
        <span>esc close</span>
      </div>
    </motion.div>
  </div>
</template>

<style scoped>
.modal-scrim {
  background: color-mix(in srgb, var(--ground) 62%, transparent);
}
.modal-card {
  background: var(--panel);
  border-radius: 16px;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent);
  max-height: min(64vh, 560px);
}

/* Query row — the field is the surface: no inner box, just the icon, the text
   and the dismiss, on the card's own ground. */
.search-query {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 14px 12px;
  color: var(--muted);
  border-bottom: 1px solid var(--line-soft);
}
.search-input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--ink);
  font-size: 15px;
  letter-spacing: -0.01em;
  outline: none;
}
.search-input::placeholder {
  color: var(--faint);
}
.picker-action {
  display: inline-flex;
  align-items: center;
  padding: 4px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.picker-action:hover {
  background: var(--hover);
  color: var(--ink);
}

/* Results — a quiet list under the query, grouped by thread. */
.search-list {
  overflow-y: auto;
  padding: 8px;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--ink) 16%, transparent) transparent;
}
.search-list::-webkit-scrollbar {
  width: 10px;
}
.search-list::-webkit-scrollbar-track {
  background: transparent;
}
.search-list::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--ink) 16%, transparent);
  border-radius: 999px;
  border: 3px solid transparent;
  background-clip: content-box;
}
.search-group {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 10px 10px 4px;
}
.search-group:first-child {
  padding-top: 4px;
}
.search-thread {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink-soft);
}
.search-chip {
  flex: none;
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 14px;
  color: var(--faint);
  background: var(--line-soft);
  padding: 1px 5px;
  border-radius: 4px;
  white-space: nowrap;
}
.search-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.12s ease;
}
.search-row:hover,
.search-row.is-active {
  background-color: var(--hover);
}
.search-row:focus-visible {
  outline: none;
  background-color: var(--hover);
}
.search-kind {
  flex: none;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.02em;
  color: var(--faint);
  width: 52px;
}
.search-snippet {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13.5px;
  line-height: 1.45;
  color: var(--ink);
}
.search-snippet :deep(mark) {
  background: transparent;
  color: inherit;
  font-weight: 700;
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--accent) 65%, transparent);
  text-decoration-thickness: 2px;
  text-underline-offset: 2px;
}
.search-when {
  flex: none;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--faint);
  font-variant-numeric: tabular-nums;
}
.search-note {
  padding: 14px 10px;
  font-size: 13.5px;
  line-height: 1.45;
  color: var(--muted);
}
.search-note--err {
  color: var(--diff-del-soft);
}

/* Footer hints — the quietest line on the card, mono, out of the way. */
.search-foot {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 8px 14px 10px;
  border-top: 1px solid var(--line-soft);
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--faint);
}
</style>
