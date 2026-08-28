<script setup lang="ts">
// One view's rows: every thread you have, from every project, in one flat list.
//
// Flat is the point. The launcher's list groups by pin under its own header and
// reads as a place you go to resume something; this one is a queue, and a queue
// with sections in it stops being a queue. So a pin is expressed as position
// plus a mark on the row, not as a division of the list. Ordering is otherwise
// plain recency for now — once threads carry live agent state the sort key
// becomes "when the agent last spoke", which is a different question than "when
// did this thread last change".
//
// A row selects and nothing else: no archiving, no pinning, no menus. Selecting
// is the one gesture the list owns, because it is the only one that is about
// the list rather than about the thread.

import { computed } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Add01Icon, Folder01Icon, GitBranchIcon, PinIcon } from "@hugeicons/core-free-icons";
import AgentFace from "~/components/agent/AgentFace.vue";
import ProviderLogo from "~/components/provider/ProviderLogo.vue";
import { agentIdentity } from "~/utils/agentIdentity";
import { sessionBrand } from "~/utils/modelCatalog";
import { timeAgo } from "~/utils/timeAgo";
import { prefetchThread } from "~/composables/useAgent";

const { cue } = useSound();

const props = withDefaults(defineProps<{ archived?: boolean }>(), { archived: false });

/** Which thread the reading pane is showing. Owned by the portal, not by this
 *  list — the two views each have their own list, and a selection made in one
 *  stays on screen after switching to the other. */
const selected = defineModel<string | null>("selected", { default: null });

// Read once at setup rather than watched: the pane mounts one of these per view
// and keeps it alive, so an instance never changes which side of the archive it
// is reading.
const { pinned, recent, loading } = useAllRecentSessions({ archived: props.archived });

// Pinned threads lead, each run newest-first. The composable has already split
// them, and both arrives sorted, so this is a concatenation rather than a sort —
// which also means the boundary between the two runs is exact, and the row at
// the top of the unpinned run can draw the line that a section header otherwise
// would.
const threads = computed(() => [...pinned.value, ...recent.value]);
const pinnedCount = computed(() => pinned.value.length);

// Two different silences: still counting, and nothing to count. Claiming
// emptiness while the fan-out is still running would be a lie that corrects
// itself a moment later — and an empty archive is a normal, permanent state
// worth wording differently from an empty inbox.
const quiet = computed(() => {
  if (loading.value) return "Gathering threads…";
  return props.archived ? "Nothing archived." : "Nothing here yet.";
});

function select(threadId: string): void {
  if (selected.value === threadId) return;
  cue("select");
  selected.value = threadId;
}
</script>

<template>
  <div class="tl">
    <!-- Names the list under it, because the rail's mark alone says which tab is
         lit without saying what you are now looking at. -->
    <header class="tl__head">
      <h2 class="tl__heading">{{ archived ? "Archived" : "Inbox" }}</h2>
      <button type="button" class="tl__new" aria-label="New chat" title="New chat">
        <HugeiconsIcon :icon="Add01Icon" :size="16" :stroke-width="2" aria-hidden="true" />
      </button>
    </header>

    <div class="tl__scroll">
      <ol v-if="threads.length" class="tl__list">
        <li
          v-for="(s, i) in threads"
          :key="s.threadId"
          class="tl__row"
          :class="{
            'tl__row--pinned': s.pinned,
            'tl__row--resumes': i === pinnedCount && i > 0,
            'tl__row--on': s.threadId === selected,
          }"
          :style="{ '--i': i }"
          role="button"
          tabindex="0"
          :aria-current="s.threadId === selected ? 'true' : undefined"
          @click="select(s.threadId)"
          @keydown.enter.prevent="select(s.threadId)"
          @keydown.space.prevent="select(s.threadId)"
          @pointerenter="prefetchThread(s.threadId)"
          @focus="prefetchThread(s.threadId)"
        >
          <div class="tl__lead">
            <AgentFace :seed="s.threadId" :size="32" />
            <span class="tl__badge">
              <ProviderLogo :brand="sessionBrand(s.provider, s.brand, s.model)" :size="16" />
            </span>
          </div>

          <div class="tl__main">
            <div class="tl__title">
              <HugeiconsIcon
                v-if="s.pinned"
                class="tl__pin"
                :icon="PinIcon"
                :size="11"
                :stroke-width="2"
                aria-label="Pinned"
              />
              <span class="tl__name">{{ s.title }}</span>
            </div>
            <div class="tl__meta">
              <span class="tl__agent">{{ agentIdentity(s.threadId).name }}</span>

              <span v-if="s.projectName" class="tl__chip" :title="s.projectPath">
                <HugeiconsIcon :icon="Folder01Icon" :size="11" :stroke-width="1.7" aria-hidden="true" />
                {{ s.projectName }}
              </span>

              <span v-if="s.branch" class="tl__chip" :title="s.branch">
                <HugeiconsIcon :icon="GitBranchIcon" :size="11" :stroke-width="2" aria-hidden="true" />
                {{ s.branch }}
              </span>
            </div>
          </div>

          <span class="tl__when">{{ timeAgo(s.updatedAt) }}</span>
        </li>
      </ol>

      <p v-else class="tl__quiet">{{ quiet }}</p>
    </div>
  </div>
</template>

<style scoped>
.tl {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* Pinned above the scroll so the heading and the button stay put while the rows
   move under them. */
.tl__head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 14px 14px 10px;
}

.tl__heading {
  font-family: var(--font-sans);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--ink-soft);
}

.tl__new {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 9px;
  color: var(--muted);
  background: transparent;
  cursor: pointer;
  transition:
    color 0.16s ease,
    background-color 0.16s ease;
}
.tl__new:hover {
  color: var(--accent);
  background: var(--accent-wash);
}

.tl__scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 8px 8px;
}

.tl__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  list-style: none;
  margin: 0;
  padding: 0;
}

.tl__row {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 9px 10px;
  border-radius: 12px;
  /* Capped so a long list's last rows are not still arriving after the eye has
     already reached them. */
  animation: tl-row-in 260ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
  animation-delay: min(calc(var(--i, 0) * 22ms), 320ms);
}

.tl__lead {
  position: relative;
  flex: none;
  line-height: 0;
}
/* The vendor mark rides the corner of the face rather than taking a column of
   its own — which thread it is and what runs it are one glance, not two. */
.tl__badge {
  position: absolute;
  right: -3px;
  bottom: -3px;
  display: grid;
  place-items: center;
  padding: 2px;
  border-radius: 999px;
  background: var(--panel);
}

.tl__main {
  flex: 1;
  min-width: 0;
}

.tl__title {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.tl__name {
  font-family: var(--font-sans);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 19px;
  color: var(--ink-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The mark explains the row's position rather than decorating it, so it leads
   the title instead of trailing the row: by the time the eye reaches the right
   edge it has already wondered why this one is at the top. */
.tl__pin {
  flex: none;
  color: var(--accent);
}

.tl__row--pinned .tl__name {
  color: var(--ink);
}

.tl__row {
  cursor: pointer;
  transition: background-color 0.14s ease;
}
.tl__row:hover {
  background: var(--hover);
}
.tl__row:focus-visible {
  outline: none;
  background: var(--hover);
}
.tl__row--on,
.tl__row--on:hover {
  background: var(--selected);
}
.tl__row--on .tl__name {
  color: var(--ink);
}

/* Where the pinned run ends. A rule, not a header — the list stays one
   sequence, but the eye is told that the recency clock restarts here rather
   than being left to read the timestamps and work it out. */
.tl__row--resumes {
  margin-top: 9px;
  position: relative;
}
.tl__row--resumes::before {
  content: "";
  position: absolute;
  top: -5px;
  left: 10px;
  right: 10px;
  height: 1px;
  background: var(--line-soft);
}

.tl__meta {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 14px;
  color: var(--muted);
  white-space: nowrap;
}
.tl__agent {
  flex: none;
}
.tl__chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tl__chip svg {
  flex: none;
}

.tl__when {
  flex: none;
  align-self: flex-start;
  padding-top: 3px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 14px;
  color: var(--faint);
  font-variant-numeric: tabular-nums;
}

.tl__quiet {
  padding: 18px 12px;
  font-size: 12.5px;
  color: var(--muted);
}

@keyframes tl-row-in {
  from {
    opacity: 0;
    transform: translateY(5px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .tl__row {
    animation: none;
  }
}
</style>
