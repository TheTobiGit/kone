import { buildOpenCodeMcpServer } from "../gateway/injection.js";
import { isOpenCodeV2 } from "../opencodeHome.js";
import type { OpenCodeServerDialect } from "../opencodeServer.js";
import type { GatewayConnection, InteractionMode, ModelDescriptor } from "../types.js";
import {
  jsonNumber,
  modelSlug,
  record,
  responseData,
  textField,
  type OpenCodeEvent,
  type OpenCodeJsonValue,
  type RecordLike,
} from "./opencodeJson.js";
import { normalizeV2Event, type V2SessionState } from "./opencodeV2Events.js";

export function permissionRules(mode: InteractionMode): RecordLike[] {
  // Full access allows everything — except that `bash` is routed back here as an
  // ask, and answered instantly. The rung's contract is "never prompts", not
  // "never looks": a server-side blanket allow means the command never crosses
  // this process, and the handful of commands that end the machine rather than
  // the worktree are then unrefusable on the one rung with nobody to ask. The
  // ask is auto-approved in `permissionAsked` after the screen, so nothing
  // surfaces and nothing waits on a human. OpenCode resolves against the LAST
  // matching rule, so this has to come after the catch-all.
  if (mode === "full-access") {
    return [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "ask" },
    ];
  }
  if (mode === "accept-edits") {
    // Closed by default: a deny base, then explicit allows for read operations
    // and edit/write, with the mutating/network/out-of-tree families asked.
    // A deny base also blocks custom/MCP tools and future mutating tools that
    // a short denylist would accidentally leave enabled.
    return [
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "glob", pattern: "*", action: "allow" },
      { permission: "grep", pattern: "*", action: "allow" },
      { permission: "list", pattern: "*", action: "allow" },
      { permission: "lsp", pattern: "*", action: "allow" },
      { permission: "codesearch", pattern: "*", action: "allow" },
      { permission: "todoread", pattern: "*", action: "allow" },
      { permission: "todowrite", pattern: "*", action: "allow" },
      { permission: "question", pattern: "*", action: "allow" },
      { permission: "edit", pattern: "*", action: "allow" },
      { permission: "write", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "ask" },
      { permission: "webfetch", pattern: "*", action: "ask" },
      { permission: "websearch", pattern: "*", action: "ask" },
      { permission: "external_directory", pattern: "*", action: "ask" },
    ];
  }
  // Ask for everything; questions are the one family that never needs a
  // go-ahead, since answering one is already the user's input.
  return [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "question", pattern: "*", action: "allow" },
  ];
}

/** v2 renamed a few permission families; everything else keeps its v1 name. */
export function v2PermissionAction(action: OpenCodeJsonValue): OpenCodeJsonValue {
  if (action === "bash") return "shell";
  if (action === "task") return "subagent";
  if (action === "write" || action === "patch") return "edit";
  return action;
}

/** The same ladders in v2's `{action, resource, effect}` spelling. Order and
 *  effects carry over unchanged — v2 accepts `deny`, so accept-edits keeps its
 *  closed base, and the full-access bash ask still comes last. */
export function permissionRulesV2(mode: InteractionMode): RecordLike[] {
  return permissionRules(mode).map((rule) => ({
    action: v2PermissionAction(rule.permission),
    resource: rule.pattern,
    effect: rule.action,
  }));
}

/** Shared descriptor builder for both model inventories: one place defines
 *  the label/context/efforts/default-effort block. */
export function modelDescriptor(input: {
  providerId: string;
  modelId: string;
  name: string;
  variantIds?: string[];
  context?: OpenCodeJsonValue;
}): ModelDescriptor | undefined {
  const providerId = input.providerId.trim();
  const modelId = input.modelId.trim();
  const name = input.name.trim();
  if (!providerId || !modelId || !name) return undefined;
  const variants = input.variantIds?.map((v) => v.trim()).filter(Boolean) ?? [];
  const ctx = input.context;
  const contextWindowTokens = jsonNumber(ctx) && ctx > 0 ? ctx : undefined;
  const descriptor: ModelDescriptor = { id: `${providerId}/${modelId}`, label: name };
  if (contextWindowTokens !== undefined) descriptor.contextWindowTokens = contextWindowTokens;
  if (variants.length) descriptor.reasoningEfforts = variants;
  if (variants.includes("medium")) descriptor.defaultReasoningEffort = "medium";
  else if (variants.includes("high")) descriptor.defaultReasoningEffort = "high";
  return descriptor;
}

const SLUG_LINE = /^(\S+\/\S+)\s*$/;

export function parseOpenCodeModels(stdout: string): ModelDescriptor[] {
  const models: ModelDescriptor[] = [];
  let slug: string | undefined;
  let json: string[] = [];
  const flush = () => {
    if (!slug) return;
    const raw = json.join("\n").trim();
    if (!raw) {
      models.push({ id: slug, label: slug });
      return;
    }
    try {
      // SAFETY: JSON.parse yields unknown; the field probes below validate before use.
      const model = JSON.parse(json.join("\n")) as RecordLike;
      const name = textField(model.name)?.trim() ?? "";
      if (!name) return;
      const providerId = textField(model.providerID)?.trim() ?? "";
      const modelId = textField(model.id)?.trim() ?? "";
      const id = providerId && modelId ? `${providerId}/${modelId}` : slug;
      const variants = record(model.variants);
      const efforts = variants ? Object.keys(variants) : [];
      // The slug always carries provider/model (SLUG_LINE matched), so the
      // descriptor below is defined whenever a name is present.
      const descriptor = modelDescriptor({
        providerId: providerId || slug.split("/")[0]!,
        modelId: modelId || slug.split("/").slice(1).join("/"),
        name,
        variantIds: efforts,
        context: record(model.limit)?.context,
      });
      if (descriptor) {
        descriptor.id = id;
        models.push(descriptor);
      }
    } catch {
      /* skip one malformed block */
    }
  };
  for (const line of stdout.split("\n")) {
    const match = line.match(SLUG_LINE);
    if (match) {
      flush();
      slug = match[1];
      json = [];
      continue;
    }
    if (slug) json.push(line);
  }
  flush();
  return models;
}

/** Parse `{data: Model.Info[]}` from `opencode api model.list`. Accepts only
 *  the `{data: [...]}` envelope. */
export function parseOpenCodeModelListApi(stdout: string): ModelDescriptor[] {
  let parsed: OpenCodeJsonValue;
  try {
    // SAFETY: JSON.parse only ever yields JSON values; every field is probed
    // before it is trusted.
    parsed = JSON.parse(stdout) as OpenCodeJsonValue;
  } catch {
    return [];
  }
  const data = record(parsed)?.data;
  if (!Array.isArray(data)) return [];
  return descriptorsFromModelInfos(data);
}

function descriptorsFromModelInfos(entries: OpenCodeJsonValue[]): ModelDescriptor[] {
  const models: ModelDescriptor[] = [];
  for (const entry of entries) {
    const model = record(entry);
    if (!model) continue;
    if (model.enabled === false) continue;
    const variants = Array.isArray(model.variants)
      ? model.variants.flatMap((v) => {
          const vid = textField(record(v)?.id)?.trim();
          return vid ? [vid] : [];
        })
      : [];
    const descriptor = modelDescriptor({
      providerId: textField(model.providerID) ?? "",
      modelId: textField(model.modelID) ?? "",
      name: textField(model.name) ?? "",
      variantIds: variants,
      context: record(model.limit)?.context,
    });
    if (descriptor) models.push(descriptor);
  }
  return models;
}

export type DialectClient = {
  request(method: string, route: string, body?: OpenCodeJsonValue, signal?: AbortSignal): Promise<OpenCodeJsonValue>;
};

export type DialectFile = { uri: string; name: string; mime: string };

type ModelRef = { providerID: string; modelID: string };

/** Everything that differs between the two server protocols, in one place.
 *  The adapter never branches on the version itself: it picks a dialect once,
 *  from the server's listening line, and calls through it. */
export type OpenCodeDialect = {
  readonly name: OpenCodeServerDialect;
  /** URL prefix for every route (`""` on v1, `"/api"` on v2). */
  readonly apiPrefix: string;
  /** One decoded SSE frame, in the event vocabulary the adapter translates.
   *  Undefined for a frame with no type. */
  decodeEvent(raw: RecordLike, state: V2SessionState): OpenCodeEvent | undefined;
  createSession(
    client: DialectClient,
    input: { cwd: string; mode: InteractionMode; model?: string; effort?: string },
  ): Promise<string | undefined>;
  forkInto(client: DialectClient, id: string, cwd: string, mode: InteractionMode): Promise<string | undefined>;
  applyMode(client: DialectClient, id: string, mode: InteractionMode): Promise<void>;
  prompt(
    client: DialectClient,
    id: string,
    input: { model: ModelRef; variant?: string; prompt: string; files: DialectFile[] },
  ): Promise<void>;
  compact(client: DialectClient, id: string, model?: ModelRef): Promise<void>;
  interruptRoute(id: string): string;
  permissionReply(sessionId: string, requestId: string, decision: "once" | "always" | "reject"): { route: string; body: RecordLike };
  /** `answers` is one row of selected labels per question, in question order. */
  questionReply(sessionId: string, requestId: string, answers: string[][]): { route: string; body: RecordLike };
  registerMcp(client: DialectClient, connection: GatewayConnection, cwd: string): Promise<void>;
};

function sessionRoute(id: string, tail = ""): string {
  return `/session/${encodeURIComponent(id)}${tail}`;
}

function createdId(response: OpenCodeJsonValue): string | undefined {
  return textField(responseData(response)?.id);
}

function eventOf(raw: RecordLike, properties: RecordLike | undefined): OpenCodeEvent | undefined {
  const type = textField(raw.type);
  return type === undefined ? undefined : { type, properties: properties ?? {} };
}

const openCodeDialectV1: OpenCodeDialect = {
  name: "v1",
  apiPrefix: "",

  decodeEvent(raw) {
    return eventOf(raw, record(raw.properties));
  },

  async createSession(client, input) {
    return createdId(await client.request("POST", "/session", { permission: permissionRules(input.mode) }));
  },

  async forkInto(client, id, cwd, mode) {
    const forked = createdId(
      await client.request("POST", sessionRoute(id, "/fork"), { directory: cwd, permission: permissionRules(mode) }),
    );
    if (forked) await this.applyMode(client, forked, mode);
    return forked;
  },

  async applyMode(client, id, mode) {
    await client.request("PATCH", sessionRoute(id), { permission: permissionRules(mode) });
  },

  async prompt(client, id, input) {
    const parts: RecordLike[] = input.files.map((f) => ({ type: "file", mime: f.mime, filename: f.name, url: f.uri }));
    if (input.prompt) parts.unshift({ type: "text", text: input.prompt });
    const body: RecordLike = { model: input.model, parts };
    if (input.variant) body.variant = input.variant;
    await client.request("POST", sessionRoute(id, "/prompt_async"), body);
  },

  async compact(client, id, model) {
    if (!model) throw new Error("OpenCode compaction requires an active 'provider/model' selection.");
    await client.request("POST", sessionRoute(id, "/summarize"), model);
  },

  interruptRoute(id) {
    return sessionRoute(id, "/abort");
  },

  permissionReply(_sessionId, requestId, decision) {
    return { route: `/permission/${encodeURIComponent(requestId)}/reply`, body: { reply: decision } };
  },

  questionReply(_sessionId, requestId, answers) {
    return { route: `/question/${encodeURIComponent(requestId)}/reply`, body: { answers } };
  },

  async registerMcp(client, connection, cwd) {
    const mcpResult = responseData(
      await client.request("POST", "/mcp", {
        name: "kone",
        config: buildOpenCodeMcpServer(connection),
        directory: cwd,
      }),
    );
    const koneStatus = record(mcpResult?.kone);
    if (koneStatus?.status !== "connected") {
      console.error(`[opencode] kone MCP server did not connect: ${String(koneStatus?.error ?? "unknown status")}`);
    }
  },
};

const openCodeDialectV2: OpenCodeDialect = {
  name: "v2",
  apiPrefix: "/api",

  // v2 frames are `{id, type, data}`; the payload is lifted into `properties`
  // with its session id on top, then re-spelled onto the v1 vocabulary.
  decodeEvent(raw, state) {
    const data = record(raw.data);
    const event = eventOf(raw, record(raw.properties) ?? (data ? { sessionID: textField(data.sessionID) ?? "", ...data } : undefined));
    return event && normalizeV2Event(state, event);
  },

  async createSession(client, input) {
    const body: RecordLike = { permissions: permissionRulesV2(input.mode), location: { directory: input.cwd } };
    const model = modelSlug(input.model);
    if (model) {
      const ref: RecordLike = { id: model.modelID, providerID: model.providerID };
      if (input.effort) ref.variant = input.effort;
      body.model = ref;
    }
    return createdId(await client.request("POST", "/session", body));
  },

  // v2's fork takes no directory, so the copy is moved into the working
  // directory before its rules are applied. A failed move fails the fork: the
  // session would otherwise run against the source thread's directory.
  async forkInto(client, id, cwd, mode) {
    const forked = createdId(await client.request("POST", sessionRoute(id, "/fork"), {}));
    if (forked) {
      await client.request("POST", sessionRoute(forked, "/move"), { directory: cwd });
      await this.applyMode(client, forked, mode);
    }
    return forked;
  },

  async applyMode(client, id, mode) {
    await client.request("PATCH", sessionRoute(id), { permissions: permissionRulesV2(mode) });
  },

  // v2 selects the model on the session rather than per prompt. A refused
  // selection fails the turn instead of quietly running it on another model.
  async prompt(client, id, input) {
    const modelRef: RecordLike = { id: input.model.modelID, providerID: input.model.providerID };
    if (input.variant) modelRef.variant = input.variant;
    await client.request("POST", sessionRoute(id, "/model"), { model: modelRef });
    const files = input.files.map((f) => ({ uri: f.uri, name: f.name })).filter((f) => f.uri);
    const body: RecordLike = { text: input.prompt || "Attached files" };
    if (files.length) body.files = files;
    await client.request("POST", sessionRoute(id, "/prompt"), body);
  },

  async compact(client, id) {
    await client.request("POST", sessionRoute(id, "/compact"), {});
  },

  interruptRoute(id) {
    return sessionRoute(id, "/interrupt");
  },

  permissionReply(sessionId, requestId, decision) {
    return { route: sessionRoute(sessionId, `/permission/${encodeURIComponent(requestId)}/reply`), body: { decision } };
  },

  questionReply(sessionId, requestId, answers) {
    return { route: sessionRoute(sessionId, `/question/${encodeURIComponent(requestId)}/reply`), body: { answers } };
  },

  async registerMcp(client, connection, cwd) {
    const full = buildOpenCodeMcpServer(connection);
    const config = { type: "remote", url: full.url, headers: full.headers, oauth: false };
    const query = `?location[directory]=${encodeURIComponent(cwd)}`;
    await client.request("PUT", `/experimental/mcp/kone${query}`, { config });
  },
};

export function dialectForServer(server: { dialect: OpenCodeServerDialect }): OpenCodeDialect {
  return server.dialect === "v2" ? openCodeDialectV2 : openCodeDialectV1;
}

export type ModelProbe = {
  args: string[];
  parse: (stdout: string) => ModelDescriptor[];
  /** Tries before moving to the next probe. */
  attempts: number;
};

/** Probe list by version. v1 retries `--verbose` once: one transient timeout
 *  must not strip context windows and reasoning efforts off the inventory. v2
 *  goes straight to the rich `api model.list` inventory, then falls back to
 *  bare `models`. Unknown versions probe richest-first. */
export function modelProbesForVersion(version: string | undefined): ModelProbe[] {
  const verbose: ModelProbe = { args: ["models", "--verbose"], parse: parseOpenCodeModels, attempts: 1 };
  const modelList: ModelProbe = { args: ["api", "model.list"], parse: parseOpenCodeModelListApi, attempts: 1 };
  const bare: ModelProbe = { args: ["models"], parse: parseOpenCodeModels, attempts: 1 };
  if (version === undefined) return [verbose, modelList, bare];
  if (isOpenCodeV2(version)) return [modelList, bare];
  return [{ ...verbose, attempts: 2 }];
}
