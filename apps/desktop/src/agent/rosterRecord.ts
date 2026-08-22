import type { ProviderKind } from "./types.js";

// ── the roster (v22) ─────────────────────────────────────────────────────────

/**
 * An agent as it lives in the store.
 *
 * Every prose field is nullable and the null is meaningful: on a row with a
 * `presetId` it means "inherit whatever the shipped preset says", so the
 * renderer resolves it against the definition it holds. `''` is not the same
 * answer — it is a field the user deliberately emptied, and it stays empty.
 */
/** A skill an agent is assigned, by the path the skills inventory keys on. The
 *  name and origin ride along so a chip can be drawn without a fresh disk scan;
 *  the path is the identity. */
export type AgentSkillRef = {
  path: string;
  name: string;
  origin: string;
};

/** A model an agent is allowed to run on: a provider and the model id within
 *  it. The label rides along for display, the way a skill's name does. */
export type AgentModelRef = {
  provider: ProviderKind;
  model: string;
  label?: string;
};

/** An agent's permanent restrictions (v25). Where capabilities say what an
 *  agent has available, policies say what it may never do, whatever the
 *  thread's interaction mode would otherwise allow. Empty lists forbid nothing.
 *  The matching that turns a stored string into a block lives with whatever
 *  enforces it, not here — this is only the written-down set of restrictions. */
export type AgentPolicies = {
  /** Command lines the agent may never run. */
  deniedCommands: string[];
  /** File paths the agent may never read or write. */
  deniedPaths: string[];
};

/** A picture of an agent (v27). `source` records where it came from, so a later
 *  editor can tell a generated face from an uploaded one without inspecting the
 *  bytes; `src` is whatever draws it — a path to a shipped asset, or a data URL
 *  carrying a generated one by value. Opaque to the store either way. */
export type AgentAvatarRef = {
  source: string;
  src: string;
};

/** The bot an agent drives (v27): a body shape, a colour, and an expression,
 *  each named by id. Only ids, never geometry — what a shape looks like is this
 *  build's to supply, and a stored bot must not freeze a copy of it. */
export type AgentBotRef = {
  shape: string;
  color: string;
  expression: string;
};

export type AgentRecord = {
  agentId: string;
  /** The shipped preset this row overlays, or null for a user-made agent. */
  presetId: string | null;
  name: string | null;
  /** One line under the name in the roster. Never sent to a provider. */
  role: string | null;
  instructions: string | null;
  /** The marble the face is drawn in, and the ink drawn on it — a colour or a
   *  theme variable, opaque to the store. */
  faceBody: string | null;
  faceInk: string | null;
  /** The agent's capabilities (v24). Each is an overlay: null inherits from the
   *  preset. Skills are additive, so `[]` is "none assigned". `model` is the one
   *  model the agent runs on: null inherits the preset's, and a resolved ref is
   *  the model it uses (no model named means the thread picks per turn, as it
   *  always has). */
  skills: AgentSkillRef[] | null;
  model: AgentModelRef | null;
  /** The agent's permanent restrictions (v25), or null to inherit the preset's.
   *  A resolved object forbids exactly what its lists name and nothing else. */
  policies: AgentPolicies | null;
  /** How the agent looks (v27), each an overlay: null inherits the preset's. An
   *  agent with neither is drawn by the face they have always had. */
  avatar: AgentAvatarRef | null;
  bot: AgentBotRef | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  /** When the agent left the roster, or null while they're still in it. The row
   *  outlives the deletion so a finished thread can still name who worked it. */
  deletedAt: number | null;
};

/** The fields a user-made agent is created with. The id is the caller's to mint
 *  so it can draw the agent before the write lands. */
export type AgentCreateInput = {
  agentId?: string;
  name: string;
  role?: string | null;
  instructions?: string | null;
  faceBody?: string | null;
  faceInk?: string | null;
  skills?: AgentSkillRef[] | null;
  model?: AgentModelRef | null;
  policies?: AgentPolicies | null;
  avatar?: AgentAvatarRef | null;
  bot?: AgentBotRef | null;
};

/** An edit. A key left out is left alone; an explicit null clears the field —
 *  back to the shipped preset on an overlay row, unset on a user-made agent. */
export type AgentPatch = {
  name?: string | null;
  role?: string | null;
  instructions?: string | null;
  faceBody?: string | null;
  faceInk?: string | null;
  skills?: AgentSkillRef[] | null;
  model?: AgentModelRef | null;
  policies?: AgentPolicies | null;
  avatar?: AgentAvatarRef | null;
  bot?: AgentBotRef | null;
};

/** A fork of an existing agent. `inherited` carries the shipped preset's values
 *  for whatever the source row leaves null, because a fork keeps no inheritance
 *  of its own — see `duplicateAgent`. */
export type AgentDuplicateInput = {
  agentId: string;
  newAgentId?: string;
  /** The copy's name; defaults to the source's, which the roster shows twice
   *  over until the caller renames it. */
  name?: string;
  inherited?: {
    name?: string | null;
    role?: string | null;
    instructions?: string | null;
    faceBody?: string | null;
    faceInk?: string | null;
    skills?: AgentSkillRef[] | null;
    model?: AgentModelRef | null;
    policies?: AgentPolicies | null;
    avatar?: AgentAvatarRef | null;
    bot?: AgentBotRef | null;
  };
};

/**
 * Who worked a thread. `agentId` is null when it ran as a guest — a recorded
 * decision, not a missing one. A thread that never started has no binding at
 * all, which is why this is only ever handed out for a row that exists.
 */
export type ThreadAgentBinding = {
  threadId: string;
  agentId: string | null;
};

/**
 * A preset sub-agent (v26): a reusable, globally-available definition an agent
 * can hand a piece of work to. Not a roster member, and bound to no thread —
 * just a name, a set of instructions, and a model preference a spawn is cut
 * from. Deliberately lightweight: it carries no skills, MCPs, or project
 * membership of its own; the agent that invokes it owns the richer context.
 */
export type SubagentPresetRecord = {
  presetId: string;
  name: string;
  /** What the sub-agent is told when a spawn is cut from this preset. */
  instructions: string | null;
  /** The one model a spawn from this preset runs on, or null for no preference
   *  — the runtime then lets the caller's own model stand. Unlike an agent's
   *  `model` there is no preset above this to inherit from, so null here means
   *  "no model", not "inherit". */
  model: AgentModelRef | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
};

/** The fields a preset sub-agent is created with. The id is the caller's to
 *  mint so it can draw the preset before the write lands. */
export type SubagentPresetCreateInput = {
  presetId?: string;
  name: string;
  instructions?: string | null;
  model?: AgentModelRef | null;
};

/** An edit to a preset sub-agent. A key left out is left alone; the name is the
 *  one field that can't be cleared, since a preset with no name is not one. */
export type SubagentPresetPatch = {
  name?: string;
  instructions?: string | null;
  model?: AgentModelRef | null;
};

/** Room for a name the roster can lay out on one line. */
export const AGENT_NAME_MAX = 64;
/** Room for the line under it. */
export const AGENT_ROLE_MAX = 120;
/**
 * Room for a set of instructions.
 *
 * A ceiling on the row rather than the product rule: the editor is where a
 * sensible length is enforced, and the gateway caps again on the way to a model.
 * This is only here so a runaway paste can't put a megabyte in the database.
 */
export const AGENT_PROSE_MAX = 4000;
/** Room for a colour or a theme variable reference. */
export const AGENT_PAINT_MAX = 64;
/**
 * Room for an avatar, which is far more than anything else on the row needs.
 *
 * A generated face has to be carried by value: the source hands back a
 * different one on every request, so a stored URL would give the agent a new
 * face on every paint. A 256px JPEG data URL runs to a few tens of kilobytes,
 * and this leaves room for a larger one without letting a full-size original
 * through — the editor downscales, and this is the floor under it.
 */
export const AGENT_AVATAR_MAX = 512 * 1024;

export const AGENT_COLUMNS =
  "agent_id, preset_id, name, role, instructions, " +
  "face_body, face_ink, skills, providers, models, policies, " +
  "avatar, bot, sort_order, created_at, updated_at, deleted_at";

/** How long a stored capability list may get, and how long each string inside
 *  one may be. A ceiling, not a rule: like `clampAgentField`, this is the floor
 *  that keeps a runaway write out of the database, not the editor's own limit. */
export const AGENT_LIST_MAX = 128;
export const AGENT_REF_FIELD_MAX = 512;

/** Trim and bound one stored field. Undefined and null both store as null —
 *  "inherit" — while a string that trims to empty stores as '', which is the
 *  user saying the field is blank on purpose. */
export function clampAgentField(
  value: string | null | undefined,
  max: number,
): string | null {
  if (value === null || value === undefined) return null;
  return value.trim().slice(0, max);
}

/** Trim and bound one string inside a capability ref, dropping it to null when
 *  it is empty — a ref with no path, or a model with no id, is not a ref. */
export function boundRefField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, AGENT_REF_FIELD_MAX);
  return trimmed || null;
}

/** Serialize a capability list to the JSON a column holds. Null and undefined
 *  both store as null ("inherit"); an array — even an empty one — is a real
 *  answer and stores as JSON. Each entry is validated and bounded, and one that
 *  can't be made valid is dropped rather than stored malformed, so a column
 *  never holds a ref the reader has to guess at. */
export function serializeAgentList<T>(
  value: readonly unknown[] | null | undefined,
  normalize: (entry: unknown) => T | null,
): string | null {
  if (value === null || value === undefined) return null;
  const clean: T[] = [];
  for (const entry of value.slice(0, AGENT_LIST_MAX)) {
    const normalized = normalize(entry);
    if (normalized !== null) clean.push(normalized);
  }
  return JSON.stringify(clean);
}

export function normalizeSkillRef(entry: unknown): AgentSkillRef | null {
  if (!entry || typeof entry !== "object") return null;
  const ref = entry as Record<string, unknown>;
  const path = boundRefField(ref.path);
  if (!path) return null;
  return { path, name: boundRefField(ref.name) ?? "", origin: boundRefField(ref.origin) ?? "" };
}

export function normalizeModelRef(entry: unknown): AgentModelRef | null {
  if (!entry || typeof entry !== "object") return null;
  const ref = entry as Record<string, unknown>;
  const provider = boundRefField(ref.provider);
  const model = boundRefField(ref.model);
  if (!provider || !model) return null;
  const out: AgentModelRef = { provider: provider as ProviderKind, model };
  const label = boundRefField(ref.label);
  if (label) out.label = label;
  return out;
}

/** Serialize the single model an agent runs on to the JSON its column holds.
 *  Null and undefined both store as null ("inherit"/"no model"); a ref stores
 *  as a JSON object, validated and bounded. A ref that can't be made valid
 *  stores as null rather than malformed. */
export function serializeModelRef(value: AgentModelRef | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = normalizeModelRef(value);
  return normalized === null ? null : JSON.stringify(normalized);
}

/** Read the model column back into its single ref, or null when the column is
 *  null ("inherit"/"no model"). Tolerates a legacy array (the column once held
 *  an ordered preference list) by taking its first entry, so a row written
 *  before the collapse to one model still reads. Unparseable JSON reads as null,
 *  exactly as a malformed capability list does. */
export function parseModelRef(raw: string | null): AgentModelRef | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    return normalizeModelRef(entry);
  } catch {
    return null;
  }
}

/** Read a capability column back into its list, or null when the column is null
 *  ("inherit"). A column that somehow holds unparseable or non-array JSON reads
 *  as null rather than throwing — a malformed capability is no capability, and
 *  the roster falls back to the preset exactly as it would for an absent one. */
export function parseAgentList<T>(raw: string | null, normalize: (entry: unknown) => T | null): T[] | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const out: T[] = [];
    for (const entry of parsed) {
      const normalized = normalize(entry);
      if (normalized !== null) out.push(normalized);
    }
    return out;
  } catch {
    return null;
  }
}

/** Clean one list of strings inside a policy: drop anything that isn't a
 *  string, trim and bound each, drop the ones that empty out, and cap the
 *  count — the same floor `serializeAgentList` puts under a capability list. */
export function cleanStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value.slice(0, AGENT_LIST_MAX)) {
    const bounded = boundRefField(entry);
    if (bounded) out.push(bounded);
  }
  return out;
}

/** Normalize a policies object. Null and undefined both mean "inherit" and
 *  come back as null; anything that isn't an object is not a policy set and
 *  reads the same way. A real object always resolves to both lists, each
 *  cleaned — a missing or malformed list is an empty one, never a throw. */
export function normalizePolicies(value: unknown): AgentPolicies | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  return {
    deniedCommands: cleanStringList(obj.deniedCommands),
    deniedPaths: cleanStringList(obj.deniedPaths),
  };
}

/** Serialize the policies object to the JSON its column holds. Null and
 *  undefined store as null ("inherit"); a real object stores as cleaned JSON. */
export function serializeAgentPolicies(value: AgentPolicies | null | undefined): string | null {
  const normalized = normalizePolicies(value);
  return normalized === null ? null : JSON.stringify(normalized);
}

/** Read the policies column back into its object, or null when the column is
 *  null ("inherit"). Unparseable or non-object JSON reads as null — a malformed
 *  policy is no policy, exactly as a malformed capability list is. */
export function parseAgentPolicies(raw: string | null): AgentPolicies | null {
  if (raw === null) return null;
  try {
    return normalizePolicies(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Normalize an avatar. Both fields are required and neither may be empty — an
 *  avatar with nothing to draw is not one, and reads as null ("inherit") rather
 *  than as a picture that paints a blank. `src` is bounded but never inspected:
 *  the store has no opinion on whether it is an asset path or a data URL. */
export function normalizeAvatar(value: unknown): AgentAvatarRef | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const source = boundRefField(obj.source);
  const src = typeof obj.src === "string" ? obj.src.trim().slice(0, AGENT_AVATAR_MAX) : null;
  if (!source || !src) return null;
  return { source, src };
}

/** Serialize an avatar to the JSON its column holds. Null and undefined both
 *  store as null ("inherit"); one that can't be made valid stores as null too,
 *  rather than malformed. */
export function serializeAgentAvatar(value: AgentAvatarRef | null | undefined): string | null {
  const normalized = normalizeAvatar(value);
  return normalized === null ? null : JSON.stringify(normalized);
}

/** Read the avatar column back into its ref, or null when the column is null
 *  ("inherit"). Unparseable JSON reads as null, the way a malformed capability
 *  list does — no picture, and the drawn face stands in. */
export function parseAgentAvatar(raw: string | null): AgentAvatarRef | null {
  if (raw === null) return null;
  try {
    return normalizeAvatar(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Normalize a bot. Every field is a plain id the renderer's catalogue
 *  resolves, so an id this build has never heard of is stored and handed back
 *  unchanged — the catalogue answers an unknown one with its default, which is
 *  what lets a bot survive a build that drops the shape it was made with. A bot
 *  missing any of the three is not one and reads as null. */
export function normalizeBot(value: unknown): AgentBotRef | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const shape = boundRefField(obj.shape);
  const color = boundRefField(obj.color);
  const expression = boundRefField(obj.expression);
  if (!shape || !color || !expression) return null;
  return { shape, color, expression };
}

/** Serialize a bot to the JSON its column holds. Null and undefined both store
 *  as null, which on an overlay row is "inherit" and on a user-made agent is an
 *  agent with no bot — a different thing from one wearing the default bot. */
export function serializeAgentBot(value: AgentBotRef | null | undefined): string | null {
  const normalized = normalizeBot(value);
  return normalized === null ? null : JSON.stringify(normalized);
}

/** Read the bot column back into its ref, or null when the column is null. */
export function parseAgentBot(raw: string | null): AgentBotRef | null {
  if (raw === null) return null;
  try {
    return normalizeBot(JSON.parse(raw));
  } catch {
    return null;
  }
}

export type AgentRow = {
  agent_id: string;
  preset_id: string | null;
  name: string | null;
  role: string | null;
  instructions: string | null;
  face_body: string | null;
  face_ink: string | null;
  skills: string | null;
  providers: string | null;
  models: string | null;
  policies: string | null;
  avatar: string | null;
  bot: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
};

export function rowToAgent(row: AgentRow): AgentRecord {
  return {
    agentId: row.agent_id,
    presetId: row.preset_id,
    name: row.name,
    role: row.role,
    instructions: row.instructions,
    faceBody: row.face_body,
    faceInk: row.face_ink,
    skills: parseAgentList(row.skills, normalizeSkillRef),
    model: parseModelRef(row.models),
    policies: parseAgentPolicies(row.policies),
    avatar: parseAgentAvatar(row.avatar),
    bot: parseAgentBot(row.bot),
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export const SUBAGENT_PRESET_COLUMNS =
  "preset_id, name, instructions, models, sort_order, created_at, updated_at";

export type SubagentPresetRow = {
  preset_id: string;
  name: string;
  instructions: string | null;
  models: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
};

export function rowToSubagentPreset(row: SubagentPresetRow): SubagentPresetRecord {
  return {
    presetId: row.preset_id,
    name: row.name,
    instructions: row.instructions,
    // A null column reads as "no model" because a preset has no preset above it
    // to inherit from, unlike an agent's `model`.
    model: parseModelRef(row.models),
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
