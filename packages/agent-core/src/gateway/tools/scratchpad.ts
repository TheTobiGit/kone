// Scratchpad gateway tools (docs/mcp-gateway-design.md §6).
//
// The scratchpad is the user's own notes for a project, a pane in the studio.
// Agents read it when the user points them at it and write it when the user
// asks; it is not agent memory and not a channel between agents. v1 speaks the current
// single-pad model — read without a scratchpadId resolves the project's
// most-recently-updated pad; write targets that pad (creating it when the
// project has none). The list-read stays for future multi-pad.
//
// Write semantics:
// - `append: true` → server-side atomic append ("\n\n" + body) inside the
//   store — no client read-modify-write race, no prior read required.
// - `expectedRevision` → optimistic lock against the web editor (the revision
//   source of truth); a stale value is a `revision_conflict` carrying the
//   current revision. Omit = unconditional overwrite.
// - `clientRequestId` → idempotency (docs/mcp-gateway-design.md §7): the same
//   (thread, turn, clientRequestId) with the same content replays the stored
//   post-write result; with different content it's an `idempotency_conflict`.
// - Attribution: every write result and every `scratchpad.updated` event
//   carries `writer: { model, provider }` from the calling session, so the
//   pane can render "written by <model> via kone".

import { randomUUID } from "node:crypto";

import type { EmitEvent, RuntimeEvent } from "../../types.js";
import type { ScratchpadRecord } from "../../ConversationStore.js";
import type {
  GatewayRecord,
  GatewayToolContext,
  GatewayToolResult,
  ScratchpadPayload,
  ToolEntry,
} from "../schemas.js";
import {
  GatewayToolError,
  ScratchpadReadInputSchema,
  ScratchpadWriteInputSchema,
  SCRATCHPAD_READ_JSON_SCHEMA,
  SCRATCHPAD_WRITE_JSON_SCHEMA,
} from "../schemas.js";
import { gatewayToolErrorResult } from "../registry.js";

/** The store surface the scratchpad tools need — structural, so unit tests can
 *  substitute an in-memory fake. The real ConversationStore satisfies it. */
export interface ScratchpadStore {
  listScratchpads(projectPath: string): ScratchpadRecord[];
  getScratchpad(padId: string): ScratchpadRecord | null;
  saveScratchpad(input: {
    padId: string;
    projectPath: string;
    title: string;
    body: string;
    expectedRevision?: number;
    append?: boolean;
  }): { savedAt: number; revision: number } | { conflict: number } | null;
  reserveGatewayOp(input: {
    threadId: string;
    turnId: string;
    requestId: string;
    kind: string;
    fingerprint: string;
  }): { kind: "reserved" } | { kind: "replay"; result: unknown } | { kind: "conflict" } | null;
  setGatewayOpResult(input: {
    threadId: string;
    turnId: string;
    requestId: string;
    resultJson: string;
  }): void;
}

/** Stable FNV-1a hex over the canonicalized write — the idempotency
 *  fingerprint, not a security boundary. */
function fingerprintOf(parts: Array<string | number | undefined>): string {
  let hash = 0x811c9dc5;
  const canonical = parts.map((part) => (part === undefined ? "" : String(part))).join("\u0001");
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

export interface ScratchpadToolInput {
  store: ScratchpadStore;
  emit: EmitEvent;
}

/** The project's current pad: most-recently-updated row, per the single-pad
 *  model the web board collapsed onto. */
function currentPad(store: ScratchpadStore, projectPath: string) {
  const pads = store.listScratchpads(projectPath);
  return pads.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0] ?? null;
}

export function createScratchpadTools(input: ScratchpadToolInput): ToolEntry[] {
  const readHandler = async (
    ctx: GatewayToolContext,
    args: { scratchpadId?: string },
  ): Promise<GatewayToolResult> => {
    const pad = args.scratchpadId
      ? input.store.getScratchpad(args.scratchpadId)
      : currentPad(input.store, ctx.cwd);
    if (!pad) {
      return gatewayToolErrorResult(
        new GatewayToolError("not_found", "No scratchpad for this project yet.", {
          projectPath: ctx.cwd,
        }),
      );
    }
    const payload: ScratchpadPayload = {
      id: pad.id,
      title: pad.title,
      body: pad.body,
      revision: pad.revision,
      savedAt: pad.updatedAt,
    };
    return {
      content: [{ type: "text", text: pad.body }],
      structuredContent: { pad: payload },
    };
  };

  const writeHandler = async (
    ctx: GatewayToolContext,
    args: { title: string; body: string; append?: boolean; expectedRevision?: number; clientRequestId?: string },
  ): Promise<GatewayToolResult> => {
    // The event carries the writer as-is, while the JSON payload omits model
    // when unknown — undefined has no representation in decoded data.
    const writer = { model: ctx.model, provider: ctx.provider };
    const resultWriter: GatewayRecord = { provider: ctx.provider };
    if (ctx.model !== undefined) resultWriter.model = ctx.model;

    // 1. Idempotency reserve (docs/mcp-gateway-design.md §7). Keys come from
    //    the bound authority context — never agent-supplied fields.
    let reserved = false;
    let opKey: { threadId: string; turnId: string; requestId: string } | null = null;
    if (args.clientRequestId && ctx.turnId) {
      opKey = {
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        requestId: args.clientRequestId,
      };
      const fingerprint = fingerprintOf([
        "scratchpad.write",
        args.title,
        args.body,
        args.append ? 1 : 0,
        args.expectedRevision,
      ]);
      const reserve = input.store.reserveGatewayOp({
        ...opKey,
        kind: "scratchpad.write",
        fingerprint,
      });
      if (reserve === null) {
        return gatewayToolErrorResult(
          new GatewayToolError("internal", "Idempotency reserve failed."),
        );
      }
      if (reserve.kind === "replay") {
        // SAFETY: the replayed payload is canonical JSON this store recorded
        // from a prior GatewayToolResult, so every field is plain data.
        return {
          content: [{ type: "text", text: "Replayed prior scratchpad write." }],
          structuredContent: reserve.result as GatewayRecord,
        };
      }
      if (reserve.kind === "conflict") {
        return gatewayToolErrorResult(
          new GatewayToolError(
            "idempotency_conflict",
            "This clientRequestId was already used for a different scratchpad write.",
          ),
        );
      }
      reserved = true;
    }

    // 2. Resolve the target pad (single-pad model — create on first write).
    const current = currentPad(input.store, ctx.cwd);
    const scratchpadId = current?.id ?? randomUUID();

    // 3. Revision guard + upsert, atomically inside the store.
    const saved = input.store.saveScratchpad({
      padId: scratchpadId,
      projectPath: ctx.cwd,
      title: args.title,
      body: args.body,
      expectedRevision: args.expectedRevision,
      append: args.append,
    });
    if (saved === null) {
      return gatewayToolErrorResult(
        new GatewayToolError("internal", "Scratchpad save failed."),
      );
    }
    if ("conflict" in saved) {
      return gatewayToolErrorResult(
        new GatewayToolError(
          "revision_conflict",
          "The scratchpad changed since this write was based on it (the web editor may have saved).",
          { currentRevision: saved.conflict },
        ),
      );
    }

    const payload: ScratchpadPayload = {
      id: scratchpadId,
      title: args.title,
      body: args.append && current ? `${current.body}\n\n${args.body}` : args.body,
      revision: saved.revision,
      savedAt: saved.savedAt,
    };
    const result = { pad: payload, savedAt: saved.savedAt, revision: saved.revision, writer: resultWriter };

    // 4. Publish the write to the web board (live update, revision-aware).
    const event: RuntimeEvent = {
      type: "scratchpad.updated",
      threadId: ctx.threadId,
      provider: ctx.provider,
      at: Date.now(),
      source: "kone.store",
      scratchpadId,
      projectPath: ctx.cwd,
      title: args.title,
      body: payload.body,
      revision: saved.revision,
      savedAt: saved.savedAt,
      writer,
    };
    input.emit(event);

    // 5. Record the result so an ambiguous-network-failure retry replays.
    if (reserved && opKey) {
      input.store.setGatewayOpResult({
        ...opKey,
        resultJson: JSON.stringify(result),
      });
    }

    return {
      content: [{ type: "text", text: `Scratchpad saved (revision ${saved.revision}).` }],
      structuredContent: result,
    };
  };

  return [
    {
      name: "scratchpad_read",
      description:
        "Read this project's scratchpad: the user's own notes for the project, kept in a studio pane. Read it when the user points you at their notes. It is not a store for your own plans or state, and not a channel between agents. Omit scratchpadId for the project's current pad.",
      inputSchema: ScratchpadReadInputSchema,
      jsonSchema: SCRATCHPAD_READ_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet:
        "Read the user's notes for this project, when they point you at them.",
      promptGuidelines: [
        "The scratchpad belongs to the user: their notes for the project, not a place for your own plans, progress or handoffs, and not a channel between agents. Read it when the user points you at it and write to it only when they ask. When you do write, prefer append, and on a revision conflict re-read rather than overwrite their edits.",
      ],
      handler: readHandler,
    },
    {
      name: "scratchpad_write",
      description:
        "Write to this project's scratchpad, the user's own notes for the project. Use it only when the user asks you to add to or edit their notes, never for your own plans, progress or handoffs. append: true adds to the end (safe without a read first); omitting it replaces the whole pad. expectedRevision makes the write fail rather than overwrite the user's own edits; clientRequestId makes a retry safe. The pad updates live for the user, and writes are attributed to this session.",
      inputSchema: ScratchpadWriteInputSchema,
      jsonSchema: SCRATCHPAD_WRITE_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      promptSnippet:
        "Add to or edit the user's project notes, when they ask you to.",
      handler: writeHandler,
    },
  ];
}
