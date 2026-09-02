// The preset sub-agents, as gateway tools: the standing definitions
// `kone_spawn_worker_preset` cuts a spawn from, now authored from the same side
// that spawns them.
//
// Unlike the roster next door, these need no help from the renderer. A preset is
// a whole row — a name, instructions, one model — with nothing above it to
// inherit from, and it lives in the store the gateway already holds. So the
// write happens here and the emitted event only tells the open windows to
// re-read, rather than asking one of them to do the writing.
//
// The built-in presets are the exception: they are shipped definitions rather
// than rows, so they are listed (an agent should be able to spawn from one) and
// refused for editing (there is no row to edit, and a later build would
// overwrite whatever was kept).

import { BUILTIN_SWARM_PRESETS } from "../../presetSpawn.js";
import type {
  SubagentPresetCreateInput,
  SubagentPresetPatch,
  SubagentPresetRecord,
} from "../../rosterRecord.js";
import type { EmitEvent } from "../../types.js";
import {
  CreateSubagentPresetInputSchema,
  DeleteSubagentPresetInputSchema,
  ListSubagentPresetsInputSchema,
  UpdateSubagentPresetInputSchema,
  CREATE_SUBAGENT_PRESET_JSON_SCHEMA,
  DELETE_SUBAGENT_PRESET_JSON_SCHEMA,
  LIST_SUBAGENT_PRESETS_JSON_SCHEMA,
  UPDATE_SUBAGENT_PRESET_JSON_SCHEMA,
  type CreateSubagentPresetInput,
  type DeleteSubagentPresetInput,
  type ListSubagentPresetsInput,
  type UpdateSubagentPresetInput,
  GatewayToolError,
  type GatewayRecord,
} from "../schemas.js";
import type { GatewayToolContext, GatewayToolResult, ToolEntry } from "../registry.js";
import { modelRefPayload, squash } from "../helpers.js";

/** The slice of the store these tools use. Narrow on purpose: the same reason
 *  the spawn tools declare their own — a test can stand one up without a
 *  database, and the tools cannot reach anything else in the store. */
export interface SubagentPresetStore {
  listSubagentPresets(): SubagentPresetRecord[];
  getSubagentPreset(presetId: string): SubagentPresetRecord | null;
  createSubagentPreset(input: SubagentPresetCreateInput): SubagentPresetRecord | null;
  updateSubagentPreset(
    presetId: string,
    patch: SubagentPresetPatch,
  ): SubagentPresetRecord | null;
  deleteSubagentPreset(presetId: string): boolean;
}

export interface AppSubagentToolOptions {
  store: SubagentPresetStore;
  /** Raised after every write so an open settings pane re-reads the presets
   *  instead of showing the set from before the call. */
  emit?: EmitEvent;
}


/** A shipped preset, which has no row behind it. Editing one is refused rather
 *  than quietly forked: a fork under the same name would be spawned from in
 *  preference to the built-in and nobody asked for a second definition. */
function isBuiltin(preset: SubagentPresetRecord): boolean {
  return BUILTIN_SWARM_PRESETS.some((builtin) => builtin.presetId === preset.presetId);
}


function presetPayload(preset: SubagentPresetRecord): GatewayRecord {
  const fallbacks = preset.modelFallbacks ?? [];
  return {
    presetId: preset.presetId,
    name: preset.name,
    instructions: preset.instructions,
    model: preset.model ? modelRefPayload(preset.model) : null,
    modelFallbacks: fallbacks.map(modelRefPayload),
    builtIn: isBuiltin(preset),
  };
}

/** One line of the listing. The instructions are summarised rather than quoted
 *  in full: the list is for choosing between presets, and four sets of standing
 *  orders at full length crowd out the choice. */
function presetLine(preset: SubagentPresetRecord): string {
  const gist = preset.instructions?.trim().replace(/\s+/g, " ") ?? "";
  const shortened = gist.length > 140 ? `${gist.slice(0, 139)}…` : gist;
  const chain = preset.model
    ? [preset.model, ...(preset.modelFallbacks ?? [])]
        .map((ref) => `${ref.provider}/${ref.model}`)
        .join(" → ")
    : "inherits the caller";
  const bits = [
    isBuiltin(preset) ? "built-in, read-only" : "editable",
    `model: ${chain}`,
  ];
  return `- **${preset.name}** (\`${preset.presetId}\`) [${bits.join(", ")}]${shortened ? `: ${shortened}` : ""}`;
}

export function createAppSubagentTools(options: AppSubagentToolOptions): ToolEntry[] {
  const { store } = options;
  const emit = options.emit;

  /** Every preset an agent can name: the user's own first, then the shipped
   *  ones a user preset hasn't taken the name of. The same precedence
   *  `kone_spawn_worker_preset` resolves by, so what is listed here is what a
   *  spawn from that name would actually use. */
  const allPresets = (): SubagentPresetRecord[] => {
    const stored = store.listSubagentPresets();
    const taken = new Set(stored.map((preset) => squash(preset.name)));
    return [
      ...stored,
      ...BUILTIN_SWARM_PRESETS.filter((builtin) => !taken.has(squash(builtin.name))),
    ];
  };

  const resolve = (ref: string): SubagentPresetRecord | undefined => {
    const clean = squash(ref.trim());
    if (!clean) return undefined;
    const presets = allPresets();
    return (
      presets.find((preset) => squash(preset.presetId) === clean) ??
      presets.find((preset) => squash(preset.name) === clean) ??
      presets.find((preset) => squash(preset.name).includes(clean))
    );
  };

  /** Resolve or refuse with the set spelled out, so the next attempt has real
   *  ids rather than another guess. */
  const requirePreset = (ref: string): SubagentPresetRecord => {
    const found = resolve(ref);
    if (found) return found;
    const sample = allPresets()
      .slice(0, 12)
      .map((preset) => `\`${preset.presetId}\` (${preset.name})`)
      .join(", ");
    throw new GatewayToolError(
      "not_found",
      `No preset sub-agent matching "${ref}".${sample ? ` kone holds: ${sample}.` : " kone holds none yet."} Use app_list_subagent_presets to see them all.`,
    );
  };

  /** Resolve to a preset that can actually be written to. */
  const requireEditable = (ref: string): SubagentPresetRecord => {
    const preset = requirePreset(ref);
    if (isBuiltin(preset)) {
      throw new GatewayToolError(
        "permission_denied",
        `"${preset.name}" is one of the presets kone ships, so it has no stored definition to edit. Create a preset of your own with app_create_subagent_preset — a stored preset takes precedence over a shipped one of the same name.`,
      );
    }
    return preset;
  };

  const announce = (
    ctx: GatewayToolContext,
    op: "create" | "update" | "delete",
    presetId: string,
  ): void => {
    if (!emit) return;
    emit({
      threadId: ctx.threadId,
      provider: ctx.provider,
      at: Date.now(),
      source: "kone.store",
      type: "app.subagent_presets_changed",
      op,
      presetId,
    });
  };

  // ── 1. app_list_subagent_presets ─────────────────────────────────────────
  const listHandler = async (
    _ctx: GatewayToolContext,
    params: ListSubagentPresetsInput,
  ): Promise<GatewayToolResult> => {
    const query = params.query?.trim().toLowerCase();
    const presets = allPresets().filter((preset) => {
      if (!query) return true;
      return `${preset.name} ${preset.instructions ?? ""}`.toLowerCase().includes(query);
    });

    return {
      content: [
        {
          type: "text",
          text:
            presets.length === 0
              ? "No preset sub-agents match. Use app_create_subagent_preset to define one."
              : `${presets.length} preset sub-agent${presets.length === 1 ? "" : "s"}, in the order a spawn resolves a name:\n` +
                presets.map(presetLine).join("\n") +
                "\nStart a worker from one with kone_spawn_worker_preset.",
        },
      ],
      structuredContent: {
        total: presets.length,
        presets: presets.map(presetPayload),
      },
    };
  };

  // ── 2. app_create_subagent_preset ────────────────────────────────────────
  const createHandler = async (
    ctx: GatewayToolContext,
    params: CreateSubagentPresetInput,
  ): Promise<GatewayToolResult> => {
    const name = params.name.trim();
    // A second preset under a name already in use would shadow the first for
    // every spawn that names it, and neither is obviously the one meant.
    const clash = store
      .listSubagentPresets()
      .find((preset) => squash(preset.name) === squash(name));
    if (clash) {
      throw new GatewayToolError(
        "invalid_input",
        `A preset sub-agent called "${clash.name}" (\`${clash.presetId}\`) already exists. Edit it with app_update_subagent_preset, or pick another name.`,
      );
    }

    const input: SubagentPresetCreateInput = { name };
    if (params.instructions !== undefined) input.instructions = params.instructions;
    if (params.model !== undefined) input.model = params.model;
    if (params.modelFallbacks !== undefined) input.modelFallbacks = [...params.modelFallbacks];

    const created = store.createSubagentPreset(input);
    if (!created) {
      throw new GatewayToolError(
        "internal",
        `kone could not store the preset sub-agent "${name}".`,
      );
    }
    announce(ctx, "create", created.presetId);

    const summary = `Created preset sub-agent "${created.name}" (\`${created.presetId}\`).`;
    return {
      content: [
        {
          type: "text",
          text: `${summary} Start a worker from it by name with kone_spawn_worker_preset.`,
        },
      ],
      structuredContent: { ok: true, summary, preset: presetPayload(created) },
    };
  };

  // ── 3. app_update_subagent_preset ────────────────────────────────────────
  const updateHandler = async (
    ctx: GatewayToolContext,
    params: UpdateSubagentPresetInput,
  ): Promise<GatewayToolResult> => {
    const target = requireEditable(params.preset);

    const patch: SubagentPresetPatch = {};
    if (params.name !== undefined) patch.name = params.name.trim();
    if (params.instructions !== undefined) patch.instructions = params.instructions;
    if (params.model !== undefined) patch.model = params.model;
    if (params.modelFallbacks !== undefined) patch.modelFallbacks = [...params.modelFallbacks];

    const cleared = params.clear ?? [];
    // Set and cleared in one call is a contradiction, and picking a winner would
    // silently do half of what was asked.
    const conflict = cleared.find((field) => patch[field] !== undefined);
    if (conflict) {
      throw new GatewayToolError(
        "invalid_input",
        `"${conflict}" is both set and listed in \`clear\`. Do one or the other.`,
      );
    }
    for (const field of cleared) patch[field] = null;

    if (patch.name !== undefined) {
      const clash = store
        .listSubagentPresets()
        .find(
          (preset) =>
            preset.presetId !== target.presetId && squash(preset.name) === squash(patch.name ?? ""),
        );
      if (clash) {
        throw new GatewayToolError(
          "invalid_input",
          `Another preset sub-agent is already called "${clash.name}" (\`${clash.presetId}\`).`,
        );
      }
    }

    const updated = store.updateSubagentPreset(target.presetId, patch);
    if (!updated) {
      throw new GatewayToolError(
        "not_found",
        `The preset sub-agent "${target.name}" (\`${target.presetId}\`) could not be updated — it may have been deleted.`,
      );
    }
    announce(ctx, "update", updated.presetId);

    // Read off the arguments rather than the assembled patch: the clears were
    // written into it as nulls, and they are reported separately below.
    const set = (["name", "instructions", "model", "modelFallbacks"] as const).filter(
      (field) => params[field] !== undefined,
    );
    const parts: string[] = [];
    if (set.length > 0) parts.push(`set ${set.join(", ")}`);
    if (cleared.length > 0) parts.push(`cleared ${cleared.join(", ")}`);
    const summary = `Updated preset sub-agent "${updated.name}" (\`${updated.presetId}\`): ${parts.join("; ")}.`;

    return {
      content: [{ type: "text", text: summary }],
      structuredContent: {
        ok: true,
        summary,
        preset: presetPayload(updated),
        previous: presetPayload(target),
      },
    };
  };

  // ── 4. app_delete_subagent_preset ────────────────────────────────────────
  const deleteHandler = async (
    ctx: GatewayToolContext,
    params: DeleteSubagentPresetInput,
  ): Promise<GatewayToolResult> => {
    const target = requireEditable(params.preset);

    const removed = store.deleteSubagentPreset(target.presetId);
    if (!removed) {
      throw new GatewayToolError(
        "not_found",
        `The preset sub-agent "${target.name}" (\`${target.presetId}\`) was already gone.`,
      );
    }
    announce(ctx, "delete", target.presetId);

    const summary = `Deleted preset sub-agent "${target.name}" (\`${target.presetId}\`).`;
    return {
      content: [
        {
          type: "text",
          // A preset keeps no history, so there is nothing to restore it from —
          // say so rather than leaving the impression it can be undone.
          text: `${summary} A preset keeps no history, so this cannot be undone.`,
        },
      ],
      structuredContent: { ok: true, summary, preset: presetPayload(target) },
    };
  };

  return [
    {
      name: "app_list_subagent_presets",
      description:
        "List the preset sub-agents in kone — the reusable definitions (name, standing instructions, model) that kone_spawn_worker_preset starts a specialist worker from. Includes the presets kone ships, marked read-only.",
      inputSchema: ListSubagentPresetsInputSchema,
      jsonSchema: LIST_SUBAGENT_PRESETS_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet:
        "`app_list_subagent_presets`: the reusable sub-agent definitions, with ids, instructions and models.",
      promptGuidelines: [
        "Call `app_list_subagent_presets` before editing a preset, and to see what you can already spawn from before defining another.",
      ],
      handler: listHandler,
    },
    {
      name: "app_create_subagent_preset",
      description:
        "Define a new preset sub-agent: a name, the standing instructions a spawn from it is given, and optionally the model it runs on. Use this when the user wants a reusable sub-agent rather than a one-off delegation.",
      inputSchema: CreateSubagentPresetInputSchema,
      jsonSchema: CREATE_SUBAGENT_PRESET_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      promptSnippet:
        "`app_create_subagent_preset`: define a reusable sub-agent (name, instructions, model).",
      promptGuidelines: [
        "Use `app_create_subagent_preset` for a sub-agent the user wants to reuse; for a single task, spawn a one-off worker with `kone_spawn_worker` instead of leaving a preset behind.",
      ],
      handler: createHandler,
    },
    {
      name: "app_update_subagent_preset",
      description:
        "Edit a preset sub-agent: rename it, rewrite its instructions, or change the model it runs on. Fields left out are left alone; fields named in `clear` are unset. The presets kone ships cannot be edited.",
      inputSchema: UpdateSubagentPresetInputSchema,
      jsonSchema: UPDATE_SUBAGENT_PRESET_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      promptSnippet:
        "`app_update_subagent_preset`: edit a reusable sub-agent definition; `clear` unsets a field.",
      promptGuidelines: [
        "Use `app_update_subagent_preset` to sharpen an existing preset rather than adding a near-duplicate beside it.",
      ],
      handler: updateHandler,
    },
    {
      name: "app_delete_subagent_preset",
      description:
        "Delete a preset sub-agent for good. Requires confirm: true — a preset keeps no history, so this cannot be undone.",
      inputSchema: DeleteSubagentPresetInputSchema,
      jsonSchema: DELETE_SUBAGENT_PRESET_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      promptSnippet:
        "`app_delete_subagent_preset`: delete a reusable sub-agent definition (confirm: true required).",
      promptGuidelines: [
        "Only call `app_delete_subagent_preset` when the user has asked for that preset to go — it cannot be recovered.",
      ],
      handler: deleteHandler,
    },
  ];
}
