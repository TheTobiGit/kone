// App-context injection for provider sessions (docs/mcp-gateway-design.md §4).
//
// The agents kone drives can't discover kone from inside their own CLI, so each
// adapter delivers a versioned "kone host context" block telling the agent what
// it is running inside and what the app gateway lets it do. Everything here is
// built from ONE options struct (`KoneContextOptions`) by ONE pair of block
// renderers, and the per-provider functions below only choose a channel. That
// is the whole discipline of this file: a block is written once and worded
// once, so three delivery mechanisms cannot drift into three dialects.
//
// Channels:
//
// - System channel — providers with a system/developer-instruction surface.
//   Claude takes it through the SDK preset's `append` (sdk.d.ts: `{ type:
//   'preset', preset: 'claude_code', append: '...' }` is "Use default prompt
//   with appended instructions"). Codex takes it through turn/start
//   `collaborationMode.settings.developer_instructions`; the shape is checked
//   against codex-rs's generated schema (V2TurnStartParams__Settings).
// - First-prompt channel — providers with no such surface (the ACP adapters,
//   OpenCode, Antigravity). The blocks are wrapped in their own tags and ride
//   in front of the first user prompt, once per session (runOrdinal === 1).
//
// The tool half of the block is not written here. Each gateway tool carries its
// own one-line `promptSnippet` and any `promptGuidelines` it imposes, and the
// registry hands the session's servable set to the connection at mint time. So
// the prose can only ever name tools this session actually got — the invariant
// that a hand-written paragraph could restate but never enforce.

import type { JsonObject } from "@kone/agent-core/lib-jsonValue.js";
import type { AgentPersona, GatewayConnection, GatewayToolPrompt } from "../types.js";

/**
 * Everything the blocks are built from. One struct, threaded to every channel,
 * so adding a fact to the host context is one field and one renderer rather
 * than an edit in each adapter.
 */
export interface KoneContextOptions {
  /** The session's gateway grant. Absent means no `kone_*` tools were installed,
   *  and no host-context block is delivered at all. */
  gateway?: Pick<GatewayConnection, "tools">;
  /** Whose name is on the thread. Absent for a guest, which is told nothing. */
  agent?: AgentPersona;
}

/** Versioned marker so a host-context block in a transcript can be dated. */
export const KONE_HOST_CONTEXT_VERSION = "2026-08-31.1";
export const KONE_HOST_CONTEXT_MARKER = `[kone host context ${KONE_HOST_CONTEXT_VERSION}]`;

/** What every gateway session is told regardless of which tools it got. */
const HOST_CONTEXT_PREAMBLE = [
  "You are running inside kone, a desktop app for AI-assisted development. kone hosts this agent session and renders your work on the user's project board.",
  "The `kone` MCP server is kone's app gateway: your native connection to the app the user is looking at. App tools are part of your job — when one fits, use it directly instead of searching files or inventing terminal workarounds. Tool names may carry an MCP prefix (e.g. `mcp__kone__kone_scratchpad_read`); the semantics are the same.",
  "WORKSPACE CONTROLS: To change themes, dark/light mode, or workspace appearance, invoke `app_set_theme` directly. Never run shell commands (grep, ps, node, curl) to configure the UI.",
];

/**
 * The host-context block for a session holding `tools`.
 *
 * The tool index is one line each. Each tool's full account already reaches the
 * same model through MCP tools/list, so spending the system channel on a second
 * copy of it would buy nothing and cost the tokens twice — what goes here is
 * only what tools/list cannot say: that the tool exists before the agent goes
 * looking, and the standing rules that sit *between* tools.
 *
 * Returns "" for a session that got no announceable tools, which keeps a
 * gateway that served nothing from claiming otherwise.
 */
export function renderKoneHostContext(tools: readonly GatewayToolPrompt[]): string {
  if (!tools?.length) return "";
  const index = tools.map((tool) => {
    const approval = tool.needsApproval ? " (stops for the user's approval)" : "";
    return `- \`${tool.name}\`: ${tool.snippet}${approval}`;
  });
  const guidelines: string[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    for (const guideline of tool.guidelines) {
      if (seen.has(guideline)) continue;
      seen.add(guideline);
      guidelines.push(guideline);
    }
  }
  return [
    KONE_HOST_CONTEXT_MARKER,
    ...HOST_CONTEXT_PREAMBLE,
    "",
    "Tools kone gives you in this session:",
    ...index,
    ...(guidelines.length ? ["", ...guidelines] : []),
  ].join("\n");
}

// ── who the session is working as ────────────────────────────────────────────
// A thread handed to a named agent has to arrive at the model knowing whose name
// is on it. Without this the transcript is the only party that knows: kone labels
// the turn, the user writes "Maya, can you take another look", and the agent on
// the other end has never heard the name — so it either ignores it or invents
// what it is being asked to be.
//
// The name is not a costume — the block says it is a presentation and tells the
// agent to answer plainly when asked what is behind it, because a model denying
// its own provider is a worse failure than a thread with no name at all. After
// the name comes one optional block: the agent's instructions — how it should
// work, in the user's words, framed as standing orders rather than this turn's
// request. An agent may have them or not; without them it is still just a name.
//
// A guest session is told none of this, which is the point. A guest name belongs
// to the conversation rather than to anybody — it is rolled from the thread's id
// so a column has a face — and telling a model it "is Alder" would make an actor
// out of a label. A guest behaves exactly as it did before any of this existed.

export const KONE_AGENT_IDENTITY_VERSION = "2026-08-20.4";
export const KONE_AGENT_IDENTITY_MARKER = `[kone agent identity ${KONE_AGENT_IDENTITY_VERSION}]`;

const MAX_NAME_LENGTH = 48;
/** A generous ceiling for an agent's instructions — room for real standing
 *  orders, short of a field that could crowd the turn out of its own context. */
const MAX_INSTRUCTIONS_LENGTH = 4000;

/**
 * One line of plain text with nothing in it that could close a block.
 *
 * The name is the user's own text, and on the first-prompt channel this block is
 * delivered inside tags — so a name carrying `</kone_agent_identity>` would end
 * the block early and leave the rest of it reading as the user's request.
 * Brackets go, whitespace collapses, and what survives is a single line.
 */
function oneLine(value: string, limit: number): string {
  return value
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

/**
 * A multi-line prose field — an agent's instructions — made safe to sit inside
 * the identity block.
 *
 * Same tag concern as the name: on the first-prompt channel this block is
 * delivered inside `<kone_agent_identity>` tags, so a `>` in the text would
 * close it early. Angle brackets go — but the newlines stay, because unlike the
 * name these are multi-line prose. Runs of blank lines and trailing spaces are
 * tidied so the block reads cleanly however the field was typed, and the whole
 * thing is capped.
 */
function sanitizeProse(value: string, limit: number): string {
  return value
    .replace(/[<>]/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, limit);
}

/** The agent's identity block, or "" for a guest — see the note above. Empty
 *  for a nameless agent too: a block that has to say "you are" and then trail
 *  off is worse than no block. The agent's instructions, when it has any, follow
 *  the name. */
export function renderAgentIdentity(agent: AgentPersona | undefined): string {
  if (!agent) return "";
  const name = oneLine(agent.name, MAX_NAME_LENGTH);
  if (!name) return "";
  const lines = [
    KONE_AGENT_IDENTITY_MARKER,
    `The user handed this thread to a named agent, and you are it: in kone you are ${name}. kone labels your turns with that name and the user will address you by it, so answer to it, and use it when you refer to yourself.`,
    "That name is how you are presented here, not a cover story — if the user asks which model or CLI is behind it, tell them plainly.",
  ];
  const instructions = agent.instructions
    ? sanitizeProse(agent.instructions, MAX_INSTRUCTIONS_LENGTH)
    : "";
  if (instructions) {
    lines.push(
      `The user set how you, ${name}, are to work. Treat this as your standing orders for the whole thread, above your defaults but below anything they ask for directly:`,
      instructions,
    );
  }
  return lines.join("\n");
}

/** The two blocks a session gets, each already empty when it does not apply. */
export interface KoneContextBlocks {
  /** What the app is and which tools it granted. */
  hostContext: string;
  /** Whose name the thread carries. */
  identity: string;
}

/**
 * Build both blocks from one struct.
 *
 * They stay separate all the way to the channel because they are gated on
 * different things: whose name a thread carries has nothing to do with which
 * tools the session got, so an agent that came up without a gateway still knows
 * who it is, and a guest holding the full toolset is still told nothing about a
 * name it does not have.
 */
export function buildKoneContext(options: KoneContextOptions): KoneContextBlocks {
  return {
    hostContext: options.gateway ? renderKoneHostContext(options.gateway.tools) : "",
    identity: renderAgentIdentity(options.agent),
  };
}

/** Claude system channel: the blocks layered onto the stock claude_code preset
 *  via the SDK's preset `append` (sdk.d.ts: "Use default prompt with appended
 *  instructions"). Empty when there is nothing to say — no gateway and no named
 *  agent — and the adapter then appends nothing, keeping the preset pristine. */
export function claudeSystemPromptAppend(options: KoneContextOptions): string {
  const { hostContext, identity } = buildKoneContext(options);
  return [hostContext, identity].filter(Boolean).join("\n");
}

/** Codex envelope default when kone hasn't selected a model. The app-server
 *  schema requires `collaborationMode.settings.model` (Schema.String, not
 *  optional), so provider-default sessions still need a slug to send. A
 *  `model` whenever one is known stays authoritative, so this slug only rides
 *  along on provider-default sessions. */
export const CODEX_ENVELOPE_DEFAULT_MODEL = "gpt-5.6-sol";

export interface CodexTurnCollaborationMode extends JsonObject {
  mode: "default";
  settings: {
    model: string;
    reasoning_effort: string;
    developer_instructions: string;
    [key: string]: string;
  };
}

/** The turn/start `collaborationMode` envelope carrying the app context.
 *  kone has no plan/build interaction-mode axis (the CodexAdapter comment on
 *  that axis), so the block always opens a Default collaboration mode, exactly
 *  like the default-mode developer instructions. Undefined when there is
 *  nothing to deliver. */
export function buildCodexTurnCollaborationMode(
  input: KoneContextOptions & { model?: string; effort?: string },
): CodexTurnCollaborationMode | undefined {
  const developerInstructions = codexDeveloperInstructions(input);
  if (developerInstructions === undefined) return undefined;
  return {
    mode: "default",
    settings: {
      model: input.model ?? CODEX_ENVELOPE_DEFAULT_MODEL,
      reasoning_effort: input.effort ?? "medium",
      developer_instructions: developerInstructions,
    },
  };
}

/** Codex system channel: the full `developer_instructions` string delivered
 *  through turn/start collaborationMode. The leading `<collaboration_mode>`
 *  block pins codex's collaboration-mode state to Default (kone never uses
 *  Plan); the app context rides after it, outside the tags.
 *
 *  This channel is re-sent on EVERY turn, unlike Claude's one-time system
 *  append — which is the reason the tool index above is one line per tool
 *  rather than a paragraph. */
export function codexDeveloperInstructions(options: KoneContextOptions): string | undefined {
  const { hostContext, identity } = buildKoneContext(options);
  // Nothing to deliver, so no envelope at all. The collaboration-mode preamble
  // is not reason enough on its own: it only restates the mode kone always runs
  // in, and sending it alone would put a mode declaration on every turn of a
  // session that has nothing else to be told.
  if (!hostContext && !identity) return undefined;
  const collaborationMode = [
    "<collaboration_mode># Collaboration Mode: Default",
    "",
    "You are now in Default mode. Any previous instructions for other modes (e.g. Plan mode) are no longer active.",
    "",
    "Your active mode changes only when new developer instructions with a different `<collaboration_mode>...</collaboration_mode>` change it; user requests or tool descriptions do not change mode by themselves. Known mode names are Default and Plan.",
    "",
    "## request_user_input availability",
    "",
    "The `request_user_input` tool is unavailable in Default mode. If you call it while in Default mode, it will return an error.",
    "",
    "In Default mode, strongly prefer making reasonable assumptions and executing the user's request rather than stopping to ask questions. If you absolutely must ask a question because the answer cannot be discovered from local context and a reasonable assumption would be risky, ask the user directly with a concise plain-text question. Never write a multiple choice question as a textual assistant message.",
    "</collaboration_mode>",
  ].join("\n");
  return [collaborationMode, hostContext, identity].filter(Boolean).join("\n\n");
}

/** The first-prompt channel's wrapped prompt, with whichever blocks this session
 *  actually has. Each block carries its own tag, so an agent's identity is a
 *  thing the model can tell apart from the app it is running in rather than one
 *  long preamble. Nothing to say leaves the prompt alone — an empty preamble
 *  would still cost the agent a `<user_request>` wrapper to see through. */
export function prependKoneHostContext(prompt: string, options: KoneContextOptions): string {
  const { hostContext, identity } = buildKoneContext(options);
  const preamble = [
    hostContext ? `<kone_host_context>${hostContext.trim()}</kone_host_context>` : "",
    identity ? `<kone_agent_identity>${identity}</kone_agent_identity>` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  if (!preamble) return prompt;
  return `${preamble}\n\n<user_request>\n${prompt}\n</user_request>`;
}

/** First-prompt channel: fire it once per session, on the session's first run. */
export function koneHostContextForFirstRun(
  input: KoneContextOptions & { prompt: string; runOrdinal: number },
): string {
  if (input.runOrdinal !== 1) return input.prompt;
  return prependKoneHostContext(input.prompt, input);
}
