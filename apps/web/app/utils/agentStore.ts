/**
 * The roster's durable side: the rows behind the agents.
 *
 * `~/utils/agents` is the domain — who the agents are, what a face looks like,
 * what a provider session gets told. This file is the one door to where that
 * survives a quit: the desktop store (agents, project_agents, thread_agents and
 * roster_selection, store v24), or browser storage when there is no bridge to
 * reach it through.
 *
 * A row is a *delta*, never a whole agent. The shipped presets live in
 * `agents.ts` — they are prose in the binary, and re-storing them would freeze
 * a copy that a later build could no longer improve. So a row belonging to a
 * built-in leaves untouched fields null ("inherit"), and resolving those nulls
 * against the preset is `agents.ts`'s job, not this file's and not the store's.
 *
 * Nothing here knows which ids are presets, which is deliberate: the caller
 * holds the preset definitions, so the caller says when a row has to exist
 * (`ensure`) and what a cleared field falls back to.
 */
import { useStorage } from "@vueuse/core";
import type {
  AgentAvatarRef,
  AgentBotRef,
  AgentCreateInput,
  AgentDuplicateInput,
  AgentModelRef,
  AgentPatch,
  AgentRecord,
  RosterSnapshot,
  ThreadAgentBinding,
} from "~/types/desktop";

/**
 * Every row the store knows about, deleted ones included, in roster order.
 *
 * Also the warm cache: it is written back on every hydrate, so the first paint
 * after a relaunch shows the agents you actually have instead of the shipped
 * defaults for the millisecond the bridge takes to answer. With no bridge at
 * all (a browser `nuxt dev`) the same array *is* the store — edits made while
 * iterating on the pane survive a reload, which is the whole point of being able
 * to iterate there.
 *
 * Read it; don't write it from outside. Every mutation goes through the four
 * functions below so the backend and the cache can't drift.
 */
export const agentRows = useStorage<AgentRecord[]>("kone.agents.rows", [], undefined, {
  listenToStorageChanges: true,
});

/**
 * Which agent worked a given thread, by thread id — the same warm-cache
 * arrangement as the rows above, and the same rule about writing it.
 *
 * A thread that ran as a guest records `GUEST_BINDING`, not nothing. *Absence*
 * means the thread never started, which is what stops a guest conversation
 * being claimed later by an agent picked after the fact — and it is also every
 * thread from before any of this existed, which correctly reads as a guest.
 */
export const threadBindings = useStorage<Record<string, string>>(
  "kone.agents.threads",
  {},
  undefined,
  { listenToStorageChanges: true },
);

/** What a thread handed to nobody in particular records. It is not an agent id,
 *  so it resolves to a guest everywhere an id is looked up. The store says the
 *  same thing with a NULL; this is the renderer's spelling of it. */
export const GUEST_BINDING = "";

/**
 * Who answers the next turn you send, or null to send it to a guest.
 *
 * Null is the shipped default. Handing work to a named agent is a decision the
 * user makes, so nothing is picked on their behalf.
 */
export const selectedAgentId = useStorage<string | null>(
  "kone.agents.selected",
  null,
  undefined,
  { listenToStorageChanges: true },
);

/**
 * Each project's team, by project path → the agent ids on it, in the order they
 * were added.
 *
 * The same warm-cache-or-store arrangement as the rows above. With a bridge this
 * mirrors the store's `project_agents`, loaded a project at a time on demand;
 * without one (a browser `nuxt dev`) the map *is* the team, so membership set
 * while iterating on the pane survives a reload.
 *
 * Read it; don't write it from outside. Every change goes through the three
 * functions below so the backend and the cache can't drift.
 */
export const projectTeams = useStorage<Record<string, string[]>>(
  "kone.agents.teams",
  {},
  undefined,
  { listenToStorageChanges: true },
);

/** The rename map the roster kept before it had rows, and the flag that says it
 *  has been carried over. The data is deliberately left behind rather than
 *  cleared: it costs nothing, and a rollback to an older build still finds it. */
const LEGACY_NAMES_KEY = "kone.agents.names";
const LEGACY_NAMES_CARRIED_KEY = "kone.agents.names.carried";

/** Field ceilings, mirroring the store's own. The editor is where a sensible
 *  length belongs; these are the floor that keeps a runaway paste out of a row,
 *  and the store clamps again on the way in. */
const NAME_MAX = 64;
const ROLE_MAX = 120;
const PROSE_MAX = 4000;
const PAINT_MAX = 64;
/**
 * How long an avatar's `src` may get, mirroring the store's own ceiling.
 *
 * Far larger than anything else here because a generated face is carried by
 * value — the source hands back a different one per request, so a stored URL
 * would repaint a new face every time. Worth knowing in the dev fallback in
 * particular: rows there live in browser storage, which is a few megabytes
 * total, so a handful of avatars is fine and a full-size original is not.
 */
const AVATAR_MAX = 512 * 1024;
/** How long a capability list may get in the dev fallback, mirroring the
 *  store's own ceiling. */
const LIST_MAX = 128;

function bridge() {
  return import.meta.client ? window.koneDesktop?.roster : undefined;
}

/**
 * The same payload with nothing reactive left in it.
 *
 * Everything crossing the bridge is structured-cloned, and that serializer
 * refuses a Proxy outright — so a value read out of a `ref` holding an object
 * fails to send at all, with nothing but "an object could not be cloned" to say
 * why. Which is every picture, bot, model and policy list a pane collects, since
 * a pane holds its draft in refs.
 *
 * Done here, at the one place these leave the renderer, rather than at each
 * pane: a field that forgets is a write that fails in the app and nowhere else,
 * and the next field added would have to remember all over again. A round trip
 * through JSON rather than `toRaw`, because the nesting is arbitrary — an
 * unwrapped top level with a reactive array inside it is the same failure.
 * Everything here is stored as JSON at the far end, so nothing survives the trip
 * that wouldn't have survived the column.
 *
 * Exported for its test rather than for callers: the bridge itself is out of
 * reach from a test, so the guarantee this makes is worth pinning down on its
 * own.
 */
export function sendable<T>(payload: T): T {
  // SAFETY: a JSON round-trip preserves plain data exactly — strings, numbers,
  // arrays and records come back with the same shape T declares. Only things
  // JSON can't carry (functions, reactivity) are dropped, which is the point.
  return JSON.parse(JSON.stringify(payload)) as T;
}

/** In flight while the first hydrate is still running. Writes wait on it, so an
 *  edit made the instant a pane mounts lands on a row that already exists. */
let hydrating: Promise<void> | null = null;

/**
 * Load the roster, creating an overlay row for any shipped preset that hasn't
 * got one. Idempotent per app run; call it wherever the roster is first read.
 *
 * `presetIds` is in the order the build wants them. A preset the user deleted is
 * not re-created — dismissing a built-in has to stick.
 */
export function hydrateAgentRows(presetIds: readonly string[]): Promise<void> {
  hydrating ??= runHydrate([...presetIds]).finally(() => {
    hydrating = null;
  });
  return hydrating;
}

async function runHydrate(presetIds: string[]): Promise<void> {
  const api = bridge();
  if (api) applyRosterSnapshot(await api.hydrate({ presetIds }));
  else for (const presetId of presetIds) ensureLocalRow(presetId);
  carryLegacyNames(presetIds);
}

/**
 * Take the store's word for the whole roster layer — the one place an
 * authoritative snapshot enters the renderer. Hydrate is its only caller in the
 * app; the reason it is exported is that this reconciliation is the whole
 * contract between the two halves of the roster, and it is worth stating.
 *
 * The bindings are *replaced*, not merged, which is what keeps the mirror the
 * same size as the history: a deleted thread takes its binding with it, and a
 * merge could only ever grow — every thread id the app had ever opened would
 * stay in browser storage for good.
 *
 * The one exception is a binding whose write is still in the air. It has no row
 * in the snapshot yet, and dropping it would leave that conversation looking
 * unclaimed — at which point the next send would settle it again, on whoever is
 * picked by then. For everything else the store's answer stands, since
 * write-once means what it holds is what actually settled.
 */
export function applyRosterSnapshot(snapshot: RosterSnapshot): void {
  // A store that failed to open answers with nothing at all — not even the
  // presets it was just asked to ensure. That is not an answer, so it must not
  // be mistaken for "you have no agents and no history": the cache is all there
  // is in that case, and it stays exactly as it was.
  if (snapshot.agents.length === 0) return;
  agentRows.value = snapshot.agents;
  const settled: Record<string, string> = {};
  for (const threadId of pendingBindings) {
    const local = threadBindings.value[threadId];
    if (local !== undefined) settled[threadId] = local;
  }
  for (const binding of snapshot.bindings) {
    settled[binding.threadId] = binding.agentId ?? GUEST_BINDING;
  }
  threadBindings.value = settled;
  selectedAgentId.value = snapshot.selectedAgentId;
}

/**
 * Carry the renames the roster kept before it had rows into the store, once.
 *
 * A rename was the only thing the old layer stored, so this is the whole
 * migration: each one becomes the name on that preset's overlay row, which is
 * exactly what a rename means now.
 */
function carryLegacyNames(presetIds: string[]): void {
  if (!import.meta.client) return;
  try {
    if (localStorage.getItem(LEGACY_NAMES_CARRIED_KEY)) return;
    const raw = localStorage.getItem(LEGACY_NAMES_KEY);
    // SAFETY: this key is written by kone alone, by a build whose rename map
    // was `Record<string, string>`, so a map of names is the only shape it can
    // hold. Anything else throws below — and the flag is stamped first, so a
    // damaged map is read once and never again.
    const names = raw ? (JSON.parse(raw) as Partial<Record<string, string>>) : {};
    localStorage.setItem(LEGACY_NAMES_CARRIED_KEY, "1");
    for (const presetId of presetIds) {
      const name = names[presetId]?.trim();
      if (name) void patchAgentRow(presetId, { name }, { presetId });
    }
  } catch {
    // Unreadable storage, or a map that turned out not to be one. There is
    // nothing to carry either way, and nothing worth failing a hydrate over.
  }
}

/** Add a user-made agent. Returns the stored row, or null if it was refused
 *  (a nameless agent has nothing to inherit a name from). */
export async function insertAgentRow(input: AgentCreateInput): Promise<AgentRecord | null> {
  await hydrating;
  const api = bridge();
  if (!api) return insertLocalRow(input);
  const row = await api.create(sendable(input));
  if (row) applyRow(row);
  return row;
}

/**
 * Edit one agent. A field left out of the patch is left alone; an explicit null
 * clears it — which on a built-in's row hands that field back to the shipped
 * preset, and on a user-made agent unsets it.
 *
 * `ensure` names the preset this row overlays, for the case where the row does
 * not exist yet: an edit is then also the moment the row is created. Without it,
 * editing an agent nobody has heard of is a no-op rather than an invention.
 */
export async function patchAgentRow(
  agentId: string,
  patch: AgentPatch,
  ensure?: { presetId: string },
): Promise<AgentRecord | null> {
  await hydrating;
  if (ensure && !agentRows.value.some((row) => row.agentId === agentId)) {
    ensureLocalRow(ensure.presetId);
  }
  // Applied here first so the pane redraws on the keystroke rather than on the
  // round trip; the authoritative row replaces it a moment later.
  const optimistic = patchLocalRow(agentId, patch);
  const api = bridge();
  if (!api) return optimistic;
  const row = await api.update(sendable({ agentId, patch }));
  if (row) applyRow(row);
  // Refused — the row is gone, or the edit left an agent with no name at all.
  // Nothing local is trustworthy after that, so go back to what the store has.
  else await reload();
  return row;
}

/** Take an agent out of the roster. The row survives, so a thread they worked
 *  can still be captioned with their name. */
export async function removeAgentRow(agentId: string): Promise<boolean> {
  await hydrating;
  const api = bridge();
  if (!api) return removeLocalRow(agentId);
  const removed = await api.delete({ agentId });
  if (removed) removeLocalRow(agentId);
  return removed;
}

/** Fork an agent into a new user-made one, sitting straight below the original.
 *  `inherited` carries the shipped preset's values for whatever the source row
 *  leaves null — a fork keeps no inheritance, so it copies what the source
 *  reads as. */
export async function forkAgentRow(input: AgentDuplicateInput): Promise<AgentRecord | null> {
  await hydrating;
  const api = bridge();
  if (!api) return forkLocalRow(input);
  const row = await api.duplicate(sendable(input));
  // A fork renumbers the rows below it, so the local copy is stale in more
  // places than the new row — read the order back rather than guessing it.
  if (row) await reload();
  return row;
}

/** Re-read the roster from the store, keeping the presets it already has. */
async function reload(): Promise<void> {
  const api = bridge();
  if (!api) return;
  const presetIds = agentRows.value
    .map((row) => row.presetId)
    .filter((presetId): presetId is string => presetId !== null);
  applyRosterSnapshot(await api.hydrate({ presetIds }));
}

// ── who worked a thread, and who is up next ─────────────────────────────────
// Written through rather than awaited. A binding settles on the send path,
// which cannot wait on a round trip, and it is write-once at both ends: the
// local map refuses to overwrite a thread that already has one, and so does the
// store. The reply is reconciled when it lands, so an id that settled in some
// other window wins over the one this one just guessed.

/** Threads written locally whose round trip hasn't come back yet — the bindings
 *  a hydrate landing in the same moment must not prune. */
const pendingBindings = new Set<string>();

/** Follow a write to the store with the answer it settled on. */
function reconcile(threadId: string, answer: Promise<ThreadAgentBinding | null>): void {
  pendingBindings.add(threadId);
  void answer
    .then((binding) => {
      if (binding) applyBinding(threadId, binding.agentId);
    })
    .catch(() => {
      // The bridge went away mid-write. The local binding stands — it is the one
      // the send that settled it actually used — but nothing durable holds it,
      // so a later hydrate will drop it and the thread reads as a guest.
    })
    .finally(() => {
      pendingBindings.delete(threadId);
    });
}

/** Settle who works a thread, at the moment it starts. Returns what it is bound
 *  to now, which for an already-settled thread is what it settled on before. */
export function bindThread(threadId: string, agentId: string | null): string | null {
  const settled = threadBindings.value[threadId];
  if (settled !== undefined) return settled === GUEST_BINDING ? null : settled;
  threadBindings.value = { ...threadBindings.value, [threadId]: agentId ?? GUEST_BINDING };
  const api = bridge();
  if (api) reconcile(threadId, api.bind({ threadId, agentId }));
  return agentId;
}

/** Hand a new thread the agent an old one had. Write-once at the far end, and a
 *  guest binding carries too — a guest thread restarted has to come back one. */
export function carryThread(fromThreadId: string, toThreadId: string): void {
  const source = threadBindings.value[fromThreadId];
  if (source === undefined || threadBindings.value[toThreadId] !== undefined) return;
  threadBindings.value = { ...threadBindings.value, [toThreadId]: source };
  const api = bridge();
  if (api) reconcile(toThreadId, api.carry({ fromThreadId, toThreadId }));
}

/** Point the next turn at an agent, or at a guest with null. */
export function selectAgentId(agentId: string | null): void {
  selectedAgentId.value = agentId;
  void bridge()?.select({ agentId });
}

function applyBinding(threadId: string, agentId: string | null): void {
  threadBindings.value = { ...threadBindings.value, [threadId]: agentId ?? GUEST_BINDING };
}

// ── each project's team ─────────────────────────────────────────────────────
// Membership is per project and set by hand — an agent is global, but nothing is
// on a team until the user puts it there. Optimistic like the rows above: the id
// lands in the cache on the click so the pane redraws at once, and the store's
// answer is taken when it lands.

/** Read a project's team from the store into the cache. A no-op without a
 *  bridge — the cache is the store there, and reloading would wipe the local
 *  edits that are the whole point of iterating in the browser. */
export async function fetchProjectTeam(projectPath: string): Promise<void> {
  await hydrating;
  const api = bridge();
  if (!api) return;
  const rows = await api.team({ projectPath });
  projectTeams.value = { ...projectTeams.value, [projectPath]: rows.map((row) => row.agentId) };
}

/** Put an agent on a project's team. Returns whether it stuck: the store refuses
 *  an agent that has left the roster, and a refusal rolls the cache back to what
 *  the store holds. */
export async function addTeamMember(projectPath: string, agentId: string): Promise<boolean> {
  await hydrating;
  const current = projectTeams.value[projectPath] ?? [];
  if (!current.includes(agentId)) {
    projectTeams.value = { ...projectTeams.value, [projectPath]: [...current, agentId] };
  }
  const api = bridge();
  if (!api) return true;
  const ok = await api.addToTeam({ projectPath, agentId });
  if (!ok) await fetchProjectTeam(projectPath);
  return ok;
}

/** Take an agent off a project's team. The agent itself is untouched — it stays
 *  in the roster and on every other team. */
export async function removeTeamMember(projectPath: string, agentId: string): Promise<void> {
  await hydrating;
  const current = projectTeams.value[projectPath] ?? [];
  projectTeams.value = {
    ...projectTeams.value,
    [projectPath]: current.filter((id) => id !== agentId),
  };
  await bridge()?.removeFromTeam({ projectPath, agentId });
}

// ── the rows themselves ─────────────────────────────────────────────────────
// One set of mutations, used both as the optimistic path in front of the bridge
// and as the whole store when there isn't one. Ordering matches the desktop
// store's: everything appends, except a fork, which takes the position below its
// source and pushes the rest down.

function clamp(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  return value.trim().slice(0, max);
}

/** A capability list's delta: null and undefined both mean "inherit", while an
 *  array — even an empty one — is a real answer the dev fallback keeps by value,
 *  length-bounded so a runaway never lands in browser storage. */
function clampList<T>(value: readonly T[] | null | undefined): T[] | null {
  if (value === null || value === undefined) return null;
  return value.slice(0, LIST_MAX);
}

/** The single model an agent runs on: null and undefined both mean "inherit",
 *  while a ref is a real answer the dev fallback keeps by value. */
function clampModel(value: AgentModelRef | null | undefined): AgentModelRef | null {
  return value ?? null;
}

/** An avatar delta: null and undefined both mean "inherit", and one with
 *  nothing to draw is no avatar at all rather than a picture that paints blank.
 *  `src` is bounded but never inspected — an asset path and a data URL are the
 *  same thing to a row. */
function clampAvatar(value: AgentAvatarRef | null | undefined): AgentAvatarRef | null {
  if (value === null || value === undefined) return null;
  const src = value.src?.trim().slice(0, AVATAR_MAX);
  if (!src) return null;
  return { source: value.source, src };
}

/** A bot delta: null and undefined both mean "inherit", and the three ids are
 *  kept as given — an id this build doesn't know is the catalogue's problem to
 *  answer with a default, not this layer's to drop. */
function clampBot(value: AgentBotRef | null | undefined): AgentBotRef | null {
  if (value === null || value === undefined) return null;
  const form = value.form?.trim();
  const color = value.color?.trim();
  const expression = value.expression?.trim();
  if (!form || !color || !expression) return null;
  return { form, color, expression };
}

function nextSortOrder(): number {
  return agentRows.value.reduce((max, row) => Math.max(max, row.sortOrder + 1), 0);
}

function ordered(rows: AgentRecord[]): AgentRecord[] {
  return [...rows].sort(
    (a, b) =>
      a.sortOrder - b.sortOrder || a.createdAt - b.createdAt || a.agentId.localeCompare(b.agentId),
  );
}

/** Put a row where it belongs, replacing any row already under that id. */
function applyRow(row: AgentRecord): void {
  const rest = agentRows.value.filter((existing) => existing.agentId !== row.agentId);
  agentRows.value = ordered([...rest, row]);
}

/** The overlay row a built-in gets the first time it is touched: a position, a
 *  pair of timestamps, and nothing else — every field still the preset's. */
function ensureLocalRow(presetId: string): AgentRecord {
  const existing = agentRows.value.find((row) => row.agentId === presetId);
  if (existing) return existing;
  const now = Date.now();
  const row: AgentRecord = {
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
    sortOrder: nextSortOrder(),
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  applyRow(row);
  return row;
}

function insertLocalRow(input: AgentCreateInput): AgentRecord | null {
  const name = clamp(input.name, NAME_MAX);
  if (!name) return null;
  const now = Date.now();
  const row: AgentRecord = {
    agentId: input.agentId ?? mintAgentId(),
    presetId: null,
    name,
    role: clamp(input.role, ROLE_MAX),
    instructions: clamp(input.instructions, PROSE_MAX),
    faceBody: clamp(input.faceBody, PAINT_MAX),
    faceInk: clamp(input.faceInk, PAINT_MAX),
    skills: clampList(input.skills),
    model: clampModel(input.model),
    modelFallbacks: clampModel(input.model) ? (clampList(input.modelFallbacks) ?? []) : null,
    avatar: clampAvatar(input.avatar),
    bot: clampBot(input.bot),
    sortOrder: nextSortOrder(),
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  applyRow(row);
  return row;
}

function patchLocalRow(agentId: string, patch: AgentPatch): AgentRecord | null {
  const current = agentRows.value.find((row) => row.agentId === agentId);
  if (!current || current.deletedAt !== null) return null;
  const next = { ...current, updatedAt: Date.now() };
  if (patch.name !== undefined) next.name = clamp(patch.name, NAME_MAX);
  if (patch.role !== undefined) next.role = clamp(patch.role, ROLE_MAX);
  if (patch.instructions !== undefined) next.instructions = clamp(patch.instructions, PROSE_MAX);
  if (patch.faceBody !== undefined) next.faceBody = clamp(patch.faceBody, PAINT_MAX);
  if (patch.faceInk !== undefined) next.faceInk = clamp(patch.faceInk, PAINT_MAX);
  if (patch.skills !== undefined) next.skills = clampList(patch.skills);
  if (patch.model !== undefined) next.model = clampModel(patch.model);
  if (patch.modelFallbacks !== undefined) next.modelFallbacks = clampList(patch.modelFallbacks);
  if (next.model === null) next.modelFallbacks = null;
  if (patch.avatar !== undefined) next.avatar = clampAvatar(patch.avatar);
  if (patch.bot !== undefined) next.bot = clampBot(patch.bot);
  // The store's CHECK, mirrored: an agent with nothing to inherit from has to
  // keep a name, so a clear that would leave it nameless is refused outright.
  if (next.presetId === null && !next.name) return null;
  applyRow(next);
  return next;
}

function removeLocalRow(agentId: string): boolean {
  const current = agentRows.value.find((row) => row.agentId === agentId);
  if (!current || current.deletedAt !== null) return false;
  applyRow({ ...current, deletedAt: Date.now(), updatedAt: Date.now() });
  return true;
}

function forkLocalRow(input: AgentDuplicateInput): AgentRecord | null {
  const source = agentRows.value.find((row) => row.agentId === input.agentId);
  if (!source || source.deletedAt !== null) return null;
  const inherited = input.inherited ?? {};
  const name = clamp(input.name ?? source.name ?? inherited.name, NAME_MAX);
  if (!name) return null;
  const now = Date.now();
  const copy: AgentRecord = {
    agentId: input.newAgentId ?? mintAgentId(),
    presetId: null,
    name,
    role: clamp(source.role ?? inherited.role, ROLE_MAX),
    instructions: clamp(source.instructions ?? inherited.instructions, PROSE_MAX),
    faceBody: clamp(source.faceBody ?? inherited.faceBody, PAINT_MAX),
    faceInk: clamp(source.faceInk ?? inherited.faceInk, PAINT_MAX),
    skills: clampList(source.skills ?? inherited.skills),
    model: clampModel(source.model ?? inherited.model),
    modelFallbacks: clampList(source.modelFallbacks ?? inherited.modelFallbacks),
    avatar: clampAvatar(source.avatar ?? inherited.avatar),
    bot: clampBot(source.bot ?? inherited.bot),
    sortOrder: source.sortOrder + 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  agentRows.value = ordered([
    ...agentRows.value.map((row) =>
      row.sortOrder > source.sortOrder ? { ...row, sortOrder: row.sortOrder + 1 } : row,
    ),
    copy,
  ]);
  return copy;
}

export function mintAgentId(): string {
  return import.meta.client && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
