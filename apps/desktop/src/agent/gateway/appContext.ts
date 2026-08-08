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

/** Versioned marker so a host-context block in a transcript can be dated —
export const KONE_HOST_CONTEXT_VERSION = "2026-08-07.1";
export const KONE_HOST_CONTEXT_MARKER = `[kone host context ${KONE_HOST_CONTEXT_VERSION}]`;

 *  identity first, then the gateway tools and when to use them. */
export function renderKoneHostContext(gatewayControlAvailable: boolean): string {
  if (!gatewayControlAvailable) {
    return [
      KONE_HOST_CONTEXT_MARKER,
      "You are running inside kone, a desktop app for AI-assisted development.",
      "kone's app gateway is unavailable in this session, so no kone_* tools are installed. Do not claim you can read or write kone's project scratchpad.",
    ].join("\n");
  }
  return [
    KONE_HOST_CONTEXT_MARKER,
    "You are running inside kone, a desktop app for AI-assisted development. kone hosts this agent session and renders your work on the user's project board.",
    "The `kone` MCP server is kone's app gateway: your native connection to the app the user is looking at. App tools are part of your job — when one fits, use it instead of inventing file-based workarounds. Tool names may carry an MCP prefix (e.g. `mcp__kone__kone_scratchpad_read`); the semantics are the same.",
    "`kone_scratchpad_read` reads this project's scratchpad: a notes board the user sees live on kone's project page, and your durable shared memory for the project — it persists across sessions. Read it when the user references their notes, or to ground yourself in prior decisions before acting.",
    "`kone_scratchpad_write` updates that board, and it re-renders on the user's page as you write. Use it to record plans, decisions, and durable notes the user will keep reading after this conversation; append: true merges new notes safely, and writes are attributed to this agent.",
    "The scratchpad is the one place agent work and the user's own edits meet: read before overwriting, prefer append for additions, and treat revision conflicts (the web editor saved) as the user's word.",
  ].join("\n");
}

/** Claude system channel: the block layered onto the stock claude_code preset
 *  via the SDK's preset `append` (sdk.d.ts: "Use default prompt with appended
 *  instructions"). Empty when the session has no gateway connection — the
 *  adapter then appends nothing, keeping the preset pristine. */
export function claudeSystemPromptAppend(gatewayControlAvailable: boolean): string {
  return gatewayControlAvailable ? renderKoneHostContext(true) : "";
}

/** Codex envelope default when kone hasn't selected a model. The app-server
 *  schema requires `collaborationMode.settings.model` (Schema.String, not
 *  optional); both references hardcode an envelope fallback the same way
 *  `model` whenever one is known, which stays authoritative, so this slug
 *  only rides along on provider-default sessions. */
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
 *  the session has no gateway connection. */
export function buildCodexTurnCollaborationMode(input: {
  model?: string;
  effort?: string;
  gatewayControlAvailable: boolean;
}): CodexTurnCollaborationMode | undefined {
  const developerInstructions = codexDeveloperInstructions(input.gatewayControlAvailable);
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
export function codexDeveloperInstructions(gatewayControlAvailable: boolean): string | undefined {
  if (!gatewayControlAvailable) return undefined;
  return [
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
    "",
    renderKoneHostContext(true),
  ].join("\n");
}

/** Phase B first-prompt channel: the block wrapped so it can't be mistaken
 *  for user text and prepended to the first user prompt — for providers
 *  prependT3OrchestrationInstructions. */
export function prependKoneHostContext(prompt: string): string {
  return `<kone_host_context>${renderKoneHostContext(true).trim()}</kone_host_context>\n\n<user_request>\n${prompt}\n</user_request>`;
}

/** Phase B helper: fire the first-prompt channel once per session, on the
export function koneHostContextForFirstRun(input: {
  prompt: string;
  runOrdinal: number;
  gatewayControlAvailable: boolean;
}): string {
  return input.runOrdinal === 1 && input.gatewayControlAvailable
    ? prependKoneHostContext(input.prompt)
    : input.prompt;
}
