// The app's own agent roster, as gateway tools: who the user can hand a thread
// to, and the agent the next turn goes to.
//
// The same division of labour as the theme tools next door, and for the same
// reason. The renderer owns the roster — the agents kone ships are prose in its
// bundle, and a stored row is a *delta* against one, so resolving what a
// cleared field falls back to is only possible there. It pushes the resolved
// roster to the shell; these tools read it back, and every write is emitted as
// an `app.agent_mutation` the renderer performs through the same code path the
// settings pane uses. Nothing here duplicates the inheritance rules, which is
// what stops the two drifting apart.

import { randomUUID } from "node:crypto";

import type { EmitEvent, RuntimeEvent } from "../../types.js";
import {
  CreateAppAgentInputSchema,
  DeleteAppAgentInputSchema,
  ListAppAgentsInputSchema,
  SetActiveAgentInputSchema,
  UpdateAppAgentInputSchema,
  CREATE_APP_AGENT_JSON_SCHEMA,
  DELETE_APP_AGENT_JSON_SCHEMA,
  LIST_APP_AGENTS_JSON_SCHEMA,
  SET_ACTIVE_AGENT_JSON_SCHEMA,
  UPDATE_APP_AGENT_JSON_SCHEMA,
  type CreateAppAgentInput,
  type DeleteAppAgentInput,
  type ListAppAgentsInput,
  type SetActiveAgentInput,
  type UpdateAppAgentInput,
  GatewayToolError,
  type GatewayRecord,
} from "../schemas.js";
import type { GatewayToolContext, GatewayToolResult, ToolEntry } from "../registry.js";
import { modelRefPayload, squash } from "../helpers.js";
import {
  isSkillInternallyEnabled,
  readInternalSkillsSettings,
  type InternalSkillsSettings,
} from "../../skillsSettings.js";

/**
 * One agent as the renderer reports it: resolved, so every field here is what
 * the roster actually shows rather than a row's half-answer.
 *
 * Deliberately flatter than the renderer's own `Agent` — a drawn face and a
 * roster sort order say nothing to a model, and the two paint colours are here
 * only because an agent can be asked to recolour one.
 */
export interface AgentRosterEntry {
  id: string;
  name: string;
  /** The line under the name. Empty when the agent has none. */
  role: string;
  /** The agent's standing orders — what reaches a model when a thread is handed
   *  to it. Empty when the agent is nothing but a name and a face. */
  instructions: string;
  /** The face's two colours, so a recolour can be described relative to what is
   *  already there. */
  face: { body: string; ink: string };
  /** The one model the agent runs on first, or null to inherit — at which
   *  point each turn (or a spawned child) rides its caller. */
  model: { provider: string; model: string; label?: string } | null;
  /** Ordered fallbacks behind `model`. Empty when the agent inherits or has
   *  no second choice. */
  modelFallbacks: readonly { provider: string; model: string; label?: string }[];
  /** The skills assigned to the agent, by name. Additive, so empty is none. */
  skills: readonly string[];
  /** True for an agent kone ships. Worth reporting: clearing a field on a
   *  built-in hands it back to the shipped value, and on a user-made agent
   *  unsets it — the same call means two different things. */
  builtIn: boolean;
  /** True for the agent the user's next turn is handed to. Nobody being active
   *  is the shipped default and means the next turn runs as a guest. */
  active: boolean;
  /** The project paths whose team this agent is on. */
  teams: readonly string[];
}

export interface AppAgentToolOptions {
  emit?: EmitEvent;
  /** Reads the roster the renderer last reported. Absent (or returning null)
   *  means the app has not said who it holds, and the tools say so rather than
   *  guessing at a roster whose built-ins live in the renderer's bundle. */
  readAgents?: () => readonly AgentRosterEntry[] | null;
}

/** Everything an agent can be matched on for a search, lower-cased. */
function searchText(agent: AgentRosterEntry): string {
  return [agent.name, agent.role, agent.instructions, ...agent.skills].join(" ").toLowerCase();
}

/**
 * Resolve a reference to one agent in the roster.
 *
 * Exact ids and names win before anything partial, so an agent called "Scout"
 * is never lost to one called "Scout Runner". A word from the role or the
 * instructions is the last resort — enough for "the reviewer" to land, and
 * ordered so it can never outrank a real name.
 */
export function resolveAgent(
  ref: string,
  agents: readonly AgentRosterEntry[],
): AgentRosterEntry | undefined {
  const normalized = ref.trim().toLowerCase();
  if (!normalized) return undefined;
  const clean = squash(normalized);

  return (
    agents.find((a) => squash(a.id) === clean) ??
    agents.find((a) => squash(a.name) === clean) ??
    agents.find((a) => squash(a.name).includes(clean)) ??
    agents.find((a) => searchText(a).includes(normalized))
  );
}

function entryPayload(agent: AgentRosterEntry, settings: InternalSkillsSettings): GatewayRecord {
  const activeSkills = agent.skills.filter((name) => isSkillInternallyEnabled({ name }, settings));
  const payload: GatewayRecord = {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    instructions: agent.instructions,
    face: { body: agent.face.body, ink: agent.face.ink },
    model: agent.model ? modelRefPayload(agent.model) : null,
    modelFallbacks: (agent.modelFallbacks ?? []).map(modelRefPayload),
    skills: activeSkills,
    builtIn: agent.builtIn,
    active: agent.active,
    teams: [...agent.teams],
  };
  return payload;
}

/** One roster line, for the text half of a result. */
function entryLine(agent: AgentRosterEntry, settings: InternalSkillsSettings): string {
  const activeSkills = agent.skills.filter((name) => isSkillInternallyEnabled({ name }, settings));
  const chain = agent.model
    ? [agent.model, ...(agent.modelFallbacks ?? [])]
        .map((ref) => `${ref.provider}/${ref.model}`)
        .join(" → ")
    : "inherits";
  const bits = [
    agent.builtIn ? "built-in" : "user-made",
    `model: ${chain}`,
  ];
  if (activeSkills.length > 0) bits.push(`skills: ${activeSkills.join(", ")}`);
  if (agent.teams.length > 0) bits.push(`teams: ${agent.teams.length}`);
  if (agent.active) bits.push("takes the next turn");
  return `- **${agent.name}** (\`${agent.id}\`)${agent.role ? ` — ${agent.role}` : ""} [${bits.join(", ")}]`;
}

export function createAppAgentTools(options: AppAgentToolOptions): ToolEntry[] {
  const emit = options.emit;
  const readAgents = options.readAgents;

  const roster = (): readonly AgentRosterEntry[] | null => readAgents?.() ?? null;

  /** The roster, or a refusal. Naming an agent is the one thing these tools
   *  cannot do without the app's own list: kone's built-ins exist only in the
   *  renderer's bundle, so any fallback would be a guess. */
  const requireRoster = (): readonly AgentRosterEntry[] => {
    const agents = roster();
    if (!agents?.length) {
      throw new GatewayToolError(
        "provider_unavailable",
        "kone has not reported its agent roster yet, so there is no agent to resolve a name against. Try again once the app window has finished loading.",
      );
    }
    return agents;
  };

  /** Resolve a reference or refuse with the roster spelled out, so the next
   *  attempt has the ids it needs instead of another guess. */
  const requireAgent = (ref: string): AgentRosterEntry => {
    const agents = requireRoster();
    const found = resolveAgent(ref, agents);
    if (!found) {
      const sample = agents.slice(0, 12).map((a) => `\`${a.id}\` (${a.name})`).join(", ");
      throw new GatewayToolError(
        "not_found",
        `No agent matching "${ref}". kone's roster holds: ${sample}. Use app_list_agents to see them all.`,
      );
    }
    return found;
  };

  /** Emit one roster mutation. Returns whether it went anywhere: a gateway
   *  built without an emitter has no renderer to write through, and reporting
   *  success for a write nobody performed is the one answer worse than failing. */
  const emitMutation = (
    ctx: GatewayToolContext,
    mutation: Omit<
      Extract<RuntimeEvent, { type: "app.agent_mutation" }>,
      "threadId" | "provider" | "at" | "source" | "type"
    >,
  ): void => {
    if (!emit) {
      throw new GatewayToolError(
        "provider_unavailable",
        "kone cannot apply roster changes in this session — no window is listening for them.",
      );
    }
    emit({
      threadId: ctx.threadId,
      provider: ctx.provider,
      at: Date.now(),
      source: "kone.store",
      type: "app.agent_mutation",
      ...mutation,
    });
  };

  // ── 1. app_list_agents ───────────────────────────────────────────────────
  const listAgentsHandler = async (
    _ctx: GatewayToolContext,
    params: ListAppAgentsInput,
  ): Promise<GatewayToolResult> => {
    const agents = roster();
    if (!agents?.length) {
      return {
        content: [
          {
            type: "text",
            text: "kone has not reported its agent roster yet. Try again once the app window has finished loading.",
          },
        ],
        structuredContent: { known: false, total: 0, agents: [] },
      };
    }

    const query = params.query?.trim().toLowerCase();
    const matches = query
      ? agents.filter((a) => squash(a.id).includes(squash(query)) || searchText(a).includes(query))
      : [...agents];
    const active = agents.find((a) => a.active);
    // One read per tool call: the row helpers below take it as a parameter
    // rather than reading the file once per agent.
    const skillSettings = readInternalSkillsSettings();

    return {
      content: [
        {
          type: "text",
          text:
            `${matches.length} agent${matches.length === 1 ? "" : "s"} in kone's roster:\n` +
            matches.map((agent) => entryLine(agent, skillSettings)).join("\n") +
            `\n\nThe next turn is handed to ${active ? `**${active.name}**` : "a guest (nobody in particular), which is the shipped default"}.`,
        },
      ],
      structuredContent: {
        known: true,
        total: matches.length,
        activeAgentId: active?.id ?? null,
        agents: matches.map((agent) => entryPayload(agent, skillSettings)),
      },
    };
  };

  // ── 2. app_create_agent ──────────────────────────────────────────────────
  const createAgentHandler = async (
    ctx: GatewayToolContext,
    params: CreateAppAgentInput,
  ): Promise<GatewayToolResult> => {
    // The id is minted here rather than by the renderer so this call can name
    // the agent it made. The renderer honours it, which is what lets a follow-up
    // app_update_agent land on the right row without waiting for a roster push.
    const agentId = `agent-${randomUUID()}`;

    const fields: NonNullable<
      Extract<RuntimeEvent, { type: "app.agent_mutation" }>["fields"]
    > = { name: params.name.trim() };
    if (params.role !== undefined) fields.role = params.role;
    if (params.instructions !== undefined) fields.instructions = params.instructions;
    if (params.face !== undefined) fields.face = params.face;
    if (params.model !== undefined) fields.model = params.model;
    if (params.modelFallbacks !== undefined) fields.modelFallbacks = [...params.modelFallbacks];

    const mutation: Parameters<typeof emitMutation>[1] = { op: "create", agentId, fields };
    // The calling thread's project is the only one this session can speak for,
    // and off a project there is no team to join.
    if (params.addToActiveProject && ctx.cwd) mutation.projectPath = ctx.cwd;
    emitMutation(ctx, mutation);

    const summary =
      `Created agent "${fields.name}" (\`${agentId}\`)` +
      (mutation.projectPath ? ` and added it to the team for ${mutation.projectPath}` : "") +
      ".";

    return {
      content: [
        {
          type: "text",
          text: `${summary} It is in the roster now; it does not take turns until someone hands it one (app_set_active_agent).`,
        },
      ],
      structuredContent: {
        ok: true,
        summary,
        agentId,
        projectPath: mutation.projectPath ?? null,
      },
    };
  };

  // ── 3. app_update_agent ──────────────────────────────────────────────────
  const updateAgentHandler = async (
    ctx: GatewayToolContext,
    params: UpdateAppAgentInput,
  ): Promise<GatewayToolResult> => {
    const target = requireAgent(params.agent);

    const fields: NonNullable<
      Extract<RuntimeEvent, { type: "app.agent_mutation" }>["fields"]
    > = {};
    if (params.name !== undefined) fields.name = params.name.trim();
    if (params.role !== undefined) fields.role = params.role;
    if (params.instructions !== undefined) fields.instructions = params.instructions;
    if (params.face !== undefined) fields.face = params.face;
    if (params.model !== undefined) fields.model = params.model;
    if (params.modelFallbacks !== undefined) fields.modelFallbacks = [...params.modelFallbacks];

    const cleared = params.clear ?? [];
    // A field both set and cleared in one call is a contradiction, and picking a
    // winner would silently do half of what was asked.
    const conflict = cleared.find((field) => fields[field] !== undefined);
    if (conflict) {
      throw new GatewayToolError(
        "invalid_input",
        `"${conflict}" is both set and listed in \`clear\`. Do one or the other.`,
      );
    }

    const mutation: Parameters<typeof emitMutation>[1] = {
      op: "update",
      agentId: target.id,
      fields,
    };
    if (cleared.length > 0) mutation.clear = [...cleared];
    emitMutation(ctx, mutation);

    const changed = Object.keys(fields);
    const parts: string[] = [];
    if (changed.length > 0) parts.push(`set ${changed.join(", ")}`);
    if (cleared.length > 0) {
      parts.push(
        `cleared ${cleared.join(", ")} (${target.builtIn ? "back to what kone ships" : "unset"})`,
      );
    }
    const summary = `Updated agent "${target.name}" (\`${target.id}\`): ${parts.join("; ")}.`;
    const skillSettings = readInternalSkillsSettings();

    return {
      content: [{ type: "text", text: summary }],
      structuredContent: {
        ok: true,
        summary,
        agentId: target.id,
        set: changed,
        cleared: [...cleared],
        previous: entryPayload(target, skillSettings),
      },
    };
  };

  // ── 4. app_delete_agent ──────────────────────────────────────────────────
  const deleteAgentHandler = async (
    ctx: GatewayToolContext,
    params: DeleteAppAgentInput,
  ): Promise<GatewayToolResult> => {
    const target = requireAgent(params.agent);

    emitMutation(ctx, { op: "delete", agentId: target.id });

    const summary = `Removed agent "${target.name}" (\`${target.id}\`) from the roster.`;
    const skillSettings = readInternalSkillsSettings();

    return {
      content: [
        {
          type: "text",
          text: `${summary} The threads it worked keep its name and face; nothing new is handed to it.${
            target.builtIn ? " It is one kone ships, so it can be brought back from the agents settings." : ""
          }`,
        },
      ],
      structuredContent: { ok: true, summary, agentId: target.id, agent: entryPayload(target, skillSettings) },
    };
  };

  // ── 5. app_set_active_agent ──────────────────────────────────────────────
  const setActiveAgentHandler = async (
    ctx: GatewayToolContext,
    params: SetActiveAgentInput,
  ): Promise<GatewayToolResult> => {
    // `guest: true` and a named agent are mutually exclusive, and the schema's
    // refine only guarantees one of them is present.
    if (params.guest === true && params.agent !== undefined) {
      throw new GatewayToolError(
        "invalid_input",
        "Name an agent or set guest: true — not both.",
      );
    }

    if (params.guest === true) {
      emitMutation(ctx, { op: "select" });
      const summary = "The next turn is handed to a guest — nobody in particular.";
      return {
        content: [{ type: "text", text: summary }],
        structuredContent: { ok: true, summary, activeAgentId: null },
      };
    }

    // SAFETY: the schema's refine admits only an input with `agent` or
    // `guest: true`, and the guest branch above has already returned.
    const target = requireAgent(params.agent as string);
    emitMutation(ctx, { op: "select", agentId: target.id });

    const summary = `The next turn is handed to "${target.name}" (\`${target.id}\`).`;
    return {
      content: [{ type: "text", text: summary }],
      structuredContent: { ok: true, summary, activeAgentId: target.id },
    };
  };

  // One name per tool, in the underscore form: a dot is not a legal character
  // in a tool name for every client that consumes this server.
  return [
    {
      name: "app_list_agents",
      description:
        "List the agents in kone's roster — the ones it ships plus any the user or an agent created — with each one's role, standing instructions, model (and fallback chain), skills, project teams, and whether it takes the user's next turn.",
      inputSchema: ListAppAgentsInputSchema,
      jsonSchema: LIST_APP_AGENTS_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet:
        "`app_list_agents`: the app's agent roster — ids, roles, instructions, models, and who takes the next turn.",
      promptGuidelines: [
        "Call `app_list_agents` before naming or editing an agent — the roster differs per install, so never assume an id.",
      ],
      handler: listAgentsHandler,
    },
    {
      name: "app_create_agent",
      description:
        "Add an agent to kone's roster: a name, an optional role line, the standing instructions it works from, the model it runs on (optionally with fallbacks), and the colours its face is drawn in. Use this when the user asks for a new agent or teammate in the app.",
      inputSchema: CreateAppAgentInputSchema,
      jsonSchema: CREATE_APP_AGENT_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      promptSnippet:
        "`app_create_agent`: add an agent to the app's roster (name, role, instructions, model, face).",
      promptGuidelines: [
        "Use `app_create_agent` when the user asks for a new agent in the app — do not write files or edit config to make one.",
        "An agent's `instructions` are what reach the model when a thread is handed to it, so write them as standing orders rather than as a description.",
      ],
      handler: createAgentHandler,
    },
    {
      name: "app_update_agent",
      description:
        "Edit an agent in kone's roster: rename it, rewrite its role or standing instructions, repaint its face, or pin the model it runs on. Fields left out are left alone; fields named in `clear` are handed back (to kone's shipped value on a built-in agent, unset on a user-made one).",
      inputSchema: UpdateAppAgentInputSchema,
      jsonSchema: UPDATE_APP_AGENT_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      promptSnippet:
        "`app_update_agent`: edit an agent in the roster; `clear` hands a field back rather than emptying it.",
      promptGuidelines: [
        "Use `app_update_agent` to change an existing agent instead of creating a near-duplicate of it.",
      ],
      handler: updateAgentHandler,
    },
    {
      name: "app_delete_agent",
      description:
        "Take an agent out of kone's roster. Requires confirm: true. The threads it already worked keep its name and face; nothing new is handed to it.",
      inputSchema: DeleteAppAgentInputSchema,
      jsonSchema: DELETE_APP_AGENT_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      promptSnippet:
        "`app_delete_agent`: remove an agent from the roster (confirm: true required).",
      promptGuidelines: [
        "Only call `app_delete_agent` when the user has actually asked for that agent to go — never to tidy the roster on your own judgement.",
      ],
      handler: deleteAgentHandler,
    },
    {
      name: "app_set_active_agent",
      description:
        "Choose who the user's next turn is handed to: an agent from the roster, or a guest (nobody in particular, which is kone's default).",
      inputSchema: SetActiveAgentInputSchema,
      jsonSchema: SET_ACTIVE_AGENT_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      promptSnippet:
        "`app_set_active_agent`: hand the user's next turn to a named agent, or to a guest.",
      promptGuidelines: [
        "Use `app_set_active_agent` when the user asks to switch who they are talking to, or to go back to a plain guest session.",
      ],
      handler: setActiveAgentHandler,
    },
  ];
}
