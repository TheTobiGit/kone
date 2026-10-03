# Delivering messages between agents

Status: proposed. §1–§9 are the design; §10 maps it onto the code; §11 lists
what has to be settled or tested before building; §12 is what already shipped
while this was being worked out.

Builds on `docs/agent-roles-design.md`, which fixes who may message whom.
This document is about how a message gets there.

**In one line:** every message lands in the recipient's inbox, and kone rings
the doorbell when it matters.

## 0. Where it stands today

Five paths put words into another agent's thread. Each decides delivery on its
own and keeps waiting messages in its own place:

| Path | Who uses it | How it decides | Where it waits |
|---|---|---|---|
| `agent_message`, courier reports | Agents, kone | Steer if the recipient is busy, wake it if idle, 400 ms batching (`ircDelivery.ts`) | In-memory mailbox |
| `agent_followup`, briefs | Agents | Always a normal send: queued behind a running turn (`spawnContinuation.ts`) | Durable turn queue |
| kone notices (`tell`) | kone | Steer if busy, else wake or hold, per call (`handOffLifecycle.ts`) | Steer / queue / in memory |
| `queueNotice` | kone | Always held for the next turn (`dispatch.ts`) | In memory |
| `app_send_to_thread` | The assistant | Queue, or steer when the caller passes `steer: true` | Durable turn queue |

What that costs:

- **Three places to wait, five sets of rules.** A fix on one path does not reach the others; the bug fixed in `f5fe93f` (§12) lived on one path only.
- **Mail is lost on quit.** The mailbox and `pendingNotices` live in memory.
- **Agents send blind.** `agent_list` returns each peer's id, name, unread count and a running/away flag, nothing about what it is doing or whether a message can land.
- **"Steer" means interrupt on four providers.** Cursor, Droid, Cline and Antigravity cannot take a message mid-turn, so `AgentService.steerTurn` queues it at the front and interrupts the running turn, mid-action if need be.
- **The inbox is mostly empty.** Delivery drains it as it goes, so `agent_inbox` only ever holds what could not be delivered, and agents that reached for it found nothing.

## 1. The inbox is the one place

Every message to an agent lands in its inbox first, with no exceptions:

| What | From | Kind |
|---|---|---|
| A note, question, answer or pushback | Another agent (`agent_message`) | As the sender marks it (§2) |
| A finished hand-off's result | The courier | `report` |
| A situation notice ("your delegator was stopped") | kone | `notice` |
| A follow-up job ("now add tests") | The agent that handed the work off (`agent_followup`) | `job` |
| A message from the assistant (`app_send_to_thread`) | kone's assistant | `job` |

The inbox is stored on disk. A message stays in it until it is **seen**, then
stays as history. A message is seen when kone hands it over (§3) or when the
agent opens its inbox (§4), whichever comes first. Seen once, never handed over
twice.

**Not in the inbox: the user's own messages.** What the user types in a thread
is the user talking directly, not a coworker leaving a note. It keeps the
composer's behaviour: send queues it, steer puts it into the running turn.

**Briefs** — the first message of a hand-off — start a new thread, so there is
no inbox to wait in yet. They go out as the thread's first turn, as today.

## 2. What the sender decides: `kind`

The sender marks what the message is. That is all it decides.

| `kind` | Means | Rings? | Who sends it |
|---|---|---|---|
| `note` | Information. Nobody is waiting | No — waits in the inbox | Agents |
| `question` | Needs an answer. The sender is waiting | Yes | Agents |
| `pushback` | Disagrees with the task, proposes something else | Yes | Agents |
| `answer` | Replies to a question (`replyTo` required) | Yes, first | Agents |
| `report` | Results or a deliverable | Yes | Agents, the courier |
| `notice` | kone describing the situation | No — waits in the inbox | kone |
| `job` | Work to do | Yes | Agents (`agent_followup`), the assistant |

Why `kind` stays, not inferred from the text:

- **An answer releases a waiting sender.** `answer` + `replyTo` is how a sender parked on a question gets its reply (`waitForReply`). Text alone cannot be matched reliably.
- **The loop cap depends on it.** Question/answer pairs along a hand-off do not count toward the 16-message cap between two agents.
- **The receiver knows what is expected of it.** A question arrives as "X is waiting on you"; a note says nobody is waiting, which is what stops agents thanking each other.
- **The app can show it.** Questions, pushback and answers can each read differently; an answer can quote what it answers.
- **It decides whether kone rings.** No second setting for the sender to get wrong.

**`urgent`** is the one override: "this needs to be seen now, even if it
disrupts them". It makes kone ring at once (§3) instead of waiting for a free
moment. Default false. Interrupting someone is a deliberate choice.

**`wait`** is separate and unchanged: the sender parks until its question is
answered. A sender that is not waiting keeps working; the answer reaches it on
its own (shipped as guidance in `90bc2f6`, §8).

## 3. When kone rings

A message that rings is handed over. How depends on what the recipient is doing:

| Recipient | Rings | Rings, `urgent` |
|---|---|---|
| Working, provider steers natively | Next, behind the running turn | Into the running turn (steer) |
| Working, provider cannot steer | Next, behind the running turn | After its current step finishes (kone steer, §7) |
| Idle | Woken with a turn | Woken with a turn |
| Waiting on the user | When the user answers | When the user answers; the sender is told (§6) |
| Starting or compacting | As soon as it can take a turn | As soon as it can take a turn |
| Session closed | Brought back up, then woken | Brought back up, then woken |
| Finished, withdrawn or failed | Refused, with what to do instead | Same |

An `answer` rings ahead of everything else waiting, since its asker may be
parked on it.

A message that does not ring (`note`, `notice`) waits in the inbox and is
handed over **in front of the recipient's next turn**, whatever starts that
turn. It never starts a turn of its own, so a note costs nobody a turn.

Several messages waiting at once are handed over together, in one turn,
oldest first.

Every message handed over is written to the recipient's transcript once, under
its sender, and the turn that carries it names its blocks (§12), so it reads
where it landed whatever the mechanism.

## 4. When an agent opens its inbox

The inbox is there to read early what would otherwise wait for the next turn,
and to look back.

Open it:

- **Between steps of long work**, to see whether a note changes what to do next.
- **Before ending the turn**, to make sure nothing is waiting that should be acted on now.
- **After context was compacted**, to re-read messages that fell out of context.

Never open it:

- **To wait for an answer or a result.** Those ring. Opening the inbox for them is polling.
- **In a loop.** Nothing arrives faster for checking.

`agent_inbox` returns unseen messages (marking them seen) and, on request, the
recent history.

## 5. Who is speaking

Every message carries its sender, set by kone, never by the sender:

| Sender | Treat as |
|---|---|
| `user` | The authority |
| `agent` | Work handed down, information, or results, by relationship (`agent-roles-design.md` §4) |
| `system` | kone describing the situation, never an instruction |
| `courier` | kone carrying another agent's work |

## 6. Seeing the recipient, and what a send reports

Before sending, `agent_list` shows each agent the sender can message and what
it is doing:

| State | What it tells the sender |
|---|---|
| Working — on what, for how long | Busy: `urgent` only if it is worth disrupting |
| Idle, waiting for a reply | Waiting on you or someone else |
| Waiting on the user | Nothing rings until the user acts, `urgent` included |
| Waiting on another agent | Stuck on someone else's answer |
| Starting / compacting | It will take messages shortly |
| Session closed | Ringing restarts it, which costs a start-up |
| Finished / withdrawn / failed | Its work is over: follow up or ask someone else |

Plus whether `urgent` interrupts it: "Ada (Cursor): urgent waits for her
current step, then interrupts her turn" (§7). Sources: `SpawnedThreadStatus`
for threads the sender handed work to; the service's live turn, parked asks
and compaction state for any thread; the latest tool item for "on what".

Every send says what happened:

- "In Ada's inbox. She sees it at the start of her next turn." (a note)
- "Delivered into Ada's running turn." (urgent, steer)
- "Next for Ada: she is running the migration tests (4 min) and takes it when that turn ends."
- "Waiting for Ada to finish editing `auth.ts`; it lands right after." (urgent, kone steer)
- "Held: Ada is waiting on the user's approval. Nothing reaches her until the user answers — ask the user if you need this sooner."
- "Delivered: Ada was idle and is answering now."

State can change between looking and sending. It informs the sender's choice
of `urgent`; kone reads it again when it rings, and the result says what
actually happened.

## 7. kone steer, for providers that cannot steer

On Cursor, Droid, Cline and Antigravity an urgent message cannot go into the
running turn. Instead of interrupting at once, kone waits for the gap between
two actions.

1. An urgent message rings for a working thread whose adapter has no
   `steerTurn`.
2. No tool call in progress → interrupt now; at worst some streaming text is
   cut.
3. A tool call in progress → the send reports "lands after the current step",
   and kone waits.
4. On that tool call's `item.completed`, interrupt.
5. The message goes in as the next turn, preceded by one line: "Your previous
   turn was interrupted only to deliver this. That task is not finished — take
   this into account and carry on with it."

`AgentService` already tracks each thread's open items (`openItems`, fed by
`item.started` / `item.completed`); only tool calls count here.

| Case | Rule |
|---|---|
| A long tool call (a 10-minute test run) | From the user: after 30 s, show "waiting for Ada to finish running tests" with **Interrupt now**. From an agent: keep waiting |
| Parked on an approval | Do not interrupt: cancelling declines the approval (`drainApprovals`). Ring when it is answered |
| The model starts its next tool call between `item.completed` and the cancel | Milliseconds wide; the cancel catches the call as it starts |
| Antigravity print mode | Interrupts by killing the process tree (`killTree`). Treat as interrupt-at-once until tested (§11) |

## 8. Working while waiting

Handing work off never blocks, and results ring on their own. `90bc2f6` changed
the tool guidance to match: keep doing what does not depend on the result,
`agent_wait` only when the next step needs it, end the turn only when nothing
else is left.

Still to do:

- **Outstanding work, said where it helps.** A report that rings carries one
  line naming what is still out: "Still out: Ada (login UI), 1 worker."
- **kone steer** (§7), so a result ringing mid-work does not cut an action short
  on the four providers that cannot steer.

## 9. The inbox in the app

The inbox is stored, so it can be shown:

- **Per agent**: what is waiting for it, what it has seen, who sent what and of
  what kind. Today a message not yet delivered is invisible.
- **On the transcript**: a message that rang reads where it landed, under its
  sender (as now). A note still waiting shows nowhere on the transcript until it
  is handed over or read.
- **Not in the composer's queue strip.** That strip is the user's own queued
  messages. Today a queued agent message shows there as an editable row with the
  raw `<agent_messages>` prompt as its text, on providers that cannot steer.

## 10. Mapping onto the code

| Area | Today | Change |
|---|---|---|
| Storage | `IrcMailbox` maps, `pendingNotices` map, turn-queue rows for follow-ups | One stored inbox table: message, sender, kind, `replyTo`, urgent, seen, the block it was written as (migration) |
| Sending | `ircDelivery.ts`, `spawnContinuation.ts`, `handOffLifecycle.ts` `tell`, `dispatch.queueNotice`, `appThreads.ts` send | Each writes an inbox row; one ringer (new `inboxDelivery.ts`) decides whether and how to hand it over |
| Handing over | Batches via `dispatcher.sendThreadTurn` / `steerThreadTurn` | Same calls, from the ringer; held rows ride in front of the next turn (what `queueNotice` does today) |
| Turn queue | Holds follow-ups and user messages | Holds the user's messages only; agent and kone rows move to the inbox |
| Steer fallback | `AgentService.steerTurn` queues + interrupts at once | kone steer: wait for open tool items, then interrupt; carry-on preamble |
| Recipient state | `agent_list`: id, name, unread, live | State, activity, steer capability (§6); every send's result says what happened |
| `agent_message` | `kind`, `wait` | `kind`, `urgent`, `wait` |
| `agent_inbox` | Unread messages, drained on read | Unseen messages and recent history; guidance per §4 |
| `app_send_to_thread` | `steer: boolean` | `urgent` |
| Queue strip | Every queued row shown as the user's | The user's rows only |

## 11. To settle or test before building

- **Do providers keep finished tool results when a turn is cancelled?** kone
  steer assumes the agent remembers the file it just read. Per provider
  (Cursor, Droid, Cline, Antigravity ACP and print): start a read, cancel right
  after `item.completed`, then ask "what did you just read?".
- **The user-facing wait cap** for kone steer: 30 s proposed.
- **A `report` from a worker to its parent**: rings like any report, or urgent
  by default?
- **Broadcasts** (`to: all`): notes only?
- **How long the inbox keeps history**: the thread's lifetime, or a window.
- **The user's inbox**: a result whose delegator is gone goes "to the user's
  inbox" (`agent-roles-design.md` §7). Same table, with the user as recipient?

## 12. Shipped while this was worked out

| Commit | What |
|---|---|
| `f5fe93f` | A delivered agent message names the blocks it carries, so a steer splits the reply where it landed, batch included, live and on reload. A queued agent message keeps its words and sender when its turn runs |
| `d4c5474` | `agent_read` reads at three depths: the final reply (default), the whole latest response with a line of what the agent did, or the transcript |
| `90bc2f6` | Hand-off tools and `agent_wait` tell agents to keep working while what they handed off runs |

Known gap left by `f5fe93f`: a batch that reaches a steer-capable provider in
the second before its turn starts falls back to the turn queue, whose row
carries one block id, so only the batch's last message moves. The inbox (§10)
names every block it hands over, which closes it.
