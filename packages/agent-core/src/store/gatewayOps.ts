import type { ConversationDb } from "./ConversationDb.js";

export class GatewayOpRepo {
  constructor(private readonly dbh: ConversationDb) {}

  // ── gateway idempotency ops (docs/mcp-gateway-design.md §7) ───────────────
  // One table for every gateway tool: agent write tools carry a clientRequestId
  // so ambiguous-network-failure retries replay instead of re-applying. Keys
  // come from the bound authority context (thread + turn + agent-supplied
  // request id); the fingerprint is over the canonicalized request.

  /** Reserve one gateway operation, or resolve a prior one:
   *  - "reserved" — first sighting; the caller performs the work, then
   *    `setGatewayOpResult`.
   *  - { kind: "replay"; result } — same key + same fingerprint, completed
   *    before: return the stored post-write result. If a crash between the
   *    write and `setGatewayOpResult` left the row without a result, the
   *    retry falls through to "reserved" and re-applies (the revision guard
   *    catches a write that actually landed).
   *  - "conflict" — same key, different fingerprint: the agent re-sent the
   *    same request id with different content.
   *  - null — store failure. */
  reserveGatewayOp(input: {
    threadId: string;
    turnId: string;
    requestId: string;
    kind: string;
    fingerprint: string;
  }): { kind: "reserved" } | { kind: "replay"; result: unknown } | { kind: "conflict" } | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      const inserted = db
        .prepare(
          `INSERT INTO gateway_ops (thread_id, turn_id, request_id, kind, fingerprint, result_json, status)
           VALUES (?, ?, ?, ?, ?, NULL, 'reserved')
           ON CONFLICT(thread_id, turn_id, request_id) DO NOTHING`,
        )
        .run(input.threadId, input.turnId, input.requestId, input.kind, input.fingerprint);
      if (Number(inserted.changes) > 0) return { kind: "reserved" };
      // SAFETY: the projection names the two columns written by reserveGatewayOp/setGatewayOpResult.
      const prior = db
        .prepare(
          `SELECT fingerprint, result_json FROM gateway_ops
            WHERE thread_id = ? AND turn_id = ? AND request_id = ?`,
        )
        .get(input.threadId, input.turnId, input.requestId) as
        | { fingerprint: string; result_json: string | null }
        | undefined;
      if (prior && prior.fingerprint === input.fingerprint && prior.result_json) {
        try {
          return { kind: "replay", result: JSON.parse(prior.result_json) };
        } catch {
          return { kind: "conflict" };
        }
      }
      return { kind: "conflict" };
    } catch (err) {
      console.error("[conversation-store] reserveGatewayOp failed:", err);
      return null;
    }
  }

  /** Record a completed gateway operation's result so a retry with the same
   *  key + fingerprint replays it. Status transitions to 'dispatching'. */
  setGatewayOpResult(input: {
    threadId: string;
    turnId: string;
    requestId: string;
    resultJson: string;
  }): void {
    const db = this.dbh.handle();
    if (!db) return;
    try {
      db.prepare(
        `UPDATE gateway_ops SET result_json = ?, status = 'dispatching'
          WHERE thread_id = ? AND turn_id = ? AND request_id = ?`,
      ).run(input.resultJson, input.threadId, input.turnId, input.requestId);
    } catch (err) {
      console.error("[conversation-store] setGatewayOpResult failed:", err);
    }
  }

  /** Record that a reserved gateway operation's side effect was actually
   *  dispatched. Status transitions to 'completed'. */
  markGatewayOpDispatched(input: {
    threadId: string;
    turnId: string;
    requestId: string;
  }): void {
    const db = this.dbh.handle();
    if (!db) return;
    try {
      db.prepare(
        `UPDATE gateway_ops SET status = 'completed'
          WHERE thread_id = ? AND turn_id = ? AND request_id = ?`,
      ).run(input.threadId, input.turnId, input.requestId);
    } catch (err) {
      console.error("[conversation-store] markGatewayOpDispatched failed:", err);
    }
  }
}
