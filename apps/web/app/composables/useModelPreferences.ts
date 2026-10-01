import { computed, onMounted, ref } from "vue";
import {
  DEFAULT_MODEL_PREFERENCE_KINDS,
  MODEL_PREFERENCE_KIND_MAX,
  MODEL_PREFERENCE_LIST_MAX,
  modelPreferenceKindKey,
} from "@kone/protocol/model-preferences";
import { sendable } from "~/utils/agentStore";
import type { AgentModelRef, ModelPreference } from "~/types/desktop";

// The user's model routing: for each category of work they define, which model
// and effort a thread an agent starts for it runs on, when nobody named a
// model. The list lives in the store (the spawn gateway reads it on every
// dispatch), so a change here reaches the next hand-off without a restart.
//
// A short set of suggested categories ships as a starting point, each with no
// model. The user renames, removes and adds their own, and an agent only ever
// hears of a category once it has a model — a suggestion costs nothing until
// it is routed.
//
// Module-scope, so the Teams page and anything else that reads the list share
// one copy and one hydration.

const suggested = (): ModelPreference[] =>
  DEFAULT_MODEL_PREFERENCE_KINDS.map((kind) => ({ ...kind, model: null, effort: null }));

/** The store's side of the list — the two calls the composable makes. */
export type ModelPreferencesBridge = {
  modelPreferences: () => Promise<ModelPreference[]>;
  saveModelPreferences: (input: { preferences: ModelPreference[] }) => Promise<ModelPreference[] | null>;
};

/** One edit: the list it wants, derived from the list it is handed — or null
 *  when there is nothing to do. It always reads the latest list rather than a
 *  snapshot from when the edit was asked for, so edits compose. */
type Edit = (list: readonly ModelPreference[]) => ModelPreference[] | null;

/** `saved` — the store kept it; `skipped` — the edit had nothing to change;
 *  `failed` — the store could not be read or written, and nothing changed. */
type Outcome = "saved" | "skipped" | "failed";

/** The list and the rules for changing it.
 *
 *  Nothing is written before the store has been read: a write made against the
 *  suggested starting set would replace whatever the user had saved. So every
 *  edit waits on one shared read, and a read that failed is tried again by the
 *  next edit instead of being remembered as done.
 *
 *  Edits run one at a time, each against the list the store last confirmed, so
 *  a slow answer to an earlier edit can't overwrite a later one. The list on
 *  screen is the confirmed list with every edit still waiting laid on top, so a
 *  change shows on the click; an edit the store refuses is lifted out of that
 *  stack and the ones after it stay. */
export function createModelPreferenceStore(bridge: () => ModelPreferencesBridge | undefined) {
  const preferences = ref<ModelPreference[]>(suggested());
  let confirmed = suggested();
  const waiting: Edit[] = [];
  let loading: Promise<void> | null = null;
  let tail: Promise<unknown> = Promise.resolve();

  function show() {
    preferences.value = waiting.reduce((list, edit) => edit(list) ?? list, confirmed);
  }

  /** Read the store once. With no bridge (the browser dev surface) the local
   *  copy stands alone and there is nothing to read. */
  function hydrate(): Promise<void> {
    const api = bridge();
    if (!api) return Promise.resolve();
    if (!loading) {
      const read = api.modelPreferences().then((list) => {
        confirmed = list;
        show();
      });
      loading = read;
      // A failed read is not remembered as done: the next caller reads again.
      read.catch(() => {
        if (loading === read) loading = null;
      });
    }
    return loading;
  }

  async function commit(edit: Edit): Promise<Outcome> {
    try {
      try {
        await hydrate();
      } catch {
        return "failed";
      }
      const next = edit(confirmed);
      if (!next) return "skipped";
      const api = bridge();
      let stored: ModelPreference[] | null = next;
      if (api) {
        try {
          stored = await api.saveModelPreferences(sendable({ preferences: next }));
        } catch {
          stored = null;
        }
      }
      if (!stored) return "failed";
      confirmed = stored;
      return "saved";
    } finally {
      waiting.splice(waiting.indexOf(edit), 1);
      show();
    }
  }

  function mutate(edit: Edit): Promise<Outcome> {
    waiting.push(edit);
    show();
    const done = tail.then(() => commit(edit));
    tail = done.catch(() => {});
    return done;
  }

  return { preferences, hydrate, mutate };
}

/** The slug an edit settled on, for the caller to hand back once it is saved. */
type Made = { kind: string | null };

const SAVE_FAILED = "Could not save — nothing was changed.";

/** A slug for a new category that no existing one already has. The suffix of a
 *  repeat is counted inside the slug limit, so the store — which re-keys every
 *  slug to that limit — keeps exactly the slug chosen here rather than cutting
 *  the suffix off and taking the new category for a duplicate. */
function freshKind(label: string, taken: readonly ModelPreference[]): string {
  const base = modelPreferenceKindKey(label) || "category";
  const used = new Set(taken.map((p) => p.kind));
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const stem = base.slice(0, MODEL_PREFERENCE_KIND_MAX - suffix.length).replace(/-+$/, "");
    const candidate = `${stem}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** What the editor submits: a category's words and where it runs. */
export type RouteDraft = {
  label: string;
  hint: string;
  model: AgentModelRef | null;
  effort: string | null;
};

const shared = createModelPreferenceStore(() =>
  import.meta.client ? window.koneDesktop?.presets : undefined,
);

export function useModelPreferences() {
  const { preferences, hydrate, mutate } = shared;

  // A failed read is not fatal here: the list stays on the suggestions and the
  // next edit reads again before it writes.
  onMounted(() => void hydrate().catch(() => {}));

  /** Categories an agent can see: those with a model. */
  const routedCount = computed(() => preferences.value.filter((p) => p.model).length);

  const canAdd = computed(() => preferences.value.length < MODEL_PREFERENCE_LIST_MAX);

  /** Add a category, or rewrite one. A rewrite keeps its slug, so an agent that
   *  already learned it keeps reaching the same category after a rename. An
   *  effort belongs to the model it tunes, so none is kept without one.
   *  Returns the category's slug, or null when the draft has no name or the list
   *  is full. Throws when the store could not keep the change. */
  const saveRoute = async (kind: string | null, draft: RouteDraft): Promise<string | null> => {
    const label = draft.label.trim();
    if (!label) return null;
    const entry = {
      label,
      hint: draft.hint.trim(),
      model: draft.model,
      effort: draft.model ? draft.effort : null,
    };
    const made: Made = { kind: null };
    const outcome = await mutate((list) => {
      made.kind = null;
      if (kind && list.some((p) => p.kind === kind)) {
        made.kind = kind;
        return list.map((p) => (p.kind === kind ? { ...p, ...entry } : p));
      }
      if (list.length >= MODEL_PREFERENCE_LIST_MAX) return null;
      made.kind = freshKind(label, list);
      return [...list, { kind: made.kind, ...entry }];
    });
    if (outcome === "failed") throw new Error(SAVE_FAILED);
    return outcome === "saved" ? made.kind : null;
  };

  /** Bring back any suggested category the list no longer has, after the user's
   *  own and unset, so nothing they made or routed is touched. */
  const restoreSuggested = async (): Promise<boolean> =>
    (await mutate((list) => {
      const have = new Set(list.map((p) => p.kind));
      const missing = suggested().filter((p) => !have.has(p.kind));
      return missing.length ? [...list, ...missing].slice(0, MODEL_PREFERENCE_LIST_MAX) : null;
    })) !== "failed";

  const removeRoute = async (kind: string): Promise<boolean> =>
    (await mutate((list) => (list.some((p) => p.kind === kind) ? list.filter((p) => p.kind !== kind) : null))) !==
    "failed";

  return { preferences, routedCount, canAdd, saveRoute, removeRoute, restoreSuggested };
}
