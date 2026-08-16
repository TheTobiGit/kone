// Process-local cancellation ownership for MCP calls on the kone gateway.
//
// MCP clients send `notifications/cancelled` as a *separate* POST from the
// tools/call they want to stop. Same-batch skip (a cancel slot that arrives
// in the same body as its target) is not enough: the common case is a later
// notification targeting a request that is already running. This registry is
// that cross-request map — register on start, cancel by (session, request id)
// or by turn, unregister on settle.
//
// MCP clients may also omit the notification entirely when their parent
// operation is interrupted (the user hit Cancel). The gateway therefore
// cancels the turn directly through this registry when turn.completed /
// turn.aborted fires. Interrupted turn ids are retained for the lifetime of
// the session so a request racing Stop is cancelled at registration instead
// of escaping the first sweep.

export type JsonRpcRequestId = string | number | null;

export interface InFlightRegistration {
  readonly sessionKey: string;
  readonly turnId: string | null;
  readonly requestId: JsonRpcRequestId;
  readonly cancel: () => Promise<void>;
}

export interface InFlightSelector {
  readonly sessionKey: string;
  readonly turnId?: string;
  readonly requestId?: JsonRpcRequestId;
}

export interface InFlightCancellation {
  readonly count: number;
  readonly settled: Promise<void>;
}

export interface InFlightRequestRegistry {
  register(registration: InFlightRegistration): () => void;
  cancel(selector: InFlightSelector): InFlightCancellation;
  cancelTurn(sessionKey: string, turnId: string): InFlightCancellation;
  revokeSession(sessionKey: string): InFlightCancellation;
}

interface RegisteredRequest extends InFlightRegistration {
  readonly token: symbol;
}

/**
 * In-memory in-flight map. One instance per gateway (injected, never a
 * process singleton — tests construct their own so they cannot leak state
 * across files).
 *
 * `cancel()` callbacks that throw are swallowed: cancellation is best-effort
 * at this synchronous boundary. The caller (Stop / a later cancelled
 * notification) must never be prevented from interrupting the provider turn
 * itself. That is the can't-verify branch — fail open, not closed.
 */
export function makeInFlightRequestRegistry(): InFlightRequestRegistry {
  const requests = new Map<symbol, RegisteredRequest>();
  const cancelledTurns = new Map<string, Set<string>>();

  const cancel = (selector: InFlightSelector): InFlightCancellation => {
    const matches = [...requests.values()].filter(
      (request) =>
        request.sessionKey === selector.sessionKey &&
        (selector.turnId === undefined || request.turnId === selector.turnId) &&
        (selector.requestId === undefined || request.requestId === selector.requestId),
    );
    for (const request of matches) requests.delete(request.token);
    const cancellations = matches.map((request) => {
      try {
        return request.cancel();
      } catch {
        return Promise.resolve();
      }
    });
    return {
      count: matches.length,
      settled: Promise.allSettled(cancellations).then(() => undefined),
    };
  };

  return {
    register: (registration) => {
      if (
        registration.turnId !== null &&
        cancelledTurns.get(registration.sessionKey)?.has(registration.turnId)
      ) {
        void registration.cancel();
        return () => undefined;
      }
      const token = Symbol("kone-gateway-in-flight-request");
      requests.set(token, { ...registration, token });
      return () => {
        requests.delete(token);
      };
    },
    cancel,
    cancelTurn: (sessionKey, turnId) => {
      let turns = cancelledTurns.get(sessionKey);
      if (!turns) {
        turns = new Set();
        cancelledTurns.set(sessionKey, turns);
      }
      turns.add(turnId);
      return cancel({ sessionKey, turnId });
    },
    revokeSession: (sessionKey) => {
      const cancelled = cancel({ sessionKey });
      cancelledTurns.delete(sessionKey);
      return cancelled;
    },
  };
}
