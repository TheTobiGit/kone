/**
 * Agents — the named ones you choose to work with.
 *
 * An agent is a persistent actor: an identity that outlives any one
 * conversation. A thread is a single execution of work; an agent is whoever did
 * it, across all of them. That separation is the whole point of this file — it
 * is why an agent's name and face live here, keyed by the agent, rather than
 * being derived from a thread id.
 *
 * Working with one is a choice. A thread with no agent on it runs as a guest,
 * which is the behaviour that came first and is still the default: a name and a
 * face rolled from the thread's own id, good for the life of that conversation
 * and nothing beyond it. Picking an agent is how you say you want the same
 * colleague back, and eventually the settings that come with them.
 *
 * The name and the agent's instructions are the fields that reach a provider
 * session — see `agentPersonaForThread`, the one door out of this file. The role
 * and the face are for the person reading the drawer.
 *
 * Instructions are how an agent works — its standing orders, in its own words.
 * They do not pick a provider, a model or an effort: those stay the thread's own
 * per-turn picks. The built-in `kone` agent ships with a set; a user-made agent
 * has only what its maker wrote.
 *
 * Where an agent lives: the built-in below is prose in this build, and a
 * *row* in the store carries whatever the user changed about it — see
 * `~/utils/agentStore`. A field the row leaves null is still this file's to
 * answer, which is what keeps a later build free to improve the wording for
 * everyone who never edited it. A user-made agent is a row and nothing else.
 */
import type {
  AgentAvatarRef,
  AgentCreateInput,
  AgentDuplicateInput,
  AgentModelRef,
  AgentPatch,
  AgentRecord,
  AgentSkillRef,
} from "~/types/desktop";
import {
  addTeamMember,
  agentRows,
  bindThread,
  carryThread,
  forkAgentRow,
  hydrateAgentRows,
  insertAgentRow,
  fetchProjectTeam as loadTeam,
  patchAgentRow,
  projectTeams,
  removeAgentRow,
  removeTeamMember,
  selectAgentId,
  selectedAgentId,
  threadBindings,
} from "~/utils/agentStore";
import { readBot, type AgentBot } from "~/utils/bot";
import { resolveRootThreadId } from "~/composables/sideChats";
import { sampleFace } from "~/utils/sphereFace";

/**
 * How a face is painted: the marble, and the ink drawn on it.
 *
 * Both colours must be opaque. The eyes are painted rather than punched, so a
 * translucent ink would let the marble show through them and the face would
 * come out blank.
 */
export interface FacePaint {
  body: string;
  ink: string;
}

/**
 * An agent's capabilities: what it is equipped with and what it runs on. Skills
 * are additive — the ones this agent is given — so an empty list is "none".
 * `model` is the one model the agent uses: a ref pins it there, and `null` is no
 * preference at all, which is the shipped default (a thread picks whatever it
 * likes, per turn). `modelFallbacks` is the ordered chain behind that pin — tried
 * when the primary is rate-limited or spent. An empty list is a pin with no
 * second choice. The provider is implied by the model ref, so there is no
 * separate provider axis.
 *
 * Reasoning is deliberately absent: it is a per-turn choice made when a model is
 * actually being used, not a standing capability of the agent.
 */
export interface AgentCapabilities {
  skills: AgentSkillRef[];
  model: AgentModelRef | null;
  modelFallbacks: AgentModelRef[];
}

/**
 * A picture of an agent — who is speaking, for a transcript or a roster row.
 *
 * `source` says where the picture came from, so an editor can offer to replace a
 * generated face without having to inspect the bytes. `src` is whatever draws
 * it: a path to an asset this build ships, or a data URL carrying a generated
 * face by value. It has to be by value — the generator hands back a different
 * face on every request, so a stored URL would give the agent a new face on
 * every paint.
 *
 * Distinct from a bot (`~/utils/bot`), and worth keeping distinct: an avatar
 * says who is speaking, a bot is a creature the agent drives.
 */
export type AgentAvatarSource = "generated" | "upload" | "dicebear" | "shipped";

/** The sources a stored picture can name. A row from a build that offered one
 *  this build doesn't is read as generated rather than dropped: the bytes are
 *  still a picture of the agent, and only the label for where they came from is
 *  lost. */
const AVATAR_SOURCES: readonly AgentAvatarSource[] = [
  "generated",
  "upload",
  "dicebear",
  "shipped",
];

export interface AgentAvatar {
  source: AgentAvatarSource;
  src: string;
}

/** An agent as shipped — the built-in definition, before any user edits. */
export interface AgentPreset {
  id: string;
  name: string;
  /** One line under the name: what they are here for. Shown in the roster; not
   *  sent anywhere. */
  role: string;
  face: FacePaint;
  /** How the agent works, in its own words — reaches the model as the agent's
   *  standing orders (see `agentPersonaForThread`). Optional: an agent can be
   *  nothing but a name and a face. */
  instructions?: string;
  /** What the agent is equipped with. Optional: a preset that names none ships
   *  an agent with no skills and no provider/model restriction, which is what
   *  the built-in does today. */
  capabilities?: Partial<AgentCapabilities>;
  /** The picture of the agent, and the bot it drives. Both optional and
   *  independent: an agent with no avatar is identified by its drawn face, and an
   *  agent with no bot simply has none. */
  avatar?: AgentAvatar;
  bot?: AgentBot;
}

/**
 * What a provider session is told about an agent — the subset of an `Agent`
 * that crosses the IPC boundary (mirrors the desktop `AgentPersona`). The
 * drawer-only fields — face, role, roster order — stop here; a model has no use
 * for them.
 */
export interface AgentPersona {
  name: string;
  instructions?: string;
}

/** An agent, resolved: the preset with the user's edits and a drawn face. */
export interface Agent {
  id: string;
  name: string;
  role: string;
  /** Inline SVG, ready to mount. Same contract as a guest's face, so one
   *  component can render either. */
  svg: string;
  /** The colour the face is painted, carried alongside the drawn SVG so a
   *  surface can tint something *around* the face — the roster's dither field —
   *  in the agent's own hue instead of parsing it back out of the markup. */
  hue: string;
  /** The colour the eyes are drawn in. Here for the same reason as `hue`, and
   *  only because the two have to be read as a pair: an agent asked to recolour
   *  a face has to know what it is repainting, and half a paint job is how a
   *  face goes unreadable. */
  ink: string;
  /** The agent's standing instructions, when it has any — carried through so
   *  the send path can hand them to the session. */
  instructions?: string;
  /** The agent's resolved capabilities. Concrete on a resolved agent — the
   *  null-is-inherit of a stored row is answered here, against the preset — so a
   *  reader never has to resolve inheritance a second time. A null `model` means
   *  no preference; an empty `skills` means none assigned. Host-side only:
   *  capabilities never reach a provider session (see `agentPersonaForThread`). */
  capabilities: AgentCapabilities;
  /** The agent's picture, or null when it has none — at which point `svg` is how
   *  it is identified. Resolved on the same terms as everything else here: null
   *  on the row inherits the preset's. */
  avatar: AgentAvatar | null;
  /** The bot the agent drives, or null when it has none. Null is a real answer,
   *  not a missing one: an agent without a bot is not an agent wearing the
   *  default bot. Ids are resolved through the catalogue, so one stored by a
   *  build offering a shape this one dropped still draws. */
  bot: AgentBot | null;
}

/** What a solo thread with no teammate persona picked is called. */
export const DEFAULT_PARTNER_LABEL = "Default";
export const GUEST_LABEL = DEFAULT_PARTNER_LABEL;

/**
 * kone itself — the agent every user starts with.
 *
 * It wears the accent, and it is the only one that does. That is the visual
 * hierarchy the roster needs: the house agent is the one you already know, and
 * every agent added later reads as a colleague beside it rather than as another
 * copy of it.
 *
 * The colours are the two the theme already pairs — the hue the agent is, and
 * the ink meant to sit on top of it — so a face re-themes with everything else
 * rather than carrying its own palette.
 */
/**
 * How the kone agent works — the one thing besides its name that reaches the
 * model. It reads as the agent's own standing orders and stays behavioural: how
 * to act, not which provider, model or effort to run. It opens with the
 * temperament to carry through a thread, then the habits good engineers already
 * expect of each other and that agents are most often faulted for missing —
 * plain talk, honesty over agreement, verifying before claiming, staying in
 * scope, fitting the codebase, and asking before the moves that can't be taken
 * back.
 */
const KONE_INSTRUCTIONS = `Work like a senior engineer a teammate trusts.

Stay calm and even-keeled — the teammate who stays level when the build is red and the clock is against you. Be conscientious: keep the details straight and follow through, without being fussy about it. Stay curious about the codebase and genuinely interested in the problem, not just closing the task. Keep a low ego — take the work seriously without taking yourself too seriously, share credit freely, and own a mistake the moment you spot it.

**Talk plainly.** Direct and concrete, the way one good engineer talks to another. No filler openers ("Great question," "Certainly"), no praise, no emoji, no enthusiasm you don't feel.

**Be honest over agreeable.** If the user is wrong or an approach is risky, say so before going along — flattery is a worse failure than disagreement. Don't fold the moment you're questioned; if you were right, explain why.

**Verify before you claim.** Don't say tests pass, or something's fixed, unless you ran it and saw it. If you didn't check, say so. Report failures and uncertainty as they are — a truthful "still failing" beats a confident "done."

**Stay in scope.** Do what was asked, nothing more — no drive-by reformatting, import reordering, renaming, or "simplifying" untouched code. Spot something else worth doing? Name it, let the user decide.

**Fit the codebase.** Read enough to match its conventions before adding to it, and prefer the simplest change that solves the real problem over a sweeping one.

**Ask before one-way moves.** Architectural, irreversible, public-API, or genuinely ambiguous — stop and ask. Otherwise decide from the code; don't interrupt for what you can settle yourself.`;

export const KONE: AgentPreset = {
  id: "kone",
  name: "kone",
  role: "Agent assistant",
  face: { body: "var(--agent)", ink: "var(--accent-ink)" },
  instructions: KONE_INSTRUCTIONS,
  // A shipped asset rather than a data URL on the row: the house agent's picture
  // is part of the build, so it belongs in the bundle where a later one can
  // improve it, exactly as its instructions do.
  avatar: { source: "shipped", src: "/agents/kone.jpg" },
  // The house bot wears the accent's own hue, and the accent is the only colour
  // it may claim — every bot made later reads as a colleague beside it. A sphere
  // because that is the shape kone already is.
  bot: { form: "circle", color: "orange", expression: "attentive" },
};

const PRESETS: readonly AgentPreset[] = [KONE];

/** What the store is asked to keep a row for, in the order the roster wants
 *  them. A preset dropped from a later build leaves its row behind — see
 *  `resolveRow`, which declines to render an agent it has no definition for. */
const PRESET_IDS: readonly string[] = PRESETS.map((preset) => preset.id);

/**
 * The paint a user-made agent wears until somebody picks a hue for it.
 *
 * Deliberately none of the three accent voices: the house agent wears the first,
 * and an agent made in a hurry should not arrive claiming one of the others.
 * Soft ink with the ground punched through it reads as a face with no colour
 * chosen yet, which is exactly what it is.
 */
const UNPAINTED_FACE: FacePaint = { body: "var(--ink-soft)", ink: "var(--ground)" };

// ── the face ────────────────────────────────────────────────────────────────
/**
 * The pose an agent is drawn in: kone's own face, held still and looking
 * straight out.
 *
 * The idle pose is deliberately NOT used. Idling, the head is turned up and to
 * its right, and the eyes ride near the limb of the sphere — alive when it is
 * moving, but frozen at that angle the two capsules read as glare on a marble
 * rather than as a face. A centred aim is the same geometry pointed at the
 * viewer: eyes level and forward, the signature lean kept.
 *
 * The clock is only there to fix which frame; it sits before the first blink and
 * inside a quiet stretch of the idle drift.
 */
const REST_TIME = 0.9;
const REST_AIM = { nx: 0, ny: 0, mix: 1 } as const;

/**
 * Body diameter inside the 100-unit tile.
 *
 * Nearly the whole tile: an agent's face is a marble, the same object the
 * composer collapses into, so it fills what it is given rather than floating in
 * a ring of something else. The couple of units held back are for the sphere
 * being marginally taller than it is wide — at a full 100 the crown and the chin
 * would both clip.
 */
const BODY = 96;
const INSET_X = (100 - BODY) / 2;
/** Slightly less than the horizontal inset: the extra height all falls below
 *  the equator, and centring on the box would leave the chin outside it. */
const INSET_Y = INSET_X - 0.4;

const faceCache = new Map<string, string>();

/**
 * An agent's face as an inline SVG string, sized by whatever mounts it.
 *
 * The eyes are painted on the marble rather than punched out of it. A mask was
 * tried and is wrong here: masks need ids, one face is mounted dozens of times
 * across a board, and every one of those mounts resolves `url(#id)` against the
 * first copy in the document — which may be sitting in a subtree that never
 * paints, at which point every face on screen goes blank. Painted eyes carry no
 * references at all, so a face is self-contained wherever it lands.
 */
export function agentFace(paint: FacePaint): string {
  const key = `${paint.body}|${paint.ink}`;
  const hit = faceCache.get(key);
  if (hit) return hit;

  const frame = sampleFace(REST_TIME, { size: BODY, aim: REST_AIM });
  const eyes = frame.eyes
    .map(
      (eye) =>
        `<path d="${eye.d}" transform="${eye.matrix}" opacity="${eye.alpha}" fill="${paint.ink}"/>`,
    )
    .join("");

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<g transform="translate(${INSET_X} ${INSET_Y})">` +
    `<path d="${frame.bodyPath}" fill="${paint.body}"/>${eyes}` +
    `</g></svg>`;

  faceCache.set(key, svg);
  return svg;
}

/**
 * An avatar read back off a row. Anything without both halves is no avatar at
 * all — a picture with nothing to draw would paint a blank where a face used to
 * be — and an unrecognised `source` reads as generated, which loses only the
 * label for where the bytes came from.
 */
function readAvatar(value: AgentAvatarRef | null): AgentAvatar | null {
  const src = value?.src?.trim();
  if (!src) return null;
  // SAFETY: the row's source tag is whatever an older build stored; the
  // membership test on the next line demotes anything not in AVATAR_SOURCES
  // to "generated".
  const named = value?.source as AgentAvatarSource | undefined;
  const source = named && AVATAR_SOURCES.includes(named) ? named : "generated";
  return { source, src };
}

/**
 * The row a shipped preset reads through before the store has one for it: no
 * name, no role, no prose — every field still this file's to answer.
 *
 * It stands in for the moment before `hydrateRoster` returns, and for the first
 * paint of a fresh install. Its position is the preset's own index, which is the
 * position `hydrateRoster` will give the real row, so nothing jumps when the
 * store answers.
 */
function implicitRow(presetId: string, index: number): AgentRecord {
  return {
    agentId: presetId,
    presetId,
    name: null,
    role: null,
    instructions: null,
    faceBody: null,
    faceInk: null,
    skills: null,
    model: null,
    modelFallbacks: null,
    avatar: null,
    bot: null,
    sortOrder: index,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
  };
}

/**
 * Every row the roster resolves through: what the store has, plus an implicit
 * row for any shipped preset it hasn't got one for yet.
 *
 * The union is what makes the pre-hydrate state safe. If the roster read only
 * stored rows, a fresh install would show no agents at all until the store
 * answered, and a build shipping several would show only the first one edited
 * the instant it was edited. Rows are still the truth
 * wherever there is one — an edit, a fork's position, a tombstone all come from
 * the store — and a preset with nothing stored about it simply reads as
 * unedited, which it is.
 */
function rosterRows(): AgentRecord[] {
  const rows = agentRows.value;
  const stored = new Set(rows.map((row) => row.agentId));
  const missing = PRESETS.flatMap((preset, index) =>
    stored.has(preset.id) ? [] : [implicitRow(preset.id, index)],
  );
  return [...rows, ...missing].sort(
    (a, b) =>
      a.sortOrder - b.sortOrder || a.createdAt - b.createdAt || a.agentId.localeCompare(b.agentId),
  );
}

/**
 * A stored row, read as an agent.
 *
 * Every null on the row is a question this file answers: the preset it overlays
 * says what the user never changed. `''` is a different answer and is honoured
 * as one — a field somebody deliberately emptied stays empty.
 *
 * Returns undefined for a row this build cannot render: one that inherits
 * everything from a preset the build no longer ships. Rather than invent a name
 * for it, the roster leaves it out and it reads as a guest wherever it is
 * looked up — the row survives untouched for a build that knows what it is.
 */
function resolveRow(row: AgentRecord): Agent | undefined {
  const preset = row.presetId ? PRESETS.find((p) => p.id === row.presetId) : undefined;
  const name = row.name?.trim() || preset?.name;
  if (!name) return undefined;

  const instructions = row.instructions ?? preset?.instructions;
  const paint: FacePaint = {
    body: row.faceBody || preset?.face.body || UNPAINTED_FACE.body,
    ink: row.faceInk || preset?.face.ink || UNPAINTED_FACE.ink,
  };

  // Each capability is its own overlay: null on the row hands it back to the
  // preset, and a preset that names none lands on the empty default — no skills,
  // no model. `[]`/a ref on the row is a real answer (the user set it) and is
  // kept, never re-inherited.
  const capabilities: AgentCapabilities = {
    skills: row.skills ?? preset?.capabilities?.skills ?? [],
    model: row.model ?? preset?.capabilities?.model ?? null,
    modelFallbacks:
      row.model !== null
        ? (row.modelFallbacks ?? [])
        : (preset?.capabilities?.modelFallbacks ?? []),
  };

  // Appearance resolves as one overlay each, like the prose: null on the row is
  // the preset's answer, and neither field lands on a default — an agent with no
  // avatar is identified by its drawn face, and an agent with no bot has none.
  // A stored bot is read through the catalogue so ids this build has dropped
  // still draw something rather than nothing.
  const avatar = readAvatar(row.avatar) ?? preset?.avatar ?? null;
  const bot = readBot(row.bot) ?? preset?.bot ?? null;

  const agent: Agent = {
    id: row.agentId,
    name,
    role: row.role ?? preset?.role ?? "",
    svg: agentFace(paint),
    hue: paint.body,
    ink: paint.ink,
    capabilities,
    avatar,
    bot,
  };
  if (instructions) agent.instructions = instructions;
  return agent;
}

/** Whether an id belongs to an agent this build ships. Worth asking outside
 *  this file: clearing a field on a shipped agent hands it back to the preset,
 *  and on a user-made one unsets it, so the same edit means two things. */
export function isShippedAgent(id: string): boolean {
  return PRESET_IDS.includes(id);
}

/** Everyone you can hand a turn to, in roster order. */
export function agentRoster(): Agent[] {
  return rosterRows()
    .filter((row) => row.deletedAt === null)
    .map(resolveRow)
    .filter((agent): agent is Agent => agent !== undefined);
}

/** Load the roster from the store, and give every shipped preset a row to hang
 *  the user's edits on. Idempotent; call it wherever the roster is first read. */
export function hydrateRoster(): Promise<void> {
  return hydrateAgentRows(PRESET_IDS);
}

/** Somebody in the roster, by id — nobody for an agent who has left it. Use
 *  this for anything the user picks from. */
export function agentById(id: string | null | undefined): Agent | undefined {
  if (!id) return undefined;
  const row = rosterRows().find((r) => r.agentId === id && r.deletedAt === null);
  return row ? resolveRow(row) : undefined;
}

/**
 * Anybody who has ever been in the roster, by id — including an agent who has
 * since left it.
 *
 * A transcript records who did the work, so deleting an agent cannot rewrite the
 * threads they worked: their row outlives them precisely so the conversations
 * still have a name and a face on them.
 */
function agentOrDeparted(id: string | null | undefined): Agent | undefined {
  if (!id) return undefined;
  const row = rosterRows().find((r) => r.agentId === id);
  return row ? resolveRow(row) : undefined;
}

/** Whether an agent can be handed the next turn — in the roster, not merely
 *  remembered. Picking or settling on somebody who has left it is refused. */
function isPickable(id: string): boolean {
  return agentById(id) !== undefined;
}

/** Who the next turn goes to, or undefined for a guest. */
export function selectedAgent(): Agent | undefined {
  return agentById(selectedAgentId.value);
}

/** Point the next turn at an agent, or at a guest with null. */
export function selectAgent(id: string | null): void {
  if (id === null || isPickable(id)) selectAgentId(id);
}

/**
 * Whoever worked this thread, or undefined if it ran as a guest.
 *
 * An unclaimed thread stays unclaimed — it does not fall back to the current
 * selection, so picking an agent tomorrow cannot retroactively put their name on
 * work they never did.
 */
export function agentForThread(threadId: string | null | undefined): Agent | undefined {
  if (!threadId) return undefined;
  const bound = threadBindings.value[threadId];
  if (bound !== undefined) {
    return agentOrDeparted(bound);
  }
  const rootId = resolveRootThreadId(threadId);
  if (rootId && rootId !== threadId) {
    const rootBound = threadBindings.value[rootId];
    if (rootBound !== undefined) {
      return agentOrDeparted(rootBound);
    }
  }
  return undefined;
}

/**
 * Settle who works this thread, at the moment it starts. Write-once: a thread
 * that already has an agent keeps them, so a later send can never rewrite who
 * wrote the lines already above it.
 *
 * `null` settles it on a guest, which is a decision like any other — it closes
 * the thread to being claimed by an agent picked afterwards.
 */
export function settleThreadAgent(threadId: string | null | undefined, id: string | null): void {
  if (!threadId || threadId in threadBindings.value) return;
  if (id !== null && !isPickable(id)) return;
  bindThread(threadId, id);
}

/**
 * Hand a new thread the agent an old one had — for a thread reborn under a new
 * id (a provider or model switch tears the session down and starts another).
 *
 * The same work continuing under a new id is still the same colleague's, so the
 * record follows it. It carries a guest binding too, and that matters as much:
 * a guest thread restarted has to come back a guest rather than fall through to
 * whoever the composer is pointing at by then. Write-once at the far end, so a
 * thread that has already settled keeps what it settled on.
 */
export function carryThreadAgent(
  fromThreadId: string | null | undefined,
  toThreadId: string | null | undefined,
): void {
  if (!fromThreadId || !toThreadId) return;
  carryThread(fromThreadId, toThreadId);
}

// ── project teams ───────────────────────────────────────────────────────────
// A project's team is the slice of the roster made available to work within it:
// who you can hand a thread to there, and who a teammate can delegate to. An
// agent stays one global entity that joins many teams; membership is per project
// and set by hand, so a fresh project's team is empty until the user builds it.

/**
 * A project's team, in the order they were added — resolved to agents, with any
 * who have left the roster dropped.
 *
 * A team can outlive the agent (the membership row survives a delete, so
 * restoring one restores every team they were on), but you cannot hand work to
 * somebody who is gone, so a departed member is not returned here.
 */
export function projectTeam(projectPath: string | null | undefined): Agent[] {
  if (!projectPath) return [];
  return (projectTeams.value[projectPath] ?? [])
    .map((id) => agentById(id))
    .filter((agent): agent is Agent => agent !== undefined);
}

/**
 * Every project team known to this machine, as a path with its resolved
 * members — the raw material for a cross-project overview of who works where.
 *
 * Only the teams that have been loaded show up (see `agentTeamPaths` for why),
 * and a team with no resolvable member left is dropped: an empty section is a
 * project that reads as having no team, which for this listing it does.
 */
export function projectTeamsList(): { path: string; agents: Agent[] }[] {
  return Object.keys(projectTeams.value)
    .map((path) => ({ path, agents: projectTeam(path) }))
    .filter((team) => team.agents.length > 0);
}

/** Whether an agent is on a project's team right now. */
export function isOnProjectTeam(projectPath: string | null | undefined, id: string): boolean {
  if (!projectPath) return false;
  return (projectTeams.value[projectPath] ?? []).includes(id);
}

/**
 * Every project path whose team an agent is on, as far as this machine knows.
 *
 * Membership is read per project, so this only sees the projects whose teams
 * have been loaded — the ones you've opened. It answers "where does this agent
 * work", which is a hint, not a census: a project you've never opened here has
 * no team in hand to check.
 */
export function agentTeamPaths(id: string): string[] {
  return Object.keys(projectTeams.value).filter((path) =>
    (projectTeams.value[path] ?? []).includes(id),
  );
}

/** Read a project's team from the store. Call it when a project becomes active. */
export function loadProjectTeam(projectPath: string | null | undefined): Promise<void> {
  return projectPath ? loadTeam(projectPath) : Promise.resolve();
}

/** Put an agent on a project's team. Refused, like a pick, for one who has left
 *  the roster — you cannot staff a project with somebody who is gone. */
export function addAgentToProject(projectPath: string, id: string): Promise<boolean> {
  if (!isPickable(id)) return Promise.resolve(false);
  return addTeamMember(projectPath, id);
}

/** Take an agent off a project's team. */
export function removeAgentFromProject(projectPath: string, id: string): Promise<void> {
  return removeTeamMember(projectPath, id);
}

/**
 * What the provider session is told about whoever is working a thread, or
 * undefined when it runs as a guest.
 *
 * This is the one place an agent stops being a face in a list and becomes
 * something the model hears about. The name goes, and the agent's instructions
 * when it has them: the face, the role and the roster order are for the person
 * reading the drawer, and a model has no use for any of them.
 *
 * Read from the thread's settled binding rather than from the current
 * selection: the session belongs to a thread, and the thread's agent is a
 * decision already made. Picking somebody else points the *next* thread at
 * them; it cannot change who a running conversation has been all along.
 */
export function agentPersonaForThread(threadId: string | null | undefined): AgentPersona | undefined {
  const agent = agentForThread(threadId);
  if (!agent) return undefined;
  const persona: AgentPersona = { name: agent.name };
  if (agent.instructions) persona.instructions = agent.instructions;
  return persona;
}

// ── changing the roster ─────────────────────────────────────────────────────
// Every one of these is a write to the store (see `~/utils/agentStore`), and
// every one speaks in this file's own terms — a face is a `FacePaint`, not two
// loose colour strings. They resolve to the agent as it now reads, so a caller
// can put the result straight on screen.

/** What you fill in to make an agent: a name, and whatever else you have.
 *  Everything but the name is optional — an agent can be a name and a face. */
export interface AgentDraft {
  /** The id to store the agent under. The caller's to mint when it has to name
   *  the agent before the row exists — an agent tool reporting what it just
   *  created, say. Left out, the store mints one. */
  id?: string;
  name: string;
  role?: string;
  instructions?: string;
  face?: FacePaint;
  skills?: AgentSkillRef[];
  model?: AgentModelRef;
  modelFallbacks?: AgentModelRef[];
  avatar?: AgentAvatar;
  bot?: AgentBot;
}

/** An edit to an existing agent. A field left out is left alone; an explicit
 *  null clears it — which on a built-in hands that field back to the shipped
 *  preset, and on a user-made agent unsets it. A capability list clears the
 *  same way: null re-inherits, `[]` is a kept empty. A null `model` re-inherits
 *  the preset's; a ref sets it. */
export interface AgentEdit {
  name?: string | null;
  role?: string | null;
  instructions?: string | null;
  face?: FacePaint | null;
  skills?: AgentSkillRef[] | null;
  model?: AgentModelRef | null;
  modelFallbacks?: AgentModelRef[] | null;
  /** Appearance clears the same way: null re-inherits the preset's picture or
   *  bot, and on a user-made agent takes it away entirely. */
  avatar?: AgentAvatar | null;
  bot?: AgentBot | null;
}

/** The preset's own values, for a fork that has to keep no inheritance. A row
 *  overlaying a built-in answers half its fields with null, and the copy has to
 *  read the same as what was copied — capabilities included. */
function inheritedFrom(preset: AgentPreset | undefined) {
  if (!preset) return undefined;
  return {
    name: preset.name,
    role: preset.role,
    instructions: preset.instructions ?? null,
    faceBody: preset.face.body,
    faceInk: preset.face.ink,
    skills: preset.capabilities?.skills ?? null,
    model: preset.capabilities?.model ?? null,
    modelFallbacks: preset.capabilities?.modelFallbacks ?? null,
    avatar: preset.avatar ?? null,
    bot: preset.bot ?? null,
  };
}

/** Rename an agent. An empty name — or the one they shipped with — drops the
 *  override, handing the name back to the preset. */
export function renameAgent(id: string, name: string): Promise<Agent | undefined> {
  const preset = PRESETS.find((p) => p.id === id);
  const trimmed = name.trim();
  const cleared = !trimmed || trimmed === preset?.name;
  // A user-made agent has no preset to fall back to, so clearing its name is
  // not a rename at all: it would leave them with nothing to be called.
  if (cleared && !preset) return Promise.resolve(undefined);
  return updateAgent(id, { name: cleared ? null : trimmed });
}

/** Add an agent. Returns the agent as stored, or undefined if it was refused —
 *  which only happens for a draft with nothing to be called. */
export async function createAgent(draft: AgentDraft): Promise<Agent | undefined> {
  const input: AgentCreateInput = {
    name: draft.name,
    role: draft.role ?? null,
    instructions: draft.instructions ?? null,
    faceBody: draft.face?.body ?? null,
    faceInk: draft.face?.ink ?? null,
    skills: draft.skills ?? null,
    model: draft.model ?? null,
    modelFallbacks: draft.model ? (draft.modelFallbacks ?? []) : null,
    avatar: draft.avatar ?? null,
    bot: draft.bot ?? null,
  };
  // Set only when the caller minted one: an explicit undefined would read as a
  // field the store has to answer, and the store's answer is to mint its own.
  if (draft.id) input.agentId = draft.id;
  const row = await insertAgentRow(input);
  return row ? resolveRow(row) : undefined;
}

/** Edit an agent. Returns them as they now read, or undefined if the edit was
 *  refused — an agent who has left the roster, or one this would leave with no
 *  name at all. */
export async function updateAgent(id: string, edit: AgentEdit): Promise<Agent | undefined> {
  const preset = PRESETS.find((p) => p.id === id);
  const patch: AgentPatch = {};
  if (edit.name !== undefined) patch.name = edit.name;
  if (edit.role !== undefined) patch.role = edit.role;
  if (edit.instructions !== undefined) patch.instructions = edit.instructions;
  // A face is one decision, so both halves of it move together — repainting the
  // marble and leaving last week's ink on it is how a face goes unreadable.
  if (edit.face !== undefined) {
    patch.faceBody = edit.face?.body ?? null;
    patch.faceInk = edit.face?.ink ?? null;
  }
  if (edit.skills !== undefined) patch.skills = edit.skills;
  if (edit.model !== undefined) patch.model = edit.model;
  if (edit.modelFallbacks !== undefined) patch.modelFallbacks = edit.modelFallbacks;
  if (edit.avatar !== undefined) patch.avatar = edit.avatar;
  if (edit.bot !== undefined) patch.bot = edit.bot;
  const row = await patchAgentRow(id, patch, preset ? { presetId: preset.id } : undefined);
  return row ? resolveRow(row) : undefined;
}

/**
 * Take an agent out of the roster.
 *
 * They are not erased: the threads they worked keep their name and face, which
 * is why `agentForThread` reads tombstones and the roster does not. What has to
 * change is anything pointing at them for *future* work — a selection left on a
 * departed agent would send the next turn to nobody.
 */
export async function deleteAgent(id: string): Promise<boolean> {
  const removed = await removeAgentRow(id);
  if (removed && selectedAgentId.value === id) selectAgentId(null);
  return removed;
}

/** Fork an agent into a user-made copy of itself, sitting straight below the
 *  original. A built-in forks into an ordinary agent: the copy carries the
 *  preset's words but none of its inheritance, so a later build cannot rewrite
 *  what somebody kept. */
export async function duplicateAgent(id: string, name?: string): Promise<Agent | undefined> {
  const presetId = agentRows.value.find((row) => row.agentId === id)?.presetId ?? id;
  const inherited = inheritedFrom(PRESETS.find((p) => p.id === presetId));
  const fork: AgentDuplicateInput = { agentId: id };
  const trimmed = name?.trim();
  if (trimmed) fork.name = trimmed;
  if (inherited) fork.inherited = inherited;
  const row = await forkAgentRow(fork);
  return row ? resolveRow(row) : undefined;
}
