// A hand-off's result, delivered to whoever handed the work off.
//
// The result of a hand-off used to be pull-only: a delegator saw it if it was
// sitting in agent_wait when the delegate settled, or if it thought to wait
// later. One that had already ended its turn heard nothing, while the delegate
// — told its final reply goes back to the delegator — wrote that reply and
// sent nothing else. The report sat in the delegate's thread, read by the user
// and never by the agent it was for.
//
// So a settled turn nobody collected is carried to the parent by the courier,
// kone's own agent, kind "report", through the same mailbox agent_message
// uses: it steers the parent's running turn or wakes it idle, and lands on its
// transcript in kone's name. kone wrote the message, so kone signs it; the
// child's reply is the quoted payload, with the child's name and thread beside
// it so the parent knows whose work it is and where to follow it up. When to
// send is the spawn engine's call (it knows who is waiting); this module is
// what gets sent and how.

import type { CourierSender } from "@kone/protocol/message-sender";
import { relationshipOf, type IrcMailbox, type IrcToolStore } from "./gateway/tools/irc.js";
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

/** A reply set off as a quotation, so the words the child wrote read apart
 *  from the words kone wrote around them. */
function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

/** The report's text, as kone writes it: who worked, how the turn ended, and
 *  the child's reply quoted underneath. `childName` is the name the parent
 *  knows the child by. */
export function renderSettleReport(report: SettledTurnReport, childName: string): string {
  const where = `thread ${report.childThreadId}, turn ${report.turnId}`;
  const reply = report.summary?.trim();
  const lines: string[] = [];
  if (report.status === "failed") {
    lines.push(`${childName}'s turn failed (${where})${report.detail ? `: ${report.detail}` : "."}`);
    if (reply) lines.push("", "Its last reply:", "", quote(reply));
  } else if (report.status === "interrupted") {
    lines.push(`${childName}'s turn was interrupted before it finished (${where}).`);
    if (reply) lines.push("", "Its last reply:", "", quote(reply));
  } else {
    lines.push(`${childName} finished the work you handed it (${where}). Its final reply:`, "", reply ? quote(reply) : "(It ended without a reply.)");
  }
  lines.push(
    "",
    `Nobody was waiting for this result, so kone carried it to you. agent_wait on thread ${report.childThreadId} returns the same result, so there is nothing left to wait for; ask ${childName} more with agent_followup on that thread.`,
  );
  return lines.join("\n");
}

/** The courier's sender for a report on a child's work: kone speaking, about
 *  the child, as the child relates to the parent receiving it. */
export function courierReportSender(store: IrcToolStore, report: SettledTurnReport): CourierSender {
  const about: NonNullable<CourierSender["about"]> = {
    threadId: report.childThreadId,
    name: threadAgentName(store, report.childThreadId),
    relationship: relationshipOf(store, report.childThreadId, report.parentThreadId),
  };
  const agentId = store.getThreadAgent?.(report.childThreadId)?.agentId;
  if (agentId) about.agentId = agentId;
  return { kind: "courier", messageKind: "report", about };
}

export interface MailboxReportSinkDeps {
  mailbox: IrcMailbox;
  store: IrcToolStore;
  /** Is the parent mid-turn? Only an interruption asks: see below. */
  isBusy?: (threadId: string) => boolean;
}

/**
 * The sink the app runs on: reports go out through the agent mailbox.
 *
 * A finished or failed turn is news the parent has to act on, so it wakes an
 * idle parent. An interruption is not: somebody stopped the child, and when
 * that was the user, waking the parent invites it to start the work up again
 * over the user's head. So an interruption reaches a parent that is running,
 * and otherwise is held in its inbox for its next turn. Held or not, it is
 * the same stored report, retractable until it is seen.
 */
export function createMailboxReportSink(deps: MailboxReportSinkDeps): SettleReportSink {
  return {
    deliver(report) {
      const meta = deps.store.threadMeta?.(report.childThreadId);
      if (!meta) return null;
      const sender = courierReportSender(deps.store, report);
      const text = renderSettleReport(report, sender.about?.name ?? report.childThreadId);
      const rings = !(report.status === "interrupted" && deps.isBusy && !deps.isBusy(report.parentThreadId));
      try {
        const sent = deps.mailbox.sendCourierMessage({
          to: report.parentThreadId,
          projectPath: meta.projectPath,
          message: text,
          kind: "report",
          sender,
          // One report per settled turn: the same turn reported again is
          // already in the parent's inbox.
          dedupeKey: `report:${report.childThreadId}:${report.turnId}`,
          rings,
        });
        return sent?.messageId ?? null;
      } catch (err) {
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
