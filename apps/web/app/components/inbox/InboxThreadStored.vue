<script setup lang="ts">
// A thread read straight off disk, with no session behind it.
//
// The fallback for a row whose project is not one of the recent ones — the
// transcript is still there and still worth reading, so the pane degrades to
// reading rather than to an apology. There is no composer here because there
// is nowhere to send: a turn needs a project root to run in, and this row
// cannot name one.
//
// Turns are read a window at a time, newest first, and older ones are walked
// back through the page cursor — so selecting a long thread paints its tail
// immediately instead of waiting on a transcript that could run to thousands
// of blocks. The host keys this pane on the thread, so the read happens once,
// at setup, and a new thread is a new pane.

import { computed, onMounted, ref } from "vue";
import ConversationThread from "~/components/conversation/ConversationThread.vue";
import { markHistorical } from "~/composables/agentPrefetch";
import { peelIpcError } from "~/utils/ipcError";
import type { ThreadBlock } from "~/composables/agentTypes";
import type { SessionSummary } from "~/types/session";

const props = defineProps<{ row: SessionSummary }>();

const history = () => (import.meta.client ? window.koneDesktop?.agent?.history : undefined);

const blocks = ref<ThreadBlock[]>([]);
const cursor = ref<string | null>(null);
const loading = ref(true);
const loadFailed = ref(false);
const loadingOlder = ref(false);
const olderError = ref<string | null>(null);

// A settled transcript has nothing counting up in it, so this is stamped once
// per read rather than ticked. A turn still running when it was written keeps
// whatever elapsed reading it had at that moment, which is the honest figure —
// this pane is not watching it.
const now = ref(Date.now());

onMounted(async () => {
  const api = history();
  if (!api) {
    loading.value = false;
    return;
  }
  try {
    const page = await api.threadPage(props.row.threadId);
    if (!page) {
      loadFailed.value = true;
      return;
    }
    // SAFETY: stored blocks deserialize to ThreadBlocks — the two types differ
    // only by the `historical` hint markHistorical is adding here.
    blocks.value = markHistorical(page.blocks as ThreadBlock[]);
    cursor.value = page.nextCursor;
    now.value = Date.now();
  } catch {
    loadFailed.value = true;
  } finally {
    loading.value = false;
  }
});

async function loadOlder(): Promise<void> {
  const api = history();
  const at = cursor.value;
  if (!api || !at || loadingOlder.value) return;
  loadingOlder.value = true;
  olderError.value = null;
  try {
    const page = await api.threadPage(props.row.threadId, { cursor: at });
    if (!page || page.blocks.length === 0) {
      // Nothing older left — the walk is complete; clear the affordance.
      cursor.value = null;
      return;
    }
    // Pages are disjoint by construction, but a turn that grew between two
    // reads can straddle them; dropping ids already in hand is cheaper than
    // reasoning about when that can happen.
    const known = new Set(blocks.value.map((b) => b.id));
    // SAFETY: as above — page blocks are ThreadBlocks minus the render hint.
    const older = markHistorical((page.blocks as ThreadBlock[]).filter((b) => !known.has(b.id)));
    if (older.length > 0) blocks.value = [...older, ...blocks.value];
    cursor.value = page.nextCursor;
  } catch (e) {
    olderError.value = peelIpcError(e, "Could not load older turns");
  } finally {
    loadingOlder.value = false;
  }
}

const subtitle = computed(() =>
  [props.row.projectName, props.row.branch].filter(Boolean).join(" · "),
);
</script>

<template>
  <div class="rd">
    <header class="rd__head">
      <h2 class="rd__title">{{ row.title }}</h2>
      <p v-if="subtitle" class="rd__sub">{{ subtitle }}</p>
    </header>

    <div class="rd__body">
      <ConversationThread
        :blocks="blocks"
        :now="now"
        :thread-id="row.threadId"
        :agent-seed="row.threadId"
        :loading="loading"
        :load-failed="loadFailed"
        :has-older="cursor !== null"
        :loading-older="loadingOlder"
        :older-error="olderError"
        :empty-art="false"
        @load-older="loadOlder"
      />
    </div>
  </div>
</template>

<style scoped>
.rd {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.rd__head {
  flex: none;
  padding: 14px 18px 10px;
}
.rd__title {
  font-family: var(--font-sans);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rd__sub {
  margin-top: 2px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 14px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The scroll host. The transcript renders as a plain column and finds its
   scroller by walking up from itself, so this element has to be the one that
   overflows — not an ancestor, and not the transcript. */
.rd__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 18px 24px;
}
</style>
