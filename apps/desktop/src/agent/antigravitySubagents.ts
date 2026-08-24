import { fileURLToPath } from "node:url";

// Parsers for Antigravity's native subagents — the `invoke_subagent` tool.
//
// A native subagent is a second agy conversation, not a nested tool result: the
// parent hands it a brief, agy answers with the child's own conversation id and
// transcript path, and the child then runs independently until it messages the
// parent back. Three artifacts describe that lifecycle, and this module turns
// each of them into plain data:
//
//   1. the `invoke_subagent` call's arguments — one brief per child, in order;
//   2. the tool result step that names the children it actually created;
//   3. the SYSTEM_MESSAGE the parent receives when a child reports back.
//
// The child's live activity is not here: it arrives on the capture-hook stream
// tagged with the child's own conversation id, and through the child's own
// transcript file, which the adapter tails exactly like the parent's.

/** The brief handed to one child, as the `invoke_subagent` arguments carry it.
 *  Every field is optional because the tool's arguments are the model's to
 *  write. */
export type AntigravitySubagentSpec = {
  /** `Role` — the child's one-line label. */
  role?: string;
  /** `TypeName` — which built-in subagent kind was invoked (`research`,
   *  `self`), or a custom one the agent defined. */
  typeName?: string;
  /** `Prompt` — the brief itself. */
  prompt?: string;
  /** `Model`, unless it is the `inherit` sentinel (which names no model). */
  model?: string;
};

/** One child agy actually created, from the `invoke_subagent` result. */
export type AntigravitySubagentHandle = {
  conversationId: string;
  /** Filesystem path of the child's transcript, from its `file://` URI. */
  transcriptPath?: string;
};

/** A message another conversation sent into this one. Children report their
 *  results this way, and `sender` is the child's conversation id — the same id
 *  its hook lines and transcript carry. */
export type AntigravityInboundMessage = {
  sender: string;
  content: string;
};

// ── decoding ─────────────────────────────────────────────────────────────────

export type AntigravityJsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | AntigravityJsonRecord
  | AntigravityJsonValue[];

export interface AntigravityJsonRecord {
  [key: string]: AntigravityJsonValue;
}

function isRecord(value: AntigravityJsonValue | undefined): value is AntigravityJsonRecord {
  return value instanceof Object && !Array.isArray(value);
}

/** Decoded JSON numbers are always finite, so finiteness separates the number
 *  variant from every other JSON variant without inspecting representations. */
function isNumber(value: AntigravityJsonValue | undefined): value is number {
  return Number.isFinite(value);
}

/** Text is the one JSON variant left after every other variant is excluded by
 *  identity — booleans by value, numbers by finiteness, composites by their
 *  constructors. */
function readText(value: AntigravityJsonValue | undefined): string | undefined {
  if (value === undefined || value === null || value === true || value === false) return undefined;
  if (Array.isArray(value) || value instanceof Object || isNumber(value)) return undefined;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : undefined;
}

/** Tool arguments arrive JSON-encoded inside the JSON step, so a text value is
 *  one `JSON.parse` away from the structure it stands for. */
function decodeArgument(value: AntigravityJsonValue | undefined): AntigravityJsonValue | undefined {
  const text = readText(value);
  if (text === undefined) return value;
  try {
    // SAFETY: JSON.parse yields exactly the JSON domain this type names, and
    // every reader below still narrows before use.
    return JSON.parse(text) as AntigravityJsonValue;
  } catch {
    return value;
  }
}

/** The briefs an `invoke_subagent` call carries, in the order it listed them —
 *  which is the order the result names the children it created, and the only
 *  thing that binds a brief to a conversation id. */
export function parseInvokeSubagentSpecs(
  args: AntigravityJsonRecord | undefined,
): AntigravitySubagentSpec[] {
  const decoded = decodeArgument(args?.Subagents);
  if (!Array.isArray(decoded)) return [];
  return decoded.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const spec: AntigravitySubagentSpec = {};
    const role = readText(entry.Role);
    const typeName = readText(entry.TypeName);
    const prompt = readText(entry.Prompt);
    const model = readText(entry.Model);
    if (role) spec.role = role;
    if (typeName) spec.typeName = typeName;
    if (prompt) spec.prompt = prompt;
    // `inherit` means "whatever the parent runs" — it names no model, so
    // reporting it as one would put a sentinel on the user's screen.
    if (model && model !== "inherit") spec.model = model;
    return [spec];
  });
}

const CREATED_SUBAGENTS_MARKER = "Created the following subagents";
const CONVERSATION_ID_PATTERN = /"conversationId"\s*:\s*"([^"]+)"/g;
const LOG_URI_PATTERN = /"logAbsoluteUri"\s*:\s*"([^"]+)"/g;

function pathFromFileUri(uri: string): string | undefined {
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

/** The children named by an `invoke_subagent` result step. The result is not
 *  JSON — it is a human-readable preamble followed by one JSON object per
 *  child — so this reads the two fields it needs positionally rather than
 *  parsing the whole thing. */
export function parseCreatedSubagents(content: string | undefined): AntigravitySubagentHandle[] {
  if (!content || !content.includes(CREATED_SUBAGENTS_MARKER)) return [];
  const ids = [...content.matchAll(CONVERSATION_ID_PATTERN)].map((match) => match[1]!);
  const uris = [...content.matchAll(LOG_URI_PATTERN)].map((match) => match[1]!);
  return ids.map((conversationId, index) => {
    const handle: AntigravitySubagentHandle = { conversationId };
    const uri = uris[index];
    const transcriptPath = uri ? pathFromFileUri(uri) : undefined;
    if (transcriptPath) handle.transcriptPath = transcriptPath;
    return handle;
  });
}

const INBOUND_MESSAGE_PATTERN =
  /\[Message\][^\n]*?sender=(\S+)[^\n]*?content=([\s\S]*?)\n<\/SYSTEM_MESSAGE>/;

/** The message a SYSTEM_MESSAGE step delivered, when it is one conversation
 *  writing to another. Returns undefined for anything else — including agy's
 *  own `sender=system` notices, which are the CLI talking about itself, not a
 *  child reporting in. */
export function parseInboundMessage(content: string | undefined): AntigravityInboundMessage | undefined {
  if (!content) return undefined;
  const match = INBOUND_MESSAGE_PATTERN.exec(content);
  if (!match) return undefined;
  const sender = match[1]!.trim();
  const body = match[2]!.trim();
  if (!sender || sender === "system" || !body) return undefined;
  return { sender, content: body };
}
