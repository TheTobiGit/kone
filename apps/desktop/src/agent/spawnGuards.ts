// ── spawn admission guards (docs/thread-spawning-design.md §6 Wave 1 row D) ─
// One pure admission check that runs before kone opens a child thread. The
// engine (threadSpawn.ts) does the store lookups and feeds the results in here
// — this module holds no store, no AgentService and no I/O, so it can be
// unit-tested flat and reasoned about in isolation. Everything it needs
// arrives as input; the caller does the lookups.
//
// The check order is load-bearing, not cosmetic:
//
//   prompt → depth → breadth → provider health → model → effort → mode
//
// The first six rungs can refuse the spawn (SpawnGuardResult.ok: false); the
// one after them never does — an unsupported effort is dropped and reported as
// a SpawnAdjustment so the parent learns what it actually got instead of being
// silently surprised. An EXPLICIT mode escalation is a refusal, not a silent
// clamp: privilege never increases across a spawn, and quietly downgrading
// what the caller asked for lets it plan against a mode it won't actually get
// (a child that stops for permission stays stopped — nobody sits in its
// thread). An unset mode inherits the parent's without an adjustment.
//
// The model and effort rungs mirror AgentService.validModelFor / validEffortFor
// semantics exactly — those methods encode desync bugs kone already paid for
// (a Cursor model id sent to Codex drew an opaque upstream 400; the "base"
// sentinel crossing IPC drew "[reasoning.effort] Invalid value: 'base'"). One
// deliberate difference: a spawn's model is a *choice*, so an out-of-catalog
// model is refused with the catalog, never silently swapped — while effort
// stays a nicety and drops to the provider's default.

import {
  MAX_LIVE_CHILDREN_PER_PARENT,
  MAX_LIVE_SPAWNED_THREADS,
  MAX_SPAWN_DEPTH,
} from "./types.js";
import type {
  InteractionMode,
  ModelDescriptor,
  ProviderKind,
  SpawnAdjustment,
  SpawnTarget,
} from "./types.js";

/** Refusal codes, chosen to map 1:1 onto the gateway's GatewayErrorCode so the
 *  tool layer can pass them straight through. */
export type SpawnRefusalCode =
  | "invalid_input"
  | "capability_denied"
  | "provider_unavailable"
  | "not_found"
  | "permission_denied";

/** Everything the admission check needs. The engine resolves each value from
 *  the store and the agent layer — depth, breadth, provider health and the
 *  catalog are all lookups, none of them this module's job. */
export type SpawnGuardInput = {
  prompt: string;
  target: SpawnTarget;
  /** The mode the caller asked the child to run under, if any. */
  requestedMode?: InteractionMode;
  /** The parent thread's current mode — the ceiling. */
  parentMode: InteractionMode;
  /** The parent session's reasoning-effort tier, when its adapter knows it.
   *  Mirrors `parentMode`: an unset target effort inherits the parent's instead
   *  of running the child at the provider's default. */
  parentEffort?: string;
  /** store.spawnDepth(parentThreadId) — the PARENT's depth. The child lands at
   *  parentDepth + 1. */
  parentDepth: number;
  /** Spawned children of this parent that are in flight right now. */
  liveChildrenOfParent: number;
  /** Spawned threads in flight app-wide. */
  liveSpawnedTotal: number;
  /** The target provider's last known health, or undefined when kone has never
   *  probed it. A structural shape rather than Pick<ProviderStatus, …> because
   *  ProviderStatus has no `error` key (its human hint lives on `message`); the
   *  caller maps the status onto it. */
  providerStatus?: { available: boolean; error?: string } | undefined;
  /** The target provider's discovered model catalog, or undefined when kone has
   *  never successfully read one. */
  catalog?: ModelDescriptor[] | undefined;
};

/** Admission verdict. `ok: true` means the child may spawn — `model`, `effort`
 *  and `mode` are what kone will actually run with, and `adjustments` lists
 *  every target the caller asked for that got changed. `ok: false` is a
 *  refusal: a code that maps 1:1 onto the gateway's GatewayErrorCode, an
 *  instruction-style message the parent agent reads to decide what to do next,
 *  and optional details (e.g. the catalog's available models). */
export type SpawnGuardResult =
  | {
      ok: true;
      model?: string;
      effort?: string;
      mode: InteractionMode;
      adjustments: SpawnAdjustment[];
    }
  | { ok: false; code: SpawnRefusalCode; message: string; details?: Record<string, unknown> };

// ── refusal messages ─────────────────────────────────────────────────────────
// Every refusal message is read by a model deciding what to do next, so each is
// written as an instruction — what happened AND what to do instead — never a
// diagnostic.

/** Spawn refused — the brief is empty. The child starts with none of the
 *  parent's context, so a blank prompt would wake it up with nothing to do. */
export const SPAWN_REFUSAL_EMPTY_PROMPT =
  "A spawned thread needs a prompt — the brief it wakes up to. Pass the whole task: the child starts with none of this conversation's context.";

/** Spawn refused — the child would land deeper than MAX_SPAWN_DEPTH. Only
 *  reachable when the parent is itself a spawned child (a thread at
 *  depth-(MAX) may not spawn), so the message names the thread's own depth. */
export function spawnRefusalDepth(parentDepth: number): string {
  return `Spawn depth limit reached (max ${MAX_SPAWN_DEPTH}). This thread is itself a spawned child at depth ${parentDepth} — do this work here rather than delegating it further.`;
}

/** Spawn refused — this parent already has too many children in flight. The
 *  fix is to wait on what it has, not to pile on more. */
export function spawnRefusalParentBreadth(live: number, limit: number): string {
  return `You already have ${live} children running (limit ${limit}). Call kone_wait_for_threads on the ones you have before spawning more.`;
}

/** Spawn refused — the app-wide spawn cap (MAX_LIVE_SPAWNED_THREADS) is
 *  reached: the backstop against a fork bomb. */
export function spawnRefusalAppBreadth(live: number, limit: number): string {
  return `kone is already running ${live} spawned threads app-wide (limit ${limit}). Wait for some to settle — or do this work yourself — before spawning more.`;
}

/** Spawn refused — the target provider is known to be unavailable. An
 *  undefined status never reaches here (that is a cold launch, not a
 *  refusal); this is the case where kone probed and got a definitive "no". */
export function spawnRefusalProviderUnavailable(provider: ProviderKind, error?: string): string {
  return error
    ? `The ${provider} provider is not available right now (${error}). Get it working — log in or reinstall — and retry, or spawn on a different provider.`
    : `The ${provider} provider is not available right now. Get it working — log in or reinstall — and retry, or spawn on a different provider.`;
}

/** Spawn refused — the chosen model is not in the provider's catalog. A model
 *  is a deliberate choice, so it is refused with the catalog rather than
 *  silently swapped. */
export function spawnRefusalModelNotFound(
  provider: ProviderKind,
  model: string,
  availableModels: string[],
): string {
  return `Model "${model}" is not in ${provider}'s catalog. Available: ${availableModels.join(", ")}. Pick one of those, or omit \`model\` to take the provider's default.`;
}

// ── adjustment reasons ───────────────────────────────────────────────────────
// Adjustments never refuse a spawn — they tell the parent what it asked for
// that it isn't getting, so the tool layer can surface the drift instead of
// the parent discovering it later.

/** Effort dropped — `"base"` is a renderer-internal sentinel meaning "this
 *  model has no reasoning-effort axis", never a provider value; it must not
 *  cross the IPC boundary (the exact bug validEffortFor guards against). */
export const SPAWN_ADJUSTMENT_EFFORT_BASE =
  `"base" is a kone-internal sentinel for a model with no reasoning-effort axis, not a provider value — running at the provider's default instead.`;

/** Effort dropped — the chosen model's discovered reasoningEfforts doesn't
 *  list the requested tier (a ladder carried over from another provider). The
 *  provider's own default is always a valid answer. */
export function spawnAdjustmentEffortUnsupported(
  provider: ProviderKind,
  model: string,
  effort: string,
): string {
  return `Effort "${effort}" is not supported by ${provider}/${model} — running at the provider's default instead.`;
}

/** Spawn refused — the caller explicitly asked for a mode wider than the
 *  parent's. An explicit escalation is a refusal, not a silent clamp: the child
 *  must never be less restrictive than its parent, and a quietly downgraded
 *  child would plan against a mode it doesn't have — stopping for permission
 *  nobody answers. Unset inherits silently, which is exactly the parent's rung. */
export function spawnRefusalModeEscalation(requested: InteractionMode, parent: InteractionMode): string {
  return `Requested mode "${requested}" exceeds this thread's "${parent}" — a spawned child can never be less restrictive than its parent, and an explicit escalation is refused rather than quietly downgraded. Leave \`mode\` unset to inherit your own rung, or do this work here; if the task truly needs more, ask the user to raise your thread's mode.`;
}

/** InteractionMode as an ordering, ask < accept-edits < full-access, so a
 *  child's requested mode can be compared against the parent's. */
function modeRank(mode: InteractionMode): number {
  return mode === "ask" ? 0 : mode === "accept-edits" ? 1 : 2;
}

/** Run the full admission check for one spawn, in the documented order. The
 *  engine feeds it everything it knows; it holds no state. On success the
 *  result carries the resolved model/effort/mode plus every adjustment made;
 *  on refusal it carries a SpawnRefusalCode that maps 1:1 onto the gateway's
 *  GatewayErrorCode and an instruction-style message the parent agent reads to
 *  decide what to do next. */
export function checkSpawn(input: SpawnGuardInput): SpawnGuardResult {
  // 1. Prompt — the child starts with none of the parent's context, so a blank
  //    brief is not a spawn worth opening.
  if (input.prompt.trim().length === 0) {
    return { ok: false, code: "invalid_input", message: SPAWN_REFUSAL_EMPTY_PROMPT };
  }

  // 2. Depth — the child lands at parentDepth + 1, and a thread at depth-(MAX)
  //    may not spawn. Checked before breadth: a thread that is already too deep
  //    has no business counting siblings, it should finish its own work.
  if (input.parentDepth + 1 > MAX_SPAWN_DEPTH) {
    return {
      ok: false,
      code: "capability_denied",
      message: spawnRefusalDepth(input.parentDepth),
    };
  }

  // 3. Breadth, this parent — a parent may not outrun its own attention.
  if (input.liveChildrenOfParent >= MAX_LIVE_CHILDREN_PER_PARENT) {
    return {
      ok: false,
      code: "capability_denied",
      message: spawnRefusalParentBreadth(input.liveChildrenOfParent, MAX_LIVE_CHILDREN_PER_PARENT),
    };
  }

  // 4. Breadth, app-wide — the fork-bomb backstop.
  if (input.liveSpawnedTotal >= MAX_LIVE_SPAWNED_THREADS) {
    return {
      ok: false,
      code: "capability_denied",
      message: spawnRefusalAppBreadth(input.liveSpawnedTotal, MAX_LIVE_SPAWNED_THREADS),
    };
  }

  // 5. Provider health — only a KNOWN unavailability refuses. An undefined
  //    status is NOT a refusal: kone simply hasn't probed yet, and refusing on
  //    absent knowledge would make a cold launch unspawnable.
  if (input.providerStatus && !input.providerStatus.available) {
    return {
      ok: false,
      code: "provider_unavailable",
      message: spawnRefusalProviderUnavailable(input.target.provider, input.providerStatus.error),
      ...(input.providerStatus.error ? { details: { error: input.providerStatus.error } } : {}),
    };
  }

  // 6. Model — a deliberate choice, so it is refused, never silently swapped.
  //    An unknown or empty catalog skips the check entirely — the same
  //    permissive fallback AgentService.validModelFor takes on a failed probe.
  const model = input.target.model;
  if (model && input.catalog && input.catalog.length > 0) {
    const availableModels = input.catalog.map((m) => m.id);
    if (!availableModels.includes(model)) {
      return {
        ok: false,
        code: "not_found",
        message: spawnRefusalModelNotFound(input.target.provider, model, availableModels),
        details: { availableModels },
      };
    }
  }

  // 7. Effort — never a refusal. The provider's own default is always a valid
  //    answer, so an effort that doesn't fit is dropped, not fatal. Mirrors
  //    validEffortFor exactly: drop the renderer-internal "base" sentinel, and
  //    drop an effort the chosen model's discovered reasoningEfforts doesn't
  //    list. Every drop reports an adjustment.
  const adjustments: SpawnAdjustment[] = [];
  // An unset target effort inherits the parent session's (mirror of mode:
  // unset inherits the parent's rung silently). The inherited value runs the
  // exact same validation as an explicit one — an unsupported tier drops to
  // the provider's default with an adjustment, never a refusal.
  let effort = input.target.effort || input.parentEffort;
  if (effort === "base") {
    adjustments.push({
      field: "effort",
      requested: "base",
      applied: null,
      reason: SPAWN_ADJUSTMENT_EFFORT_BASE,
    });
    effort = undefined;
  } else if (effort && model && input.catalog && input.catalog.length > 0) {
    const efforts = input.catalog.find((m) => m.id === model)?.reasoningEfforts;
    if (efforts && efforts.length > 0 && !efforts.includes(effort)) {
      adjustments.push({
        field: "effort",
        requested: effort,
        applied: null,
        reason: spawnAdjustmentEffortUnsupported(input.target.provider, model, effort),
      });
      effort = undefined;
    }
  }

  // 8. Mode — result mode = requested ?? parent, and an EXPLICIT escalation is
  //    runtimeModeEscalatesPrivilege: "created threads cannot use
  //    higher-privileged ..."). Privilege only ever increases across a spawn,
  //    and a silently downgraded child plans against a mode it doesn't have.
  //    Unset inherits the parent's rung silently; a downgrade or equal request
  //    is kept as-is (going down is exactly what was asked for).
  const requestedMode = input.requestedMode;
  if (requestedMode !== undefined && modeRank(requestedMode) > modeRank(input.parentMode)) {
    return {
      ok: false,
      code: "permission_denied",
      message: spawnRefusalModeEscalation(requestedMode, input.parentMode),
      details: { requestedMode, parentMode: input.parentMode },
    };
  }
  const mode = requestedMode ?? input.parentMode;

  return { ok: true, model, effort, mode, adjustments };
}
