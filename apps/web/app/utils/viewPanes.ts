// A studio column, described for the assistant.
//
// The strip draws a column from its live session; the assistant reads the same
// session as a `ViewPane` — which thread, what state it is in, and, when it is
// parked, what it is waiting on. Pure over the pane, so the status rule is
// stated once and tested here rather than in the row that publishes it.

import type { ViewPane, ViewThreadStatus } from "@kone/protocol/view-context";
import type { ThreadSession } from "~/composables/useAgent";
import type { Pane, PaneId } from "~/types/studio";
import { isThreadSessionBlank } from "~/utils/panes";

/** A thread's state as one word. A parked thread outranks everything, the way
 *  `app_list_threads` ranks it: nothing moves there until a human acts. */
export function threadViewStatus(session: ThreadSession): ViewThreadStatus {
  if (session.pendingApproval.value) return "waiting-for-approval";
  if (session.pendingUserInput.value) return "waiting-for-user-input";
  if (session.busy.value) return "working";
  if (session.unstarted.value) return "not-started";
  if (session.error.value || session.sessionState.value === "error") return "failed";
  if (session.sessionState.value === "starting" && session.session.value) return "starting";
  return "idle";
}

function threadPane(pane: Extract<Pane, { kind: "thread" }>, focused: boolean): ViewPane {
  const session = pane.session;
  let out: Extract<ViewPane, { kind: "thread" }>;
  if (!session) {
    const threadId = pane.entry.anchor.kind === "thread" ? pane.entry.anchor.threadId : null;
    out = { kind: "thread", focused, threadId, title: "", status: "dormant" };
  } else if (isThreadSessionBlank(session)) {
    out = { kind: "thread", focused, threadId: null, title: "", status: "not-started" };
  } else {
    out = describeLiveThread(session, focused);
  }
  if (pane.entry.zen) out.zen = true;
  return out;
}

function describeLiveThread(session: ThreadSession, focused: boolean): Extract<ViewPane, { kind: "thread" }> {
  const status = threadViewStatus(session);
  const out: Extract<ViewPane, { kind: "thread" }> = {
    kind: "thread",
    focused,
    threadId: session.threadId.value,
    title: session.title.value,
    status,
  };
  const provider = session.provider.value;
  if (provider) out.provider = provider;
  const model = session.model.value;
  if (model) out.model = model;
  if (session.isSideChat.value) out.sideChat = true;
  if (session.worktreePath.value) out.worktree = session.worktreePath.value;
  const queued = session.queuedTurns.value.length;
  if (queued > 0) out.queued = queued;

  const approval = session.pendingApproval.value;
  const question = session.pendingUserInput.value?.questions[0];
  if (approval) {
    out.waitingOn = { kind: "approval", summary: approval.approval.title };
  } else if (question) {
    out.waitingOn = { kind: "question", summary: question.question };
  }
  const error = session.error.value;
  if (status === "failed" && error) out.error = error;
  return out;
}

/** One column as the assistant reads it. */
export function describePane(pane: Pane, focusedId: PaneId | null): ViewPane {
  const focused = pane.id === focusedId;
  if (pane.kind === "thread") return threadPane(pane, focused);
  let out: ViewPane;
  if (pane.kind === "terminal") {
    const session = pane.session;
    out = {
      kind: "terminal",
      focused,
      terminalId: session?.terminalId ?? (pane.entry.anchor.kind === "terminal" ? pane.entry.anchor.terminalId : null),
      cwd: session?.cwd ?? "",
      status: session?.status ?? "dormant",
      running: session?.hasRunningSubprocess ? session.childCommandLabel : null,
    };
  } else {
    out = { kind: "scratchpad", focused, title: "Scratchpad" };
  }
  if (pane.entry.zen) out.zen = true;
  return out;
}
