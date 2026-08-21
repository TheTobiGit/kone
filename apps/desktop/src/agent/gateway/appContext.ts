// App-context injection for provider sessions (docs/mcp-gateway-design.md §4).
//
// The agents kone drives can't discover kone from inside their own CLI, so
// each adapter delivers a versioned "kone host context" block telling the
// agent what it is, the gateway tools it has (kone_scratchpad_read/write),
// CodexDeveloperInstructions.ts):
//
// - System channel — providers WITH a system/developer-instruction surface:
//   Claude gets the block through the SDK preset's `append` (verified against
//   sdk.d.ts: `{ type: 'preset', preset: 'claude_code', append: '...' }` is
//   "Use default prompt with appended instructions" — the stock preset is
//   exactly this). Codex gets it through turn/start
//   `collaborationMode.settings.developer_instructions` — the app-server
//   (codexAppServerManager buildCodexCollaborationMode) use; shape verified
//   against codex-rs's generated schema (V2TurnStartParams__Settings).
// - First-prompt channel — providers WITHOUT such a surface (Phase B ACP
//   adapters): the block is wrapped in <kone_host_context>…</kone_host_context>
//   and prepended to the first user prompt (prependKoneHostContext), so it
//   prependT3OrchestrationInstructions, firing on runOrdinal === 1).
//
// Everything is gated on the session actually having a gateway connection:
// never promise tools the agent doesn't have.

import type { AgentPersona } from "../types.js";

/** Versioned marker so a host-context block in a transcript can be dated —
 */
export const KONE_HOST_CONTEXT_VERSION = "2026-08-08.2";
export const KONE_HOST_CONTEXT_MARKER = `[kone host context ${KONE_HOST_CONTEXT_VERSION}]`;

export function renderKoneHostContext(gatewayControlAvailable: boolean): string {
  if (!gatewayControlAvailable) {
    return [
      KONE_HOST_CONTEXT_MARKER,
      "You are running inside kone, a desktop app for AI-assisted development.",
      "kone's app gateway is unavailable in this session, so no kone_* tools are installed. Do not claim you can read or write kone's project scratchpad, or that you can spawn kone threads, wait on them, or read a spawned thread's transcript.",
    ].join("\n");
  }
  return [
    KONE_HOST_CONTEXT_MARKER,
    "You are running inside kone, a desktop app for AI-assisted development. kone hosts this agent session and renders your work on the user's project board.",
    "The `kone` MCP server is kone's app gateway: your native connection to the app the user is looking at. App tools are part of your job — when one fits, use it instead of inventing file-based workarounds. Tool names may carry an MCP prefix (e.g. `mcp__kone__kone_scratchpad_read`); the semantics are the same.",
    "`kone_scratchpad_read` reads this project's scratchpad: a notes board the user sees live on kone's project page, and your durable shared memory for the project — it persists across sessions. Read it when the user references their notes, or to ground yourself in prior decisions before acting.",
    "`kone_scratchpad_write` updates that board, and it re-renders on the user's page as you write. Use it to record plans, decisions, and durable notes the user will keep reading after this conversation; append: true merges new notes safely, and writes are attributed to this agent.",
    "The scratchpad is the one place agent work and the user's own edits meet: read before overwriting, prefer append for additions, and treat revision conflicts (the web editor saved) as the user's word.",
    "`kone_spawn_thread` opens a new kone thread on any installed provider and sets an agent working in it — a second conversation the user watches in the sidebar, not a nested subagent inside your turn. Reach for it when a piece of work is self-contained and large enough that doing it inline would crowd out your context, or when several independent pieces can run at once. The child wakes with no memory of this conversation, so its prompt must stand entirely on its own. Its mode — what it may do without stopping to ask — can never exceed yours, and requesting a wider one refuses the spawn rather than quietly downgrading it; leave mode unset to inherit yours, and match it to what the child must do unattended, because nobody sits in its thread: a child that stops for permission stays stopped until the user notices. If the work needs more than your own thread is allowed, ask the user to raise your mode first — do not spawn a child that cannot finish.",
    "`kone_spawn_targets` tells you which providers and models are actually installed and how many more children you may open; `kone_wait_for_threads` collects your children's outcomes and surfaces any that have parked on a question — pin the wait to the exact turn you spawned by passing the child's first turn id (returned by `kone_spawn_thread`) as `turnIds`, so a newer turn in the child can't swap which outcome you collect; `kone_read_thread` opens a child's full transcript when its summary is not enough.",
    "Spawned work is the user's work too — they see these threads run. Give every child a brief you would be willing to have read back to you, and keep the number of children proportionate to the task.",
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

/** Claude system channel: the blocks layered onto the stock claude_code preset
 *  via the SDK's preset `append` (sdk.d.ts: "Use default prompt with appended
 *  instructions"). Empty when there is nothing to say — no gateway and no named
 *  agent — and the adapter then appends nothing, keeping the preset pristine.
 *
 *  The two blocks are independently optional on purpose: an agent's name is not
 *  a gateway capability, so a session that came up without a gateway connection
 *  still knows who it is. */
export function claudeSystemPromptAppend(
  gatewayControlAvailable: boolean,
  agent?: AgentPersona,
): string {
  return [gatewayControlAvailable ? renderKoneHostContext(true) : "", renderAgentIdentity(agent)]
    .filter(Boolean)
    .join("\n");
}

/** Codex envelope default when kone hasn't selected a model. The app-server
 *  schema requires `collaborationMode.settings.model` (Schema.String, not
 *  optional), so provider-default sessions still need a slug to send. A
 *  `model` whenever one is known stays authoritative, so this slug only rides
 *  along on provider-default sessions. */
export const CODEX_ENVELOPE_DEFAULT_MODEL = "gpt-5.6-sol";

export interface CodexTurnCollaborationMode {
  mode: "default";
  settings: {
    model: string;
    reasoning_effort: string;
    developer_instructions: string;
  };
}

/** The turn/start `collaborationMode` envelope carrying the app context.
 *  kone has no plan/build interaction-mode axis (the CodexAdapter comment on
 *  that axis), so the block always opens a Default collaboration mode, exactly
 *  like the default-mode developer instructions. Undefined when
 *  the session has no gateway connection. */
export function buildCodexTurnCollaborationMode(input: {
  model?: string;
  effort?: string;
  gatewayControlAvailable: boolean;
  agent?: AgentPersona;
}): CodexTurnCollaborationMode | undefined {
  const developerInstructions = codexDeveloperInstructions(input.gatewayControlAvailable, input.agent);
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
 *  Plan); the app context rides after it, outside the tags, as in both
 *  references. */
export function codexDeveloperInstructions(
  gatewayControlAvailable: boolean,
  agent?: AgentPersona,
): string | undefined {
  const identity = renderAgentIdentity(agent);
  // Nothing to deliver, so no envelope at all. The collaboration-mode preamble
  // is not reason enough on its own: it only restates the mode kone always runs
  // in, and sending it alone would put a mode declaration on every turn of a
  // session that has nothing else to be told.
  if (!gatewayControlAvailable && !identity) return undefined;
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
  return [collaborationMode, gatewayControlAvailable ? renderKoneHostContext(true) : "", identity]
    .filter(Boolean)
    .join("\n\n");
}

/** Phase B first-prompt channel: the blocks wrapped so they can't be mistaken
 *  for user text and prepended to the first user prompt — for providers
 *  prependT3OrchestrationInstructions. Each block carries its own tag, so an
 *  agent's identity is a thing the model can tell apart from the app it is
 *  running in rather than one long preamble. */
export function prependKoneHostContext(prompt: string, agent?: AgentPersona): string {
  return wrapFirstPrompt({ prompt, gatewayControlAvailable: true, agent });
}

/** The wrapped first prompt, with whichever blocks this session actually has.
 *  Nothing to say leaves the prompt alone — an empty preamble would still cost
 *  the agent a `<user_request>` wrapper to see through. */
function wrapFirstPrompt(input: {
  prompt: string;
  gatewayControlAvailable: boolean;
  agent?: AgentPersona;
}): string {
  const identity = renderAgentIdentity(input.agent);
  const preamble = [
    input.gatewayControlAvailable
      ? `<kone_host_context>${renderKoneHostContext(true).trim()}</kone_host_context>`
      : "",
    identity ? `<kone_agent_identity>${identity}</kone_agent_identity>` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  if (!preamble) return input.prompt;
  return `${preamble}\n\n<user_request>\n${input.prompt}\n</user_request>`;
}

/** Phase B helper: fire the first-prompt channel once per session, on the
 */
export function koneHostContextForFirstRun(input: {
  prompt: string;
  runOrdinal: number;
  gatewayControlAvailable: boolean;
  agent?: AgentPersona;
}): string {
  if (input.runOrdinal !== 1) return input.prompt;
  return wrapFirstPrompt({
    prompt: input.prompt,
    gatewayControlAvailable: input.gatewayControlAvailable,
    agent: input.agent,
  });
}
