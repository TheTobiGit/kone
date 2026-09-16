// Thread-export presentation — the renderer side of the
// `@kone/protocol/thread-export` contract. The main process owns the save
// dialog and the file write; this module owns everything around them: the
// suggested file name, the format labels, and turning a file outcome into
// finished prose worth showing. Pure and clock-free, so the whole module is
// unit tested without a bridge.
import {
  parseThreadExportFormat,
  threadExportBlockedMessage,
  type ThreadExportFormat,
} from "@kone/protocol/thread-export";
import type { ThreadExportOutcome } from "~/types/desktop";

export type { ThreadExportFormat };
export { parseThreadExportFormat };

/** The formats the export affordance offers, in the order it offers them. */
export const THREAD_EXPORT_FORMATS: readonly ThreadExportFormat[] = [
  "markdown",
  "json",
];

export const THREAD_EXPORT_FORMAT_LABELS = {
  markdown: "Markdown",
  json: "JSON",
} satisfies Record<ThreadExportFormat, string>;

/** The extension a suggested export name wears. Markdown takes `md` — the
 *  save dialog also accepts `markdown`, but the suggestion stays short. */
export function threadExportExtension(format: ThreadExportFormat): string {
  return format === "json" ? "json" : "md";
}

/** Chars of slug the suggested name keeps from a thread title. Long titles
 *  still suggest the whole idea's start rather than a truncated hash. */
const EXPORT_FILENAME_MAX_STEM = 60;

/** The file name suggested to the save dialog: a slug of the thread title
 *  plus the format extension, or `thread-<short id>` when the title has
 *  nothing worth keeping. Always a bare name — never a path — so the main
 *  process can take its basename without changing what the user reads. */
export function threadExportFilename(
  title: string | null | undefined,
  threadId: string,
  format: ThreadExportFormat,
): string {
  const slug = (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, EXPORT_FILENAME_MAX_STEM)
    .replace(/-+$/g, "");
  const stem = slug.length > 0 ? slug : `thread-${threadId.slice(0, 8)}`;
  return `${stem}.${threadExportExtension(format)}`;
}

/** Finished prose for a failed file outcome. Blocked threads read through
 *  the shared predicate's own words, so the caller and the handler can never
 *  disagree about what is exportable; every other failure already carries
 *  finished prose from the backend, which stands as-is. Null when the export
 *  succeeded and there is nothing to explain. */
export function exportFailureMessage(
  outcome: ThreadExportOutcome,
): string | null {
  if (outcome.ok) return null;
  switch (outcome.reason) {
    case "thread-not-found":
    case "thread-running":
    case "no-completed-turns":
      return threadExportBlockedMessage(outcome.reason);
    default:
      return outcome.message;
  }
}

/** Bytes as a short human size for the saved confirmation: bare bytes under
 *  a kilobyte, one decimal above it. */
export function formatExportBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** The last segment of a saved path for the confirmation line. The dialog
 *  returns an absolute path, and the directory is context the user just
 *  chose — not news. Both separators are split on; the main process runs on
 *  any OS, so the renderer cannot assume which one it will see. */
export function exportFileBasename(filePath: string): string {
  const parts = filePath.split(/[/\\]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? filePath;
}
