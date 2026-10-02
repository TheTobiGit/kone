// A hand-off's result, delivered to whoever handed the work off.
//
// The result of a hand-off used to be pull-only: a delegator saw it if it was
// sitting in agent_wait when the delegate settled, or if it thought to wait
// later. One that had already ended its turn heard nothing, while the delegate
// — told its final reply goes back to the delegator — wrote that reply and
// sent nothing else. The report sat in the delegate's thread, read by the user
// and never by the agent it was for.
//
// So a settled turn nobody collected is sent on as a message from the child,
// kind "report", through the same mailbox agent_message uses: it steers the
// parent's running turn or wakes it idle, lands on its transcript in the
// child's name, and is held to the same guards as any message. When to send is
// the spawn engine's call (it knows who is waiting); this module is what gets
// sent and how.

import type { IrcMailbox, IrcToolStore } from "./gateway/tools/irc.js";
import { threadAgentName } from "./senderHeader.js";
import type { HandOffKind, SpawnedThreadStatus } from "./types.js";

/** One settled turn of a spawned child, as its parent is told it. */
export type SettledTurnReport = {
  childThreadId: string;
  parentThreadId: string;
  turnId: string;
  handOff: HandOffKind;
  /** completed, failed or interrupted — never a parked or running state. */
  status: SpawnedThreadStatus;
  /** The child's final reply, already capped, with the pointer to agent_read
   *  when it was cut. */
  summary?: string;
  /** Why a failed turn failed. */
  detail?: string;
};

/** Where the engine sends a report, and how it takes one back. */
export interface SettleReportSink {
  /** Send the report; the message id, or null when it could not be sent (a
   *  guard refused it, the parent is gone) and the result stays where
   *  agent_wait finds it. */
  deliver(report: SettledTurnReport): string | null;
  /** The parent collected the same result through agent_wait after all: take
   *  the report back if it has not been delivered yet. */
  retract(parentThreadId: string, messageId: string): void;
}

/** The report's text, as the parent reads it inside the message from its child. */
export function renderSettleReport(report: SettledTurnReport): string {
  const where = `thread ${report.childThreadId}, turn ${report.turnId}`;
  const reply = report.summary?.trim();
  const lines: string[] = [];
  if (report.status === "failed") {
    lines.push(`This turn failed (${where})${report.detail ? `: ${report.detail}` : "."}`);
    if (reply) lines.push("", "Its last reply:", "", reply);
  } else if (report.status === "interrupted") {
    lines.push(`This turn was interrupted before it finished (${where}).`);
    if (reply) lines.push("", "Its last reply:", "", reply);
  } else {
    lines.push(`This turn finished (${where}). Its final reply:`, "", reply || "(It ended without a reply.)");
  }
  lines.push(
    "",
    "kone sent this on because nobody was waiting for it. agent_wait on this thread returns the same result, so there is nothing left to wait for; ask it more with agent_followup.",
  );
  return lines.join("\n");
}

export interface MailboxReportSinkDeps {
  mailbox: IrcMailbox;
  store: IrcToolStore;
  /** Is the parent mid-turn? Only an interruption asks: see below. */
  isBusy?: (threadId: string) => boolean;
  /** Put kone's words in front of the parent's next turn without starting one. */
  queueNotice?: (threadId: string, text: string) => void;
}

/**
 * The sink the app runs on: reports go out through the agent mailbox.
 *
 * A finished or failed turn is news the parent has to act on, so it wakes an
 * idle parent. An interruption is not: somebody stopped the child, and when
 * that was the user, waking the parent invites it to start the work up again
 * over the user's head. So an interruption reaches a parent that is running,
 * and otherwise waits as a notice on its next turn.
 */
export function createMailboxReportSink(deps: MailboxReportSinkDeps): SettleReportSink {
  return {
    deliver(report) {
      const meta = deps.store.threadMeta?.(report.childThreadId);
      if (!meta) return null;
      const text = renderSettleReport(report);
      if (report.status === "interrupted" && deps.isBusy && !deps.isBusy(report.parentThreadId)) {
        const name = threadAgentName(deps.store, report.childThreadId);
        deps.queueNotice?.(report.parentThreadId, `From ${name}, who is working for you:\n${text}`);
        return null;
      }
      const lineage = deps.store.threadLineage?.(report.childThreadId);
      try {
        const sent = deps.mailbox.sendMessage(
          {
            threadId: report.childThreadId,
            projectPath: meta.projectPath,
            parentThreadId: report.parentThreadId,
            rootThreadId: lineage?.rootThreadId,
          },
          { to: report.parentThreadId, message: text, kind: "report" },
          deps.store,
        );
        return sent.messageId;
      } catch (err) {
        // A guard said no — most often the pair has traded too many messages.
        // Nothing is lost: the result is still what agent_wait returns.
        console.warn(`[agent] could not report ${report.childThreadId}'s settled turn:`, err);
        return null;
      }
    },
    retract(parentThreadId, messageId) {
      deps.mailbox.retract(parentThreadId, messageId);
    },
  };
}
