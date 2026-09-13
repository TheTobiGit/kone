import { getSpawnEngine, SpawnError } from "../../threadSpawn.js";
import type { SpawnCaller, SpawnEngine } from "../../threadSpawn.js";
import type {
  GatewayToolContext,
  GatewayToolResult,
  GatewayValue,
} from "../schemas.js";
import { GatewayToolError } from "../schemas.js";
import { gatewayToolErrorResult } from "../registry.js";

// The shared leaf both spawn tool modules import downward from: the engine
// lookup, the caller identity, the refusal mapping, and the turn-bound
// wrapper. Neither tool module imports the other, so no cycle can form here.

/** The engine, or the gateway-equivalent internal error when it is not running
 *  in this session. */
export function requiredEngine(): SpawnEngine {
  const engine = getSpawnEngine();
  if (!engine) {
    throw new GatewayToolError("internal", "kone's thread engine is not running in this session.");
  }
  return engine;
}

/** Build the engine's caller identity from the gateway's bound authority
 *  context ONLY — never from agent-supplied arguments, so a child's parentage
 *  cannot be forged (design property 1). Read tools run turn-less; their
 *  callers get an empty turn id, which nothing the engine does with the caller
 *  cares about without a live turn. */
export function callerOf(ctx: GatewayToolContext): SpawnCaller {
  return {
    threadId: ctx.threadId,
    turnId: ctx.turnId ?? "",
    provider: ctx.provider,
    model: ctx.model,
    cwd: ctx.cwd,
  };
}

/** Map an engine refusal onto the gateway's error vocabulary — the code
 *  strings are identical by construction, so they cross unchanged. Anything
 *  that is not a SpawnError is rethrown for the registry's internal handling. */
export function mapSpawnError(cause: unknown): GatewayToolError {
  if (cause instanceof SpawnError) {
    // SAFETY: engine refusals carry plain-JSON detail bags that are embedded
    // verbatim into the tool result without further interpretation.
    return new GatewayToolError(cause.code, cause.message, cause.details as GatewayValue);
  }
  throw cause;
}

/** Run a turn-bound tool body: refuse turn-less calls, resolve the engine and
 *  caller, then map engine refusals onto gateway errors. Non-SpawnError
 *  failures rethrow through mapSpawnError for the registry's internal
 *  handling, exactly as the inlined guard/try-catch did. */
export async function withActiveTurn(
  ctx: GatewayToolContext,
  run: (engine: SpawnEngine, caller: SpawnCaller) => Promise<GatewayToolResult>,
): Promise<GatewayToolResult> {
  if (!ctx.turnId) {
    return gatewayToolErrorResult(
      new GatewayToolError("capability_denied", "This tool requires an active agent turn."),
    );
  }
  const engine = requiredEngine();
  const caller = callerOf(ctx);
  try {
    return await run(engine, caller);
  } catch (error) {
    return gatewayToolErrorResult(mapSpawnError(error));
  }
}
