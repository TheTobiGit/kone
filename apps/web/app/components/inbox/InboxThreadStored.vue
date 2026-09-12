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

import { computed, nextTick, onMounted, ref, watch } from "vue";
import ConversationThread from "~/components/conversation/ConversationThread.vue";
import ThreadSubagentDock from "~/components/thread/ThreadSubagentDock.vue";
import InboxThreadHeader from "~/components/inbox/InboxThreadHeader.vue";
import { useEdgeFade } from "~/composables/useEdgeFade";
import { useStudioIntake } from "~/composables/useStudioIntake";
import { markHistorical } from "~/composables/agentPrefetch";
import { peelIpcError } from "~/utils/ipcError";
import { deriveActivePlan } from "~/utils/planTasks";
import { deriveChangedFiles } from "~/utils/changedFiles";
import { deriveDelegates } from "~/utils/subagentRuns";
import type { ThreadBlock } from "~/composables/agentTypes";
import type { CompactionRecord } from "~/types/desktop";
import type { SessionSummary } from "~/types/session";

const props = defineProps<{ row: SessionSummary }>();

const { cue } = useSound();
const intake = useStudioIntake();
// The live list's shared pipeline — the same instance the inbox rows read —
// so a header archive drops optimistically with the same refusal-restore as a
// row archive, instead of a second bridge path with its own semantics.
const sessions = useAllRecentSessions();

const history = () => (import.meta.client ? window.koneDesktop?.agent?.history : undefined);

// Archiving from the header walks the same path as the list row's own
// archive — optimistic drop with refusal-restore — and the reading pane clears
// off the store fan-out the portal already trusts. No project root is named on
// this pane, so the column is found rather than known.
async function onArchive(): Promise<void> {
  const threadId = props.row.threadId;
  if (!threadId) return;
  cue("press");
  const ok = await sessions.archive(threadId, true).catch(() => false);
  if (!ok) return;
  void intake.dismissThreadAnywhere(threadId);
}

const blocks = ref<ThreadBlock[]>([]);
const compactions = ref<CompactionRecord[]>([]);
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

// The corner docks read the same derives as the live surfaces — tasks,
// touched files, and delegated runs — straight off the stored blocks. Nothing
// here streams, so the derives are read directly rather than through a
// debounced snapshot. No project root is named on this pane, so the changes
// rows stay inert (there is nothing to read a diff from); the list itself
// still reads.
const storedPlan = computed(() => deriveActivePlan(blocks.value));
const storedChanges = computed(() => deriveChangedFiles(blocks.value));
const storedDelegates = computed(() => deriveDelegates(blocks.value, []));

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
    // Markers ride a separate read — few rows ever, so no paging — and a miss
    // only drops annotation, never the transcript.
    try {
      compactions.value = (await api.compactions?.(props.row.threadId)) ?? [];
    } catch {
      compactions.value = [];
    }
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

// No visible scrollbar — the thread content smokes its top/bottom edges over whatever
// content runs past the cutoff, easing in over the first ~28px of scroll.
const scroller = ref<HTMLElement>();
const { measure, maskStyle } = useEdgeFade(scroller);

watch(blocks, () => void nextTick(measure));

// Same bottom-pin as the live portal: opening a stored thread should reveal the
// newest message, with the transcript arriving async on mount.
function scrollStoredToBottom(): void {
  const el = scroller.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

const storedInitialDoneFor = ref<string | null>(null);
function tryStoredInitialScroll(): void {
  if (!import.meta.client) return;
  const key = props.row.threadId ?? "";
  if (!key || storedInitialDoneFor.value === key) return;
  if (blocks.value.length === 0) return;
  storedInitialDoneFor.value = key;
  void nextTick(() => {
    void nextTick(() => {
      if (!import.meta.client) return;
      requestAnimationFrame(() => scrollStoredToBottom());
    });
  });
}

watch(() => props.row.threadId, () => void nextTick(() => tryStoredInitialScroll()));
watch(blocks, () => tryStoredInitialScroll());
onMounted(() => void nextTick(() => tryStoredInitialScroll()));
</script>

<template>
  <div class="rd">
    <InboxThreadHeader
      :title="row.title"
      :seed="row.threadId"
      :provider="row.provider"
      :brand="row.brand"
      :side-chat="row.sideChat"
      :worktree-path="row.worktreePath"
      :workspace-pending="row.workspacePending"
      archivable
      @archive="onArchive"
    />

    <div
      ref="scroller"
      class="rd__body"
      :style="maskStyle"
      @scroll.passive="measure"
    >
      <ConversationThread
        :blocks="blocks"
        :compactions="compactions"
        :now="now"
        :thread-id="row.threadId"
        :agent-seed="row.threadId"
        mode="reply"
        :loading="loading"
        :load-failed="loadFailed"
        :has-older="cursor !== null"
        :loading-older="loadingOlder"
        :older-error="olderError"
        hide-empty-art
        @load-older="loadOlder"
      />
    </div>

    <!-- The subagent corner — delegated runs bottom-left. -->
    <ThreadSubagentDock
      :rows="storedDelegates.rows"
    />

    <!-- Corner dock stack — Changes above Tasks, bottom-right. -->
    <ThreadDockStack
      :changes="storedChanges"
      :plan="storedPlan"
      :thread-key="row.threadId"
      position-mode="absolute-pane"
    />
  </div>
</template>

<style scoped>
.rd {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* The scroll host — matches the live pane's scroll layout. */
.rd__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 20px 18px 24px;
  scrollbar-width: none;
}
.rd__body::-webkit-scrollbar {
  width: 0;
  height: 0;
}
</style>
