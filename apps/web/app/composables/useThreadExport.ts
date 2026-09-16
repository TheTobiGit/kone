// The export flow: suggest a name, let the main process run its native save
// dialog, then write the transcript to the chosen path. The two bridge calls
// stay in this order — a cancelled dialog ends the flow before any file is
// touched, and every legible state (saved, cancelled, empty, failed) lands in
// `phase` + `message` for the affordance to render. Rejections resolve into
// words, never throw: an export the user watches must explain itself.
import { ref } from "vue";
import type {
  ThreadExportDialogResult,
  ThreadExportFormat,
  ThreadExportOutcome,
} from "~/types/desktop";
import { peelIpcError } from "~/utils/ipcError";
import {
  exportFailureMessage,
  exportFileBasename,
  formatExportBytes,
  threadExportFilename,
} from "~/utils/threadExport";

/** The slice of the desktop bridge the export flow reaches for. The real
 *  `window.koneDesktop.agent` satisfies this structurally; tests hand a fake
 *  with the same two methods. */
export type ThreadExportBridge = {
  pickExportPath: (
    suggestedName: string,
    format: ThreadExportFormat,
  ) => Promise<ThreadExportDialogResult>;
  exportThread: (
    threadId: string,
    format: ThreadExportFormat,
    filePath: string,
  ) => Promise<ThreadExportOutcome>;
};

/** Where an export stands. `dialog` and `exporting` are the two waits (the
 *  native dialog open, the file writing); `cancelled` and `empty` are quiet
 *  answers, not errors — only `failed` is one. */
export type ThreadExportPhase =
  | "idle"
  | "dialog"
  | "exporting"
  | "saved"
  | "cancelled"
  | "empty"
  | "failed";

/** The bridge as the app sees it. Null outside the desktop shell — the flow
 *  then fails legibly instead of faking a browser download. */
function defaultBridge(): ThreadExportBridge | null {
  if (!import.meta.client) return null;
  return window.koneDesktop?.agent ?? null;
}

export function useThreadExport() {
  const phase = ref<ThreadExportPhase>("idle");
  const message = ref<string | null>(null);

  function reset(): void {
    phase.value = "idle";
    message.value = null;
  }

  function fail(text: string): void {
    phase.value = "failed";
    message.value = text;
  }

  async function runExport(
    threadId: string,
    title: string | null | undefined,
    format: ThreadExportFormat,
    bridge: ThreadExportBridge | null = defaultBridge(),
  ): Promise<void> {
    if (!bridge) {
      fail(
        "Export needs the desktop app: open this thread there to save a transcript.",
      );
      return;
    }
    if (!threadId) {
      fail("There's no thread to export yet.");
      return;
    }
    phase.value = "dialog";
    message.value = null;
    let picked: ThreadExportDialogResult;
    try {
      picked = await bridge.pickExportPath(
        threadExportFilename(title, threadId, format),
        format,
      );
    } catch (cause) {
      fail(peelIpcError(cause, "Couldn't open the save dialog."));
      return;
    }
    if (!picked) {
      fail("The save dialog answered in a shape this build doesn't read.");
      return;
    }
    if (picked.canceled) {
      phase.value = "cancelled";
      message.value = "Export cancelled — no file was written.";
      return;
    }
    phase.value = "exporting";
    let outcome: ThreadExportOutcome;
    try {
      outcome = await bridge.exportThread(threadId, format, picked.filePath);
    } catch (cause) {
      fail(peelIpcError(cause, "Couldn't write the export."));
      return;
    }
    if (!outcome) {
      fail("The export answered in a shape this build doesn't read.");
      return;
    }
    if (outcome.ok) {
      phase.value = "saved";
      message.value = `Saved ${exportFileBasename(outcome.path)} (${formatExportBytes(outcome.bytes)}).`;
      return;
    }
    // An exportable-shaped thread that turns out to hold no completed turns
    // is the "empty" every new thread hits — a quiet note, not an error.
    if (outcome.reason === "no-completed-turns") {
      phase.value = "empty";
      message.value = exportFailureMessage(outcome) ?? outcome.message;
      return;
    }
    fail(exportFailureMessage(outcome) ?? outcome.message);
  }

  return { phase, message, runExport, reset };
}
