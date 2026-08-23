import type { ComputedRef, Ref } from "vue";
import type {
  ProviderKind,
  RuntimeEvent,
  RuntimeItem,
  RuntimeItemKind,
  RuntimeSessionState,
  SubagentRunSnapshot,
  TokenUsage,
} from "~/types/desktop";
import { formatPlanTasks, type PlanTask } from "~/utils/planTasks";
import type { QueuedTurnEntry, ReasoningTier, ThreadBlock } from "./useAgentTypes.js";
import { titleFromPrompt, uid } from "./useAgentPrefetch.js";

export function createMockTurnRunner(deps: {
  threadId: Ref<string>;
  provider: Ref<ProviderKind>;
  sessionState: Ref<RuntimeSessionState>;
  reasoning: Ref<ReasoningTier>;
  blocks: Ref<ThreadBlock[]>;
  title: Ref<string>;
  tokenUsage: Ref<TokenUsage | null>;
  queuedTurnsRaw: Ref<QueuedTurnEntry[]>;
  reduce: (event: RuntimeEvent) => void;
  busy: ComputedRef<boolean>;
}) {
  const {
    threadId,
    provider,
    sessionState,
    reasoning,
    blocks,
    title,
    tokenUsage,
    queuedTurnsRaw,
    reduce,
    busy,
  } = deps;

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

  function base() {
    return {
      threadId: threadId.value,
      provider: provider.value,
      at: Date.now(),
      source: "kone.mock" as const,
    };
  }

  /** Browser dev only: a send/steer while the mock turn runs parks a chip
   *  exactly like the real durable queue (the mock can't run two concurrent
   *  turns). The chip anchors by the local block id — the mock hands the
   *  renderer's own id back as userBlockId, which the real store can't. */
  function mockQueueFollowUp(blockId: string, dispatchMode: "queue" | "steer"): void {
    reduce({
      ...base(),
      type: "turn.queued",
      queueId: uid(),
      userBlockId: blockId,
      dispatchMode,
      position: queuedTurnsRaw.value.length + 2,
    });
    sessionState.value = "running";
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
    reduce({ ...base(), type: "turn.started", turnId });

    const emit = (item: RuntimeItem, type: "item.started" | "item.updated" | "item.completed") =>
      reduce({ ...base(), type, turnId, item: { ...item } });
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
    // A nested subagent spawn — the whole shape the real ClaudeAdapter produces:
    // the parent's Task tool_call opens, `subagent.started` nests a run on it, the
    // child's transcript streams in as items tagged with the run's toolUseId (the
    // corner Subagents dock reads these), the run settles with a summary, then the
    // parent tool call completes carrying that summary. Exercises the dock's
    // starting → running → completed lifecycle end to end.
    const spawnSubagent = async (opts: {
      agentType: string;
      description: string;
      model?: string;
      effort?: string;
      /** Hold before the run opens — staggers concurrent spawns in the dock. */
      leadMs?: number;
      steps: Array<{ kind: RuntimeItemKind; name?: string; text: string; ms: number }>;
      summary: string;
    }): Promise<void> => {
      if (opts.leadMs) await wait(opts.leadMs);
      if (cancelled) return;
      const toolUseId = uid();
      const parentItemId = uid();
      const startedAt = Date.now();
      // 1 — the parent Task tool call opens (the spawn point).
      const parent: RuntimeItem = {
        itemId: parentItemId,
        kind: "tool_call",
        status: "in-progress",
        name: "task",
        text: `task: ${opts.description}`,
      };
      emit(parent, "item.started");
      const snapshot: SubagentRunSnapshot = {
        toolUseId,
        parentItemId,
        agentType: opts.agentType,
        description: opts.description,
        status: "starting",
        startedAt,
        toolUses: 0,
      };
      if (opts.model) snapshot.model = opts.model;
      if (opts.effort) snapshot.effort = opts.effort;
      const emitRun = (type: "subagent.started" | "subagent.updated" | "subagent.completed") =>
        reduce({ ...base(), type, turnId, subagent: { ...snapshot } });
      // 2 — the run is recognized and nested onto its parent tool call.
      emitRun("subagent.started");
      await wait(320);
      if (cancelled) return;
      snapshot.status = "running";
      emitRun("subagent.updated");
      // 3 — the child's transcript streams in, tagged with the run's id so it
      //     lands inside the run, not the parent turn's body.
      let toolUses = 0;
      for (const step of opts.steps) {
        if (cancelled) return;
        const child: RuntimeItem = {
          itemId: uid(),
          kind: step.kind,
          status: "in-progress",
          text: step.kind === "tool_call" && step.name ? `${step.name}: ${step.text}` : step.text,
        };
        if (step.name) child.name = step.name;
        reduce({ ...base(), type: "item.started", turnId, item: { ...child }, subagentToolUseId: toolUseId });
        if (step.kind === "tool_call") {
          toolUses += 1;
          snapshot.toolUses = toolUses;
          snapshot.lastToolName = step.name;
          emitRun("subagent.updated");
        }
        await wait(step.ms);
        if (cancelled) return;
        child.status = "completed";
        reduce({ ...base(), type: "item.completed", turnId, item: { ...child }, subagentToolUseId: toolUseId });
      }
      if (cancelled) return;
      // 4 — the run settles with its report…
      snapshot.status = "completed";
      snapshot.summary = opts.summary;
      snapshot.endedAt = Date.now();
      delete snapshot.lastToolName;
      emitRun("subagent.completed");
      // 5 — …and the parent tool call completes, carrying that report.
      parent.status = "completed";
      parent.detail = opts.summary;
      emit(parent, "item.completed");
    };

    // A TodoWrite-style plan — one item that can be updated in place as tasks
    // move pending → in-progress → completed, then settles at the end.
    let planItem: RuntimeItem | null = null;
    const setPlan = async (tasks: readonly PlanTask[], hold = 0): Promise<void> => {
      if (hold) await wait(hold);
      if (cancelled) return;
      const text = formatPlanTasks(tasks);
      const structured = tasks.map((t) => ({ ...t }));
      if (!planItem) {
        planItem = {
          itemId: uid(),
          kind: "plan_text",
          status: "in-progress",
          text,
          tasks: structured,
        };
        emit(planItem, "item.started");
      } else {
        planItem.text = text;
        planItem.tasks = structured;
        emit(planItem, "item.updated");
      }
    };
    const finishPlan = async (): Promise<void> => {
      if (!planItem || cancelled) return;
      planItem.status = "completed";
      emit(planItem, "item.completed");
    };

    const demoPlan: PlanTask[] = [
      { id: uid(), content: "Tour every tool family in the thread", status: "pending" },
      { id: uid(), content: "Show task plans updating mid-turn", status: "pending" },
      { id: uid(), content: "Stream the final markdown answer", status: "pending" },
      {
        id: uid(),
        content: "Verify failed-tool and empty-thought states",
        status: "pending",
      },
    ];
    const demoPlanAt = (updates: Partial<Record<number, PlanTask["status"]>>): PlanTask[] =>
      demoPlan.map((task, i) => ({
        ...task,
        status: updates[i] ?? task.status,
      }));

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
      if (opts.demo) {
        await setPlan(demoPlan, 360);
        if (cancelled) return;
      }
      // Tool calls at the start of the turn (before any answer text).
      await tool("read_file", "AgentComposer.vue");
      if (cancelled) return;
      if (opts.demo) {
        await setPlan(demoPlanAt({ 0: "in-progress" }), 420);
        if (cancelled) return;
      }
      await tool(
        "grep_search",
        "useAgent · 6 matches",
        "AgentComposer.vue:42:  emit(\"send\", trimmed);\nAgentComposer.vue:58:  emit(\"interrupt\");\nuseAgent.ts:205:  async function send(text: string)\nuseAgent.ts:233:  async function interrupt()\nuseAgent.ts:256:  function setModel(id)\nuseAgent.ts:262:  function setReasoning(next)",
      );
      if (cancelled) return;
      // A longer, unhurried middle for the normal (non-demo) mock — enough steps,
      // with generous pauses between them, that you can step back out to the
      // working tree and watch the away-from-thread status pill work through its
      // states (Reading → Thinking → Editing → Working) before the reply lands.
      if (!opts.demo) {
        await tool("read_file", "app/components/example.vue", undefined, 1500);
        if (cancelled) return;
        await tool("list_dir", "app/components", undefined, 1100);
        if (cancelled) return;
        await stream(
          "reasoning_text",
          "I can see how the pieces connect now — the composer hands each turn to the session and the reducer folds the events back into this timeline. Let me line up the edits before I touch anything.",
        );
        if (cancelled) return;
        await tool("grep_search", "describeTurnActivity · 3 matches", undefined, 1200);
        if (cancelled) return;
        await tool("edit_file", "app/components/example.vue", undefined, 1600);
        if (cancelled) return;
        await tool("write_to_file", "docs/example.md", undefined, 1400);
        if (cancelled) return;
        await tool(
          "bash",
          "bun run check-types",
          " ✓ no type errors\nDone in 3.1s",
          1800,
        );
        if (cancelled) return;
      }
      // The demo tours every tool family the real providers can produce — list,
      // code-intel, run, web, sub-agent, delete — plus a failed call, so every
      // visual state is on screen to review, not just the read/write/search trio.
      if (opts.demo) {
        await setPlan(demoPlanAt({ 0: "completed", 1: "in-progress" }), 380);
        if (cancelled) return;
        await tool("list_dir", "apps/web/app/components", undefined, 420);
        if (cancelled) return;
        await tool("go_to_definition", "segKindOf → useAgent.ts:167", undefined, 380);
        if (cancelled) return;
        await setPlan(demoPlanAt({ 0: "completed", 1: "completed", 2: "in-progress" }), 360);
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
        await setPlan(
          demoPlanAt({ 0: "completed", 1: "completed", 2: "completed", 3: "in-progress" }),
          360,
        );
        if (cancelled) return;
      }
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
        // Several real nested subagents, launched together — the corner
        // Subagents dock fills with concurrent runs (each streaming its own
        // transcript) that settle one by one as the parent waits on the batch.
        await Promise.all([
          spawnSubagent({
            agentType: "explore",
            description: "Map the conversation-thread render path",
            model: "claude-haiku-4-5",
            effort: "low",
            leadMs: 0,
            steps: [
              {
                kind: "reasoning_text",
                text: "I'll trace how a turn's parts reach the screen — from the reducer's ordered items through AgentActivity into the thread.",
                ms: 1100,
              },
              { kind: "tool_call", name: "grep_search", text: "segKindOf · 4 matches", ms: 900 },
              { kind: "tool_call", name: "read_file", text: "ConversationThread.vue", ms: 1300 },
              { kind: "tool_call", name: "read_file", text: "AgentActivity.vue", ms: 1200 },
              { kind: "tool_call", name: "list_dir", text: "apps/web/app/components", ms: 800 },
              {
                kind: "assistant_text",
                text: "The reducer folds events into ordered parts; AgentActivity groups thinking + tools, and the thread paints them in arrival order.",
                ms: 900,
              },
            ],
            summary:
              "Mapped the render path: reducer → ordered RuntimeItems → AgentActivity (groups thinking + tools) → ConversationThread paints in arrival order. No indirection between the stream and the timeline.",
          }),
          spawnSubagent({
            agentType: "review",
            description: "Audit the step-list rail for regressions",
            model: "claude-sonnet-5",
            effort: "high",
            leadMs: 700,
            steps: [
              {
                kind: "reasoning_text",
                text: "I'll walk the connecting line across every group shape — thinking-only, tools-only, mixed, and text-broken — and look for gaps.",
                ms: 1300,
              },
              { kind: "tool_call", name: "read_file", text: "AgentActivity.vue", ms: 1100 },
              { kind: "tool_call", name: "grep_search", text: "seg-rail · 5 matches", ms: 900 },
              { kind: "tool_call", name: "read_file", text: "ActivityStep.vue", ms: 1200 },
              { kind: "tool_call", name: "bash", text: "bun test conversation-thread", ms: 1600 },
              {
                kind: "assistant_text",
                text: "Rail holds across all four shapes — the connector never breaks between a thought and the tool that follows it.",
                ms: 800,
              },
            ],
            summary:
              "Reviewed the step-list rail across 4 group shapes (thinking-only, tools-only, mixed, text-broken) — connecting line is continuous, no gaps found. Suite green.",
          }),
          spawnSubagent({
            agentType: "build",
            description: "Draft the nested-transcript inline view",
            model: "claude-sonnet-5",
            effort: "medium",
            leadMs: 1500,
            steps: [
              {
                kind: "reasoning_text",
                text: "I'll sketch a collapsible transcript that hangs under the spawning tool call, reusing the same ordered-parts renderer.",
                ms: 1200,
              },
              { kind: "tool_call", name: "read_file", text: "AgentSubagentDock.vue", ms: 1100 },
              { kind: "tool_call", name: "write_to_file", text: "SubagentTranscript.vue", ms: 1500 },
              { kind: "tool_call", name: "edit_file", text: "ConversationThread.vue", ms: 1400 },
              { kind: "tool_call", name: "bash", text: "bun run check-types", ms: 1800 },
              {
                kind: "assistant_text",
                text: "Drafted SubagentTranscript.vue and wired it under the parent tool call — types pass.",
                ms: 900,
              },
            ],
            summary:
              "Drafted SubagentTranscript.vue — a collapsible child transcript nested under the spawning tool call, reusing the ordered-parts renderer. Types pass; left unwired behind the dock for review.",
          }),
        ]);
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
        await setPlan(
          demoPlan.map((task) => ({ ...task, status: "completed" as const })),
          360,
        );
        if (cancelled) return;
        await finishPlan();
        if (cancelled) return;
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
          ? `Done — for "${prompt}", here's the full tour.\n\n### What ran\n\n- Every part above — thinking, tool calls, narration — renders in the true order it arrived\n- The agent's task plan docks bottom-right (folder-picker shell) while it works the list\n- Tool calls span every family: read, write, list, code intel, shell, web, sub-agent, and delete\n- One \`bash\` call above **failed on purpose** — the red state is real, not a screenshot\n\n| Family | Tool | Hue |\n| --- | --- | --- |\n| Read | \`read_file\` | blue |\n| Write | \`edit_file\` | violet |\n| Search | \`grep_search\` | amber |\n| Run | \`bash\` | green |\n\n\`\`\`ts\nfunction segKindOf(item: RuntimeItem): SegKind {\n  if (item.kind === "reasoning_text") return "thinking";\n  if (item.kind === "tool_call") return "tools";\n  if (item.kind === "plan_text") return "plan";\n  return "text";\n}\n\`\`\`\n\n> [!NOTE]\n> This whole reply is a mocked stream — no agent ran in the browser — but every event passed through the same [ConversationThread.vue](file:///apps/web/app/components/ConversationThread.vue) timeline the real providers feed. Press **⇧⌘D** any time to replay it.`
          : `Done — for "${prompt}", the parts now render in the true order they arrived: thinking, tool calls, and text interleaved, exactly like a real ${provider.value} session. This is a mocked reply (no agent ran in the browser), but every event flowed through the same stream.`,
      );
      if (cancelled) return;
      // Feed the context meter so its come-in and fill are reviewable in browser
      // dev (no bridge) — it grows with each turn toward the window, crossing the
      // warm/full colour steps after enough turns. No-op cost in the desktop mock.
      const priorTurns = blocks.value.filter((b) => b.role === "user").length;
      const contextWindow = 200_000;
      const contextUsed = Math.min(contextWindow, 14_000 + priorTurns * 26_000);
      tokenUsage.value = { total: contextUsed, contextUsed, contextWindow, compactsAutomatically: true };
      // Consume the head of the mock queue — the real backend emits
      // turn.promoted when it hands a row to the adapter; the mock's settle
      // is that hand-off.
      const nextQueued = queuedTurnsRaw.value[0];
      if (nextQueued) {
        reduce({
          ...base(),
          type: "turn.promoted",
          queueId: nextQueued.queueId,
        });
      }
      reduce({ ...base(), type: "turn.completed", turnId });
      sessionState.value = "ready";
      stopMock();
    })();
  }

  /** Play a scripted demo conversation — a user turn plus a full assistant reply
   *  (thinking with text, a live task plan, tool calls with output, narration, a
   *  no-content thought, and the final answer). Runs the in-browser mock directly
   *  so it works even in the desktop shell, for reviewing the conversation UI
   *  without a live agent. Bound to ⇧⌘D via the shortcuts registry. */
  function demo(): void {
    if (busy.value) return;
    const prompt = "Show me a full conversation";
    blocks.value = [...blocks.value, { id: uid(), role: "user", text: prompt, at: Date.now() }];
    if (!title.value) title.value = titleFromPrompt(prompt);
    mockTurn(prompt, { demo: true });
  }

  return {
    stopMock,
    mockQueueFollowUp,
    mockTurn,
    demo,
    getMockTurnId: () => mockTurnId,
  };
}
