import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";

// The subagent *catalog* kone hands the Claude Agent SDK — the set of nested
// agents the main agent may spawn with its Task/Agent tool.
//
// Ported from research's agent-mention alias table (packages/contracts
// agentMentions.ts) + its `buildClaudeSdkSubagents()`: a small set of curated
// role agents (explore / plan / build / review) with their own prompts, tool
// allowlists and cheap-model defaults, plus four `worker-<tier>` variants that
// exist purely to carry reasoning effort.
//
// Why the worker tiers: the Agent tool's input has a `model` parameter but NO
// effort parameter, so effort can only be chosen by picking an agent definition
// that bakes one in. The workers therefore leave `model` unset (inherit) so the
// tool's own `model` input still composes with the tier — "haiku at low effort"
// and "opus at xhigh" are both reachable. That's also why the system-prompt
// append below spells the convention out: without it the model has no way to
// know effort is selected by agent type.

/** The effort ladder exposed through `worker-<tier>` agent definitions. */
export const CLAUDE_WORKER_EFFORT_TIERS = ["low", "medium", "high", "xhigh"] as const;

const CLAUDE_WORKER_PROMPT =
  "You are a general-purpose worker agent. Complete the assigned task end to end with the available tools, then return a concise report covering what you did, key findings, and any remaining risks.";

/** kone's curated role agents. Keyed by the agent name the Agent tool's
 *  `subagent_type` takes. */
const CLAUDE_ROLE_AGENTS: Record<string, AgentDefinition> = {
  explore: {
    description:
      "Read-only codebase explorer. Use for file discovery, code search, and gathering context before implementation.",
    prompt:
      "You are a focused codebase exploration specialist. Search broadly, gather the most relevant findings, and return a concise summary with the key files, evidence, and risks. Do not make code changes.",
    tools: ["Read", "Grep", "Glob"],
    model: "haiku",
  },
  plan: {
    description:
      "Planning specialist. Use for breaking work into steps, evaluating approaches, and preparing execution plans.",
    prompt:
      "You are a planning specialist. Clarify goals, evaluate tradeoffs, identify edge cases, and return a concrete ordered plan with the main risks called out explicitly.",
    tools: ["Read", "Grep", "Glob", "TodoWrite"],
    model: "sonnet",
  },
  build: {
    description:
      "Implementation teammate. Use for scoped code changes, debugging, and hands-on execution tasks.",
    prompt:
      "You are an implementation-focused coding teammate. Make targeted changes, validate assumptions with the available tools, and return a short implementation summary plus any remaining risks.",
    tools: ["Read", "Grep", "Glob", "Bash", "Edit", "Write", "MultiEdit"],
    model: "sonnet",
  },
  review: {
    description:
      "Bug and risk reviewer. Use for code review, regression hunting, and edge-case analysis.",
    prompt:
      "You are a senior code reviewer. Focus on behavioral regressions, correctness bugs, edge cases, and missing tests. Return findings first, then open questions, then a brief summary.",
    tools: ["Read", "Grep", "Glob"],
    model: "sonnet",
  },
};

/** Build the `agents` map for the SDK's query options: the curated roles plus
 *  the effort-tier workers (workers never override a role of the same name). */
export function buildClaudeSubagentDefinitions(): Record<string, AgentDefinition> {
  const agents: Record<string, AgentDefinition> = { ...CLAUDE_ROLE_AGENTS };

  for (const tier of CLAUDE_WORKER_EFFORT_TIERS) {
    const name = `worker-${tier}`;
    if (agents[name]) continue;
    agents[name] = {
      description: `General-purpose worker at ${tier} reasoning effort; choose per task complexity`,
      prompt: CLAUDE_WORKER_PROMPT,
      effort: tier,
    };
  }

  return agents;
}

/** The effort a `worker-<tier>` agent type encodes, or undefined for a role
 *  agent (whose effort is inherited and so isn't ours to report). */
export function claudeSubagentEffort(agentType: string | undefined): string | undefined {
  if (!agentType) return undefined;
  const trimmed = agentType.trim();
  return (CLAUDE_WORKER_EFFORT_TIERS as readonly string[]).find(
    (tier) => trimmed === `worker-${tier}`,
  );
}

/** Guidance appended to the Claude Code system preset so the main agent knows
 *  the catalog exists and how effort is chosen (research's
 *  buildEmbeddedClaudeSystemPromptAppend, trimmed to the subagent lines). */
export const CLAUDE_SUBAGENT_SYSTEM_PROMPT_APPEND = [
  "When delegating with the Agent tool, set its `model` parameter and pick reasoning effort by choosing a worker-<tier> subagent type (worker-low, worker-medium, worker-high, worker-xhigh).",
  "Honor explicit user instructions about a subagent's model or effort verbatim; otherwise match task complexity: mechanical work → haiku or worker-low, standard work → sonnet or worker-medium, hard reasoning → opus with worker-high or above.",
  "Launch independent subagents in a single message so they run concurrently.",
].join("\n");

/** How a steer message is framed to a running subagent (it arrives as extra
 *  context on the child's next tool call, not as a user turn). */
export function claudeSubagentSteerContext(message: string): string {
  return `The user sent you a message mid-task: ${message}. Address it and adjust your work accordingly.`;
}

/** Claude's tool names for spawning a subagent. `Task` is the historical name,
 *  `Agent` the current one; both are live depending on CLI version. */
export function isClaudeSubagentTool(toolName: string | undefined): boolean {
  const normalized = toolName?.trim().toLowerCase();
  return normalized === "task" || normalized === "agent";
}
