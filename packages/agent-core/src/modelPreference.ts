import {
  DEFAULT_MODEL_PREFERENCE_KINDS,
  MODEL_PREFERENCE_HINT_MAX,
  MODEL_PREFERENCE_LABEL_MAX,
  MODEL_PREFERENCE_LIST_MAX,
  modelPreferenceKindKey,
} from "@kone/protocol/model-preferences";
import {
  boundRefField,
  isColumnRecord,
  normalizeModelRef,
  type AgentModelRef,
  type ColumnValue,
} from "./rosterRecord.js";

// The user's model preferences by kind of work (see the protocol module for
// what a kind is). This half is the record the store keeps and the gateway
// reads: its shape, the one gate every stored or submitted list passes
// through, and the lookup a dispatch makes when an agent names a kind.

export type ModelPreference = {
  /** The slug an agent passes as `kind`. */
  kind: string;
  label: string;
  hint: string;
  /** The model this kind of work runs on, or null while the user hasn't set
   *  one — a dormant kind, kept for the user and invisible to an agent. */
  model: AgentModelRef | null;
  /** Reasoning effort in the provider's own vocabulary, or null for the
   *  provider's default. Soft, as a spawn's effort always is: one the model
   *  doesn't take is dropped and reported, never refused. */
  effort: string | null;
};

/** The suggested kinds with no model set — what a store that never saved a list
 *  reads as, so the user opens the pane on a starting set to route. */
export function defaultModelPreferences(): ModelPreference[] {
  return DEFAULT_MODEL_PREFERENCE_KINDS.map((kind) => ({ ...kind, model: null, effort: null }));
}

/** One line of text from a stored or submitted field, bounded; empty when the
 *  field is not text. */
function boundText(value: ColumnValue | undefined, max: number): string {
  return (boundRefField(value) ?? "").replace(/\s+/g, " ").slice(0, max).trim();
}

/** One entry as stored or submitted, or null when it can't be a preference: a
 *  kind with no usable slug or label. The slug is re-keyed so a submitted
 *  "Big Frontend" lands as the same `big-frontend` an agent will pass. */
export function normalizeModelPreference(entry: ColumnValue | undefined): ModelPreference | null {
  if (!isColumnRecord(entry)) return null;
  const label = boundText(entry.label, MODEL_PREFERENCE_LABEL_MAX);
  const kind = modelPreferenceKindKey(boundRefField(entry.kind) ?? label);
  if (!kind || !label) return null;
  const model = normalizeModelRef(entry.model);
  return {
    kind,
    label,
    hint: boundText(entry.hint, MODEL_PREFERENCE_HINT_MAX),
    model,
    // An effort without a model has nothing to tune.
    effort: model ? boundRefField(entry.effort) : null,
  };
}

/** A whole list through the gate: each entry normalized, the unusable dropped,
 *  a repeated kind kept at its first place only, and the list bounded. */
export function normalizeModelPreferences(list: readonly ColumnValue[]): ModelPreference[] {
  const out: ModelPreference[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const pref = normalizeModelPreference(entry);
    if (!pref || seen.has(pref.kind)) continue;
    seen.add(pref.kind);
    out.push(pref);
    if (out.length >= MODEL_PREFERENCE_LIST_MAX) break;
  }
  return out;
}

/** The preference an agent's `kind` names, matched on the slug so any spelling
 *  of it finds the same entry. Only a kind with a model is found: one the user
 *  hasn't set is dormant, and to an agent it doesn't exist — the same answer as
 *  a kind nobody ever made. */
export function lookupModelPreference(
  prefs: readonly ModelPreference[],
  ref: string,
): (ModelPreference & { model: AgentModelRef }) | null {
  const wanted = modelPreferenceKindKey(ref);
  if (!wanted) return null;
  return activeModelPreferences(prefs).find((p) => p.kind === wanted) ?? null;
}

/** The kinds an agent can pass: only those with a model, in the user's order. */
export function activeModelPreferences(
  prefs: readonly ModelPreference[],
): Array<ModelPreference & { model: AgentModelRef }> {
  return prefs.flatMap((p) => (p.model ? [{ ...p, model: p.model }] : []));
}
