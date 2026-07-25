import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import type {
  InteractionMode,
  ProviderKind,
  RuntimeEvent,
  RuntimeItem,
  RuntimeItemKind,
  RuntimeSessionState,
  Session,
  TokenUsage,
} from "~/types/desktop";
import { peelIpcError } from "~/utils/ipcError";
import type { EffortTier } from "~/utils/modelCatalog";

// The brain behind one agent conversation thread. It starts a provider session
// in the Electron main process, sends turns, and folds the single normalized
// `agent:event` stream into a reactive timeline the calm UI renders — so the UI
// never learns which CLI is underneath. In `nuxt dev` (no bridge) it falls back
// to a faithful mock that streams a canned reply, keeping the thread demoable in
// the browser (mirrors how useGitClone mocks the clone).
//
// One instance = one thread. Create it in the view that hosts the conversation.

export type UserBlock = { id: string; role: "user"; text: string; at: number };

export type AssistantBlock = {
  id: string;
  role: "assistant";
  turnId: string;
  items: RuntimeItem[];
  state: "running" | "completed" | "failed" | "interrupted";
  error?: string;
  /** When the turn started (turn.started). */
  at: number;
  /** When the turn settled (completed/failed/interrupted) — drives "replied in Xs". */
  endedAt?: number;
};

export type ThreadBlock = UserBlock | AssistantBlock;

/** The composer's reasoning-effort tier. Codex exposes this as a flag-based
 *  turn param (not baked into the model id), so we ride the tier along on each
 *  turn as `effort` and the adapter maps it to its own reasoning-effort param.
 *  Tiers come from the model catalog. */
export type ReasoningTier = EffortTier;

export type UseAgentOptions = {
  provider: ProviderKind;
  /** Absolute path of the project the agent works in — or a getter, resolved
   *  when the session starts so it always reflects the active project. */
  cwd: string | (() => string);
  model?: string;
  mode?: InteractionMode;
  reasoning?: ReasoningTier;
  /** A model's chosen service tier id (e.g. Codex's "fast" tier). */
  serviceTier?: string;
};

function uid(): string {
  return import.meta.client && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

export function useAgent(options: UseAgentOptions) {
  const threadId = ref(uid());
  const blocks = ref<ThreadBlock[]>([]);
  const session = shallowRef<Session | null>(null);
  const sessionState = ref<RuntimeSessionState>("starting");
  const error = ref<string | null>(null);
  const tokenUsage = ref<TokenUsage | null>(null);

  const model = ref(options.model);
  const mode = ref<InteractionMode>(options.mode ?? "accept-edits");
  const reasoning = ref<ReasoningTier>(options.reasoning ?? "medium");
  const serviceTier = ref<string | undefined>(options.serviceTier);
  // Absolute working directory for this session — read at start() time so the
  // session always boots in whatever project is active now (not a stale path
  // captured earlier). May be a getter so a switched project is picked up.
  const resolveCwd = () => (typeof options.cwd === "function" ? options.cwd() : options.cwd);

  // Busy while a turn is in flight — the composer disables send + shows stop.
  const busy = computed(
    () =>
      sessionState.value === "running" ||
      blocks.value.some((b) => b.role === "assistant" && b.state === "running"),
  );

  // A slow tick so "working · Xs" counts up live while a turn runs (and the
  // final "replied in Xs" is read from at/endedAt). Only runs while busy.
  const now = ref(Date.now());
  let clock: ReturnType<typeof setInterval> | null = null;
  watch(busy, (on) => {
    if (on && clock === null) {
      now.value = Date.now();
      clock = setInterval(() => (now.value = Date.now()), 1000);
    } else if (!on && clock !== null) {
      clearInterval(clock);
      clock = null;
    }
  });

  const bridge = () => (import.meta.client ? window.koneDesktop?.agent : undefined);

  // ── event reduction (the one place the stream becomes UI state) ─────────────

  function currentAssistant(turnId: string): AssistantBlock | undefined {
    for (let i = blocks.value.length - 1; i >= 0; i--) {
      const b = blocks.value[i];
      if (b && b.role === "assistant" && b.turnId === turnId) return b;
    }
    return undefined;
  }

  function upsertItem(block: AssistantBlock, item: RuntimeItem): void {
    const idx = block.items.findIndex((i) => i.itemId === item.itemId);
    if (idx === -1) block.items.push(item);
    else block.items[idx] = item;
    // Reassign so the shallow array ref stays reactive on nested edits.
    block.items = [...block.items];
  }

  function reduce(event: RuntimeEvent): void {
    if (event.threadId !== threadId.value) return;
    switch (event.type) {
      case "session.state.changed":
        sessionState.value = event.state;
        if (event.state === "error" && event.message) error.value = event.message;
        break;
      case "session.exited": {
        sessionState.value = "stopped";
        if (event.code && error.value === null) {
          error.value = "Agent process exited unexpectedly";
        }
        blocks.value = blocks.value.map((b) =>
          b.role === "assistant" && b.state === "running"
            ? { ...b, state: "failed", endedAt: event.at }
            : b,
        );
        break;
      }
      case "thread.token-usage.updated":
        tokenUsage.value = event.usage;
        break;
      case "turn.started":
        blocks.value = [
          ...blocks.value,
          {
            id: event.turnId,
            role: "assistant",
            turnId: event.turnId,
            items: [],
            state: "running",
            at: event.at,
          },
        ];
        break;
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const block = currentAssistant(event.turnId);
        if (block) {
          upsertItem(block, event.item);
          blocks.value = [...blocks.value];
        }
        break;
      }
      case "turn.completed": {
        const block = currentAssistant(event.turnId);
        if (block) {
          block.state = "completed";
          block.endedAt = event.at;
        }
        blocks.value = [...blocks.value];
        break;
      }
      case "turn.aborted": {
        const block = currentAssistant(event.turnId);
        if (block) {
          block.state = event.reason === "interrupted" ? "interrupted" : "failed";
          block.error = event.message;
          block.endedAt = event.at;
        }
        blocks.value = [...blocks.value];
        break;
      }
      default:
        break;
    }
  }

  let detach: (() => void) | null = null;

  // ── actions ───────────────────────────────────────────────────────────────

  /** Start the session. Attaches the event listener (desktop) and marks ready. */
  async function start(): Promise<void> {
    const api = bridge();
    error.value = null;
    if (!api) {
      // Browser dev: no real session — pretend it's ready so the composer works.
      sessionState.value = "ready";
      return;
    }
    detach = api.onEvent(reduce);
    try {
      session.value = await api.startSession({
        threadId: threadId.value,
        provider: options.provider,
        cwd: resolveCwd(),
        model: model.value,
        mode: mode.value,
      });
      sessionState.value = session.value.status;
    } catch (e) {
      error.value = peelIpcError(e, "Could not start the agent");
      sessionState.value = "error";
    }
  }

  /** Send a user turn. Pushes the user block immediately; the reply streams in. */
  async function send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || busy.value) return;
    blocks.value = [
      ...blocks.value,
      { id: uid(), role: "user", text: trimmed, at: Date.now() },
    ];

    const api = bridge();
    if (!api) {
      mockTurn(trimmed);
      return;
    }
    try {
      await api.sendTurn({
        threadId: threadId.value,
        input: trimmed,
        model: model.value,
        mode: mode.value,
        effort: reasoning.value,
        serviceTier: serviceTier.value,
      });
    } catch (e) {
      error.value = peelIpcError(e, "Could not send to the agent");
    }
  }

  /** Interrupt the running turn. */
  async function interrupt(): Promise<void> {
    const api = bridge();
    if (!api) {
      // Browser dev: mark the running mock turn as stopped, then halt its timers.
      const tid = mockTurnId;
      stopMock();
      if (tid)
        reduce({
          ...base("turn.aborted"),
          type: "turn.aborted",
          turnId: tid,
          reason: "interrupted",
        } as RuntimeEvent);
      sessionState.value = "ready";
      return;
    }
    try {
      await api.interrupt(threadId.value);
    } catch {
      // The turn.aborted event (or its absence) is the source of truth.
    }
  }

  function setModel(id: string | undefined): void {
    model.value = id;
  }
  function setMode(next: InteractionMode): void {
    mode.value = next;
  }
  function setReasoning(next: ReasoningTier): void {
    reasoning.value = next;
  }
  function setServiceTier(id: string | undefined): void {
    serviceTier.value = id;
  }

  /** Tear down: stop the session + detach the listener. */
  async function dispose(): Promise<void> {
    stopMock();
    const api = bridge();
    if (api) {
      try {
        await api.stopSession(threadId.value);
      } catch {
        // best-effort
      }
    }
    detach?.();
    detach = null;
  }

  onBeforeUnmount(() => {
    if (clock !== null) clearInterval(clock);
    void dispose();
  });

  // ── browser dev mock ────────────────────────────────────────────────────────

  // Pending timers for the in-flight mock turn, plus a cancel latch the async
  // script checks between steps — stopMock clears both so an interrupt or unmount
  // halts the reply cleanly.
  let mockTimers: Array<ReturnType<typeof setTimeout>> = [];
  let mockCancel: (() => void) | null = null;
  let mockTurnId: string | null = null;

  function stopMock(): void {
    for (const t of mockTimers) clearTimeout(t);
    mockTimers = [];
    mockCancel?.();
    mockCancel = null;
    mockTurnId = null;
  }

  // Browser dev only. Streams a canned turn that exercises the WHOLE interleaved
  // timeline the real providers produce — a short thought, a tool call mid-think,
  // a line of narration, another tool call AFTER that text, an optional second
  // thought, then the final answer. Items arrive in true chronological order
  // (the same order CodexAdapter's item/started · item/completed notifications
  // feed the desktop side), so the thread can render every ordering case —
  // tools-at-start, tool-after-text, thinking, final text — without the bridge.
  function mockTurn(prompt: string): void {
    const turnId = uid();
    mockTurnId = turnId;
    let cancelled = false;
    mockCancel = () => (cancelled = true);
    sessionState.value = "running";
    // The turn starts immediately (the orb wakes) but produces nothing yet — the
    // thread shows the working orb while we simulate the model connecting.
    reduce({ ...base("turn.started"), type: "turn.started", turnId } as RuntimeEvent);

    const emit = (item: RuntimeItem, type: "item.started" | "item.updated" | "item.completed") =>
      reduce({ ...base(type), type, turnId, item: { ...item } } as RuntimeEvent);
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          mockTimers = mockTimers.filter((x) => x !== t);
          resolve();
        }, ms);
        mockTimers.push(t);
      });
    // Stream a text-bearing item (a thought or the answer) word-by-word.
    const stream = async (kind: RuntimeItemKind, full: string, perWord = 42): Promise<void> => {
      const item: RuntimeItem = { itemId: uid(), kind, status: "in-progress", text: "" };
      emit(item, "item.started");
      for (const w of full.split(" ")) {
        if (cancelled) return;
        item.text += (item.text ? " " : "") + w;
        emit(item, "item.updated");
        await wait(perWord);
      }
      item.status = "completed";
      emit(item, "item.completed");
    };
    // A tool call: lands in-progress (its live slot pulses), then completes.
    // `output`, when given, is the expandable full result body (fake stdout/
    // diff) — exercises the same detail-expand path a real tool call uses.
    const tool = async (name: string, summary: string, output?: string, ms = 640): Promise<void> => {
      const item: RuntimeItem = {
        itemId: uid(),
        kind: "tool_call",
        status: "in-progress",
        name,
        text: `${name}: ${summary}`,
      };
      emit(item, "item.started");
      await wait(ms);
      if (cancelled) return;
      item.status = "completed";
      if (output) item.detail = output;
      emit(item, "item.completed");
    };

    const thinky = reasoning.value === "high" || reasoning.value === "thinking";

    void (async () => {
      await wait(1400); // connecting beat → working orb
      if (cancelled) return;
      if (thinky) {
        await stream(
          "reasoning_text",
          "Let me trace how the composer talks to the session before I touch anything — reading the wiring first, then the reducer.",
        );
        if (cancelled) return;
      }
      // Tool calls at the start of the turn (before any answer text).
      await tool("read_file", "AgentComposer.vue");
      if (cancelled) return;
      await tool(
        "grep_search",
        "useAgent · 6 matches",
        "AgentComposer.vue:42:  emit(\"send\", trimmed);\nAgentComposer.vue:58:  emit(\"interrupt\");\nuseAgent.ts:205:  async function send(text: string)\nuseAgent.ts:233:  async function interrupt()\nuseAgent.ts:256:  function setModel(id)\nuseAgent.ts:262:  function setReasoning(next)",
      );
      if (cancelled) return;
      // A line of narration…
      await stream(
        "assistant_text",
        "Here's the shape of it: the composer emits a turn, and `useAgent` folds the provider's event stream into this timeline in arrival order.",
      );
      if (cancelled) return;
      // …then a tool call AFTER that text (the interleaving case).
      await tool("edit_file", "ConversationThread.vue");
      if (cancelled) return;
      if (thinky) {
        await stream("reasoning_text", "That covers the ordering; now I'll state the result plainly.");
        if (cancelled) return;
      }
      // The final answer.
      await stream(
        "assistant_text",
        `Done — for "${prompt}", the parts now render in the true order they arrived: thinking, tool calls, and text interleaved, exactly like a real ${options.provider} session. This is a mocked reply (no agent ran in the browser), but every event flowed through the same stream.`,
      );
      if (cancelled) return;
      reduce({ ...base("turn.completed"), type: "turn.completed", turnId } as RuntimeEvent);
      sessionState.value = "ready";
      stopMock();
    })();
  }

  function base(_type: string) {
    return {
      threadId: threadId.value,
      provider: options.provider,
      at: Date.now(),
      source: "codex.rpc.lifecycle" as const,
    };
  }

  return {
    // identity
    threadId,
    provider: options.provider,
    // state
    blocks,
    session,
    sessionState,
    busy,
    error,
    tokenUsage,
    model,
    mode,
    reasoning,
    serviceTier,
    now,
    // actions
    start,
    send,
    interrupt,
    setModel,
    setMode,
    setReasoning,
    setServiceTier,
    dispose,
  };
}
