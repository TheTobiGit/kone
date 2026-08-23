// The vocabulary of machine-readable failure kinds that can cross the
// renderer/main boundary, and the marker that lets a kind survive the trip.
//
// Electron flattens a rejected `invoke` into "Error invoking remote method
// '<channel>': <Name>: <message>" on the renderer side — the thrown error's own
// fields (a `kind`, a `code`) are dropped and only `name` and `message` make it
// across. A classified error therefore writes its kind into the message as a
// leading "[kone:…]" marker; the renderer peels that marker back off and
// recovers the kind. Everything downstream keeps the marker a prefix of the
// human message — never embedded mid-sentence — so parsing stays a single regex
// and the marker can be stripped without touching the words a user reads.

export const IPC_ERROR_KINDS = [
  "AUTH_FAILURE",
  "NOT_AUTHENTICATED",
  "NOT_INSTALLED",
  "NOT_A_REPO",
  "NO_GITHUB_REMOTE",
  "NOT_FOUND",
  "NETWORK",
  "INVALID_INPUT",
  "INTERNAL",
  "TIMEOUT",
] as const;

export type IpcErrorKind = (typeof IPC_ERROR_KINDS)[number];

/** The marker prefix a classified error carries: "[kone:<KIND>] ". The renderer
 *  side mirrors this pattern — keep the two in lockstep. */
const KIND_MARKER = /^\[kone:([A-Z_]+)\]\s*/;

/** Prefix `message` with the marker so the kind survives IPC serialization. */
export function markKind(kind: IpcErrorKind, message: string): string {
  return `[kone:${kind}] ${message}`;
}

/** A message split by `parseKind`: the recovered machine-readable kind (null
 *  when the message was unmarked) plus the human remainder. */
export type ParsedIpcMessage = {
  kind: IpcErrorKind | null;
  message: string;
};

/** Split a (possibly marked) message into its kind and the human remainder.
 *  Unmarked messages come back with `kind: null` and the message untouched. */
export function parseKind(
  message: string,
): ParsedIpcMessage {
  const match = KIND_MARKER.exec(message);
  if (!match) return { kind: null, message };
  // SAFETY: the marker is only ever written by markKind(), whose argument is an IpcErrorKind.
  return { kind: match[1] as IpcErrorKind, message: message.slice(match[0].length) };
}
