<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from "vue";
import type { Component } from "vue";
import { AnimatePresence, motion } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import { AiBrain01Icon, ArrowDown01Icon, Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
// Tool-call glyphs are Phosphor duotone — a monochrome two-tone look, so the
// rows read calm and tonal rather than a rainbow of family hues.
import {
  PhFileText,
  PhNotePencil,
  PhListBullets,
  PhTrash,
  PhMagnifyingGlass,
  PhCode,
  PhTerminalWindow,
  PhGlobe,
  PhLinkSimple,
  PhTreeStructure,
  PhRocketLaunch,
} from "@phosphor-icons/vue";
import type { RuntimeItem } from "~/types/desktop";
import type { AssistantBlock, ThreadBlock } from "~/composables/useAgent";
import WorkingOrb from "~/components/WorkingOrb.vue";
import MarkdownMessage from "~/components/MarkdownMessage.vue";

// The live conversation — where the agent's turns become a timeline.
//
// The rule (the convention every serious agent UI + every provider wire format
// converges on): a turn is a single ORDERED list of parts — thinking, tool
// calls, and text — rendered strictly in the order they arrived. We never regroup
// by kind. Our provider stream already hands `block.items` in arrival order; here
// we only coalesce *adjacent* same-kind items into segments (a run of thoughts,
// a run of tool calls, a run of text) so the layout has rhythm, then render the
// segments in place. This is what makes tools-at-the-start, a tool-after-text,
// and interleaved thinking all read correctly.
//
//   · thinking streams live (dim aside), then collapses to a "Thought for Xs"
//     disclosure once it settles;
//   · tool calls are a vertical run of rows — icon · verb · target · status;
//   · text is Markdown once settled, a plain growing stream while live;
//   · the working orb holds any quiet gap — the opening wait, or a lull between
//     one activity finishing and the next starting.
//
// Purely presentational — it reads the reduced blocks from useAgent and never
// learns which CLI is underneath.

const props = defineProps<{
  blocks: ThreadBlock[];
  /** Ticking clock from useAgent, so "working · Xs" counts up live. */
  now: number;
  /** A session-level error (start failure, crashed process) — shown as a
   *  single banner above the thread when set. */
  sessionError?: string | null;
}>();

const { cue } = useSound();

// ── tool-call vocabulary → icon + label ──────────────────────────────────────
type ToolMeta = { icon: Component; label: string };
const TOOL_TABLE: Record<string, ToolMeta> = {
  // filesystem
  read_file: { icon: PhFileText, label: "Read" },
  view_file: { icon: PhFileText, label: "Read" },
  read: { icon: PhFileText, label: "Read" },
  write_to_file: { icon: PhNotePencil, label: "Write" },
  create_file: { icon: PhNotePencil, label: "Write" },
  write: { icon: PhNotePencil, label: "Write" },
  edit_file: { icon: PhNotePencil, label: "Edit" },
  apply_patch: { icon: PhNotePencil, label: "Edit" },
  str_replace: { icon: PhNotePencil, label: "Edit" },
  replace_file_content: { icon: PhNotePencil, label: "Edit" },
  edit: { icon: PhNotePencil, label: "Edit" },
  list_dir: { icon: PhListBullets, label: "List" },
  ls: { icon: PhListBullets, label: "List" },
  delete_file: { icon: PhTrash, label: "Delete" },
  rm: { icon: PhTrash, label: "Delete" },
  // search & navigation
  grep_search: { icon: PhMagnifyingGlass, label: "Grep" },
  ripgrep: { icon: PhMagnifyingGlass, label: "Grep" },
  glob_file_search: { icon: PhMagnifyingGlass, label: "Glob" },
  find_by_name: { icon: PhMagnifyingGlass, label: "Glob" },
  codebase_search: { icon: PhMagnifyingGlass, label: "Search" },
  grep: { icon: PhMagnifyingGlass, label: "Grep" },
  search: { icon: PhMagnifyingGlass, label: "Search" },
  go_to_definition: { icon: PhCode, label: "Code intel" },
  view_code_item: { icon: PhCode, label: "Code intel" },
  lsp: { icon: PhCode, label: "Code intel" },
  // execution
  bash: { icon: PhTerminalWindow, label: "Run" },
  run_terminal_cmd: { icon: PhTerminalWindow, label: "Run" },
  execute_command: { icon: PhTerminalWindow, label: "Run" },
  run_command: { icon: PhTerminalWindow, label: "Run" },
  run: { icon: PhTerminalWindow, label: "Run" },
  command: { icon: PhTerminalWindow, label: "Run" },
  // web
  web_search: { icon: PhGlobe, label: "Web search" },
  search_web: { icon: PhGlobe, label: "Web search" },
  web_fetch: { icon: PhLinkSimple, label: "Web fetch" },
  read_url_content: { icon: PhLinkSimple, label: "Web fetch" },
  view_web_document: { icon: PhLinkSimple, label: "Web fetch" },
  // planning & orchestration
  task: { icon: PhTreeStructure, label: "Subagent" },
  new_task: { icon: PhTreeStructure, label: "Subagent" },
  agent: { icon: PhTreeStructure, label: "Subagent" },
  // context & specialized
  deploy_web_app: { icon: PhRocketLaunch, label: "Deploy" },
};
function toolMeta(name: string | undefined): ToolMeta {
  if (!name) return { icon: PhTerminalWindow, label: "Tool" };
  const key = name.trim().toLowerCase();
  if (TOOL_TABLE[key]) return TOOL_TABLE[key]!;
  const label = key.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return { icon: PhTerminalWindow, label };
}
// The provider hands args as `read_file: src/foo.ts`; peel the name so we're left
// with the target (path / command / query). Long tails keep their end.
function toolDetail(t: RuntimeItem): string {
  const name = (t.name ?? "").trim();
  const raw = (t.text ?? "").trim();
  const prefix = `${name}:`;
  const d = raw.startsWith(prefix) ? raw.slice(prefix.length).trim() : raw === name ? "" : raw;
  const MAX = 64;
  return d.length <= MAX ? d : "…" + d.slice(-(MAX - 1));
}

// ── the ordered-parts model ───────────────────────────────────────────────────
// Walk the block's items (already in arrival order) and coalesce runs of the same
// kind into segments. Order is never changed — only adjacent same-kind items join.
type SegKind = "thinking" | "tools" | "text";
type Segment = { kind: SegKind; key: string; items: RuntimeItem[] };

function segKindOf(item: RuntimeItem): SegKind {
  if (item.kind === "reasoning_text") return "thinking";
  if (item.kind === "tool_call") return "tools";
  return "text"; // assistant_text | plan_text
}
function segmentsOf(block: AssistantBlock): Segment[] {
  const out: Segment[] = [];
  for (const it of block.items) {
    const kind = segKindOf(it);
    const cur = out[out.length - 1];
    if (cur && cur.kind === kind) cur.items.push(it);
    else out.push({ kind, key: `${block.id}:${it.itemId}`, items: [it] });
  }
  return out;
}
function segStreaming(seg: Segment): boolean {
  return seg.items.some((i) => i.status === "in-progress");
}
function segText(seg: Segment): string {
  return seg.items
    .map((i) => i.text)
    .join("\n\n")
    .trim();
}
function toolCalls(seg: Segment): RuntimeItem[] {
  return seg.items.filter((i) => i.kind === "tool_call");
}
function toolStatus(t: RuntimeItem): "running" | "done" | "error" {
  if (t.status === "in-progress") return "running";
  if (t.status === "failed") return "error";
  return "done";
}

// ── per-item timing (for "Thought for Xs") ────────────────────────────────────
// Items carry no timestamps, so we clock them ourselves: when we first see an
// item, and when it settles. A thinking segment's duration spans its earliest
// first-seen to its latest settle.
const seenAt = new Map<string, number>();
const doneAt = new Map<string, number>();
watch(
  () =>
    props.blocks
      .flatMap((b) => (b.role === "assistant" ? b.items.map((i) => `${i.itemId}:${i.status}`) : []))
      .join(","),
  () => {
    const t = Date.now();
    for (const b of props.blocks) {
      if (b.role !== "assistant") continue;
      for (const it of b.items) {
        if (!seenAt.has(it.itemId)) seenAt.set(it.itemId, t);
        if ((it.status === "completed" || it.status === "failed") && !doneAt.has(it.itemId))
          doneAt.set(it.itemId, t);
      }
    }
  },
  { immediate: true },
);
function thinkingDuration(seg: Segment): number | null {
  if (segStreaming(seg)) return null;
  const starts = seg.items.map((i) => seenAt.get(i.itemId)).filter((x): x is number => x != null);
  const ends = seg.items.map((i) => doneAt.get(i.itemId)).filter((x): x is number => x != null);
  if (!starts.length || !ends.length) return null;
  return Math.max(1, Math.round((Math.max(...ends) - Math.min(...starts)) / 1000));
}

// ── thinking collapse ─────────────────────────────────────────────────────────
// Expanded while it streams; auto-collapses the moment it settles. A click pins
// an explicit state either way.
const thinkOpen = reactive<Record<string, boolean>>({});
function thinkingExpanded(seg: Segment): boolean {
  return seg.key in thinkOpen ? thinkOpen[seg.key]! : segStreaming(seg);
}
function toggleThinking(seg: Segment): void {
  thinkOpen[seg.key] = !thinkingExpanded(seg);
  cue("toggle");
}

// ── tool-call detail expand ───────────────────────────────────────────────────
// A tool row expands on click only when it carries a `detail` body (command
// output, a diff, a file list) — no dead affordance otherwise.
const toolOpen = reactive<Record<string, boolean>>({});
function toolExpanded(t: RuntimeItem): boolean {
  return Boolean(toolOpen[t.itemId]);
}
function toggleTool(t: RuntimeItem): void {
  if (!t.detail) return;
  toolOpen[t.itemId] = !toolOpen[t.itemId];
  cue("toggle");
}

// ── markdown (settled text segments) ──────────────────────────────────────────
// While a text segment streams we show its growing string as plain text; once it
// settles we hand the whole segment to <MarkdownMessage>, which renders it as a
// rich component tree (highlighted code, favicon links, file chips, tables…).

// ── waiting ───────────────────────────────────────────────────────────────────
// A live turn with nothing currently in flight — the opening gap, or a lull
// between one activity settling and the next starting. The working orb fills it.
function isWaiting(block: AssistantBlock): boolean {
  if (block.state !== "running") return false;
  const last = block.items[block.items.length - 1];
  return !last || last.status !== "in-progress";
}

// ── timing / status ────────────────────────────────────────────────────────────
function fmt(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}
function elapsed(block: AssistantBlock): string {
  const end = block.endedAt ?? props.now;
  return fmt(Math.max(0, Math.round((end - block.at) / 1000)));
}
function statusOf(block: AssistantBlock): { text: string; tone: "live" | "muted" | "error" } {
  if (block.state === "running") return { text: `working · ${elapsed(block)}`, tone: "live" };
  if (block.state === "failed") return { text: "couldn't finish", tone: "error" };
  if (block.state === "interrupted") return { text: "stopped", tone: "muted" };
  return { text: `replied in ${elapsed(block)}`, tone: "muted" };
}
function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function assistantText(block: AssistantBlock): string {
  return block.items
    .filter((i) => i.kind === "assistant_text" || i.kind === "plan_text")
    .map((i) => i.text)
    .join("\n\n")
    .trim();
}

// The turn meta flashes in the moment a turn settles, then fades — back on hover.
const flash = reactive<Record<string, boolean>>({});
const flashed = new Set<string>();
watch(
  () => props.blocks.map((b) => (b.role === "assistant" ? `${b.id}:${b.state}` : b.id)).join(","),
  () => {
    for (const b of props.blocks) {
      if (b.role !== "assistant" || b.state === "running" || flashed.has(b.id)) continue;
      flashed.add(b.id);
      flash[b.id] = true;
      if (import.meta.client) window.setTimeout(() => (flash[b.id] = false), 3000);
    }
  },
  { immediate: true },
);

// ── copy ──────────────────────────────────────────────────────────────────────
const copied = ref<string | null>(null);
async function copy(block: AssistantBlock) {
  const text = assistantText(block);
  if (!text || !import.meta.client) return;
  try {
    await navigator.clipboard.writeText(text);
    cue("toggle");
    copied.value = block.id;
    window.setTimeout(() => {
      if (copied.value === block.id) copied.value = null;
    }, 1600);
  } catch {
    // Clipboard blocked — nothing to do.
  }
}

// ── auto-scroll ────────────────────────────────────────────────────────────────
const root = ref<HTMLElement | null>(null);
function tailSignature(): string {
  const last = props.blocks[props.blocks.length - 1];
  if (!last) return "";
  if (last.role === "user") return `${props.blocks.length}:u:${last.text.length}`;
  const chars = last.items.reduce((n, i) => n + i.text.length, 0);
  return `${props.blocks.length}:a:${last.items.length}:${chars}:${last.state}`;
}
watch(tailSignature, () => {
  void nextTick(() => {
    const sc = scroller();
    if (!sc) return;
    const nearBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 260;
    if (nearBottom) sc.scrollTo({ top: sc.scrollHeight, behavior: "smooth" });
  });
});
function scroller(): HTMLElement | null {
  let el = root.value?.parentElement ?? null;
  while (el) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight) return el;
    el = el.parentElement;
  }
  return (document.scrollingElement as HTMLElement) ?? document.documentElement;
}
const hasBlocks = computed(() => props.blocks.length > 0);
</script>

<template>
  <div ref="root" class="thread" :class="{ 'thread--empty': !hasBlocks }">
    <p v-if="sessionError" class="body body--error thread__error">{{ sessionError }}</p>
    <p v-if="!hasBlocks" class="thread__empty">Nothing here yet — say something to begin.</p>

    <motion.div
      v-for="block in blocks"
      :key="block.id"
      class="turn"
      :class="[
        block.role === 'user' ? 'turn--you' : 'turn--kone',
        block.role === 'assistant' && block.state !== 'running' ? 'turn--settled' : '',
        block.role === 'assistant' && flash[block.id] ? 'turn--flash' : '',
      ]"
      :initial="{ opacity: 0, y: 14, x: block.role === 'user' ? 18 : -6 }"
      :animate="{ opacity: 1, y: 0, x: 0 }"
      :transition="{ type: 'spring', stiffness: 320, damping: 30, mass: 0.8 }"
    >
      <!-- ── User turn — right-aligned ─────────────────────────────────── -->
      <template v-if="block.role === 'user'">
        <p class="body body--you selectable">{{ block.text }}</p>
      </template>

      <!-- ── Assistant (kone) turn — parts, in the order they arrived ────── -->
      <template v-else>
        <div class="stack selectable">
          <template v-for="seg in segmentsOf(block)" :key="seg.key">
            <!-- Thinking — a dim aside. Streams open; collapses to "Thought for
                 Xs" once it settles. -->
            <div v-if="seg.kind === 'thinking'" class="think" :class="{ 'think--open': thinkingExpanded(seg) }">
              <button type="button" class="think__head" @click="toggleThinking(seg)">
                <HugeiconsIcon :icon="AiBrain01Icon" :size="14" :stroke-width="1.8" class="think__brain" />
                <span class="think__label">
                  {{ segStreaming(seg) ? "Thinking…" : `Thought for ${thinkingDuration(seg) ?? 1}s` }}
                </span>
                <HugeiconsIcon
                  :icon="ArrowDown01Icon"
                  :size="14"
                  :stroke-width="2"
                  class="think__chev"
                  :class="{ 'think__chev--open': thinkingExpanded(seg) }"
                />
              </button>
              <div v-show="thinkingExpanded(seg)" class="think__body">
                <p class="think__text">{{ segText(seg) }}</p>
              </div>
            </div>

            <!-- Tool calls — a run of rows, icon · verb · target · status. A row
                 with a `detail` body (output/diff/file list) expands on click. -->
            <div v-else-if="seg.kind === 'tools'" class="tools" aria-label="Tools">
              <div v-for="t in toolCalls(seg)" :key="t.itemId" class="tool-wrap">
                <motion.div
                  class="tool"
                  :class="[`tool--${toolStatus(t)}`, { 'tool--expandable': !!t.detail }]"
                  :role="t.detail ? 'button' : undefined"
                  :tabindex="t.detail ? 0 : undefined"
                  :initial="{ opacity: 0, y: 6 }"
                  :animate="{ opacity: 1, y: 0 }"
                  :transition="{ type: 'spring', stiffness: 420, damping: 30 }"
                  @click="toggleTool(t)"
                  @keydown.enter="toggleTool(t)"
                >
                  <span class="tool__icon">
                    <component :is="toolMeta(t.name).icon" :size="16" weight="duotone" />
                  </span>
                  <span class="tool__verb">{{ toolMeta(t.name).label }}</span>
                  <span v-if="toolDetail(t)" class="tool__target">{{ toolDetail(t) }}</span>
                  <span class="tool__status" aria-hidden="true">
                    <span v-if="toolStatus(t) === 'running'" class="tool__spinner" />
                    <HugeiconsIcon
                      v-else-if="toolStatus(t) === 'done'"
                      :icon="Tick02Icon"
                      :size="13"
                      :stroke-width="2.4"
                    />
                    <span v-else class="tool__err">failed</span>
                  </span>
                </motion.div>
                <pre v-if="t.detail && toolExpanded(t)" class="output">{{ t.detail }}</pre>
              </div>
            </div>

            <!-- Text — rich Markdown once settled, a plain growing stream while live. -->
            <template v-else>
              <MarkdownMessage v-if="!segStreaming(seg)" class="answer" :source="segText(seg)" />
              <p v-else class="body body--stream">{{ segText(seg) }}</p>
            </template>
          </template>

          <!-- Waiting — the working orb holds any quiet gap while the turn is live
               but nothing is in flight (opening wait, or a lull between parts). -->
          <AnimatePresence>
            <motion.div
              v-if="isWaiting(block)"
              class="waiting"
              :initial="{ opacity: 0, scale: 0.86 }"
              :animate="{ opacity: 1, scale: 1 }"
              :exit="{ opacity: 0, scale: 0.86 }"
              :transition="{ type: 'spring', stiffness: 300, damping: 26, mass: 0.7 }"
            >
              <WorkingOrb :size="42" />
            </motion.div>
          </AnimatePresence>

          <!-- Failure note. -->
          <p v-if="block.state === 'failed' && block.error" class="body body--error">
            {{ block.error }}
          </p>

          <!-- Turn meta — quiet until the turn settles / you hover it. -->
          <div class="foot">
            <span class="foot__time">{{ clock(block.at) }}</span>
            <span class="foot__sep">·</span>
            <span class="foot__status" :class="`foot__status--${statusOf(block).tone}`">{{
              statusOf(block).text
            }}</span>
            <button
              v-if="block.state === 'completed' && assistantText(block)"
              type="button"
              class="foot__copy"
              :aria-label="copied === block.id ? 'Copied' : 'Copy reply'"
              @click="copy(block)"
            >
              <HugeiconsIcon :icon="copied === block.id ? Tick02Icon : Copy01Icon" :size="13" :stroke-width="2" />
              <span>{{ copied === block.id ? "Copied" : "Copy" }}</span>
            </button>
          </div>
        </div>
      </template>
    </motion.div>
  </div>
</template>

<style scoped>
.thread {
  display: flex;
  flex-direction: column;
  gap: 30px;
  width: 100%;
  max-width: 760px;
  margin: 0 auto;
}
.thread--empty {
  min-height: 40vh;
  align-items: center;
  justify-content: center;
}
.thread__empty {
  margin: 0;
  font-size: 15px;
  color: var(--muted);
}

.turn {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.turn--you {
  align-items: flex-end;
}

/* ── The turn's body stack ─────────────────────────────────────────────────── */
.stack {
  display: flex;
  flex-direction: column;
  gap: 14px;
  align-items: flex-start;
  width: 100%;
}

/* ── Message body ──────────────────────────────────────────────────────────── */
.body {
  margin: 0;
  font-size: 16px;
  line-height: 27px;
  color: var(--ink);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.body--you {
  text-align: left;
  max-width: 82%;
  padding: 11px 16px;
  border-radius: 16px 16px 5px 16px;
  background: var(--hover);
}
.body--error {
  color: var(--diff-del);
  font-size: 14px;
  line-height: 22px;
}
.body--stream {
  white-space: pre-wrap;
}
.thread__error {
  align-self: stretch;
}

/* The settled rich answer spans the turn; its internals are styled inside
   MarkdownMessage. It carries the same left alignment as the rest of the stack. */
.answer {
  width: 100%;
  max-width: 100%;
}

/* ── Thinking — a dim, collapsible aside ───────────────────────────────────── */
.think {
  display: flex;
  flex-direction: column;
  width: 100%;
}
.think__head {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  align-self: flex-start;
  padding: 3px 4px 3px 0;
  border: 0;
  background: transparent;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 12.5px;
  letter-spacing: -0.01em;
  cursor: pointer;
}
.think__head:hover {
  color: var(--ink-soft);
}
.think__brain {
  flex: none;
}
.think__label {
  white-space: nowrap;
}
.think__chev {
  flex: none;
  opacity: 0.7;
  transition: transform 0.22s ease;
}
.think__chev--open {
  transform: rotate(180deg);
}
.think__body {
  margin-top: 4px;
  padding-left: 21px;
  border-left: 1.5px solid var(--hover);
  margin-left: 6px;
}
.think__text {
  margin: 0;
  font-size: 14px;
  line-height: 23px;
  color: var(--muted);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* ── Tool calls — a run of quiet rows ──────────────────────────────────────── */
.tools {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}
.tool-wrap {
  display: flex;
  flex-direction: column;
  width: 100%;
}
.tool {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  color: var(--muted);
}
.tool--expandable {
  cursor: pointer;
}
.tool__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 18px;
  height: 18px;
  color: var(--ink-soft);
}
.tool__verb {
  flex: none;
  font-size: 13px;
  font-weight: 560;
  letter-spacing: -0.005em;
  color: var(--ink-soft);
}
.tool__target {
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tool__status {
  display: inline-flex;
  align-items: center;
  flex: none;
  margin-left: auto;
  padding-left: 6px;
  color: var(--muted);
}
.tool--done .tool__status {
  color: var(--accent);
  opacity: 0.7;
}
.tool--running {
  color: var(--ink-soft);
}
.tool--error .tool__verb {
  color: var(--diff-del);
}
.tool__err {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--diff-del);
}
.tool__spinner {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  border: 1.5px solid var(--hover);
  border-top-color: var(--accent);
  animation: tool-spin 0.7s linear infinite;
}
@keyframes tool-spin {
  to {
    transform: rotate(360deg);
  }
}

/* ── Command output ────────────────────────────────────────────────────────── */
.output {
  margin: 2px 0 0;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--hover);
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 20px;
  color: var(--ink-soft);
  white-space: pre-wrap;
  overflow-x: auto;
  max-width: 100%;
}

/* ── Waiting orb ───────────────────────────────────────────────────────────── */
.waiting {
  display: flex;
  align-items: center;
  margin: -2px 0;
  will-change: transform, opacity;
}

/* ── Turn footer (meta) — quiet until settle / hover ───────────────────────── */
.foot {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 2px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--muted);
  opacity: 0;
  transform: translateY(-2px);
  transition: opacity 0.45s ease, transform 0.3s ease;
}
.turn--flash .foot,
.turn--kone.turn--settled:hover .foot,
.foot:focus-within {
  opacity: 1;
  transform: none;
}
.foot__sep { opacity: 0.6; }
.foot__status--live { color: var(--accent); }
.foot__status--error { color: var(--diff-del); }
.foot__copy {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 6px;
  padding: 3px 7px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.foot__copy:hover { background: var(--hover); color: var(--ink); }

@media (prefers-reduced-motion: reduce) {
  .tool__spinner { animation: none; }
  .think__chev { transition: none; }
}
</style>
