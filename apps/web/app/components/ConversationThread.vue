<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import type { Component } from "vue";
import { AnimatePresence, motion } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import { AiBrain01Icon, Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
// Tool-call glyphs are Phosphor duotone — a monochrome two-tone look (the
// secondary shape rides at ~20% of currentColor), so the strip reads calm and
// tonal rather than a rainbow of family hues.
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

// The live conversation — the one place the agent's turns become a timeline.
// user (round 2):
//   · turns spring in — user from the right, kone from the left;
//   · tool calls have two lives: while one is the current activity, a single live
//     slot shows its (Phosphor duotone, monochrome) icon + a streaming line of
//     what it's doing, each new call springing in over the last; once the model
//     replies, they collapse into a spaced strip of every icon it ran;
//   · the turn meta (time · replied in Xs) flashes in when the turn settles, then
//     fades out, returning only on hover — so the answer leads;
//   · finished answers render as Markdown; mid-stream they stream a word-by-word
//     blur-up reveal (client-paced) so a buffered dump still writes itself.
// Purely presentational — it reads the reduced blocks from useAgent and never
// learns which CLI is underneath.

const props = defineProps<{
  blocks: ThreadBlock[];
  /** Ticking clock from useAgent, so "working · Xs" counts up live. */
  now: number;
}>();

const { cue } = useSound();
const { render: renderMd } = useMarkdown();

// ── tool-call vocabulary → icon + label ──────────────────────────────────────
// Six families from the "Agent tool calls" board. Names differ across CLIs; we
// map the canonical verbs and fall back to a neutral glyph for the unknown.
// Rendered monochrome (duotone), so there's no per-family hue anymore.
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

// ── block projections ─────────────────────────────────────────────────────────
function toolItems(block: AssistantBlock): RuntimeItem[] {
  return block.items.filter((i) => i.kind === "tool_call");
}

// ── the live tool slot ─────────────────────────────────────────────────────────
// While the turn is working AND its *current* activity is a tool, we show ONE
// live slot — the latest tool's icon + a streaming line of what it's doing. Each
// new tool call swaps the slot (old lifts away, new lands on top). The moment the
// model turns to writing its reply — or the turn settles — the slot collapses
// into the compact strip of all the icons it ran (see the .tools branch).
function lastItem(block: AssistantBlock): RuntimeItem | undefined {
  return block.items[block.items.length - 1];
}
function showLiveTool(block: AssistantBlock): boolean {
  return block.state === "running" && lastItem(block)?.kind === "tool_call";
}
function liveTool(block: AssistantBlock): RuntimeItem | null {
  const tools = toolItems(block);
  return tools.length ? tools[tools.length - 1]! : null;
}
// The provider hands the tool's args as a summary like `read_file: src/foo.ts`;
// peel the tool name back off so we're left with just the target (path / command
// / query). Long targets keep their tail — the basename is the salient part.
function toolDetail(t: RuntimeItem): string {
  const name = (t.name ?? "").trim();
  const raw = (t.text ?? "").trim();
  const prefix = `${name}:`;
  const d = raw.startsWith(prefix) ? raw.slice(prefix.length).trim() : raw === name ? "" : raw;
  const MAX = 52;
  return d.length <= MAX ? d : "…" + d.slice(-(MAX - 1));
}
// Split the target into words so each blurs up in turn — the "stream" is pure CSS
// (a per-word animation-delay), no timer.
function toolDetailWords(t: RuntimeItem): string[] {
  const d = toolDetail(t);
  return d ? d.split(/\s+/).filter(Boolean) : [];
}
// The settled strip is an avatar-style stack: the first few icons overlap, then a
// "+N" disc absorbs the rest so a long turn stays a tidy cluster, not a smear.
const STACK_MAX = 5;
function stackIcons(block: AssistantBlock): RuntimeItem[] {
  return toolItems(block).slice(0, STACK_MAX);
}
function stackOverflow(block: AssistantBlock): number {
  return Math.max(0, toolItems(block).length - STACK_MAX);
}
function reasoningItems(block: AssistantBlock): RuntimeItem[] {
  return block.items.filter((i) => i.kind === "reasoning_text");
}
function textItems(block: AssistantBlock): RuntimeItem[] {
  return block.items.filter(
    (i) => i.kind === "assistant_text" || i.kind === "plan_text" || i.kind === "command_output",
  );
}
function assistantText(block: AssistantBlock): string {
  return block.items
    .filter((i) => i.kind === "assistant_text" || i.kind === "plan_text")
    .map((i) => i.text)
    .join("\n\n")
    .trim();
}
// ── timing ───────────────────────────────────────────────────────────────────
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

// ── streaming reveal (the "writes itself" feel, like the Home greeting) ────────
// The provider hands us text in a few big buffered chunks (agy print flushes by
// line), which would pop in all at once. So the reveal is paced CLIENT-side: a
// per-turn cursor of how many tokens are shown walks forward each frame,
// independent of how the text actually arrived. Each freshly shown token blurs
// up into place — the same idiom as HomeGreeting's per-segment reveal. Only the
// live (last) turn is paced; earlier turns render settled at once.
const reducedMotion =
  import.meta.client && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

// The assistant text of a turn as one string (assistant + plan text).
function liveText(block: AssistantBlock): string {
  return assistantText(block);
}
// Split keeping the whitespace so newlines/spaces survive. A "word" is two
// tokens (the word + the space after it); revealing token-by-token is smooth
// enough and keeps the split trivial.
function tokenize(text: string): string[] {
  return text ? text.split(/(\s+)/) : [];
}

const reveal = reactive<Record<string, number>>({});
function shownTokens(block: AssistantBlock): string[] {
  return tokenize(liveText(block)).slice(0, reveal[block.id] ?? 0);
}
function activeAssistant(): AssistantBlock | null {
  const last = props.blocks[props.blocks.length - 1];
  return last && last.role === "assistant" ? last : null;
}
// Turns that arrive already-finished (a reopened conversation's history) should
// render settled at once, not re-stream their reveal. We only stream turns we
// actually watched go from running → done; anything else is seeded as fully
// shown the moment it appears.
const everRan = new Set<string>();
watch(
  () => props.blocks.map((b) => (b.role === "assistant" ? `${b.id}:${b.state}` : b.id)).join(","),
  () => {
    for (const b of props.blocks) {
      if (b.role !== "assistant") continue;
      if (b.state === "running") everRan.add(b.id);
      else if (!everRan.has(b.id) && reveal[b.id] === undefined) {
        reveal[b.id] = tokenize(liveText(b)).length;
      }
    }
  },
  { immediate: true },
);

let raf = 0;
function advance(block: AssistantBlock): boolean {
  const target = tokenize(liveText(block)).length;
  const shown = reveal[block.id] ?? 0;
  if (shown >= target) return false;
  if (reducedMotion) {
    reveal[block.id] = target;
    return false;
  }
  // Ease the backlog down: a big buffered dump reveals quickly, a trickle keeps
  // pace one token at a time — always bounded, never a marathon.
  const inc = Math.max(1, Math.ceil((target - shown) / 22));
  reveal[block.id] = Math.min(target, shown + inc);
  return true;
}
function tick(): void {
  const b = activeAssistant();
  const more = b ? advance(b) : false;
  raf = more && import.meta.client ? requestAnimationFrame(tick) : 0;
}
function ensureReveal(): void {
  if (!raf && import.meta.client) raf = requestAnimationFrame(tick);
}
onMounted(ensureReveal);
onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf);
});

// ── markdown (settled answers) ─────────────────────────────────────────────────
// While a turn streams we show the token reveal; once it's done AND the cursor
// has caught up, we swap in rendered Markdown so formatting lands without cutting
// the stream short. Earlier (non-last) turns settle immediately.
// The turn meta flashes into view the moment a turn settles, then fades out; it
// comes back only when you hover the finished turn. Keyed by block id, fired once.
const flash = reactive<Record<string, boolean>>({});
const flashed = new Set<string>();
function flashFoot(id: string): void {
  if (flashed.has(id)) return;
  flashed.add(id);
  flash[id] = true;
  if (import.meta.client) window.setTimeout(() => (flash[id] = false), 3000);
}

const md = reactive<Record<string, string>>({});
watch(
  () =>
    props.blocks
      .map((b) => (b.role === "assistant" ? `${b.id}:${b.state}:${reveal[b.id] ?? 0}` : b.id))
      .join(","),
  async () => {
    const last = props.blocks[props.blocks.length - 1];
    for (const b of props.blocks) {
      if (b.role !== "assistant" || b.state === "running") continue;
      const text = assistantText(b);
      // Nothing to reveal (failed / empty) → settle the meta at once.
      if (!text) {
        flashFoot(b.id);
        continue;
      }
      // The live turn waits for its reveal to finish; older turns settle at once.
      if (b === last && (reveal[b.id] ?? 0) < tokenize(text).length) continue;
      if (!md[b.id]) {
        const html = await renderMd(text);
        if (html) md[b.id] = html;
      }
      flashFoot(b.id);
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

// ── auto-scroll ──────────────────────────────────────────────────────────────
const root = ref<HTMLElement | null>(null);
function tailSignature(): string {
  const last = props.blocks[props.blocks.length - 1];
  if (!last) return "";
  if (last.role === "user") return `${props.blocks.length}:u:${last.text.length}`;
  const chars = last.items.reduce((n, i) => n + i.text.length, 0);
  return `${props.blocks.length}:a:${last.items.length}:${chars}:${last.state}`;
}
watch(tailSignature, () => {
  ensureReveal();
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
    <!-- Defensive: the thread should always arrive with turns (a live send or a
         reopened conversation). If it somehow doesn't, say so calmly rather than
         showing a blank page. -->
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

      <!-- ── Assistant (kone) turn — left-aligned ──────────────────────── -->
      <template v-else>
        <div class="stack selectable">
          <!-- Reasoning — a quiet aside, dimmer than the answer. -->
          <p v-for="r in reasoningItems(block)" :key="r.itemId" class="reason">
            <HugeiconsIcon :icon="AiBrain01Icon" :size="14" :stroke-width="1.8" class="reason__glyph" />
            <span>{{ r.text }}</span>
          </p>

          <!-- Tool calls — two lives. While a tool is the CURRENT activity: one
               live slot, its icon + a streaming line of what it's doing; each new
               tool swaps the slot (old lifts, new lands on top). Once the model
               replies / the turn settles: the slot collapses into the compact
               strip of every icon it ran. -->
          <div v-if="showLiveTool(block)" class="tool-live" aria-live="polite">
            <AnimatePresence mode="wait">
              <motion.div
                :key="liveTool(block)!.itemId"
                class="tool-live__slot"
                :initial="{ opacity: 0, y: 9, scale: 0.9 }"
                :animate="{ opacity: 1, y: 0, scale: 1 }"
                :exit="{ opacity: 0, y: -9, scale: 0.94 }"
                :transition="{ type: 'spring', stiffness: 340, damping: 22, mass: 0.7 }"
              >
                <span
                  class="tool-live__icon"
                  :class="{ 'tool-live__icon--running': liveTool(block)!.status === 'in-progress' }"
                >
                  <component
                    :is="toolMeta(liveTool(block)!.name).icon"
                    :size="17"
                    weight="duotone"
                  />
                </span>
                <span class="tool-live__msg">
                  <span class="tool-live__verb">{{ toolMeta(liveTool(block)!.name).label }}</span>
                  <span v-if="toolDetailWords(liveTool(block)!).length" class="tool-live__detail">
                    <motion.span
                      v-for="(w, wi) in toolDetailWords(liveTool(block)!)"
                      :key="wi"
                      class="tool-live__word"
                      :initial="{ opacity: 0, filter: 'blur(5px)' }"
                      :animate="{ opacity: 1, filter: 'blur(0px)' }"
                      :transition="{
                        type: 'spring',
                        stiffness: 210,
                        damping: 24,
                        delay: 0.16 + wi * 0.05,
                      }"
                      >{{ w }}</motion.span
                    >
                  </span>
                </span>
              </motion.div>
            </AnimatePresence>
          </div>
          <div v-else-if="toolItems(block).length" class="tools" aria-label="Tools used">
            <motion.span
              v-for="(t, ti) in stackIcons(block)"
              :key="t.itemId"
              class="tools__chip"
              :class="{ 'tools__chip--running': t.status === 'in-progress' }"
              :title="toolMeta(t.name).label"
              :style="{ zIndex: ti }"
              :initial="{ opacity: 0, scale: 0.3, x: -12 }"
              :animate="{ opacity: 1, scale: 1, x: 0 }"
              :transition="{ type: 'spring', stiffness: 480, damping: 19, delay: ti * 0.05 }"
            >
              <component :is="toolMeta(t.name).icon" :size="16" weight="duotone" />
            </motion.span>
            <motion.span
              v-if="stackOverflow(block)"
              key="more"
              class="tools__more"
              :title="`${toolItems(block).length} tools`"
              :style="{ zIndex: 0 }"
              :initial="{ opacity: 0, scale: 0.3, x: -12 }"
              :animate="{ opacity: 1, scale: 1, x: 0 }"
              :transition="{ type: 'spring', stiffness: 480, damping: 19, delay: STACK_MAX * 0.05 }"
            >
              +{{ stackOverflow(block) }}
            </motion.span>
          </div>

          <!-- Answer. Settled → Markdown; live → a word-by-word blur-up reveal
               (client-paced, so a buffered dump still "writes itself"). -->
          <div v-if="md[block.id]" class="body prose" v-html="md[block.id]" />
          <template v-else>
            <pre
              v-for="out in textItems(block).filter((i) => i.kind === 'command_output')"
              :key="out.itemId"
              class="output"
              >{{ out.text }}</pre
            >
            <p v-if="liveText(block)" class="body body--stream">
              <TransitionGroup name="word" tag="span">
                <span v-for="(tok, ti) in shownTokens(block)" :key="ti" class="word">{{ tok }}</span>
              </TransitionGroup>
            </p>
          </template>

          <!-- Failure note. -->
          <p v-if="block.state === 'failed' && block.error" class="body body--error">
            {{ block.error }}
          </p>

          <!-- Turn meta — moved to the END, quiet until you hover the turn. -->
          <div class="foot">
            <span class="foot__time">{{ clock(block.at) }}</span>
            <span class="foot__sep">·</span>
            <span class="foot__status" :class="`foot__status--${statusOf(block).tone}`">{{ statusOf(block).text }}</span>
            <button
              v-if="block.state === 'completed' && assistantText(block)"
              type="button"
              class="foot__copy"
              :aria-label="copied === block.id ? 'Copied' : 'Copy reply'"
              @click="copy(block)"
            >
              <HugeiconsIcon
                :icon="copied === block.id ? Tick02Icon : Copy01Icon"
                :size="13"
                :stroke-width="2"
              />
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
  gap: 12px;
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
  white-space: pre-wrap;
}
.body--error {
  color: var(--diff-del);
  font-size: 14px;
  line-height: 22px;
}

/* Markdown answer — tuned to the body rhythm; no boxed cards. */
.prose {
  white-space: normal;
}
.prose :deep(p) { margin: 0 0 12px; }
.prose :deep(p:last-child) { margin-bottom: 0; }
.prose :deep(h1),
.prose :deep(h2),
.prose :deep(h3) { margin: 18px 0 8px; font-size: 17px; font-weight: 650; line-height: 1.35; }
.prose :deep(ul),
.prose :deep(ol) { margin: 0 0 12px; padding-left: 22px; }
.prose :deep(li) { margin: 3px 0; }
.prose :deep(a) { color: var(--accent); text-underline-offset: 2px; }
.prose :deep(code) {
  font-family: var(--font-mono);
  font-size: 13.5px;
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--hover);
}
.prose :deep(pre) {
  margin: 0 0 12px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--hover);
  overflow-x: auto;
}
.prose :deep(pre code) { padding: 0; background: none; font-size: 12.5px; line-height: 20px; }

/* ── Reasoning aside ───────────────────────────────────────────────────────── */
.reason {
  display: flex;
  gap: 8px;
  margin: 0;
  font-size: 14px;
  line-height: 23px;
  color: var(--muted);
  white-space: pre-wrap;
}
.reason__glyph {
  flex-shrink: 0;
  margin-top: 4px;
  color: var(--muted);
}

/* ── Live tool slot — one at a time, streaming what it's doing ─────────────── */
.tool-live {
  display: flex;
  min-height: 24px;
}
.tool-live__slot {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  max-width: 100%;
  /* motion-v drives transform; keep it crisp through the spring. */
  will-change: transform, opacity;
}
.tool-live__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 18px;
  height: 18px;
  /* Monochrome — soft ink, not a family hue. */
  color: var(--ink-soft);
}
.tool-live__icon--running {
  animation: chip-pulse 1.4s ease-in-out infinite;
}
.tool-live__msg {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  line-height: 1;
}
.tool-live__verb {
  flex: none;
  font-size: 13px;
  font-weight: 560;
  letter-spacing: -0.005em;
  color: var(--ink-soft);
}
.tool-live__detail {
  display: inline-flex;
  align-items: baseline;
  min-width: 0;
  overflow: hidden;
}
.tool-live__word {
  display: inline-block;
  margin-right: 0.34em;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1;
  color: var(--muted);
  will-change: opacity, filter;
}

/* ── Tool strip — bare icons, stacked (overlapping) once the turn moves on ──── */
/* Just the icons, tucked over one another; no disc, no ring. A "+N" absorbs the
   rest so a long turn stays a tidy cluster. */
.tools {
  display: flex;
  align-items: center;
}
.tools__chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: 4px;
  /* Soft monochrome — quieter than full ink. */
  color: var(--muted);
}
.tools__chip:first-child {
  margin-left: 0;
}
.tools__more {
  display: inline-flex;
  align-items: center;
  margin-left: 3px;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--muted);
}
.tools__chip--running {
  animation: chip-pulse 1.4s ease-in-out infinite;
}
@keyframes chip-pulse {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}

/* ── Command output ────────────────────────────────────────────────────────── */
.output {
  margin: 0;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--hover);
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 20px;
  color: var(--ink-soft);
  white-space: pre-wrap;
  overflow-x: auto;
}

/* ── Turn footer (meta) — quiet until hover ────────────────────────────────── */
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
/* Shown briefly the moment a turn settles (turn--flash, then fades out), and
   again when you hover the finished turn — the bookkeeping stays out of the way
   otherwise. */
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

/* ── Streaming reveal — each token blurs up as the cursor reaches it ────────── */
.body--stream { white-space: pre-wrap; }
.word {
  transition: opacity 300ms ease, filter 300ms ease;
}
.word-enter-from {
  opacity: 0;
  filter: blur(5px);
}

@media (prefers-reduced-motion: reduce) {
  .tools__chip--running,
  .tool-live__icon--running {
    animation: none;
  }
  .word {
    transition: none;
  }
  .word-enter-from {
    opacity: 1;
    filter: none;
  }
}
</style>
