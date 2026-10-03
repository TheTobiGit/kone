# Delivering messages between agents

Status: proposed. Sections 1–9 are the design; §10 maps it onto the code;
§11 lists what has to be settled or tested before building; §12 is what
already shipped while this was being worked out.

Builds on `docs/agent-roles-design.md`, which fixes who may message whom.
This document is about how a message gets there.

## 0. Where it stands today

Five paths put words into another agent's thread, and each decides delivery on
its own:

| Path | Who uses it | How it decides | Where it waits |
|---|---|---|---|
| `agent_message`, courier reports | Agents, kone | Steer if the recipient is busy, wake it if idle, 400 ms batching (`ircDelivery.ts`) | In-memory mailbox |
| `agent_followup`, briefs | Agents | Always a normal send: queued behind a running turn (`spawnContinuation.ts`) | Durable turn queue |
| kone notices (`tell`) | kone | Steer if busy, else wake or hold, per call (`handOffLifecycle.ts`) | Steer / queue / in memory |
| `queueNotice` | kone | Always held for the next turn (`dispatch.ts`) | In memory |
| `app_send_to_thread` | The assistant | Queue, or steer when the caller passes `steer: true` | Durable turn queue |

What that costs:

- **The sender picks plumbing.** `agent_message` chooses a `kind`, `app_send_to_thread` chooses `steer`, kone chooses per call. None of them can see the recipient.
- **Agents send blind.** `agent_list` returns each peer's id, name, unread count and a running/away flag, nothing about what it is doing or whether a message can land.
- **Mail is lost on quit.** The mailbox and `pendingNotices` live in memory.
- **"Steer" means interrupt on four providers.** Cursor, Droid, Cline and Antigravity cannot take a message mid-turn, so `AgentService.steerTurn` queues it at the front and interrupts the running turn, mid-action if need be.
- **Bugs grow in the gaps.** A delivered message used to land below the reply it interrupted, because its path never named the block it carried (fixed in `f5fe93f`, §12).

## 1. One way in: `deliver()`

Every path above becomes a call to one function. The sender says what it is
sending and how much it matters; kone decides the mechanism.

```
deliver({
  to,                 // thread id
  text,               // what was said
  sender,             // user | agent (+ relationship) | system | courier
  urgency,            // "now" | "when-free"           (§5)
  blocking?,          // the sender is parked until this is answered (§5)
  replyTo?,           // the message this answers
}) → DeliveryResult   // what actually happened (§6)
```

What `deliver` does, by the recipient's state at that moment:

| Recipient | `now` | `when-free` |
|---|---|---|
| Working, provider steers natively | Steer into the running turn | Queue behind the running turn |
| Working, provider cannot steer | kone steer (§7) | Queue behind the running turn |
| Idle | Wake it with a turn | Wake it if the message needs a reply; otherwise hold it for its next turn |
| Waiting on the user (approval or question) | Hold until the user answers, then as `now`; the sender is told (§6) | Hold for its next turn |
| Starting or compacting | Hold until it can take a turn, then as `now` | Queue |
| Session closed | Restart it, then as idle | Hold for its next turn |
| Finished, withdrawn or failed | Refused, with what to do instead (follow up, ask someone else) | Same |

Every message is written to the recipient's transcript once, under its
sender, before it goes out, and every turn that carries it names its blocks
(§12), so it reads where it landed whatever the mechanism.

Everything waits in the durable turn queue (§9). Nothing lives only in memory.

## 2. Who is speaking

The sender's identity stays. It is what the receiver needs to weigh a message:

| Sender | Treat as |
|---|---|
| `user` | The authority |
| `agent` | Work handed down, information, or results, by relationship (`agent-roles-design.md` §4) |
| `system` | kone describing the situation, never an instruction |
| `courier` | kone carrying another agent's work |

The sender is set by kone, never chosen by the sender.

## 3. Messages and requests

Two things an agent sends, both through `deliver`:

- **A message** — "here is something; use it as you see fit". `agent_message`.
  No `kind` to pick: the reader can tell a question from a report by reading
  it. The one thing kone needs from the sender is whether a reply is wanted,
  because it decides whether an idle recipient is woken (§1). Proposal: keep
  `kind` optional and read `question` and `pushback` as "reply wanted", drop it
  from the required vocabulary and the tool description.
- **A request** — "do this and report back". `agent_followup` and the start
  tools. Tracked: it has a turn id, its result comes back on its own (courier
  report) or through `agent_wait`, and `agent_read` reads it at three depths.

They stay separate tools because a request carries bookkeeping a message does
not (the turn being waited on, the report to retract when it is collected).

## 4. Seeing the recipient

Agents see the state of the agents they can message before they send, in
`agent_list` and in every send's result:

| State | What it tells the sender |
|---|---|
| Working — on what, for how long | Busy: interrupt only if it is worth it |
| Idle, waiting for a reply | Waiting on you or someone else: just send |
| Waiting on the user | Nothing lands until the user acts, `now` included |
| Waiting on another agent | Stuck on someone else's answer |
| Starting / compacting | A message cannot go into its turn yet; it will shortly |
| Session closed | Sending restarts it, which costs a start-up |
| Finished / withdrawn / failed | Its work is over: follow up or ask someone else |

Plus, per recipient, whether `now` interrupts it: "Ada (Cursor): `now` waits
for her current step, then interrupts her turn" (§7).

Sources: `SpawnedThreadStatus` for threads the sender handed work to; the
service's live turn, parked asks and compaction state for any thread; the
latest tool item for "on what".

State can change between looking and sending. It informs the sender's choice
of urgency; delivery reads it again at send time and reports what happened.

## 5. Urgency, chosen by the sender

- **`when-free`** (the default) — "do not disturb your work for this". Queued
  behind a running turn; held for the next turn of an idle recipient unless a
  reply is wanted.
- **`now`** — "this needs to be seen right away, even if it disrupts you".
  Steered, kone-steered, or a wake.

Interrupting another agent is a deliberate choice, like a person deciding
whether to cut in.

**`blocking`** is separate: the sender parks until the answer comes back (what
`agent_message`'s `wait` does today). `now` + `blocking` is the fastest
round-trip the system has. A sender that is not blocked keeps working; the
answer reaches it like any message (shipped as guidance in `90bc2f6`, §8).

The user's own messages keep their composer behaviour (send queues, steer
steers); they are `when-free` and `now` under these names.

## 6. What a send reports back

The result says what actually happened, in words the sender can act on:

- "Delivered into Ada's running turn."
- "Queued: Ada is running the migration tests (4 min). She sees it when that turn ends."
- "Waiting: Ada is mid-edit on `auth.ts`; it lands as soon as that step finishes." (kone steer)
- "Held: Ada is waiting on the user's approval. Nothing reaches her until the user answers — ask the user if you need this sooner."
- "Delivered: Ada was idle and is answering now."

The waiting-on-the-user case matters most for `blocking` senders: sending
`now` does not help, and the sender should escalate rather than sit.

## 7. kone steer, for providers that cannot steer

On Cursor, Droid, Cline and Antigravity a `now` message cannot go into the
running turn. Instead of interrupting at once, kone waits for the gap between
two actions.

1. A `now` message arrives for a working thread whose adapter has no
   `steerTurn`.
2. No tool call in progress → interrupt now; at worst some streaming text is
   cut.
3. A tool call in progress → the message is marked as waiting ("lands after the
   current step") and held.
4. On that tool call's `item.completed`, interrupt.
5. The message goes in as the next turn, preceded by one line: "Your previous
   turn was interrupted only to deliver this. That task is not finished — take
   this into account and carry on with it."

`AgentService` already tracks each thread's open items (`openItems`, fed by
`item.started` / `item.completed`); only tool calls count here, text items do
not.

Edges:

| Case | Rule |
|---|---|
| A long tool call (a 10-minute test run) | From the user: after 30 s, show "waiting for Ada to finish running tests" with **Interrupt now**. From an agent: keep waiting |
| Parked on an approval | Do not interrupt: cancelling declines the approval (`drainApprovals`). Hold until it is answered |
| The model starts its next tool call between `item.completed` and the cancel | Milliseconds wide; the cancel catches the call as it starts |
| Antigravity print mode | Interrupts by killing the process tree (`killTree`). Whether the turn's finished work survives depends on what it had written. Treat as interrupt-at-once until tested (§11) |

## 8. Working while waiting

Handing work off never blocks, and results come back on their own: steered into
the agent's turn while it works, or as a wake once it stops. `90bc2f6` changed
the tool guidance to match: keep doing what does not depend on the result,
`agent_wait` only when the next step needs it, end the turn only when nothing
else is left.

Still to do:

- **Outstanding work, said once it matters.** A delivered result carries one
  line naming what is still out: "Still out: Ada (login UI), 1 worker."
- **kone steer** (§7) so a result arriving mid-work does not interrupt a turn on
  the four providers that cannot steer.

## 9. Durability and the queue

- The mailbox and pending notices move to the durable turn queue: a message is a
  row until its turn is accepted, and survives a quit.
- A queue row carries every block it delivers (`userBlockIds`), not just one.
  Today a batch that falls back to the queue in the second before a turn starts
  splits the reply at its last message only (§12).
- A queued agent message is not the user's. It does not appear as an editable
  row in the composer's queue strip with the raw `<agent_messages>` prompt as
  its text, as it does today on providers that cannot steer; it shows on the
  transcript as the sender's, marked as waiting.

## 10. Mapping onto the code

| Area | Today | Change |
|---|---|---|
| Delivery | `ircDelivery.ts`, `spawnContinuation.ts`, `handOffLifecycle.ts` `tell`, `dispatch.queueNotice`, `appThreads.ts` send | One `deliver` (new `delivery.ts`) over `dispatcher.sendThreadTurn` / `steerThreadTurn`; each path calls it |
| Mailbox | `IrcMailbox` in-memory maps | Rows in the turn queue, with sender, urgency and `userBlockIds` (migration) |
| Notices | `pendingNotices` map | Held rows, dispatched in front of the next turn as today |
| Steer fallback | `AgentService.steerTurn` queues + interrupts at once | kone steer: wait for open tool items, then interrupt; carry-on preamble |
| Recipient state | `agent_list`: id, name, unread, live | State, activity, steer capability (§4); every send's result (§6) |
| `agent_message` | `kind` required vocabulary, `wait` | `urgency`, `blocking`; `kind` optional |
| `app_send_to_thread` | `steer: boolean` | `urgency` |
| Queue strip | Every row shown as the user's | Rows with an agent or kone sender stay off it |

## 11. To settle or test before building

- **Do providers keep finished tool results when a turn is cancelled?** kone
  steer assumes the agent remembers the file it just read. Per provider
  (Cursor, Droid, Cline, Antigravity ACP and print): start a read, cancel right
  after `item.completed`, then ask "what did you just read?".
- **The user-facing wait cap** for kone steer: 30 s proposed.
- **`kind`**: optional with "reply wanted" read from it, or replaced by a
  `replyWanted` flag.
- **Defaults per relationship**: a worker's report to its parent is always
  `now`? A delegator's note to its delegate `when-free`?
- **Broadcasts** (`to: all`): always `when-free`?

## 12. Shipped while this was worked out

| Commit | What |
|---|---|
| `f5fe93f` | A delivered agent message names the blocks it carries, so a steer splits the reply where it landed, batch included, live and on reload. A queued agent message keeps its words and sender when its turn runs |
| `d4c5474` | `agent_read` reads at three depths: the final reply (default), the whole latest response with a line of what the agent did, or the transcript |
| `90bc2f6` | Hand-off tools and `agent_wait` tell agents to keep working while what they handed off runs |

Known gap left by `f5fe93f`: a batch that reaches a steer-capable provider in
the second before its turn starts falls back to the queue, whose row carries
one block id, so only the batch's last message moves (§9 fixes it).
