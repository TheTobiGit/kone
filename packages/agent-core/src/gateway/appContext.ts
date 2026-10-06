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
import type {
  AgentPersona,
  GatewayConnection,
  GatewayModelPreference,
  GatewayToolPrompt,
} from "../types.js";
import { KONE_ON_DEMAND_MCP_SERVER_NAME } from "./injection.js";
import { activeModelPreferences, type ModelPreference } from "../modelPreference.js";

/**
 * Everything the blocks are built from. One struct, threaded to every channel,
 * so adding a fact to the host context is one field and one renderer rather
 * than an edit in each adapter.
 */
export interface KoneContextOptions {
  /** The session's gateway grant. Absent means no `kone_*` tools were installed,
   *  and no host-context block is delivered at all. */
  gateway?: Pick<GatewayConnection, "tools" | "scope" | "role" | "modelPreferences">;
  /** Whose name is on the thread — a guest carries its call sign, flagged `guest`. */
  agent?: AgentPersona;
  /** Session role: worker agent on a codebase or global app assistant. */
  scope?: "worker" | "assistant";
  /** The client defers the on-demand tools behind its own tool search (Claude
   *  does, via the second server claudeMcpServers adds). The index then says
   *  which tools are not loaded yet and how to load one. */
  toolSearch?: boolean;
}

/** Versioned marker so a host-context block in a transcript can be dated. */
export const KONE_HOST_CONTEXT_VERSION = "2026-10-01.1";
export const KONE_HOST_CONTEXT_MARKER = `[kone host context ${KONE_HOST_CONTEXT_VERSION}]`;

const KONE_APP_LINE =
  "You are running inside kone, a desktop app where the user works with coding agents across their projects. The studio is where the work happens: each project is a row of panes (agent conversations, terminals, the project's scratchpad). The inbox lists every conversation by what it needs from the user, and the bench, still to come, queues jobs the user put down to run one at a time.";

const KONE_GATEWAY_LINE =
  "The `kone` MCP server is kone's app gateway. When one of its tools fits, use it directly instead of searching files or inventing terminal workarounds. Tool names may carry an MCP prefix (e.g. `mcp__kone__worker_start`); the semantics are the same.";

const SENDERS_LINE =
  "Not every message in this conversation is from the user. One another agent wrote arrives under a <from_agent> header, or inside <agent_messages>, naming it and how it relates to you; one kone itself wrote arrives under <kone_notice>. Anything without a header is the user.";

const WORKER_HOST_CONTEXT_PREAMBLE = [
  KONE_APP_LINE,
  "This session is a kone agent: a real conversation the user can see and open, which outlives the turn that started it, and which the user and other agents can message. Agents have an identity and take on large pieces of work; they hand parts of it to other agents (a teammate on the project's team) or to workers, which do one short task each and report back. A provider's built-in subagent (Claude Code's `Agent` tool, for one) is neither: it runs hidden inside your own turn.",
  SENDERS_LINE,
  KONE_GATEWAY_LINE,
];

/** For a session started as a worker. (WORKER_HOST_CONTEXT_PREAMBLE is the
 *  older name for any project session, kept for the scope it is keyed on.) */
const TASK_WORKER_HOST_CONTEXT_PREAMBLE = [
  KONE_APP_LINE,
  "This session is a kone worker: started by an agent for one short task. Do that task and report back — your final reply is the report the agent collects. You cannot start kone agents or workers; if the task needs splitting, use your provider's own subagents, and if part of it should go to someone else, say so in your report.",
  SENDERS_LINE,
  KONE_GATEWAY_LINE,
];

const ASSISTANT_HOST_CONTEXT_PREAMBLE = [
  "You are kone's global assistant: a permanent, unscoped technical partner and app steering co-pilot.",
  "You talk like a hyper-organized close friend texting: casual, warm, conversational, and direct. Keep the cadence natural, concise, and easy to read in quick bursts.",
  "Be proactive once there is work in play: anticipate the next step, flag gotchas early, and keep things moving without waiting to be micro-managed. Proactive means acting on the task at hand, not pitching what you could do.",
  "No robotic stiffness, corporate fluff, or canned pleasantries. Skip the filler, be authentic and helpful, and give direct answers or actions first.",
  "Match the size of the reply to the size of what was said. A greeting gets a greeting back and nothing else. Never volunteer a menu of your capabilities, and never list what you could do (\"i can switch themes, spin up work in a repo, tweak agents\"). The user knows what you are for, and will say what they want. If they open with small talk, make small talk.",
  "Do not end every reply with an offer or a question. \"want me to...?\", \"should I...?\", \"need me to...?\" as a sign-off is a tic: it hands the turn back when you had nothing to ask. Let a reply just end. Ask only when the answer actually changes what you do next, and then ask the one specific question instead of listing menu options.",
  "Punctuation constraint: Use standard ASCII characters only. Never use em dashes or en dashes under any circumstance (never emit U+2014 or U+2013). Never use dashes to connect clauses or insert pauses. Instead, break thoughts into two short sentences, or use commas, colons, or parentheses.",
  "You have full authority to steer the kone app. Use your tools directly to change themes, adjust typography and fonts, create or update agents, edit subagent presets, configure strip layouts, and read the user's projects and the conversations inside them.",
  "You are summoned over whatever the user is doing in kone, so kone attaches a short <kone_view> description of their screen to every message they send. It is there on every message by design, not because the message is about the screen. Use it only when the message needs it: when they say \"this\", \"here\" or \"that error\", they mean what is on screen, so resolve it from the view instead of asking which one, and call app_get_view when you need more than the view says. Otherwise leave it alone. A greeting gets a greeting, a question gets an answer to that question, and neither gets a remark about what is on their screen.",
  "You can also open a real thread in one of their projects and set it working, or send a follow-up into a thread that already exists. Those are their threads on their repos, not a scratch space: act when they have asked for work to happen, prefer messaging the thread already doing the work over starting a new one, and tell them what you started or sent and where.",
];

/** How a deferring client's agent reaches an on-demand tool. Its schema is
 *  not in the prompt, so without this the agent would read the index, see the
 *  tool missing from its tool list, and conclude it was never granted. */
const TOOL_SEARCH_NOTE = `Tools marked (on demand) are served by the \`${KONE_ON_DEMAND_MCP_SERVER_NAME}\` MCP server and are not loaded yet. When you need one, load it with ToolSearch (query \`select:mcp__${KONE_ON_DEMAND_MCP_SERVER_NAME}__<tool name>\`), then call it like any other tool.`;

// ── the user's model preferences ─────────────────────────────────────────────
// A preference is the user saying which model a kind of work runs on. It only
// takes effect when an agent passes the kind on a hand-off, and an agent that
// meets the list only by calling agent_directory mostly never does: it reaches
// for its own subagent or skill instead, which runs on its own model, and the
// rule is skipped without anyone deciding to skip it. So the list rides in the
// host context, with the standing rule that makes it bind.
//
// The wording follows what the dispatch actually does with `kind`: a `target`
// the agent names wins over it, and so does a preset's or a teammate's own
// model chain — the kind only fills in where nothing more specific placed the
// thread. Telling an agent "pass kind" without that would send it to a teammate
// with a model of its own and leave it believing the rule applied.
//
// The block is written once, at session start, so it can go stale when the user
// edits a rule mid-session. It says so, and points at agent_directory, which
// reads the store on every call.

/** The stored list as the grant carries it: only the rules switched on with a
 *  model, in the user's order — any other is dormant, and naming it to an agent
 *  would offer a kind that places nothing. */
export function hostContextModelPreferences(prefs: readonly ModelPreference[]): GatewayModelPreference[] {
  return activeModelPreferences(prefs).map((pref) => ({
    kind: pref.kind,
    label: pref.label,
    hint: pref.hint,
    model: { provider: pref.model.provider, model: pref.model.model },
    effort: pref.effort,
  }));
}

/** The hand-off tools that take `kind`, in the order the rule names them. */
const KIND_TOOLS = ["worker_start", "worker_start_batch", "agent_contract", "agent_delegate"] as const;

/** One preference as a line of the list. Every field is the user's own text, so
 *  each goes through `oneLine` like any other name in these blocks. */
function modelPreferenceLine(pref: GatewayModelPreference): string {
  const kind = oneLine(pref.kind, MAX_NAME_LENGTH);
  const label = oneLine(pref.label, MAX_PREFERENCE_FIELD_LENGTH);
  const model = `${oneLine(pref.model.provider, MAX_NAME_LENGTH)} / ${oneLine(pref.model.model, MAX_PREFERENCE_FIELD_LENGTH)}`;
  const effort = pref.effort ? `effort ${oneLine(pref.effort, MAX_NAME_LENGTH)}` : "the provider's default effort";
  const hint = oneLine(pref.hint, MAX_PREFERENCE_HINT_LENGTH);
  return `- \`${kind}\` (${label}): ${model}, ${effort}.${hint ? ` When it applies: ${hint}` : ""}`;
}

/**
 * The preferences section, or nothing when there is nothing to bind: no rule
 * switched on, or a session that holds none of the tools a kind is passed to
 * (a worker, the assistant), which could not act on the list if it had it.
 */
function renderModelPreferences(
  prefs: readonly GatewayModelPreference[] | undefined,
  tools: readonly GatewayToolPrompt[],
): string[] {
  if (!prefs?.length) return [];
  const held = new Set(tools.map((tool) => tool.name));
  const handOffs = KIND_TOOLS.filter((name) => held.has(name)).map((name) => `\`${name}\``);
  if (!handOffs.length) return [];
  const lines = [
    "The user's model preferences by kind of work, as they stood when this session started:",
    ...prefs.map(modelPreferenceLine),
    `Each one is the user's explicit choice of model for that kind of work, and it comes before your own judgment of which model fits. When a piece of work matches one of these kinds, hand it off through kone with that \`kind\` (${handOffs.join(", ")}). Do not do that work inline, and do not run it through your provider's built-in subagent or skill: those run on your own model and skip the user's choice. If a skill has the method you want, read its file and put its steps in the brief.`,
    "`kind` places the thread only when nothing more specific does: a `target` you pass wins over it, and so does a preset's or a teammate's own model. For work under a preference, start a briefed worker or contractor with `kind` and no `target`, or delegate only to a teammate with no model of its own.",
    "An explicit instruction from the user in this conversation, such as doing it yourself or using another model, still wins over a stored preference.",
  ];
  if (held.has("agent_directory")) {
    lines.push(
      "The user can change these during the session. `agent_directory` has the live list, so check it before relying on this one when the session has run a while or a hand-off reports a kind it does not know.",
    );
  }
  return lines;
}

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
export function renderKoneHostContext(
  tools: readonly GatewayToolPrompt[],
  scope: "worker" | "assistant" = "worker",
  options: {
    toolSearch?: boolean;
    role?: "agent" | "worker";
    modelPreferences?: readonly GatewayModelPreference[];
  } = {},
): string {
  if (!tools?.length) return "";
  const preamble =
    scope === "assistant"
      ? ASSISTANT_HOST_CONTEXT_PREAMBLE
      : options.role === "worker"
        ? TASK_WORKER_HOST_CONTEXT_PREAMBLE
        : WORKER_HOST_CONTEXT_PREAMBLE;
  const deferred = options.toolSearch === true && tools.some((tool) => tool.onDemand);
  const index = tools.map((tool) => {
    const approval = tool.needsApproval ? " (stops for the user's approval)" : "";
    const onDemand = deferred && tool.onDemand ? " (on demand)" : "";
    return `- \`${tool.name}\`: ${tool.snippet}${approval}${onDemand}`;
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
  const preferences = scope === "worker" ? renderModelPreferences(options.modelPreferences, tools) : [];
  return [
    KONE_HOST_CONTEXT_MARKER,
    ...preamble,
    "",
    "Tools kone gives you in this session:",
    ...index,
    ...(deferred ? ["", TOOL_SEARCH_NOTE] : []),
    ...(guidelines.length ? ["", ...guidelines] : []),
    ...(preferences.length ? ["", ...preferences] : []),
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
// A guest is told one thing and no more. Its name belongs to the conversation
// rather than to anybody — it is rolled from the thread's id so a column has a
// face — and telling a model it "is Alder" would make an actor out of a label.
// But other agents address it by that name, and a message to "Alder" means
// nothing to a session that has never heard it. So a guest learns its label,
// framed as what others call it: no "you are", no standing orders.

export const KONE_AGENT_IDENTITY_VERSION = "2026-10-02.1";
export const KONE_AGENT_IDENTITY_MARKER = `[kone agent identity ${KONE_AGENT_IDENTITY_VERSION}]`;

const MAX_NAME_LENGTH = 48;
/** Bounds for a preference's label/model id and its hint — the store's own
 *  limits, restated so a field that slipped past them still can't grow the
 *  block. */
const MAX_PREFERENCE_FIELD_LENGTH = 80;
const MAX_PREFERENCE_HINT_LENGTH = 300;
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

/** The agent's identity block — for a guest, only the label others address it
 *  by (see the note above); "" with no persona at all. Empty for a nameless
 *  agent too: a block that has to say "you are" and then trail
 *  off is worse than no block. The agent's instructions, when it has any, follow
 *  the name. */
export function renderAgentIdentity(agent: AgentPersona | undefined): string {
  if (!agent) return "";
  const name = oneLine(agent.name, MAX_NAME_LENGTH);
  if (!name) return "";
  if (agent.guest) {
    return [
      KONE_AGENT_IDENTITY_MARKER,
      `kone labels this conversation ${name}. Other agents see that name on your messages and address you by it, so a message to ${name} is a message to you.`,
    ].join("\n");
  }
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
  const scope = options.scope ?? options.gateway?.scope ?? "worker";
  return {
    hostContext: options.gateway
      ? renderKoneHostContext(options.gateway.tools, scope, {
          toolSearch: options.toolSearch,
          role: options.gateway.role,
          modelPreferences: options.gateway.modelPreferences,
        })
      : "",
    identity: renderAgentIdentity(options.agent),
  };
}

/** Claude system channel: the blocks layered onto the stock claude_code preset
 *  via the SDK's preset `append` (sdk.d.ts: "Use default prompt with appended
 *  instructions"). Empty when there is nothing to say — no gateway and no named
 *  agent — and the adapter then appends nothing, keeping the preset pristine. */
export function claudeSystemPromptAppend(options: KoneContextOptions): string {
  const { hostContext, identity } = buildKoneContext({ ...options, toolSearch: true });
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
  const questionGuidance = options.gateway?.tools.some((tool) => tool.name === "ask_question")
    ? "When you need to ask the user a question, use Kone's `ask_question` MCP tool. It is available in Default mode and waits for the answer as its tool result, then you continue in the same turn. Prefer it over `request_user_input_async`; do not repeat the question in assistant prose or send the answer as a new message."
    : "If you absolutely must ask a question because the answer cannot be discovered from local context and a reasonable assumption would be risky, ask the user directly with a concise plain-text question. Never write a multiple choice question as a textual assistant message.";
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
    "In Default mode, strongly prefer making reasonable assumptions and executing the user's request rather than stopping to ask questions.",
    questionGuidance,
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
