// What a thread would be, before there is a thread.
//
// The composer's controls are written against a session: the model slot reads
// `session.model`, picking one writes it back. That is right everywhere a
// conversation already exists, and wrong on a surface whose whole purpose is
// the moment before one does — claiming a session early to give those controls
// something to write to means the registry gains a thread nobody asked for, and
// (because a registry is shared with whatever else has that project open) it
// may not even be a new one: an idle blank thread elsewhere gets adopted and
// quietly re-tuned under the surface that was using it.
//
// So the choices sit here instead, in plain refs, until a send turns them into
// a session. Nothing in this file touches the registry, spawns a process, or
// writes to disk; it is a form, and it is only worth anything at the moment it
// is submitted.

import { ref, toValue, type MaybeRefOrGetter } from "vue";
import {
  bootMode,
  bootProvider,
  DEFAULT_MODEL_KEY,
  DEFAULT_REASONING_KEY,
  MODEL_KEY,
  REASONING_KEY,
} from "~/utils/modelPicker";
import { EFFORT_META, type EffortTier } from "~/utils/modelCatalog";
import type { InteractionMode, ProviderKind } from "~/types/desktop";

export function useThreadDraft(projectPath: MaybeRefOrGetter<string>) {
  const path = toValue(projectPath);

  // Seeded from the same keys the studio's boot restore reads, in the same
  // order — a configured default beats the last thing that ran, everywhere.
  // Read once, at construction: these are a starting point, and re-reading them
  // later would overwrite a choice made on this surface with one made on
  // another.
  const provider = ref<ProviderKind>(bootProvider());
  const model = ref<string | undefined>(storedModel());
  const reasoning = ref<EffortTier | undefined>(storedReasoning());
  const mode = ref<InteractionMode>(bootMode(path) ?? "accept-edits");

  /** The model's "fast" tier when fast mode is on, mirroring what a session
   *  keeps: the id itself rather than a boolean, because that is what has to be
   *  applied and a boolean would need the catalog to be resolved back. */
  const serviceTier = ref<string | undefined>(undefined);
  const contextWindow = ref<string | undefined>(undefined);

  function storedModel(): string | undefined {
    if (!import.meta.client) return undefined;
    return (
      localStorage.getItem(DEFAULT_MODEL_KEY) ?? localStorage.getItem(MODEL_KEY) ?? undefined
    );
  }

  /** An unrecognised tier is dropped rather than carried: it would reach the
   *  provider as an effort it has never heard of. */
  function storedReasoning(): EffortTier | undefined {
    if (!import.meta.client) return undefined;
    const stored =
      localStorage.getItem(DEFAULT_REASONING_KEY) ?? localStorage.getItem(REASONING_KEY);
    if (stored === null || !(stored in EFFORT_META)) return undefined;
    // SAFETY: EFFORT_META satisfies Record<EffortTier, EffortMeta>, so the `in`
    // check above proves this is one of its keys.
    return stored as EffortTier;
  }

  return { provider, model, reasoning, serviceTier, contextWindow, mode };
}

export type ThreadDraft = ReturnType<typeof useThreadDraft>;
