import {
  nonNegativeInteger,
  record,
  textField,
  type OpenCodeEvent,
  type RecordLike,
} from "./opencodeJson.js";

/** Normalize the v2 SSE vocabulary onto the v1 event shapes `handleEvent`
 *  already translates, so the translator only ever deals with one vocabulary.
 *
 *  v2 streams `{id, type, data}` (envelope unwrapped in `events()`); v1
 *  streams `{type, properties}` with `message.part.*` / `session.idle`
 *  types. The mapping below reuses the v1 paths — including `toolKind()`
 *  (todo → plan), the task/subagent routing, `reconcileOpenCodeText`, and
 *  the `session.error` turn-abort path — instead of re-implementing them
 *  per vocabulary.
 *
 *  Stateful only where v1 is stateful: text streams need their assistant
 *  message marked as `assistant` (v1 learns it from `message.updated`),
 *  and tool progress/success events that carry no name reuse the name
 *  stored when the tool started. */

export type V2SessionState = {
  messageRoleById: Map<string, string>;
  partById: Map<string, RecordLike>;
};

function v2TextItemId(p: RecordLike): string | undefined {
  const messageId = textField(p.assistantMessageID ?? p.messageID);
  if (!messageId) return undefined;
  const ord = nonNegativeInteger(p.ordinal);
  return `${messageId}:text${ord !== undefined ? `:${ord}` : ""}`;
}

function toolContentText(p: RecordLike): string | undefined {
  if (Array.isArray(p.content)) {
    const joined = p.content
      .map((c) => textField(record(c)?.text) ?? "")
      .filter(Boolean)
      .join("\n");
    if (joined) return joined;
  }
  return textField(p.error) ?? textField(p.text);
}

function knownToolName(state: V2SessionState, id: string, fallback: string): string {
  const prior = record(state.partById.get(id));
  return textField(prior?.tool) ?? fallback;
}

function toolPart(
  p: RecordLike,
  id: string,
  name: string,
  state: RecordLike,
): RecordLike {
  return {
    id,
    messageID: textField(p.assistantMessageID ?? p.messageID) ?? "",
    type: "tool",
    tool: name === "subagent" ? "task" : name,
    callID: id,
    state,
  };
}

/** Map one v2 event onto its v1 equivalent. v1 events and unknown types pass
 *  through unchanged so the caller's `default: break` drops what nothing
 *  recognizes. */
export function normalizeV2Event(state: V2SessionState, event: OpenCodeEvent): OpenCodeEvent {
  const p = event.properties ?? {};
  switch (event.type) {
    case "session.text.started":
    case "session.reasoning.started": {
      const id = v2TextItemId(p);
      const messageId = textField(p.assistantMessageID ?? p.messageID);
      if (!id || !messageId) return event;
      state.messageRoleById.set(messageId, "assistant");
      const kind = event.type === "session.reasoning.started" ? "reasoning" : "text";
      return { type: "message.part.updated", properties: { sessionID: textField(p.sessionID) ?? "", part: { id, messageID: messageId, type: kind, text: "" } } };
    }
    case "session.text.delta":
    case "session.reasoning.delta": {
      const id = v2TextItemId(p);
      const delta = textField(p.delta);
      if (!id || delta === undefined) return event;
      return { type: "message.part.delta", properties: { sessionID: textField(p.sessionID) ?? "", partID: id, delta } };
    }
    case "session.text.ended":
    case "session.reasoning.ended": {
      const id = v2TextItemId(p);
      const messageId = textField(p.assistantMessageID ?? p.messageID);
      if (!id || !messageId) return event;
      state.messageRoleById.set(messageId, "assistant");
      const kind = event.type === "session.reasoning.ended" ? "reasoning" : "text";
      const text = textField(p.text) ?? "";
      return {
        type: "message.part.updated",
        properties: { sessionID: textField(p.sessionID) ?? "", part: { id, messageID: messageId, type: kind, text, time: { end: true } } },
      };
    }
    case "session.tool.input.started": {
      const id = textField(p.id);
      if (!id) return event;
      const name = textField(p.name) ?? "tool";
      return {
        type: "message.part.updated",
        properties: {
          sessionID: textField(p.sessionID) ?? "",
          part: toolPart(p, id, name, { status: "pending", title: name }),
        },
      };
    }
    case "session.tool.input.ended":
    case "session.tool.called":
    case "session.tool.progress": {
      const id = textField(p.id);
      if (!id) return event;
      const name = textField(p.name) ?? knownToolName(state, id, "tool");
      const input = record(p.input);
      const toolState: RecordLike = { status: "running", title: textField(p.text) ?? name };
      if (input) toolState.input = input;
      return {
        type: "message.part.updated",
        properties: {
          sessionID: textField(p.sessionID) ?? "",
          part: toolPart(p, id, name, toolState),
        },
      };
    }
    case "session.tool.success":
    case "session.tool.error": {
      const id = textField(p.id);
      if (!id) return event;
      const failed = event.type === "session.tool.error";
      const name = textField(p.name) ?? knownToolName(state, id, "tool");
      const content = toolContentText(p);
      const toolState: RecordLike = failed ? { status: "error", title: name } : { status: "completed", title: name };
      if (content !== undefined) toolState[failed ? "error" : "output"] = content;
      return {
        type: "message.part.updated",
        properties: {
          sessionID: textField(p.sessionID) ?? "",
          part: toolPart(p, id, name, toolState),
        },
      };
    }
    case "session.step.ended":
    case "session.usage.updated":
      return { type: "session.next.step.ended", properties: { sessionID: textField(p.sessionID) ?? "", tokens: p.tokens ?? null } };
    case "session.execution.succeeded":
      return { type: "session.idle", properties: { sessionID: textField(p.sessionID) ?? "" } };
    case "session.execution.failed":
      return { type: "session.error", properties: { sessionID: textField(p.sessionID) ?? "", error: p.error ?? p } };
    case "session.compact.ended":
      return { type: "session.compacted", properties: { sessionID: textField(p.sessionID) ?? "" } };
    case "session.permission.asked":
      return { type: "permission.asked", properties: p };
    case "session.permission.replied":
      return { type: "permission.replied", properties: p };
    case "session.question.asked":
    case "session.form.asked":
      return { type: "question.asked", properties: p };
    case "session.question.replied":
    case "session.form.replied":
      return { type: "question.replied", properties: p };
    case "session.question.rejected":
    case "session.form.rejected":
      return { type: "question.rejected", properties: p };
    default:
      return event;
  }
}
