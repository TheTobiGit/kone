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
  /** On the first start, reload the project's last persisted thread into the
   *  timeline (desktop only) so a conversation survives reload / quit / project
   *  switch. Defaults to true; a restart() never rehydrates. */
  rehydrate?: boolean;
};

function uid(): string {
  return import.meta.client && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

/** First-turn word-cap fallback — mirrors desktop `buildPromptThreadTitleFallback`
 *  so browser-dev / the instant before the agent rename lands still has a label. */
function titleFromPrompt(message: string): string {
  const words = message
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean)
    .slice(0, 6);
  if (words.length === 0) return "New thread";
  const joined = words.join(" ");
  return joined.length > 60 ? `${joined.slice(0, 60)}...` : joined;
}

export function useAgent(options: UseAgentOptions) {
  const threadId = ref(uid());
  const blocks = ref<ThreadBlock[]>([]);
  /** Agent-named (or first-turn word-fallback) working title. Empty until the
   *  first user turn or a rehydrated/opened thread that already has one. */
  const title = ref("");
  const session = shallowRef<Session | null>(null);
  const sessionState = ref<RuntimeSessionState>("starting");
  const error = ref<string | null>(null);
  const tokenUsage = ref<TokenUsage | null>(null);

  // The provider is mutable so a thread can switch engines (Codex ↔ Claude).
  // Because the two are separate CLIs with no shared conversation, a switch is a
  // fresh session — restart() below tears the old one down and starts anew.
  const provider = ref<ProviderKind>(options.provider);
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
      case "thread.title.updated":
        title.value = event.title;
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
  // Rehydration runs once, on the first start — a restart() (provider/model
  // switch) keeps the on-screen history but must not reload a stale thread over
  // the new session.
  let rehydratedOnce = false;

  /** Reload the project's last persisted thread into the timeline, adopting its
   *  id so continued turns append to the same stored thread. Best-effort: any
   *  failure just leaves a fresh, empty thread. Desktop only. */
  async function rehydrate(api: NonNullable<ReturnType<typeof bridge>>): Promise<void> {
    if (rehydratedOnce || options.rehydrate === false) return;
    rehydratedOnce = true;
    try {
      const stored = await api.history.latest(resolveCwd());
      if (stored && stored.blocks.length > 0) {
        threadId.value = stored.threadId;
        blocks.value = stored.blocks as ThreadBlock[];
        title.value = stored.title?.trim() || title.value;
      }
    } catch {
      // History is a convenience — never block starting a session over it.
    }
  }

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
    // Adopt the last thread (id + transcript) before wiring events, so the
    // reducer's threadId filter matches turns continued on it.
    await rehydrate(api);
    detach = api.onEvent(reduce);
    try {
      session.value = await api.startSession({
        threadId: threadId.value,
        provider: provider.value,
        cwd: resolveCwd(),
        model: model.value,
        mode: mode.value,
        // Providers that fix effort when the session process spawns (Claude)
        // read it here; flag-based ones (Codex) ignore it and take effort per
        // turn instead. Safe to always send — the adapter picks what it needs.
        effort: reasoning.value,
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
    // Instant label for a brand-new thread; desktop may refine it via
    // thread.title.updated once the agent rename lands.
    if (!title.value) title.value = titleFromPrompt(trimmed);

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

  function setProvider(next: ProviderKind): void {
    provider.value = next;
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

  /** Tear the live session down and start a fresh one under a new thread id.
   *  Used when a change can't be applied to a running session — switching
   *  provider (a different CLI entirely), or changing a Claude model, whose
   *  effort/model are baked when the SDK subprocess spawns (the adapter reports
   *  `sessionModelSwitch: "restart-session"`). The prior turns stay on screen as
   *  history; new turns stream in under the new session. */
  async function restart(): Promise<void> {
    await dispose();
    threadId.value = uid();
    tokenUsage.value = null;
    error.value = null;
    sessionState.value = "starting";
    await start();
  }

  /** Begin a brand-new, empty thread: tear the live session down, mint a fresh
   *  thread id, clear the on-screen transcript, and start a new session bound to
   *  it. Unlike restart() (which keeps prior turns on screen for a provider/model
   *  switch), this wipes the timeline — it's the "start a new conversation" path.
   *  Rehydration is suppressed so start() can't reload the project's latest thread
   *  over the fresh, empty one. */
  async function newThread(): Promise<void> {
    await dispose();
    // start() would otherwise reload the project's latest thread into the empty
    // timeline — this is deliberately a clean slate.
    rehydratedOnce = true;
    threadId.value = uid();
    blocks.value = [];
    title.value = "";
    tokenUsage.value = null;
    error.value = null;
    sessionState.value = "starting";
    await start();
  }

  /** Bring a specific stored thread on-screen and continue it: tear down the
   *  live session, adopt the thread's id + transcript, and start a fresh session
   *  bound to that id so new turns append to it. Mirrors rehydrate() but for a
   *  chosen thread rather than the project's latest. Best-effort; desktop only. */
  async function openThread(id: string): Promise<void> {
    const api = bridge();
    if (!api) return;
    let stored;
    try {
      stored = await api.history.thread(id);
    } catch {
      return;
    }
    if (!stored) return;
    await dispose();
    // start() would otherwise reload the project's *latest* thread over this one.
    rehydratedOnce = true;
    threadId.value = stored.threadId;
    blocks.value = stored.blocks as ThreadBlock[];
    title.value = stored.title?.trim() || "";
    tokenUsage.value = null;
    error.value = null;
    sessionState.value = "starting";
    await start();
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
  function mockTurn(prompt: string, opts: { demo?: boolean } = {}): void {
    const turnId = uid();
    mockTurnId = turnId;
    let cancelled = false;
    mockCancel = () => (cancelled = true);
    sessionState.value = "running";
    // The turn starts immediately but produces nothing yet — we simulate the
    // model connecting before the first item arrives.
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
    // A tool call that comes back failed — the red "failed" state + its error
    // output, so that path is on screen too instead of only the happy one.
    const toolFail = async (name: string, summary: string, error: string, ms = 640): Promise<void> => {
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
      item.status = "failed";
      item.detail = error;
      emit(item, "item.completed");
    };

    // A thinking segment with no surfaced text — the "model didn't share its
    // reasoning" case (a bare "Thought for Xs" label, no disclosure).
    const emptyThought = async (ms = 900): Promise<void> => {
      const item: RuntimeItem = { itemId: uid(), kind: "reasoning_text", status: "in-progress", text: "" };
      emit(item, "item.started");
      await wait(ms);
      if (cancelled) return;
      item.status = "completed";
      emit(item, "item.completed");
    };

    // The demo forces the full spread regardless of the picked reasoning tier;
    // a normal turn only shows thinking when the model is actually reasoning.
    const thinky = opts.demo || reasoning.value === "high" || reasoning.value === "thinking";

    void (async () => {
      await wait(1400); // connecting beat
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
      // The demo tours every tool family the real providers can produce — list,
      // code-intel, run, web, sub-agent, delete — plus a failed call, so every
      // visual state is on screen to review, not just the read/write/search trio.
      if (opts.demo) {
        await tool("list_dir", "apps/web/app/components", undefined, 420);
        if (cancelled) return;
        await tool("go_to_definition", "segKindOf → useAgent.ts:167", undefined, 380);
        if (cancelled) return;
      }
      // A line of narration…
      await stream(
        "assistant_text",
        "Here's the shape of it: the composer emits a turn, and `useAgent` folds the provider's event stream into this timeline in arrival order.",
      );
      if (cancelled) return;
      // …then a tool call AFTER that text (the interleaving case). The demo gives
      // it an expandable diff body so the tool-output case is on screen too.
      await tool(
        "edit_file",
        "ConversationThread.vue",
        opts.demo
          ? "@@ -472,3 +472,4 @@\n-    <p class=\"body body--stream\">{{ segText(seg) }}</p>\n+    <MarkdownMessage class=\"answer\" :source=\"segText(seg)\" />\n"
          : undefined,
      );
      if (cancelled) return;
      if (opts.demo) {
        await tool(
          "write_to_file",
          "MarkdownMessage.vue",
          "+ // Each word gets its own stable key so it mounts as a genuinely new\n+ // element the instant it streams in.\n+ function renderWords(content: string, key: number): VNode { … }\n",
          520,
        );
        if (cancelled) return;
        // A second thought, mid-turn — the demo's first thinking segment is
        // interrupted by tool calls, so this shows a fresh one re-opening the
        // rail further down the same steps group.
        await stream(
          "reasoning_text",
          "Before wiring it up, let me make sure the existing suite still passes and the lint config agrees.",
        );
        if (cancelled) return;
        await tool(
          "bash",
          "bun test useAgent",
          " 12 pass\n 0 fail\n 27 expect() calls\nRan 12 tests across 1 file. [412ms]",
          900,
        );
        if (cancelled) return;
        await toolFail(
          "bash",
          "bun run lint",
          "apps/web/app/components/ConversationThread.vue\n  482:11  error  'toolsLive' is defined but never used  no-unused-vars\n\n✖ 1 problem (1 error, 0 warnings)",
          700,
        );
        if (cancelled) return;
        await tool("web_search", "markdown-it incremental token streaming", undefined, 640);
        if (cancelled) return;
        await tool(
          "web_fetch",
          "vercel.com/blog/ai-sdk · smoothStream",
          "Fetched 1 page · 2.1 KB extracted",
          760,
        );
        if (cancelled) return;
        await tool(
          "task",
          "Audit the step-list rail for regressions",
          "Sub-agent checked the connecting line across 4 group shapes (thinking-only, tools-only, mixed, text-broken) — no gaps found.",
          1400,
        );
        if (cancelled) return;
        await tool("rm", "tmp/scratch.log", undefined, 340);
        if (cancelled) return;
        // A tool name the table doesn't recognise — exercises the fallback
        // (neutral hue, auto Title-Cased label) rather than a mapped family.
        await tool("capture_screenshot", "conversation-thread--states.png", undefined, 420);
        if (cancelled) return;
      }
      // The demo shows the no-content thinking case; a normal thinky turn shows a
      // second thought that DOES carry text.
      if (opts.demo) {
        await emptyThought();
        if (cancelled) return;
      } else if (thinky) {
        await stream("reasoning_text", "That covers the ordering; now I'll state the result plainly.");
        if (cancelled) return;
      }
      // The final answer. The demo's closing reply also tours MarkdownMessage's
      // whole rendering surface — heading, list, table, fenced code, a callout,
      // and a local file chip — so typography states are reviewable too.
      await stream(
        "assistant_text",
        opts.demo
          ? `Done — for "${prompt}", here's the full tour.\n\n### What ran\n\n- Every part above — thinking, tool calls, narration — renders in the true order it arrived\n- Tool calls span every family: read, write, list, code intel, shell, web, sub-agent, and delete\n- One \`bash\` call above **failed on purpose** — the red state is real, not a screenshot\n\n| Family | Tool | Hue |\n| --- | --- | --- |\n| Read | \`read_file\` | blue |\n| Write | \`edit_file\` | violet |\n| Search | \`grep_search\` | amber |\n| Run | \`bash\` | green |\n\n\`\`\`ts\nfunction segKindOf(item: RuntimeItem): SegKind {\n  if (item.kind === "reasoning_text") return "thinking";\n  if (item.kind === "tool_call") return "tools";\n  return "text";\n}\n\`\`\`\n\n> [!NOTE]\n> This whole reply is a mocked stream — no agent ran in the browser — but every event passed through the same [ConversationThread.vue](file:///apps/web/app/components/ConversationThread.vue) timeline the real providers feed.`
          : `Done — for "${prompt}", the parts now render in the true order they arrived: thinking, tool calls, and text interleaved, exactly like a real ${provider.value} session. This is a mocked reply (no agent ran in the browser), but every event flowed through the same stream.`,
      );
      if (cancelled) return;
      reduce({ ...base("turn.completed"), type: "turn.completed", turnId } as RuntimeEvent);
      sessionState.value = "ready";
      stopMock();
    })();
  }

  /** Play a scripted demo conversation — a user turn plus a full assistant reply
   *  (thinking with text, tool calls with output, narration, a no-content thought,
   *  and the final answer). Runs the in-browser mock directly so it works even in
   *  the desktop shell, for reviewing the conversation UI without a live agent. */
  function demo(): void {
    if (busy.value) return;
    const prompt = "Show me a full conversation";
    blocks.value = [...blocks.value, { id: uid(), role: "user", text: prompt, at: Date.now() }];
    if (!title.value) title.value = titleFromPrompt(prompt);
    mockTurn(prompt, { demo: true });
  }

  function base(_type: string) {
    return {
      threadId: threadId.value,
      provider: provider.value,
      at: Date.now(),
      source: "codex.rpc.lifecycle" as const,
    };
  }

  return {
    // identity
    threadId,
    provider,
    title,
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
    restart,
    newThread,
    openThread,
    send,
    demo,
    interrupt,
    setProvider,
    setModel,
    setMode,
    setReasoning,
    setServiceTier,
    dispose,
  };
}
