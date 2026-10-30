/** Pure approval and sandbox policy for Codex: how one `requestApproval`
 *  payload becomes the neutral ask the renderer shows, how a kone
 *  ApprovalDecision maps onto each wire reply shape, and how an
 *  InteractionMode becomes the thread/turn approval+sandbox overrides. No
 *  session, transport, or process state belongs here — CodexAdapter owns that
 *  orchestration and imports these as plain functions. */

import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRequestKind,
  InteractionMode,
} from "../types.js";
import { asArray, asRecord, readString, type CodexJsonObject, type CodexJsonValue } from "./codexJson.js";

/** Normalize one Codex `requestApproval` payload into the neutral ask the
 *  renderer shows. Each request kind has its own fields — command execution
 *  carries the command line, file change/read carry the path (or root), and a
 *  permissions grant carries the concrete profile it wants (filesystem paths
 *  and/or network), which is the only subject the user can judge it by. */
export function buildApprovalRequest(kind: ApprovalRequestKind, params: CodexJsonValue | null | undefined): ApprovalRequest {
  const reason = readString(params, "reason")?.trim();
  const withDetail = (request: ApprovalRequest, detail?: string): ApprovalRequest => {
    if (reason) request.detail = reason;
    else if (detail) request.detail = detail;
    return request;
  };
  switch (kind) {
    case "command": {
      const command = readString(params, "command")?.trim();
      return withDetail({ kind, title: command ?? "Run a command" });
    }
    case "file-change": {
      const grantRoot = readString(params, "grantRoot")?.trim();
      return withDetail({ kind, title: grantRoot ?? "Change files" });
    }
    case "file-read": {
      const path = readString(params, "path")?.trim() ?? readString(params, "grantRoot")?.trim();
      return withDetail({ kind, title: path ?? "Read files" });
    }
    case "permission":
    default:
      return withDetail({ kind, title: "Grant expanded permissions" }, describePermissionProfile(asRecord(params)?.permissions));
  }
}

/** One-line human summary of a Codex requested-permission profile — the paths
 *  it wants to write or read and whether it wants network. Empty when the
 *  profile names nothing recognizable; the reason field then stands alone. */
export function describePermissionProfile(profile: CodexJsonValue | null | undefined): string | undefined {
  if (!profile) return undefined;
  const record = asRecord(profile);
  if (!record) return undefined;

  const parts: string[] = [];
  const pathsUnder = (key: "write" | "read"): string[] => {
    const raw = asArray(record.fileSystem ? asRecord(record.fileSystem)?.[key] : undefined);
    return raw
      .filter((v): v is string => Boolean(v && !(v instanceof Object)))
      .map(String);
  };
  const writePaths = pathsUnder("write");
  const readPaths = pathsUnder("read").filter((p) => !writePaths.includes(p));
  // Newer profiles carry { access, path } entries instead of the split
  // read/write lists; collect them so either wire shape renders.
  const entries = asArray(asRecord(record.fileSystem)?.entries)
    .map((entry) => {
      const r = asRecord(entry);
      const rawPath = r?.path;
      const path = rawPath && !(rawPath instanceof Object) ? String(rawPath) : rawPath instanceof Object ? readString(rawPath, "text") : undefined;
      const access = r?.access && !(r.access instanceof Object) ? String(r.access) : undefined;
      return path ? `${access ?? "access"} ${path}` : undefined;
    })
    .filter((v): v is string => v !== undefined);

  if (writePaths.length > 0) parts.push(`write: ${writePaths.join(", ")}`);
  if (readPaths.length > 0) parts.push(`read: ${readPaths.join(", ")}`);
  parts.push(...entries);
  if (asRecord(record.network)?.enabled === true) parts.push("network");

  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** The filesystem/network profile a permission request asks for, verbatim —
 *  it came off the wire from the app-server itself, and the approval reply
 *  must echo exactly these grants back. */
function requestedPermissionProfile(params: CodexJsonValue | null | undefined): CodexJsonObject {
  return asRecord(asRecord(params)?.permissions) ?? {};
}

/** kone's ApprovalDecision → Codex's `requestApproval` reply vocabulary.
 *  `reject-and-stop` is Codex's `cancel` — the command is denied AND the turn
 *  is immediately interrupted (the app-server's own schema words it exactly
 *  that: "User denied the command. The turn will also be immediately
 *  interrupted."), so no extra work is needed on our side. */
function toCodexApprovalDecision(decision: ApprovalDecision): string {
  switch (decision) {
    case "allow-always":
      return "acceptForSession";
    case "allow-once":
      return "accept";
    case "reject-once":
      return "decline";
    case "reject-and-stop":
      return "cancel";
  }
}

/** The JSON-RPC result for one settled approval request. Command and file
 *  requests answer `{ decision }`; a permissions grant answers a DIFFERENT
 *  shape — `{ permissions, scope }`, echoing back exactly the grants the user
 *  accepted (`{}` when refused) plus how long they last ("session" only when
 *  the user chose allow-always). There is no `decision` field on that shape,
 *  so replying one uniformly would make every permission ask unusable: an
 *  allow would grant nothing and a deny would send an unknown field. */
export function buildApprovalReply(
  kind: ApprovalRequestKind,
  decision: ApprovalDecision,
  params: CodexJsonValue | null | undefined,
): CodexJsonObject {
  if (kind !== "permission") {
    return { decision: toCodexApprovalDecision(decision) };
  }
  const allowed = decision === "allow-once" || decision === "allow-always";
  return {
    permissions: allowed ? requestedPermissionProfile(params) : {},
    scope: decision === "allow-always" ? "session" : "turn",
  };
}

/** The fail-closed reply for a request we decline without asking anyone (no
 *  live turn behind it): same per-kind shapes as a real refusal. */
export function declinedApprovalReply(kind: ApprovalRequestKind): CodexJsonObject {
  return kind === "permission" ? { permissions: {}, scope: "turn" } : { decision: "decline" };
}

// ── mode → Codex approval/sandbox mapping ───────────────────────────────────
// Thread-level `sandbox` is a flat kebab-case enum; turn-level `sandboxPolicy`
// is an object with a camelCase `type` — this asymmetry is Codex's own, not a
// typo. `approvalsReviewer` is sent explicitly on every mode change (thread AND
// turn) regardless — it's always "user" here since kone's ladder has no "auto"
// rung (the only one that would set it to "auto_review").
//
// workspaceWrite keeps Codex's default networkAccess: false. The kone gateway
// needs no exception — the app-server itself opens the loopback MCP connection,
// outside any sandbox; the flag only governs commands exec'd inside it, and
// those also can't see the gateway token (the overlay config excludes it from
// the exec environment).

type CodexThreadModeOverrides = {
  approvalPolicy: string;
  sandbox: string;
  approvalsReviewer: string;
};

export function mapModeToThreadOverrides(
  mode: InteractionMode,
): CodexThreadModeOverrides {
  switch (mode) {
    case "ask":
      return { approvalPolicy: "untrusted", sandbox: "read-only", approvalsReviewer: "user" };
    case "full-access":
      // No gate at all on this rung, and that is the CLI's design rather than a
      // gap kone can close: `never` means Codex decides locally and never sends
      // an approval request, so nothing about a command crosses into this
      // process before it runs. The other adapters screen commands at the
      // auto-approve gate they still see; there is no equivalent point here.
      // Anything stronger has to come from the sandbox, not from us.
      return { approvalPolicy: "never", sandbox: "danger-full-access", approvalsReviewer: "user" };
    case "accept-edits":
    default:
      return { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "user" };
  }
}

/** The approval/sandbox half of a codex-rs turn/start payload. */
export type CodexTurnApprovalOverrides = {
  approvalPolicy: string;
  approvalsReviewer: string;
  sandboxPolicy: { type: string; [key: string]: string };
};

export function mapModeToTurnOverrides(mode: InteractionMode): CodexTurnApprovalOverrides {
  switch (mode) {
    case "ask":
      return { approvalPolicy: "untrusted", approvalsReviewer: "user", sandboxPolicy: { type: "readOnly" } };
    case "full-access":
      return { approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "dangerFullAccess" } };
    case "accept-edits":
    default:
      return { approvalPolicy: "on-request", approvalsReviewer: "user", sandboxPolicy: { type: "workspaceWrite" } };
  }
}
