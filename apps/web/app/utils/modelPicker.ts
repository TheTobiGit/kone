// Policy the model picker and the boot restore have to agree on.
//
// Both the picker (committing a pick to the live session) and the project's
// mount (restoring what was picked last time) read these, and they must read the
// same ones: a storage key spelled differently in the two places is a setting
// that silently stops surviving a relaunch.

import type { AgentModelRef, InteractionMode, ProviderKind } from "~/types/desktop";
import {
  familyForId,
  isEffortTier,
  type BrandKey,
  type EffortTier,
  type ModelOption,
} from "~/utils/modelCatalog";

/** The provider + model + reasoning effort are remembered GLOBALLY — one
 *  app-wide "last used" choice that subsequent sessions open with. */
export const PROVIDER_KEY = "kone:provider";
export const MODEL_KEY = "kone:model";
export const REASONING_KEY = "kone:reasoning";

/** The user's *chosen* default — set in the Studio settings pane. When set,
 *  it provides the initial baseline, and setting it seeds the active last-used
 *  keys so the next session immediately starts on the user's explicit choice. */
export const DEFAULT_PROVIDER_KEY = "kone:default-provider";
export const DEFAULT_MODEL_KEY = "kone:default-model";
export const DEFAULT_REASONING_KEY = "kone:default-reasoning";

/** The assistant's own last-used model — isolated from the board's global
 *  sticky choice so retuning the assistant doesn't retune the next project
 *  thread and vice-versa. Falls back to the configured default when nothing
 *  has been picked for the assistant yet. */
export const ASSISTANT_PROVIDER_KEY = "kone:assistant:provider";
export const ASSISTANT_MODEL_KEY = "kone:assistant:model";
export const ASSISTANT_REASONING_KEY = "kone:assistant:reasoning";

/** The permission mode stays PER PROJECT — it's a per-repo trust decision, not
 *  an app-wide preference. */
export function modeKey(projectPath: string): string {
  return `kone:mode:${projectPath}`;
}

/** The app-wide fallback permission mode: what a project opens with the first
 *  time, before it has a per-project mode of its own. Set in the Studio settings
 *  pane; read at boot only when `modeKey(path)` holds nothing yet. */
export const DEFAULT_MODE_KEY = "kone:default-mode";

export const PROVIDER_VENDOR = {
  codex: "OpenAI",
  claudeAgent: "Anthropic",
  cursor: "Cursor",
  opencode: "OpenCode",
  droid: "Factory",
  antigravity: "Google",
} satisfies Record<ProviderKind, string>;

function getStorage(): Storage | null {
  if (import.meta.client && globalThis.localStorage) return globalThis.localStorage;
  if ("localStorage" in globalThis && globalThis.localStorage) return globalThis.localStorage;
  return null;
}

/**
 * Which provider a brand-new session opens on.
 *
 * The last used provider wins (so subsequent sessions stay on whatever ran last),
 * falling back to the user's configured default in settings. A provider that is
 * not installed/active is never returned: when a ready list is given the stored
 * choice is validated against it, and with no stored choice (fresh install) the
 * caller picks a random ready provider — never a hardcoded `codex`. Null means
 * no provider is active, so there is no model either.
 */
export function bootProvider(readyProviders?: readonly ProviderKind[]): ProviderKind | null {
  const storage = getStorage();
  if (!storage) return null;
  const stored = storage.getItem(PROVIDER_KEY) ?? storage.getItem(DEFAULT_PROVIDER_KEY);
  if (stored === null || !(stored in PROVIDER_VENDOR)) return null;
  const kind = toProviderKind(stored);
  if (readyProviders !== undefined && !readyProviders.includes(kind)) return null;
  return kind;
}

/**
 * Which model a brand-new session opens on.
 *
 * Reads the last used model first (so subsequent sessions stay on whatever ran last),
 * falling back to the configured default in settings.
 */
export function bootModel(): string | undefined {
  const storage = getStorage();
  if (!storage) return undefined;
  return (
    storage.getItem(MODEL_KEY) ??
    storage.getItem(DEFAULT_MODEL_KEY) ??
    undefined
  );
}

/**
 * Which reasoning effort tier a brand-new session opens on.
 *
 * Reads the last used reasoning effort first, falling back to the configured default.
 */
export function bootReasoning(): EffortTier | undefined {
  const storage = getStorage();
  if (!storage) return undefined;
  const stored =
    storage.getItem(REASONING_KEY) ?? storage.getItem(DEFAULT_REASONING_KEY);
  return isEffortTier(stored) ? stored : undefined;
}

/**
 * Record the user's active/last-used model selection so subsequent sessions
 * default to it.
 */
export function setLastUsedModel(pick: {
  provider: ProviderKind;
  modelId?: string;
  tier?: EffortTier;
}): void {
  const storage = getStorage();
  if (!storage) return;
  storage.setItem(PROVIDER_KEY, pick.provider);
  if (pick.modelId !== undefined) {
    storage.setItem(MODEL_KEY, pick.modelId);
  }
  if (pick.tier !== undefined) {
    storage.setItem(REASONING_KEY, pick.tier);
  }
}

/**
 * Which provider the assistant's next fresh chat opens on.
 *
 * The assistant's own last used wins, falling back to the user's configured
 * default — same order the board uses, but scoped to the assistant so the
 * two surfaces don't step on each other's sticky choice. Never a hardcoded
 * provider: null when nothing stored is active.
 */
export function bootAssistantProvider(readyProviders?: readonly ProviderKind[]): ProviderKind | null {
  const storage = getStorage();
  if (!storage) return null;
  const stored =
    storage.getItem(ASSISTANT_PROVIDER_KEY) ??
    storage.getItem(PROVIDER_KEY) ??
    storage.getItem(DEFAULT_PROVIDER_KEY);
  if (stored === null || !(stored in PROVIDER_VENDOR)) return null;
  const kind = toProviderKind(stored);
  if (readyProviders !== undefined && !readyProviders.includes(kind)) return null;
  return kind;
}

/**
 * Which model the assistant's next fresh chat opens on.
 *
 * Reads the assistant's last used first, falling back to the configured default.
 */
export function bootAssistantModel(): string | undefined {
  const storage = getStorage();
  if (!storage) return undefined;
  return (
    storage.getItem(ASSISTANT_MODEL_KEY) ??
    storage.getItem(MODEL_KEY) ??
    storage.getItem(DEFAULT_MODEL_KEY) ??
    undefined
  );
}

/**
 * Which reasoning effort the assistant's next fresh chat opens on.
 *
 * Reads the assistant's last used first, falling back to the configured default.
 */
export function bootAssistantReasoning(): EffortTier | undefined {
  const storage = getStorage();
  if (!storage) return undefined;
  const stored =
    storage.getItem(ASSISTANT_REASONING_KEY) ??
    storage.getItem(REASONING_KEY) ??
    storage.getItem(DEFAULT_REASONING_KEY);
  return isEffortTier(stored) ? stored : undefined;
}

/**
 * Record the assistant's own last-used model selection so subsequent assistant
 * chats default to it without retuning the board's global sticky choice.
 */
export function setAssistantLastUsedModel(pick: {
  provider: ProviderKind;
  modelId?: string;
  tier?: EffortTier;
}): void {
  const storage = getStorage();
  if (!storage) return;
  storage.setItem(ASSISTANT_PROVIDER_KEY, pick.provider);
  if (pick.modelId !== undefined) {
    storage.setItem(ASSISTANT_MODEL_KEY, pick.modelId);
  }
  if (pick.tier !== undefined) {
    storage.setItem(ASSISTANT_REASONING_KEY, pick.tier);
  }
}

/**
 * Persist the user's chosen default from Settings, and prime the last-used keys
 * so subsequent sessions immediately start with this newly configured default.
 */
export function setDefaultModel(pick: {
  provider: ProviderKind;
  modelId: string;
  tier?: EffortTier;
}): void {
  const storage = getStorage();
  if (!storage) return;
  storage.setItem(DEFAULT_PROVIDER_KEY, pick.provider);
  storage.setItem(DEFAULT_MODEL_KEY, pick.modelId);
  if (pick.tier !== undefined) {
    storage.setItem(DEFAULT_REASONING_KEY, pick.tier);
  }
  setLastUsedModel(pick);
}

export interface SessionModelSelectionRef {
  provider: ProviderKind;
  model?: string;
  reasoning?: EffortTier;
  serviceTier?: string;
  contextWindow?: string;
}

export interface SessionModelResolveInput {
  /** Pinned model from an agent definition / preset, if any */
  agentPinned?: AgentModelRef | null;
  /** Persisted selection on an existing restored thread, if any */
  threadPersisted?: SessionModelSelectionRef | null;
  /** Last used selection from session history / storage */
  lastUsed?: SessionModelSelectionRef | null;
  /** User configured default from settings */
  userDefault?: SessionModelSelectionRef | null;
  /** Ready/enabled providers & model catalogs to validate against */
  availableCatalogs?: Partial<Record<ProviderKind, ModelOption[]>>;
  availableProviders?: readonly ProviderKind[];
  /** Random source for the fresh-install fallback (defaults to Math.random).
   *  Injected in tests for determinism. */
  rand?: () => number;
}

export interface ResolvedSessionModel {
  provider: ProviderKind | null;
  model: string | undefined;
  reasoning: EffortTier | undefined;
  serviceTier: string | undefined;
  contextWindow: string | undefined;
  source:
    | "thread_persisted"
    | "agent_pinned"
    | "last_used"
    | "user_default"
    | "catalog_fallback"
    | "none";
}

/** Pick one ready provider uniformly at random. Null when none is active —
 *  the caller then yields no model either. */
export function pickRandomReadyProvider(
  ready: readonly ProviderKind[],
  rand: () => number = Math.random,
): ProviderKind | null {
  if (ready.length === 0) return null;
  const idx = Math.floor(rand() * ready.length);
  return ready[Math.min(idx, ready.length - 1)] ?? null;
}

/**
 * Resolves which provider, model, and reasoning effort a session should run on,
 * following the strict precedence hierarchy:
 * 1. Thread-persisted selection (when reopening/resuming an existing thread)
 * 2. Agent-pinned model preset (when running with a specialized agent)
 * 3. Last used model (sticky selection across subsequent sessions)
 * 4. User default setting (explicitly chosen baseline from Settings)
 * 5. Catalog fallback (random ready provider + random model — fresh install only)
 * 6. None (no provider active → no model)
 *
 * A provider that is not in `availableProviders` is deactivated: stored
 * preferences naming it are skipped, never ridden onto another CLI. The random
 * fallback runs once on a fresh install; afterwards the sticky last-used choice
 * wins, so the first random pick becomes the default until the user changes it.
 */
export function resolveSessionModelSelection(
  input: SessionModelResolveInput,
): ResolvedSessionModel {
  const {
    agentPinned,
    threadPersisted,
    lastUsed,
    userDefault,
    availableCatalogs,
    availableProviders,
    rand = Math.random,
  } = input;

  function isProviderReady(p: ProviderKind): boolean {
    return !availableProviders || availableProviders.includes(p);
  }

  function isModelValid(p: ProviderKind, m?: string): boolean {
    if (!m) return true;
    const cat = availableCatalogs?.[p];
    if (!cat || cat.length === 0) return true;
    return cat.some((o) => o.key === m || o.efforts.some((e) => e.modelId === m));
  }

  function resolveDefaultsFor(p: ProviderKind, m?: string, tier?: EffortTier) {
    const cat = availableCatalogs?.[p];
    if (!cat || cat.length === 0) {
      return { model: m, reasoning: tier, serviceTier: undefined, contextWindow: undefined };
    }
    const fam = familyForId(cat, m);
    const validModel = fam
      ? (fam.efforts.some((e) => e.modelId === m)
          ? m
          : (fam.efforts[fam.defaultEffortIndex] ?? fam.efforts[0])?.modelId)
      : (cat[0]?.efforts[cat[0].defaultEffortIndex] ?? cat[0]?.efforts[0])?.modelId;
    const resolvedFam = familyForId(cat, validModel);
    const validTier =
      tier && resolvedFam?.efforts.some((e) => e.tier === tier)
        ? tier
        : (resolvedFam?.efforts[resolvedFam.defaultEffortIndex] ?? resolvedFam?.efforts[0])?.tier;
    return {
      model: validModel,
      reasoning: validTier,
      serviceTier: undefined,
      contextWindow: resolvedFam?.contextWindows?.find((w) => w.isDefault)?.id,
    };
  }

  // 1. Thread persisted selection (existing conversation resuming)
  if (
    threadPersisted &&
    isProviderReady(threadPersisted.provider) &&
    isModelValid(threadPersisted.provider, threadPersisted.model)
  ) {
    return {
      provider: threadPersisted.provider,
      model: threadPersisted.model,
      reasoning: threadPersisted.reasoning,
      serviceTier: threadPersisted.serviceTier,
      contextWindow: threadPersisted.contextWindow,
      source: "thread_persisted",
    };
  }

  // 2. Agent pinned model (agent preset capability)
  if (
    agentPinned &&
    isProviderReady(agentPinned.provider) &&
    isModelValid(agentPinned.provider, agentPinned.model)
  ) {
    const resolved = resolveDefaultsFor(agentPinned.provider, agentPinned.model);
    return {
      provider: agentPinned.provider,
      model: resolved.model,
      reasoning: resolved.reasoning,
      serviceTier: undefined,
      contextWindow: resolved.contextWindow,
      source: "agent_pinned",
    };
  }

  // 3. Last used model (sticky default across subsequent sessions)
  if (
    lastUsed &&
    isProviderReady(lastUsed.provider) &&
    isModelValid(lastUsed.provider, lastUsed.model)
  ) {
    const resolved = resolveDefaultsFor(lastUsed.provider, lastUsed.model, lastUsed.reasoning);
    return {
      provider: lastUsed.provider,
      model: resolved.model,
      reasoning: resolved.reasoning,
      serviceTier: lastUsed.serviceTier,
      contextWindow: lastUsed.contextWindow ?? resolved.contextWindow,
      source: "last_used",
    };
  }

  // 4. User default setting (configured baseline from Settings)
  if (
    userDefault &&
    isProviderReady(userDefault.provider) &&
    isModelValid(userDefault.provider, userDefault.model)
  ) {
    const resolved = resolveDefaultsFor(userDefault.provider, userDefault.model, userDefault.reasoning);
    return {
      provider: userDefault.provider,
      model: resolved.model,
      reasoning: resolved.reasoning,
      serviceTier: userDefault.serviceTier,
      contextWindow: userDefault.contextWindow ?? resolved.contextWindow,
      source: "user_default",
    };
  }

  // 5. Catalog fallback (random ready provider + random model — fresh install
  // only; afterwards last_used wins and this pick becomes the sticky default).
  // No ready provider → no model.
  if (!availableProviders || availableProviders.length === 0) {
    return {
      provider: null,
      model: undefined,
      reasoning: undefined,
      serviceTier: undefined,
      contextWindow: undefined,
      source: "none",
    };
  }
  const fallbackProvider = pickRandomReadyProvider(availableProviders, rand);
  if (!fallbackProvider) {
    return {
      provider: null,
      model: undefined,
      reasoning: undefined,
      serviceTier: undefined,
      contextWindow: undefined,
      source: "none",
    };
  }
  // Random model within the picked provider's catalog when one is known;
  // otherwise the provider's own default (resolveDefaultsFor with no id picks
  // the catalog's first family default).
  const catalog = availableCatalogs?.[fallbackProvider];
  let fallbackModel: string | undefined;
  let fallbackTier: EffortTier | undefined;
  if (catalog && catalog.length > 0) {
    const flat: { modelId: string; tier: EffortTier }[] = [];
    for (const fam of catalog) {
      for (const e of fam.efforts) flat.push({ modelId: e.modelId, tier: e.tier });
    }
    if (flat.length > 0) {
      const pick = flat[Math.min(Math.floor(rand() * flat.length), flat.length - 1)]!;
      fallbackModel = pick.modelId;
      fallbackTier = pick.tier;
    }
  }
  const fallbackResolved = resolveDefaultsFor(fallbackProvider, fallbackModel, fallbackTier);
  return {
    provider: fallbackProvider,
    model: fallbackResolved.model,
    reasoning: fallbackResolved.reasoning,
    serviceTier: undefined,
    contextWindow: fallbackResolved.contextWindow,
    source: "catalog_fallback",
  };
}

/** Every permission mode there is, so a stored string can be checked against
 *  the set rather than trusted. */
export const MODES = ["ask", "accept-edits", "full-access"] as const;

/**
 * The mode a thread in this project should open on, or null when nothing has
 * been decided anywhere and the session's own floor should stand.
 *
 * The project's own mode wins, then the app-wide default — the same order the
 * per-project key implies, since a project that has been given a mode has said
 * something more specific than the default ever did. Read once when a thread is
 * being made, never afterwards: a running thread's mode is the one it is
 * running under, and re-reading storage would change it out from under a turn.
 */
export function bootMode(projectPath: string): InteractionMode | null {
  const storage = getStorage();
  if (!storage) return null;
  const stored =
    storage.getItem(modeKey(projectPath)) ?? storage.getItem(DEFAULT_MODE_KEY);
  if (stored === null || !MODES.some((m) => m === stored)) return null;
  // SAFETY: the check above passes only for an exact member of MODES, which is
  // exactly InteractionMode.
  return stored as InteractionMode;
}

/** The `in PROVIDER_VENDOR` check above is the parse; this only carries the
 *  result across, and every caller is that check. */
function toProviderKind(checked: string): ProviderKind {
  // SAFETY: reached only when `checked in PROVIDER_VENDOR`, and that object's
  // keys are exactly ProviderKind.
  return checked as ProviderKind;
}

export const PROVIDER_BRAND = {
  codex: "codex",
  claudeAgent: "claude",
  cursor: "cursor",
  opencode: "opencode",
  droid: "droid",
  antigravity: "antigravity",
} satisfies Record<ProviderKind, BrandKey>;
