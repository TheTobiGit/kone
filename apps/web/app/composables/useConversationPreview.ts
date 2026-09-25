import { computed, onBeforeUnmount, ref, shallowRef } from "vue";
import type { AssistantBlock, ThreadBlock } from "~/composables/agentTypes";
import type { RuntimeItem, RuntimeItemKind } from "~/types/desktop";
import { createScriptClock, streamWords } from "~/utils/scriptedTurn";

// A turn that plays itself, for the Conversation settings page.
//
// The page previews the reader's choices on the real thread renderer — the same
// ConversationThread every surface uses — so what the preview shows is exactly
// what a thread will do, not a drawing of it. That renderer only needs blocks, so
// this hands it blocks the way useAgent's reducer does: a user request, then an
// assistant turn whose items arrive, stream and settle in true order, with every
// change landing as a *new* items array (the renderer caches a turn's view by
// that array's identity, and a mutated one would never redraw).
//
// The script is a small, honest turn: a thought, a batch of reads, a line of
// narration, an edit and a test run, then the reply — enough to show every choice
// doing its thing (steps folding, words streaming, the turn folding at the end).
// It loops, holding on the settled turn long enough to read it.

type Step =
  | { kind: "text"; body: string }
  | { kind: "thinking"; body: string }
  | { kind: "tool"; name: string; target: string; detail?: string; ms: number };

const REQUEST = "Why do tool calls sometimes show up after the reply?";

const SCRIPT: Step[] = [
  { kind: "thinking", body: "The order is decided where a turn's parts are grouped, so I'll start there." },
  { kind: "text", body: "Let me trace how a turn's parts reach the screen." },
  { kind: "tool", name: "read_file", target: "useAgent.ts", ms: 700 },
  { kind: "tool", name: "grep_search", target: "renderGroups · 3 matches", ms: 650 },
  { kind: "tool", name: "read_file", target: "conversationSegments.ts", ms: 750 },
  {
    kind: "text",
    body: "Found it — parts were grouped by kind before being drawn, which loses their order. I'll keep them in arrival order.",
  },
  {
    kind: "tool",
    name: "edit_file",
    target: "conversationSegments.ts",
    detail: "@@ -61,4 +61,4 @@\n-  const byKind = groupBy(items, (i) => i.kind);\n+  const ordered = coalesceAdjacent(items);\n",
    ms: 900,
  },
  {
    kind: "tool",
    name: "bash",
    target: "bun test conversation",
    detail: " 12 pass\n 0 fail\nRan 12 tests across 1 file. [212ms]",
    ms: 1100,
  },
  {
    kind: "text",
    body: "Fixed. A turn now renders **in the order it happened**:\n\n- thinking and tool calls gather into one batch\n- text breaks the batch and starts a fresh one\n\nThe suite passes.",
  },
];

/** How long the settled turn holds before the next take. */
export const PREVIEW_HOLD_MS = 4200;

/** A script's tool call, running or settled — its output arrives as it
 *  settles, when it has one. */
function toolItem(
  step: Extract<Step, { kind: "tool" }>,
  itemId: string,
  status: "in-progress" | "completed" = "completed",
): RuntimeItem {
  const item: RuntimeItem = { itemId, kind: "tool_call", status, name: step.name, text: `${step.name}: ${step.target}` };
  if (status === "completed" && step.detail) item.detail = step.detail;
  return item;
}

export function useConversationPreview() {
  const blocks = shallowRef<ThreadBlock[]>([]);
  const now = ref(Date.now());
  const playing = ref(true);
  /** How far through the live half of the take — steps done over steps. */
  const progress = ref(0);
  /** A new number for every take, so anything timed to the take restarts. */
  const takeId = ref(0);

  /** Which half of its life the turn on stage is in. */
  const phase = computed<"live" | "done">(() => {
    const last = blocks.value[blocks.value.length - 1];
    return last?.role === "assistant" && last.state !== "running" ? "done" : "live";
  });

  const script = createScriptClock();
  let clock: ReturnType<typeof setInterval> | null = null;
  // The take in progress; bumping it cuts off any step still in flight.
  let take = 0;
  let seq = 0;
  const uid = () => `preview-${++seq}`;

  /** Wait out a step; false once the take has been replaced or paused. */
  function wait(ms: number, current: number): Promise<boolean> {
    return script.wait(ms).then(() => current === take && playing.value);
  }

  /** Swap the assistant turn for an updated copy — a fresh object and a fresh
   *  items array, as the reducer does. */
  function patchTurn(patch: (turn: AssistantBlock) => AssistantBlock): void {
    const list = blocks.value;
    const last = list[list.length - 1];
    if (!last || last.role !== "assistant") return;
    blocks.value = [...list.slice(0, -1), patch(last)];
  }

  function upsert(item: RuntimeItem): void {
    patchTurn((turn) => {
      const i = turn.items.findIndex((x) => x.itemId === item.itemId);
      const items = i === -1 ? [...turn.items, item] : turn.items.map((x, j) => (j === i ? item : x));
      return { ...turn, items };
    });
  }

  async function streamItem(kind: RuntimeItemKind, body: string, current: number): Promise<boolean> {
    const itemId = uid();
    const streamed = await streamWords(
      body,
      (text) => upsert({ itemId, kind, status: "in-progress", text }),
      (ms) => wait(ms, current),
    );
    if (!streamed) return false;
    upsert({ itemId, kind, status: "completed", text: body });
    return wait(260, current);
  }

  async function run(current: number): Promise<void> {
    const at = Date.now();
    blocks.value = [
      { id: uid(), role: "user", text: REQUEST, at },
      { id: uid(), role: "assistant", turnId: uid(), items: [], state: "running", at: at + 1 },
    ];
    progress.value = 0;
    takeId.value = current;
    if (!(await wait(700, current))) return;
    for (const [n, step] of SCRIPT.entries()) {
      progress.value = n / SCRIPT.length;
      let ok: boolean;
      if (step.kind === "text") ok = await streamItem("assistant_text", step.body, current);
      else if (step.kind === "thinking") ok = await streamItem("reasoning_text", step.body, current);
      else {
        const itemId = uid();
        upsert(toolItem(step, itemId, "in-progress"));
        if (!(await wait(step.ms, current))) return;
        upsert(toolItem(step, itemId));
        ok = await wait(180, current);
      }
      if (!ok) return;
    }
    progress.value = 1;
    patchTurn((turn) => ({ ...turn, state: "completed", endedAt: Date.now() }));
    if (!(await wait(PREVIEW_HOLD_MS, current))) return;
    void run(current);
  }

  function stopTimers(): void {
    script.stop();
  }

  function startClock(): void {
    if (!clock) clock = setInterval(() => (now.value = Date.now()), 1000);
  }

  function stopClock(): void {
    if (clock) clearInterval(clock);
    clock = null;
  }

  /** Start a fresh take from the request. */
  function replay(): void {
    stopTimers();
    take += 1;
    playing.value = true;
    startClock();
    void run(take);
  }

  /** Pausing holds the take where it stands, clock and all; playing again starts
   *  a fresh one — a turn resumed mid-sentence would read as a stutter, not a
   *  preview. */
  function toggle(): void {
    if (playing.value) {
      playing.value = false;
      stopTimers();
      stopClock();
      take += 1;
    } else replay();
  }

  /** The whole turn, already settled — the still a reader who has asked for
   *  less motion sees instead of the take. */
  function showSettled(): void {
    stopTimers();
    stopClock();
    take += 1;
    playing.value = false;
    const at = Date.now() - 14_000;
    const items = SCRIPT.map((step): RuntimeItem => {
      if (step.kind === "tool") return toolItem(step, uid());
      const kind = step.kind === "text" ? "assistant_text" : "reasoning_text";
      return { itemId: uid(), kind, status: "completed", text: step.body };
    });
    now.value = Date.now();
    progress.value = 1;
    blocks.value = [
      { id: uid(), role: "user", text: REQUEST, at },
      { id: uid(), role: "assistant", turnId: uid(), items, state: "completed", at: at + 1, endedAt: now.value },
    ];
  }

  function start(): void {
    replay();
  }

  function stop(): void {
    stopTimers();
    stopClock();
    take += 1;
  }

  onBeforeUnmount(stop);

  return { blocks, now, playing, phase, progress, takeId, start, stop, replay, toggle, showSettled };
}
