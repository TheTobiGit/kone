<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { AiBrain01Icon } from "@hugeicons/core-free-icons";
import type { useGitSpace } from "~/composables/useGitSpace";

// Where a commit gets written.
//
// It sits at the foot of the Changes list and stays there while the list scrolls
// past behind it, because the message is the point of the section — you
// shouldn't have to scroll back to a form after reviewing forty files. It stays
// closed (one line, no chrome) until there is something staged, so an untouched
// repository never shows an empty form.

const props = defineProps<{
  space: ReturnType<typeof useGitSpace>;
  stagedCount: number;
  /** Somewhere to push to — decides whether "Commit & push" is offered. */
  canPush: boolean;
}>();

const git = useGit();
const { cue } = useSound();

const summary = ref("");
const body = ref("");
const amend = ref(false);
const isGenerating = ref(false);
const summaryEl = ref<HTMLTextAreaElement | null>(null);
const bodyEl = ref<HTMLTextAreaElement | null>(null);


const busy = computed(() => props.space.op.value !== null);
const ready = computed(() => summary.value.trim().length > 0 && !busy.value);
// Amending doesn't need anything staged — it can just reword the last commit.
const armed = computed(() => props.stagedCount > 0 || amend.value);

// git's own soft limit for a subject line. Past it the counter appears; it never
// blocks the commit, it just stops being invisible.
const LIMIT = 50;
const over = computed(() => summary.value.length > LIMIT);

/** Textareas that grow with their content — no scrollbar inside a message. */
function grow(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}
watch(summary, () => grow(summaryEl.value));
watch(body, () => grow(bodyEl.value));

// Turning on amend offers the previous message rather than an empty field —
// rewording is the common reason to reach for it.
watch(amend, (on) => {
  if (!on) return;
  const last = props.space.commits.value[0];
  if (last && !summary.value.trim()) {
    summary.value = last.subject;
    void nextTick(() => grow(summaryEl.value));
  }
});

function reset() {
  summary.value = "";
  body.value = "";
  amend.value = false;
  void nextTick(() => {
    grow(summaryEl.value);
    grow(bodyEl.value);
  });
}

async function generateAiMessage() {
  if (isGenerating.value || busy.value) return;
  cue("press");
  isGenerating.value = true;
  try {
    const res = await props.space.generateCommitMessage();
    if (res.subject) {
      summary.value = res.subject;
      body.value = res.body || "";
      void nextTick(() => {
        grow(summaryEl.value);
        grow(bodyEl.value);
      });
    }
  } catch {
    /* fallback to manual */
  } finally {
    isGenerating.value = false;
  }
}



async function run(alsoPush: boolean) {
  if (!ready.value) return;
  cue("press");
  const opts = {
    message: summary.value.trim(),
    body: body.value.trim() || undefined,
    amend: amend.value || undefined,
  };
  const ok = alsoPush
    ? await props.space.commitAndPush(opts)
    : await props.space.commit(opts);
  if (ok) {
    cue("success");
    reset();
  } else {
    // The message stays put — the masthead now says why, and the user can fix
    // whatever git objected to without retyping it.
    cue("error");
  }
}

// ⌘/Ctrl+Enter commits from either field; plain Enter in the summary moves down
// to the body rather than submitting, so a stray keystroke can't commit.
function onSummaryKey(e: KeyboardEvent) {
  if (e.key !== "Enter") return;
  e.preventDefault();
  if (e.metaKey || e.ctrlKey) void run(false);
  else bodyEl.value?.focus();
}
function onBodyKey(e: KeyboardEvent) {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    void run(false);
  }
}
</script>

<template>
  <div class="cb" :class="{ 'cb--armed': armed }">
    <div class="cb__fade" aria-hidden="true" />

    <div class="cb__box">
      <textarea
        ref="summaryEl"
        v-model="summary"
        class="cb__summary"
        rows="1"
        spellcheck="false"
        :placeholder="amend ? 'Reword the last commit' : 'Summary'"
        :disabled="busy"
        aria-label="Commit summary"
        @keydown="onSummaryKey"
      />
      <textarea
        v-show="summary.length > 0"
        ref="bodyEl"
        v-model="body"
        class="cb__body"
        rows="1"
        spellcheck="false"
        placeholder="Description — optional"
        :disabled="busy"
        aria-label="Commit description"
        @keydown="onBodyKey"
      />

      <div class="cb__foot">
        <div class="cb__left">
          <span class="cb__count">
            <template v-if="amend && stagedCount === 0">amending</template>
            <template v-else>
              {{ stagedCount }} staged<template v-if="amend"> · amending</template>
            </template>
          </span>
          <span v-if="over" class="cb__over">{{ summary.length }}/{{ LIMIT }}</span>
        </div>

        <div class="cb__right">
          <button
            type="button"
            class="cb__ghost"
            :disabled="busy || isGenerating"
            @click="generateAiMessage"
          >
            <HugeiconsIcon :icon="AiBrain01Icon" :size="12" />
            {{ isGenerating ? 'Generating...' : (summary ? 'Regenerate' : 'Generate') }}
          </button>
          <button
            type="button"
            class="cb__ghost"
            :class="{ 'cb__ghost--on': amend }"
            :disabled="busy"
            :aria-pressed="amend"
            @click="cue('toggle'); amend = !amend"
          >
            Amend
          </button>

          <button
            v-if="canPush"
            type="button"
            class="cb__ghost"
            :disabled="!ready"
            @click="run(true)"
          >
            Commit &amp; push
          </button>
          <button
            type="button"
            class="cb__commit"
            :disabled="!ready"
            @click="run(false)"
          >
            Commit
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cb {
  position: sticky;
  bottom: 0;
  z-index: 2;
  margin-top: 18px;
  /* Closed: out of the way but still reachable in one click. */
  opacity: 0.55;
  transition: opacity var(--gs-t-micro) var(--gs-ease);
  animation: cb-in var(--gs-t-enter) var(--gs-ease) backwards;
}
@keyframes cb-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.cb--armed,
.cb:focus-within {
  opacity: 1;
}
/* The list dissolves into the page behind the box instead of being cut by a
   rule — kone doesn't draw lines to separate things. */
.cb__fade {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 100%;
  height: 28px;
  background: linear-gradient(to top, var(--ground), transparent);
  pointer-events: none;
}
/* Bare ground, like every row above it — a filled slab here reads as a card,
   and in dark it punches a black hole in the page. The fade is the separation.
   A wash arrives only while you're writing, on the same pill the rows hover
   with, so the field has presence under the cursor and none at rest. */
.cb__box {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 8px 8px;
  border-radius: 8px;
  background-color: transparent;
  transition: background-color var(--gs-t-micro) var(--gs-ease);
}
.cb:focus-within .cb__box {
  background-color: var(--hover);
}

.cb__summary,
.cb__body {
  width: 100%;
  resize: none;
  overflow: hidden;
  background: none;
  border: none;
  outline: none;
  font-family: var(--font-sans);
  line-height: 1.45;
  color: var(--ink);
}
.cb__summary {
  font-size: 13.5px;
  letter-spacing: -0.1px;
}
.cb__body {
  font-size: 12.5px;
  color: var(--ink-soft);
}
.cb__summary::placeholder,
.cb__body::placeholder {
  color: var(--muted);
}
.cb__summary:disabled,
.cb__body:disabled {
  opacity: 0.6;
}

.cb__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 7px;
}
.cb__left {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}
.cb__count,
.cb__over {
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  white-space: nowrap;
}
/* A long subject is a nudge, never an error. */
.cb__over {
  color: var(--ink-soft);
  opacity: 0.8;
}
.cb__right {
  display: flex;
  align-items: center;
  gap: 4px;
}

.cb__ghost,
.cb__commit {
  height: 25px;
  padding-inline: 10px;
  border-radius: 8px;
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color var(--gs-t-micro) var(--gs-ease),
    color var(--gs-t-micro) var(--gs-ease),
    opacity var(--gs-t-micro) var(--gs-ease);
}
.cb__ghost {
  color: var(--muted);
}
.cb__ghost:hover:not(:disabled) {
  background-color: var(--hover);
  color: var(--ink-soft);
}
.cb__ghost--on {
  color: var(--accent);
}
.cb__commit {
  background-color: var(--ink);
  color: var(--ground);
}
.cb__commit:hover:not(:disabled) {
  opacity: 0.88;
}
.cb__ghost:disabled,
.cb__commit:disabled {
  opacity: 0.4;
  cursor: default;
}
.cb__ghost:focus-visible,
.cb__commit:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

@media (prefers-reduced-motion: reduce) {
  .cb {
    animation: none;
    transition: none;
  }
  .cb__box,
  .cb__ghost,
  .cb__commit {
    transition: none;
  }
}
</style>
