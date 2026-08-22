/**
 * The preset sub-agents' durable side: the rows behind the reusable definitions
 * an agent cuts a spawn from (§3.4).
 *
 * A preset is a lightweight, globally-available definition — a name, standing
 * instructions, one model — that any agent can invoke. Unlike
 * `~/utils/agentStore`, there is nothing subtle here: a preset is a whole row,
 * not a delta, so no field means "inherit". It has no thread history either, so
 * a delete is a real delete — the row goes.
 *
 * The one door to where these survive a quit: the desktop store (store v26), or
 * browser storage when there is no bridge to reach it through.
 */
import { useStorage } from "@vueuse/core";
import type {
  AgentModelRef,
  SubagentPresetCreateInput,
  SubagentPresetPatch,
  SubagentPresetRecord,
} from "~/types/desktop";

/**
 * Every preset the store knows about, in roster order.
 *
 * Also the warm cache: written back on every hydrate so the first paint after a
 * relaunch shows the presets you actually have. With no bridge at all (a browser
 * `nuxt dev`) the same array *is* the store — edits made while iterating on the
 * pane survive a reload.
 *
 * Read it; don't write it from outside. Every mutation goes through the
 * functions below so the backend and the cache can't drift.
 */
export const presetRows = useStorage<SubagentPresetRecord[]>(
  "kone.presets.rows",
  [],
  undefined,
  { listenToStorageChanges: true },
);

/** Field ceilings, mirroring the store's own — the floor that keeps a runaway
 *  paste out of a row; the store clamps again on the way in. */
const NAME_MAX = 64;
const PROSE_MAX = 4000;

function bridge() {
  return import.meta.client ? window.koneDesktop?.presets : undefined;
}

/** In flight while the first hydrate is still running. Writes wait on it. */
let hydrating: Promise<void> | null = null;

/** Load the presets. Idempotent per app run; call it wherever they are first
 *  read. With no bridge the local cache is left as it stands. */
export function hydratePresets(): Promise<void> {
  hydrating ??= runHydrate().finally(() => {
    hydrating = null;
  });
  return hydrating;
}

async function runHydrate(): Promise<void> {
  const api = bridge();
  if (api) presetRows.value = ordered(await api.list());
}

/** The example presets a fresh install ships with, so the surface isn't empty
 *  the first time it's opened. Marker key that says they were laid down. */
const SEEDED_KEY = "kone.presets.seeded";

/**
 * Lay down the shipped example presets, exactly once per install.
 *
 * Unlike the roster's built-ins these are real rows, not overlays — a preset
 * has no shipped definition to inherit from. So seeding is a one-time creation,
 * flagged so it never runs again: deleting an example has to stick, the same
 * rule dismissing a built-in agent follows. A store that already holds presets
 * (an upgrade, not a fresh install) is left alone regardless of the flag.
 */
export async function seedExamplePresets(
  defs: readonly SubagentPresetCreateInput[],
): Promise<void> {
  await hydrating;
  if (!import.meta.client) return;
  try {
    if (localStorage.getItem(SEEDED_KEY)) return;
    localStorage.setItem(SEEDED_KEY, "1");
    if (presetRows.value.length > 0) return;
    for (const def of defs) await insertPreset(def);
  } catch {
    // Unreadable storage — nothing worth failing a hydrate over. The surface
    // opens empty, which is a fine first state to create presets from.
  }
}

/** Add a preset. Returns the stored row, or null if it was refused (a nameless
 *  preset has nothing to be one). */
export async function insertPreset(
  input: SubagentPresetCreateInput,
): Promise<SubagentPresetRecord | null> {
  await hydrating;
  const api = bridge();
  if (!api) return insertLocal(input);
  const row = await api.create(input);
  if (row) applyRow(row);
  return row;
}

/** Edit one preset. A field left out of the patch is left alone; the name is
 *  the one field that can't be blanked. */
export async function patchPreset(
  presetId: string,
  patch: SubagentPresetPatch,
): Promise<SubagentPresetRecord | null> {
  await hydrating;
  // Applied here first so the pane redraws on the keystroke rather than on the
  // round trip; the authoritative row replaces it a moment later.
  const optimistic = patchLocal(presetId, patch);
  const api = bridge();
  if (!api) return optimistic;
  const row = await api.update({ presetId, patch });
  if (row) applyRow(row);
  // Refused — the row is gone, or the edit left it nameless. Go back to what
  // the store has.
  else await reload();
  return row;
}

/** Delete a preset for good. */
export async function removePreset(presetId: string): Promise<boolean> {
  await hydrating;
  const api = bridge();
  if (!api) return removeLocal(presetId);
  const removed = await api.delete({ presetId });
  if (removed) removeLocal(presetId);
  return removed;
}

/** Re-read the presets from the store. */
async function reload(): Promise<void> {
  const api = bridge();
  if (!api) return;
  presetRows.value = ordered(await api.list());
}

// ── the rows themselves ─────────────────────────────────────────────────────
// One set of mutations, used both as the optimistic path in front of the bridge
// and as the whole store when there isn't one. Everything appends; a delete
// removes outright, since a preset keeps no history to caption.

function clamp(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  return value.trim().slice(0, max);
}

/** The one model a spawn from the preset runs on. Unlike a capability there is
 *  nothing above a preset to inherit, so null is not "inherit" — null and
 *  undefined both settle to null, "no model, let the caller's own stand". */
function clampModel(value: AgentModelRef | null | undefined): AgentModelRef | null {
  return value ?? null;
}

function nextSortOrder(): number {
  return presetRows.value.reduce((max, row) => Math.max(max, row.sortOrder + 1), 0);
}

function ordered(rows: SubagentPresetRecord[]): SubagentPresetRecord[] {
  return [...rows].sort(
    (a, b) =>
      a.sortOrder - b.sortOrder ||
      a.createdAt - b.createdAt ||
      a.presetId.localeCompare(b.presetId),
  );
}

/** Put a row where it belongs, replacing any row already under that id. */
function applyRow(row: SubagentPresetRecord): void {
  const rest = presetRows.value.filter((existing) => existing.presetId !== row.presetId);
  presetRows.value = ordered([...rest, row]);
}

function insertLocal(input: SubagentPresetCreateInput): SubagentPresetRecord | null {
  const name = clamp(input.name, NAME_MAX);
  if (!name) return null;
  const now = Date.now();
  const row: SubagentPresetRecord = {
    presetId: input.presetId ?? mintPresetId(),
    name,
    instructions: clamp(input.instructions, PROSE_MAX),
    model: clampModel(input.model),
    sortOrder: nextSortOrder(),
    createdAt: now,
    updatedAt: now,
  };
  applyRow(row);
  return row;
}

function patchLocal(presetId: string, patch: SubagentPresetPatch): SubagentPresetRecord | null {
  const current = presetRows.value.find((row) => row.presetId === presetId);
  if (!current) return null;
  const next = { ...current, updatedAt: Date.now() };
  if (patch.name !== undefined) {
    const name = clamp(patch.name, NAME_MAX);
    // The store's rule, mirrored: a preset with no name is not one, so a clear
    // that would leave it nameless is refused outright.
    if (!name) return null;
    next.name = name;
  }
  if (patch.instructions !== undefined) next.instructions = clamp(patch.instructions, PROSE_MAX);
  if (patch.model !== undefined) next.model = clampModel(patch.model);
  applyRow(next);
  return next;
}

function removeLocal(presetId: string): boolean {
  const before = presetRows.value.length;
  presetRows.value = presetRows.value.filter((row) => row.presetId !== presetId);
  return presetRows.value.length < before;
}

export function mintPresetId(): string {
  return import.meta.client && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
