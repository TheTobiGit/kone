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
  "worker_targets",
  "worker_spawn",
  "worker_spawn_preset",
  "worker_spawn_batch",
  "worker_delegate",
  "worker_continue",
  "worker_wait",
  "worker_read",
  "worker_cancel",
  "worker_decline",
  "worker_answer",
  "peer_send",
  "peer_list",
  "peer_inbox",
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
  kone_spawn_targets: "worker_targets",
  kone_spawn_worker: "worker_spawn",
  kone_spawn_worker_preset: "worker_spawn_preset",
  kone_spawn_batch: "worker_spawn_batch",
  kone_delegate_to_teammate: "worker_delegate",
  kone_continue_thread: "worker_continue",
  kone_wait_for_responses: "worker_wait",
  kone_read_response: "worker_read",
  kone_cancel_worker: "worker_cancel",
  kone_decline_child_gate: "worker_decline",
  kone_answer_child_input: "worker_answer",
  kone_irc_send: "peer_send",
  kone_irc_list: "peer_list",
  kone_irc_inbox: "peer_inbox",
  kone_launch: "process_control",
  kone_lsp: "code_lsp",
  kone_ast_find_calls: "code_find_calls",
  kone_ast_preview: "code_preview_rewrite",
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
