import {
  MODEL_PREFERENCE_HINT_MAX,
  MODEL_PREFERENCE_LABEL_MAX,
  MODEL_PREFERENCE_LIST_MAX,
  defaultModelPreferences,
  isBuiltInModelPreference,
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
  /** Whether the user has it switched on. Only a kind that is on and has a
   *  model reaches an agent, so this is never true without a model. */
  enabled: boolean;
};

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
    // A list saved before kinds could be switched off has no flag: a kind with
    // a model was live then, so it reads as on.
    enabled: model ? entry.enabled !== false : false,
  };
}

/** A whole list through the gate: each entry normalized, the unusable dropped,
 *  a repeated kind kept at its first place only, the user's own bounded, and
 *  any built-in the list lacks put back switched off. The bound counts only
 *  the user's own: a list saved when built-ins could be deleted may hold a
 *  full bound of them, and putting the built-ins back must not push any out.
 *  So a list read can always be saved again unchanged. */
export function normalizeModelPreferences(list: readonly ColumnValue[]): ModelPreference[] {
  const out: ModelPreference[] = [];
  const seen = new Set<string>();
  let own = 0;
  for (const entry of list) {
    const pref = normalizeModelPreference(entry);
    if (!pref || seen.has(pref.kind)) continue;
    if (!isBuiltInModelPreference(pref.kind) && own++ >= MODEL_PREFERENCE_LIST_MAX) continue;
    seen.add(pref.kind);
    out.push(pref);
  }
  return [...out, ...defaultModelPreferences().filter((p) => !seen.has(p.kind))];
}

/** The preference an agent's `kind` names, matched on the slug so any spelling
 *  of it finds the same entry. Only a kind that is on with a model is found:
 *  any other is dormant, and to an agent it doesn't exist — the same answer as
 *  a kind nobody ever made. */
export function lookupModelPreference(
  prefs: readonly ModelPreference[],
  ref: string,
): (ModelPreference & { model: AgentModelRef }) | null {
  const wanted = modelPreferenceKindKey(ref);
  if (!wanted) return null;
  return activeModelPreferences(prefs).find((p) => p.kind === wanted) ?? null;
}

/** The kinds an agent can pass: only those switched on with a model, in the
 *  user's order. */
export function activeModelPreferences(
  prefs: readonly ModelPreference[],
): Array<ModelPreference & { model: AgentModelRef }> {
  return prefs.flatMap((p) => (p.enabled && p.model ? [{ ...p, model: p.model }] : []));
}
