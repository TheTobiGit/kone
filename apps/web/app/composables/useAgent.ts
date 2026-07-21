import { computed, onBeforeUnmount, ref, shallowRef } from "vue";
import type {
  InteractionMode,
  ProviderKind,
  RuntimeEvent,
  RuntimeItem,
  RuntimeSessionState,
  Session,
} from "~/types/desktop";
import { peelIpcError } from "~/utils/ipcError";

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
  at: number;
};

export type ThreadBlock = UserBlock | AssistantBlock;

export type UseAgentOptions = {
  provider: ProviderKind;
  /** Absolute path of the project the agent works in. */
  cwd: string;
  model?: string;
  mode?: InteractionMode;
};

function uid(): string {
  return import.meta.client && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

export function useAgent(options: UseAgentOptions) {
  const threadId = uid();
  const blocks = ref<ThreadBlock[]>([]);
  const session = shallowRef<Session | null>(null);
  const sessionState = ref<RuntimeSessionState>("starting");
  const error = ref<string | null>(null);

  const model = ref(options.model);
  const mode = ref<InteractionMode>(options.mode ?? "default");

  // Busy while a turn is in flight — the composer disables send + shows stop.
  const busy = computed(
    () =>
      sessionState.value === "running" ||
      blocks.value.some((b) => b.role === "assistant" && b.state === "running"),
  );

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
    if (event.threadId !== threadId) return;
    switch (event.type) {
      case "session.state.changed":
        sessionState.value = event.state;
        if (event.state === "error" && event.message) error.value = event.message;
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
        if (block) block.state = "completed";
        blocks.value = [...blocks.value];
        break;
      }
      case "turn.aborted": {
        const block = currentAssistant(event.turnId);
        if (block) {
          block.state = event.reason === "interrupted" ? "interrupted" : "failed";
          block.error = event.message;
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
        threadId,
        provider: options.provider,
        cwd: options.cwd,
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
      await api.sendTurn({ threadId, input: trimmed, model: model.value, mode: mode.value });
    } catch (e) {
      error.value = peelIpcError(e, "Could not send to the agent");
    }
  }

  /** Interrupt the running turn. */
  async function interrupt(): Promise<void> {
    const api = bridge();
    if (!api) {
      stopMock();
      return;
    }
    try {
      await api.interrupt(threadId);
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

  /** Tear down: stop the session + detach the listener. */
  async function dispose(): Promise<void> {
    stopMock();
    const api = bridge();
    if (api) {
      try {
        await api.stopSession(threadId);
      } catch {
        // best-effort
      }
    }
    detach?.();
    detach = null;
  }

  onBeforeUnmount(() => {
    void dispose();
  });

  // ── browser dev mock ────────────────────────────────────────────────────────

  let mockTimer: ReturnType<typeof setInterval> | null = null;

  function stopMock(): void {
    if (mockTimer !== null) {
      clearInterval(mockTimer);
      mockTimer = null;
    }
  }

  function mockTurn(prompt: string): void {
    const turnId = uid();
    reduce({ ...base("turn.started"), type: "turn.started", turnId } as RuntimeEvent);
    const item: RuntimeItem = {
      itemId: uid(),
      kind: "assistant_text",
      status: "in-progress",
      text: "",
    };
    const words =
      `Here's how I'd approach "${prompt}". This is a mocked reply — running in the browser without the desktop bridge, so no real agent ran.`.split(
        " ",
      );
    let i = 0;
    reduce({ ...base("item.started"), type: "item.started", turnId, item: { ...item } } as RuntimeEvent);
    mockTimer = setInterval(() => {
      if (i >= words.length) {
        stopMock();
        item.status = "completed";
        reduce({
          ...base("item.completed"),
          type: "item.completed",
          turnId,
          item: { ...item },
        } as RuntimeEvent);
        reduce({ ...base("turn.completed"), type: "turn.completed", turnId } as RuntimeEvent);
        sessionState.value = "ready";
        return;
      }
      item.text += (item.text ? " " : "") + words[i++];
      sessionState.value = "running";
      reduce({
        ...base("item.updated"),
        type: "item.updated",
        turnId,
        item: { ...item },
      } as RuntimeEvent);
    }, 45);
  }

  function base(_type: string) {
    return {
      threadId,
      provider: options.provider,
      at: Date.now(),
      source: "antigravity.print.lifecycle" as const,
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
    model,
    mode,
    // actions
    start,
    send,
    interrupt,
    setModel,
    setMode,
    dispose,
  };
}
