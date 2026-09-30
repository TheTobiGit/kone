// The names kone's gateway serves its tools under, shared by the gateway that
// registers them and the renderer that shows their calls.
//
// Every name is `<family>_<verb>`: the family says what the tool acts on, the
// verb what it does. None repeats `kone` — the server a provider reaches them
// through already carries it, so a provider that qualifies a name
// (`mcp__kone__scratchpad_read`, `kone_scratchpad_read`) says it once.
//
// The app-steering tools (`app_*`) follow the same shape and are recognised by
// their family alone; this file lists the rest.

/** The worker-facing tools, by family. */
export const KONE_WORKER_TOOL_NAMES = [
  "scratchpad_read",
  "scratchpad_write",
  "agent_directory",
  "worker_start",
  "worker_start_batch",
  "agent_delegate",
  "agent_contract",
  "agent_followup",
  "agent_wait",
  "agent_read",
  "agent_withdraw",
  "agent_decline",
  "agent_answer",
  "agent_notify",
  "agent_list",
  "agent_inbox",
  "process_control",
  "code_lsp",
  "code_find_calls",
  "code_preview_rewrite",
] as const;

export type KoneWorkerToolName = (typeof KONE_WORKER_TOOL_NAMES)[number];

/** The names these tools were first served under. Stored transcripts still
 *  carry them, and an agent resuming one of those threads may call a tool by
 *  the name it last saw — both resolve to the tool it meant. */
export const LEGACY_KONE_TOOL_NAMES: Readonly<Record<string, KoneWorkerToolName>> = {
  kone_scratchpad_read: "scratchpad_read",
  kone_scratchpad_write: "scratchpad_write",
  kone_spawn_targets: "agent_directory",
  kone_spawn_worker: "worker_start",
  kone_spawn_worker_preset: "worker_start",
  kone_spawn_batch: "worker_start_batch",
  kone_delegate_to_teammate: "agent_delegate",
  kone_continue_thread: "agent_followup",
  kone_wait_for_responses: "agent_wait",
  kone_read_response: "agent_read",
  kone_cancel_worker: "agent_withdraw",
  kone_decline_child_gate: "agent_decline",
  kone_answer_child_input: "agent_answer",
  kone_irc_send: "agent_notify",
  kone_irc_list: "agent_list",
  kone_irc_inbox: "agent_inbox",
  kone_launch: "process_control",
  kone_lsp: "code_lsp",
  kone_ast_find_calls: "code_find_calls",
  kone_ast_preview: "code_preview_rewrite",

  // The worker/peer generation, before the family became `agent_*`.
  worker_targets: "agent_directory",
  worker_spawn_preset: "worker_start",
  worker_spawn_batch: "worker_start_batch",
  worker_spawn: "worker_start",
  worker_delegate: "agent_delegate",
  worker_continue: "agent_followup",
  worker_wait: "agent_wait",
  worker_read: "agent_read",
  worker_cancel: "agent_withdraw",
  worker_decline: "agent_decline",
  worker_answer: "agent_answer",
  peer_send: "agent_notify",
  peer_list: "agent_list",
  peer_inbox: "agent_inbox",

  // The agent-only generation, before workers got tools of their own: a
  // briefed worker and a preset worker are one tool now, and taking work back
  // from a delegate is a withdrawal, not a cancellation.
  agent_targets: "agent_directory",
  agent_spawn: "worker_start",
  agent_spawn_preset: "worker_start",
  agent_spawn_batch: "worker_start_batch",
  agent_ask: "agent_followup",
  agent_cancel: "agent_withdraw",
};

const WORKER_TOOL_NAME_SET: ReadonlySet<string> = new Set(KONE_WORKER_TOOL_NAMES);
const LEGACY_NAME_MAP: ReadonlyMap<string, KoneWorkerToolName> = new Map(Object.entries(LEGACY_KONE_TOOL_NAMES));

/** Whether `name` is one of kone's own tools under its current name. */
export function isKoneToolName(name: string): boolean {
  return WORKER_TOOL_NAME_SET.has(name) || name.startsWith("app_");
}

/** The current name for a tool kone once served as `name`, or `name` itself. */
export function currentKoneToolName(name: string): string {
  return LEGACY_NAME_MAP.get(name) ?? name;
}
