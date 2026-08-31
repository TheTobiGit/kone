// useStudioIntake — a thread born outside the studio joining its project's row.
//
// Work reaches the plane two ways. Inside the studio you open a pane and the
// pane *is* the thread, so which row it lands on was never in question. From the
// inbox you start a thread with no row in front of you at all — the inbox is
// deliberately project-blind, that is the whole point of it — and the thread
// would then exist only in history: real work, in a project that has a row, with
// nothing on the row to show for it.
//
// Intake closes that gap. A row is a project's work, so a thread belongs on it
// however it was started.
//
// Two paths, because a row is only mounted when the plane already holds one for
// its project (or that project's page is open underneath):
//
//   · mounted — hand the thread to the row. It opens the pane and persists it on
//     its own debounce. A mounted row is the only writer of its own layout, so
//     writing the document behind one would just be clobbered by its next save.
//   · not mounted — write the pane entry straight into the plane. The row set is
//     derived from the document, so this both brings the row into being and puts
//     the pane on it; when the row does mount it restores exactly what we wrote.
//
// Neither path focuses the pane and neither summons the plane. You asked for a
// thread, not to be taken somewhere — the column is simply there the next time
// you travel to that row.

import { usePaneWidthPrefs } from "~/composables/usePaneWidthPrefs";
import { useStudioPersistence } from "~/composables/useStudioPersistence";
import { useStudioRowRegistry } from "~/composables/useStudioRowRegistry";
import type { PaneEntry, StudioRow } from "~/types/studio";

let intakeSeq = 0;

/** A pane id in the studio's own shape, minted from a counter of its own. The
 *  studio's minter is private to useStudio and this path never runs inside one —
 *  there is no row to ask. Ids only collide within a single millisecond of a
 *  single run, and sanitizeRow re-mints a duplicate on the way back in anyway. */
function mintPaneId(): string {
  intakeSeq += 1;
  return `intake-${Date.now().toString(36)}-${intakeSeq.toString(36)}`;
}

export function useStudioIntake() {
  const rowRegistry = useStudioRowRegistry();
  const { defaultWidth } = usePaneWidthPrefs();

  /** Put a thread on its project's studio row. Safe to call for a thread that is
   *  already there — both paths dedupe, because one conversation is hosted by
   *  exactly one pane. */
  async function adoptThread(projectPath: string, threadId: string): Promise<void> {
    if (!projectPath || !threadId) return;

    const mounted = rowRegistry.rowFor(projectPath);
    if (mounted) {
      mounted.adoptThread(threadId);
      return;
    }

    const store = useStudioPersistence(projectPath);
    const existing = await store.loadRow();

    // Reading a cold plane is a round trip, and a row can mount inside it — the
    // studio being summoned, the project's page opening. From that moment the
    // row owns its layout, so hand the thread over rather than write underneath
    // it and have its first save drop the pane.
    const arrived = rowRegistry.rowFor(projectPath);
    if (arrived) {
      arrived.adoptThread(threadId);
      return;
    }

    const panes = existing?.panes ?? [];
    if (panes.some((p) => p.anchor.kind === "thread" && p.anchor.threadId === threadId)) return;

    const entry: PaneEntry = {
      id: mintPaneId(),
      kind: "thread",
      anchor: { kind: "thread", threadId },
      width: defaultWidth("thread"),
    };

    // At the right edge. A thread that arrived from somewhere else joins the end
    // of the row rather than splitting the cluster you were last working in.
    const next: StudioRow = {
      projectPath,
      panes: [...panes, entry],
      focusedId: existing?.focusedId ?? null,
    };
    store.saveRow(next);
  }

  return { adoptThread };
}
