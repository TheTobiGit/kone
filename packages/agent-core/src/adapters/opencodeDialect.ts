import { buildOpenCodeMcpServer } from "../gateway/injection.js";
import { isOpenCodeV2 } from "../opencodeHome.js";
import type { GatewayConnection, InteractionMode, ModelDescriptor } from "../types.js";
import {
  jsonNumber,
  modelSlug,
  record,
  responseData,
  textField,
  type OpenCodeJsonValue,
  type RecordLike,
} from "./opencodeJson.js";

export function permissionRules(mode: InteractionMode): RecordLike[] {
  if (mode === "full-access") {
    return [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "ask" },
    ];
  }
  if (mode === "accept-edits") {
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
  return [
    { permission: "*", pattern: "*", action: "ask" },
    ...["bash", "edit", "webfetch", "websearch", "external_directory"].map((permission) => ({
      permission,
      pattern: "*",
      action: "ask",
    })),
    { permission: "question", pattern: "*", action: "allow" },
  ];
}

export function v2PermissionAction(action: OpenCodeJsonValue): OpenCodeJsonValue {
  if (action === "bash") return "shell";
  if (action === "task") return "subagent";
  if (action === "write" || action === "patch") return "edit";
  return action;
}

export function permissionRulesV2(mode: InteractionMode): RecordLike[] {
  return permissionRules(mode).map((rule) => ({
    action: v2PermissionAction(rule.permission),
    resource: rule.pattern,
    effect: rule.action === "deny" ? "ask" : rule.action,
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
  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const data = record(parsed)?.data;
  if (!Array.isArray(data)) return [];
  return descriptorsFromModelInfos(data);
}

function descriptorsFromModelInfos(entries: unknown[]): ModelDescriptor[] {
  const models: ModelDescriptor[] = [];
  for (const entry of entries) {
    // SAFETY: entries come from a JSON-decoded array; the record probe below
    // validates each element before any field is trusted.
    const model = record(entry as OpenCodeJsonValue);
    if (!model) continue;
    if (model.enabled === false) continue;
    const variants = Array.isArray(model.variants)
      ? model.variants.flatMap((v) => {
          // SAFETY: variant entries come from a JSON-decoded array; the record
          // and textField probes validate before use.
          const vid = textField(record(v as OpenCodeJsonValue)?.id)?.trim();
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
  request(method: string, route: string, body?: OpenCodeJsonValue, signal?: AbortSignal): Promise<any>;
};

export type DialectFile = { uri: string; name: string; mime: string };

export type OpenCodeDialect = {
  readonly name: "v1" | "v2";
  /** URL prefix for every route (`""` on v1, `"/api"` on v2). */
  readonly apiPrefix: string;
  createSession(
    client: DialectClient,
    input: { cwd: string; mode: InteractionMode; model?: string; effort?: string },
  ): Promise<string | undefined>;
  forkInto(client: DialectClient, id: string, cwd: string, mode: InteractionMode): Promise<string | undefined>;
  applyMode(client: DialectClient, id: string, mode: InteractionMode): Promise<void>;
  prompt(
    client: DialectClient,
    id: string,
    input: {
      model: { providerID: string; modelID: string };
      variant?: string;
      prompt: string;
      files: DialectFile[];
    },
  ): Promise<void>;
  compact(client: DialectClient, id: string, model?: { providerID: string; modelID: string }): Promise<void>;
  interruptRoute(id: string): string;
  permissionReply(
    sessionId: string,
    requestId: string,
    decision: "once" | "always" | "reject",
  ): { route: string; body: RecordLike };
  registerMcp(client: DialectClient, connection: GatewayConnection, cwd: string): Promise<void>;
};

const openCodeDialectV1: OpenCodeDialect = {
  name: "v1",
  apiPrefix: "",

  async createSession(client, input) {
    return responseData(await client.request("POST", "/session", { permission: permissionRules(input.mode) }))?.id;
  },

  async forkInto(client, id, cwd, mode) {
    const forked: string | undefined = responseData(
      await client.request("POST", `/session/${encodeURIComponent(id)}/fork`, {
        directory: cwd,
        permission: permissionRules(mode),
      }),
    )?.id;
    if (forked) await client.request("PATCH", `/session/${encodeURIComponent(forked)}`, { permission: permissionRules(mode) });
    return forked;
  },

  async applyMode(client, id, mode) {
    await client.request("PATCH", `/session/${encodeURIComponent(id)}`, { permission: permissionRules(mode) });
  },

  async prompt(client, id, input) {
    const parts = [
      ...(input.prompt ? [{ type: "text", text: input.prompt }] : []),
      ...input.files.map((f) => ({ type: "file", mime: f.mime, filename: f.name, url: f.uri })),
    ];
    const body = input.variant ? { model: input.model, parts, variant: input.variant } : { model: input.model, parts };
    await client.request("POST", `/session/${encodeURIComponent(id)}/prompt_async`, body);
  },

  async compact(client, id, model) {
    if (!model) throw new Error("OpenCode compaction requires an active 'provider/model' selection.");
    await client.request("POST", `/session/${encodeURIComponent(id)}/summarize`, model);
  },

  interruptRoute(id) {
    return `/session/${encodeURIComponent(id)}/abort`;
  },

  permissionReply(_sessionId, requestId, decision) {
    return { route: `/permission/${encodeURIComponent(requestId)}/reply`, body: { reply: decision } };
  },

  async registerMcp(client, connection, cwd) {
    const mcpResult = responseData(
      await client.request("POST", "/mcp", {
        name: "kone",
        config: buildOpenCodeMcpServer(connection),
        directory: cwd,
      }),
    );
    const koneStatus = record(record(mcpResult)?.kone);
    if (koneStatus?.status !== "connected") {
      console.error(`[opencode] kone MCP server did not connect: ${String(koneStatus?.error ?? "unknown status")}`);
    }
  },
};

const openCodeDialectV2: OpenCodeDialect = {
  name: "v2",
  apiPrefix: "/api",

  async createSession(client, input) {
    const body: RecordLike = { permissions: permissionRulesV2(input.mode), location: { directory: input.cwd } };
    const model = modelSlug(input.model);
    if (model) {
      const ref: RecordLike = { id: model.modelID, providerID: model.providerID };
      if (input.effort) ref.variant = input.effort;
      body.model = ref;
    }
    return responseData(await client.request("POST", "/session", body))?.id;
  },

  async forkInto(client, id, cwd, mode) {
    const forked: string | undefined = responseData(await client.request("POST", `/session/${encodeURIComponent(id)}/fork`, {}))?.id;
    if (forked) {
      try {
        await client.request("POST", `/session/${encodeURIComponent(forked)}/move`, { directory: cwd });
      } catch {
        /* best effort */
      }
      await client.request("PATCH", `/session/${encodeURIComponent(forked)}`, { permissions: permissionRulesV2(mode) });
    }
    return forked;
  },

  async applyMode(client, id, mode) {
    await client.request("PATCH", `/session/${encodeURIComponent(id)}`, { permissions: permissionRulesV2(mode) });
  },

  async prompt(client, id, input) {
    const modelRef: RecordLike = { id: input.model.modelID, providerID: input.model.providerID };
    if (input.variant) modelRef.variant = input.variant;
    try {
      await client.request("POST", `/session/${encodeURIComponent(id)}/model`, { model: modelRef });
    } catch (error) {
      console.warn("[opencode] v2 model select failed, continuing on session default:", error instanceof Error ? error.message : String(error));
    }
    const files = input.files.map((f) => ({ uri: f.uri, name: f.name })).filter((f) => f.uri);
    const body: RecordLike = { text: input.prompt || "Attached files" };
    if (files.length) body.files = files;
    await client.request("POST", `/session/${encodeURIComponent(id)}/prompt`, body);
  },

  async compact(client, id) {
    await client.request("POST", `/session/${encodeURIComponent(id)}/compact`, {});
  },

  interruptRoute(id) {
    return `/session/${encodeURIComponent(id)}/interrupt`;
  },

  permissionReply(sessionId, requestId, decision) {
    return {
      route: `/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
      body: { decision },
    };
  },

  async registerMcp(client, connection, cwd) {
    const full = buildOpenCodeMcpServer(connection);
    const config = { type: "remote", url: full.url, headers: full.headers, oauth: false };
    const query = `?location[directory]=${encodeURIComponent(cwd)}`;
    await client.request("PUT", `/experimental/mcp/kone${query}`, { config });
  },
};

/** Post-start, the password line is definitive: v2 always prints one, v1
 *  never does. The probed version only decides what to *expect* before
 *  startup (server-pool wait) and which model probes to run — never the
 *  dialect of a server that is already up. */
export function dialectForServer(server: { password?: string }): OpenCodeDialect {
  return server.password ? openCodeDialectV2 : openCodeDialectV1;
}

export type ModelProbe = {
  args: string[];
  parse: (stdout: string) => ModelDescriptor[];
};

/** Probe list by version. v1 keeps its `--verbose` retry: one transient
 *  timeout must not strip context windows and reasoning efforts off the
 *  inventory. v2 goes straight to the rich `api model.list` inventory, then
 *  falls back to bare `models`. Unknown versions probe richest-first. */
export function modelProbesForVersion(version: string | undefined): ModelProbe[] {
  if (version !== undefined && isOpenCodeV2(version)) {
    return [
      { args: ["api", "model.list"], parse: parseOpenCodeModelListApi },
      { args: ["models"], parse: parseOpenCodeModels },
    ];
  }
  if (version !== undefined) {
    return [
      { args: ["models", "--verbose"], parse: parseOpenCodeModels },
      { args: ["models", "--verbose"], parse: parseOpenCodeModels },
    ];
  }
  return [
    { args: ["models", "--verbose"], parse: parseOpenCodeModels },
    { args: ["api", "model.list"], parse: parseOpenCodeModelListApi },
    { args: ["models"], parse: parseOpenCodeModels },
  ];
}
