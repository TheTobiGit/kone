# Delivering messages between agents

Status: being built. §1–§9 are the design; §10 maps it onto the code; §11
records the decisions that were open; §12 is the build plan, phase by phase;
§13 is what already shipped while this was being worked out.

Builds on `docs/agent-roles-design.md`, which fixes who may message whom.
This document is about how a message gets there.

**In one line:** every message lands in the recipient's inbox, and kone rings
the doorbell when it matters.

## 0. Where it stands today

Six paths put words into another agent's thread. Each decides delivery on its
own and keeps waiting messages in its own place:

| Path | Who uses it | How it decides | Where it waits |
|---|---|---|---|
| `agent_message`, courier reports | Agents, kone | Steer if the recipient is busy, wake it if idle, 400 ms batching, at most 8 per delivery (`ircDelivery.ts`) | In-memory mailbox, 50 per inbox, oldest dropped |
| Courier report of an interrupted child, parent idle | kone | Held for the parent's next turn (`settleReports.ts` → `queueNotice`) | In memory |
| `agent_followup` | Agents | Always a normal send: queued behind a running turn (`spawnContinuation.ts`) | Durable turn queue |
| kone notices (`tell`) | kone | Steer if busy, else wake or hold, by a per-call `wake` flag (`handOffLifecycle.ts`) | Steer / queue / in memory |
| `queueNotice` | kone | Always held for the next turn, but written to the transcript at once (`dispatch.ts`) | In memory |
| `app_send_to_thread` | The assistant | Sent as a peer's note. Queue, or steer when the caller passes `steer: true`. Refused while the thread waits on the user | Durable turn queue |

A courier report can also be taken back: when the parent collects the same
result through `agent_wait` before the report is read, it is retracted.

The turn queue is not only the user's either. Besides follow-ups and the
user's messages it holds agent-message batches whose steer fell back to the
queue, and any send that lands while another is still being handed to the
adapter. And a message reaches the transcript at two different moments: a
mailbox message when it is delivered, a queued notice the moment it is queued.

What that costs:

- **Three places to wait, six sets of rules.** A fix on one path does not reach the others; the bug fixed in `f5fe93f` (§13) lived on one path only.
- **Mail is lost on quit, and dropped when it piles up.** The mailbox and `pendingNotices` live in memory, and the mailbox drops the oldest unread message past 50.
- **Messages decline the user's approvals.** On a provider that cannot steer, `AgentService.steerTurn` queues the message and interrupts the running turn. Droid's and Cline's `interruptTurn` declines every pending approval first. So a message, a courier report or a `tell` reaching a thread parked on the user's approval cancels that approval. Phase 0 (§12) fixes this.
- **Agents send blind.** `agent_list` lists only the threads the mailbox has seen send a message since the app started, with an unread count and a running/away flag. Nothing about what a peer is doing or whether a message can land.
- **"Steer" means interrupt on four providers.** Cursor, Droid, Cline and Antigravity cannot take a message mid-turn, so `steerTurn` interrupts the running turn, mid-action if need be. `tell` steers even its quiet notices, so those interrupt too.
- **A follow-up to a busy agent loses its handle.** `agent_followup` returns the turn id `agent_wait` pins to, but a send that lands on a busy thread returns the queue row's id, which never matches a turn.
- **The inbox is mostly empty.** Delivery drains it as it goes, so `agent_inbox` only ever holds what could not be delivered, and agents that reached for it found nothing.

**Not messages, and staying that way.** Some turns are kone driving a
thread's own work rather than someone writing to it: a hand-off's brief
(`spawnFailover.ts`), the decision turn after a stop, the wake when background
subagents finish late (`subagentWake.ts`), the continuation after a quit
(`quitResume.ts`), and a bench job's opening turn (`jobRunner.ts`), which is
the user's own words on a thread of its own. They stay outside the inbox.
The bench's jobs and the inbox's `job` kind share a word and nothing else.

## 1. The inbox is the one place

Every message one agent or kone sends to another lands in its inbox first:

| What | From | Kind |
|---|---|---|
| A note, question, answer or pushback | Another agent (`agent_message`) | As the sender marks it (§2) |
| A finished hand-off's result | The courier | `report` |
| A situation notice ("your delegator was stopped") | kone | `notice` |
| A follow-up job ("now add tests") | The agent that handed the work off (`agent_followup`) | `job` |
| A message from the assistant (`app_send_to_thread`) | kone's assistant | `job` |

`job` is new: today `app_send_to_thread` arrives as a peer's note, and
`agent_followup` as a plain turn. A `job` is handed over as a turn of its own,
never batched with another job.
Its inbox id is the handle the sender gets back, and `agent_wait` resolves it
to the turn that carried it.

The inbox is stored on disk. Each message moves through these states:

| State | Means |
|---|---|
| Unseen | Waiting in the inbox |
| Being handed over | Claimed by one hand-over, which is on its way to the provider |
| Seen | Handed over in a turn, read with `agent_inbox`, or returned to a sender parked on it (`wait`) |
| Retracted | Taken back while unseen (a courier report whose result was collected with `agent_wait`) |

A hand-over claims its messages before it sends. When the provider accepts
the turn they become seen, with the turn that carried them. When the send
fails they go back to unseen. A message is written to the transcript once:
a retry carries the block it was already written as. After a crash, anything
still being handed over goes back to unseen. Seen once, never handed over
twice. Seen messages stay as history.

**Not in the inbox: the user's own messages.** What the user types in a thread
is the user talking directly, not a coworker leaving a note. It keeps the
composer's behaviour: send queues it, steer puts it into the running turn.

**Briefs** — the first message of a hand-off — start a new thread, so there is
no inbox to wait in yet. They go out as the thread's first turn, as today.

## 2. What the sender decides: `kind`

The sender marks what the message is. For an agent, that and `urgent` are
all it decides.

| `kind` | Means | Rings? | Who sends it |
|---|---|---|---|
| `note` | Information. Nobody is waiting | No — waits in the inbox | Agents |
| `question` | Needs an answer. The sender is waiting | Yes | Agents |
| `pushback` | Disagrees with the task, proposes something else | Yes | Agents |
| `answer` | Replies to a question (`replyTo` required) | Yes, first | Agents |
| `report` | Results or a deliverable | Yes | Agents, the courier |
| `notice` | kone describing the situation | Only when kone marks it | kone |
| `job` | Work to do | Yes | Agents (`agent_followup`), the assistant |

kone marks its own notices: a withdrawal rings ("stop here"); "the user spoke
to Ada directly" waits for the next turn.

Why `kind` stays, not inferred from the text:

- **An answer releases a waiting sender.** `answer` + `replyTo` is how a sender parked on a question gets its reply (`waitForReply`). Text alone cannot be matched reliably.
- **The loop cap depends on it.** Question/answer pairs along a hand-off do not count toward the 16-message cap between two agents.
- **The receiver knows what is expected of it.** A question arrives as "X is waiting on you"; a note says nobody is waiting, which is what stops agents thanking each other.
- **The app can show it.** Questions, pushback and answers can each read differently; an answer can quote what it answers.
- **It decides whether kone rings.** No second setting for the sender to get wrong.

An `answer` whose `replyTo` is not a question sent to the answerer is
delivered as a `note`.

**`urgent`** is the one override: "this needs to be seen now, even if it
disrupts them". It makes kone ring at once (§3) instead of waiting for a free
moment. Default false. Interrupting someone is a deliberate choice, so it is
limited:

- Only along a hand-off (either direction) or from the main agent. Peers cannot send `urgent`.
- Never from a worker. A worker puts it in its final reply.
- Never on a broadcast.

**`wait`** is separate and unchanged: the sender parks until its question is
answered. A sender that is not waiting keeps working; the answer reaches it on
its own (shipped as guidance in `90bc2f6`, §8). An answer to a parked sender
is returned to its wait directly and never rings. A `wait` question to an
agent that is itself parked waiting on the sender is refused: "Ada is already
waiting on you — answer her first."

**Broadcasts** (`to: all`, main agent only) are notes. They never ring and
never bring a closed session back up.

## 3. When kone rings

A message that rings is handed over. How depends on what the recipient is doing:

| Recipient | Rings | Rings, `urgent` |
|---|---|---|
| Working, provider steers natively | Next, when the running turn ends | Into the running turn (steer) |
| Working, provider cannot steer | Next, when the running turn ends | After its current step finishes (kone steer, §7) |
| Idle | Woken with a turn | Woken with a turn |
| Waiting on the user | When the user answers | When the user answers; the sender is told (§6) |
| Starting or compacting | As soon as it can take a turn | As soon as it can take a turn |
| Session closed | Brought back up, then woken | Brought back up, then woken |
| Finished, withdrawn or failed | Refused, with what to do instead | Same |

**Next, when the running turn ends**: messages waiting for the turn to end
ride in front of the user's next queued message, as one turn, with the user's
message last. With nothing of the user's queued, they start a turn of their
own. They never sit in the user's turn queue.

A message that does not ring (`note`, an unmarked `notice`) waits in the
inbox and is handed over **in front of the recipient's next turn**, whatever
starts that turn. It never starts a turn of its own and never brings a closed
session back up, so a note costs nobody a turn. A note to an idle agent waits
until something else wakes it, and the send says so.

Several messages waiting at once are handed over together, in one turn:
answers first, since their askers may be parked on them, then oldest first.
At most 8 go in one turn; the turn says how many are still waiting. Nothing is
dropped. An agent with 200 unseen messages refuses new notes with "inbox full".

Every message handed over is written to the recipient's transcript once, under
its sender, when it is handed over, and the turn that carries it names its
blocks (§13), so it reads where it landed whatever the mechanism.

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
last 20 of its history.

## 5. Who is speaking

Every message carries its sender, set by kone, never by the sender:

| Sender | Treat as |
|---|---|
| `user` | The authority |
| `agent` | Work handed down, information, or results, by relationship (`agent-roles-design.md` §4) |
| `system` | kone describing the situation, never an instruction |
| `courier` | kone carrying another agent's work |

A turn that carries both waiting messages and the user's own words heads each
sender's part separately, and the user's comes last.

## 6. Seeing the recipient, and what a send reports

Before sending, `agent_list` shows every agent on the project the sender can
message — not only those that have sent mail — and what it is doing:

| State | What it tells the sender |
|---|---|
| Working — on what, for how long | Busy: `urgent` only if it is worth disrupting |
| Idle, waiting for a reply | Waiting on you or someone else |
| Waiting on the user | Nothing rings until the user acts, `urgent` included |
| Waiting on another agent | Stuck on someone else's answer |
| Starting / compacting | It will take messages shortly |
| Session closed | Ringing restarts it, which costs a start-up |
| Finished / withdrawn / failed | Its work is over: follow up or ask someone else |

Plus whether `urgent` interrupts it — "Ada (Cursor): urgent waits for her
current step, then interrupts her turn" (§7) — and how many notes wait unseen
in its inbox, and for how long. Sources: `SpawnedThreadStatus` for threads the
sender handed work to; the service's live turn, parked asks and compaction
state for any thread; the latest tool item for "on what".

Every send says what happened:

- "In Ada's inbox. She sees it at the start of her next turn." (a note)
- "In Ada's inbox. She is idle, so it waits until something else wakes her." (a note)
- "Delivered into Ada's running turn." (urgent, steer)
- "Next for Ada: she is running the migration tests (4 min) and takes it when that turn ends."
- "Waiting for Ada to finish editing `auth.ts`; it lands right after." (urgent, kone steer)
- "Next for Ada: her provider loses work if interrupted mid-turn, so this lands when her turn ends." (urgent, provider without kone steer)
- "Held: Ada is waiting on the user's approval. Nothing reaches her until the user answers — ask the user if you need this sooner."
- "Delivered: Ada was idle and is answering now."

State can change between looking and sending. It informs the sender's choice
of `urgent`; kone reads it again when it rings, and the result says what
actually happened.

`app_send_to_thread` follows the same rules. A thread waiting on the user is
held, not refused as before.

## 7. kone steer, for providers that cannot steer

On Cursor, Droid, Cline and Antigravity an urgent message cannot go into the
running turn. Instead of interrupting at once, kone waits for the gap between
two actions.

1. An urgent message rings for a working thread whose adapter has no
   `steerTurn`, and whose provider passed the cancel probe (§11).
2. Parked on the user's approval or answer → hold, whatever else is running.
   Ring when the user answers.
3. No tool call in progress → interrupt now; at worst some streaming text is
   cut.
4. A tool call in progress → the send reports "lands after the current step",
   and kone waits.
5. On that tool call's `item.completed`, interrupt.
6. The message goes in as the next turn, preceded by one line: "Your previous
   turn was interrupted only to deliver this. That task is not finished — take
   this into account and carry on with it."

A provider that has not passed the probe gets no kone steer: urgent rings when
the turn ends, and the send says why.

`AgentService` tracks each thread's open items (`openItems`, fed by
`item.started` / `item.completed`), but by id only, for every kind of item:
streaming text and reasoning as well as tool calls. Only tool calls count
here, so kone steer needs a tracker that keeps each open item's kind.

| Case | Rule |
|---|---|
| A long tool call (a 10-minute test run) | From the user: after 30 s, show "waiting for Ada to finish running tests" with **Interrupt now**. From an agent: keep waiting |
| Parked on an approval | Do not interrupt: cancelling declines the approval (`drainApprovals`). Ring when it is answered |
| The model starts its next tool call between `item.completed` and the cancel | Milliseconds wide; the cancel catches the call as it starts |
| Antigravity print mode | Interrupts by killing the process tree (`killTree`). No kone steer until it passes the probe |

## 8. Working while waiting

Handing work off never blocks, and results ring on their own. `90bc2f6` changed
the tool guidance to match: keep doing what does not depend on the result,
`agent_wait` only when the next step needs it, end the turn only when nothing
else is left.

Still to do:

- **Outstanding work, said where it helps.** A report that rings carries one
  line naming what is still out: "Still out: Ada (login UI), 1 worker."
- **kone steer** (§7), so an urgent result does not cut an action short on the
  four providers that cannot steer.

## 9. The inbox in the app

The inbox is stored, so it can be shown:

- **Per agent**: what is waiting for it, what it has seen, who sent what and of
  what kind. Today a message not yet delivered is invisible.
- **On the transcript**: a message that rang reads where it landed, under its
  sender (as now). A note or notice still waiting shows nowhere on the
  transcript until it is handed over or read. This changes kone's notices,
  which today are written to the transcript the moment they are queued.
- **Not in the composer's queue strip.** That strip is the user's own queued
  messages. Today a queued agent message shows there as an editable row with the
  raw `<agent_messages>` prompt as its text, on providers that cannot steer.

## 10. Mapping onto the code

| Area | Today | Change |
|---|---|---|
| Storage | `IrcMailbox` maps, `pendingNotices` map, turn-queue rows for follow-ups | One stored inbox table, `agent_inbox` (migration 22): recipient, sender, kind, urgent, `replyTo`, body, state, the hand-over claim, the block it was written as, the turn that carried it, a dedupe key |
| Sending | `ircDelivery.ts`, `settleReports.ts`, `spawnContinuation.ts`, `handOffLifecycle.ts` `tell`, `dispatch.queueNotice`, `appThreads.ts` send | Each writes an inbox row; one ringer (new `inboxDelivery.ts`) decides whether and how to hand it over |
| Handing over | Batches via `dispatcher.sendThreadTurn` / `steerThreadTurn`, read and drained in memory | Same calls, from the ringer; claimed before the send, seen once the provider accepts |
| Turn slot | The queue drain and delivery race for an idle thread | `AgentService.drainQueuedTurns` asks the inbox for waiting messages when the slot frees: they ride in front of the user's queued row, or start a turn of their own |
| Turn queue | Holds follow-ups, user messages, agent-message batches whose steer fell back, and sends that raced another being handed over | Holds the user's messages only; agent and kone rows move to the inbox |
| Steer fallback | `AgentService.steerTurn` queues + interrupts at once, even while parked | Never interrupts while parked (Phase 0); then kone steer: wait for open tool items, then interrupt; carry-on preamble |
| Steer capability | Private: `adapterForThread` is internal and `steerTurn` optional on the adapter | An `AgentService` accessor saying how a thread's provider takes an urgent message |
| Recipient state | `agent_list`: threads the mailbox has seen, unread, live | Every agent on the project from the store; state, activity, steer capability, unseen notes (§6); every send's result says what happened |
| `agent_message` | `kind`, `wait` | `kind`, `urgent`, `wait` |
| `agent_followup` | Returns a turn id, or a queue id when the child is busy | Returns the job's inbox id, which `agent_wait` resolves to its turn |
| `agent_inbox` | Unread messages, drained on read | Unseen messages and recent history; guidance per §4 |
| `app_send_to_thread` | `steer: boolean`; refuses a thread waiting on the user | `urgent` (`steer` kept as an alias); held while the thread waits on the user |
| Queue strip | Every queued row shown as the user's | The user's rows only |

Rules that carry over unchanged into the inbox and the ringer:

- The 16-message cap between two agents, with hand-off question/answer pairs exempt.
- Workers speak only to their parent, with `report` or `question`.
- Only the main agent may message `all`.
- Each recipient's copy is headed with how the sender relates to it.
- A retried `agent_followup` or `app_send_to_thread` with the same request id sends nothing twice.
- Held messages ride in the same preamble as the transcript replay for a session that came up blank.
- The decision turn keeps following its queue row to the turn it becomes.

## 11. Decisions

| Question | Decision |
|---|---|
| Do providers keep finished tool results when a turn is cancelled? | Tested per provider by a cancel probe (below). A provider that fails gets no kone steer: urgent rings when the turn ends, and the send says why. The user's **Interrupt now** stays |
| The user-facing wait cap for kone steer | 30 s, then **Interrupt now** is offered, never taken on its own. A message from an agent has no cap; the send says what it waits for |
| A `report` from a worker to its parent | Rings like any report. Never urgent: workers cannot send `urgent` |
| Broadcasts (`to: all`) | Notes only: no `urgent`, no questions, never brings a closed session back up |
| How long the inbox keeps history | The thread's lifetime. Rows go when the thread is deleted. `agent_inbox` shows the last 20 |
| The user's inbox | Not in this table. A delegator cannot disappear mid-work (`agent-roles-design.md` §13), so nothing sends there. If it is ever needed it is the app's own inbox, not an agent's |

**The cancel probe.** A development script drives the real adapters through
`AgentService`, five runs per provider: Cursor, Droid, Cline, Antigravity ACP
and Antigravity print. Each run writes a file holding a random word, asks the
agent to read the file with its file tool and then run `sleep 60`, and cancels
the turn on the read's `item.completed`. Then it asks, without tools: "What
word was in the file you just read?" A provider passes when all five runs
answer correctly, and again after the session is closed and resumed. The
result is recorded as a provider capability that kone steer checks.

**Probe results** (`scripts/cancelProbe.ts` as of `6f7c83c5`; 5 live and 5
resume runs per provider). The file is deleted before the cancel, so a correct
answer can only come from the conversation. A run counts only when the
interrupt was accepted and the turn ended as `turn.aborted`; every run here
did. Resume runs close and reopen the session after the cancel and ask for the
nonce for the first time, so no earlier answer carries it. No answer called a
tool.

| Provider | Model | Live | After resume | `cancelKeepsCompletedTools` |
|---|---|---|---|---|
| Cursor | `gpt-5.4-mini` (and `composer-2.5`, 2 runs) | Fail, 0/5 | Fail, 0/5 | false |
| Cline | `cline-free/deepseek-v4.1-flash` | Pass, 5/5 | Fail, 0/5 | true |
| Antigravity print | Gemini 3.8 Flash, low | Fail, 4/5 | Pass, 5/5 | false |
| Antigravity ACP | — | Not run: the ACP server is not installed on the probe machine | — | false |
| Droid | — | Not run: disabled in the user's provider settings | — | false |

- Cursor: kone sees the read finish with the nonce in its result, but the
  model is told the call was interrupted. Asked next turn, it says the read
  never returned. A different model fails the same way.
- Cline's resume failure is not about the cancel. A control run with no
  cancel (`PROBE_CONTROL=1`) fails the same way: the resumed session's turn
  starts and completes with no output at all. That is a resume bug of its own,
  so Cline is judged on the live runs.
- Antigravity print usually keeps the read, but not always. kone's
  `item.completed` comes from agy's capture hook; in one run the interrupt
  killed the process tree while that hook was still running, and agy recorded
  the read as failed ("signal: killed from a hook"). An earlier run of the
  probe had passed 5/5, which is why one clean round is not enough.
- The `antigravity` provider as a whole is false either way, while ACP, its
  primary transport, is unprobed.

## 12. Build plan

Each phase ships on its own and leaves the app working and tested.

| Phase | What | Status |
|---|---|---|
| 0 | Never interrupt a thread parked on the user | Done (`bab89204`) |
| 0.5 | The cancel probe (§11) | Done (`f1875b1d`, `6f7c83c5`): Cline passes; Cursor and Antigravity print fail; Droid and Antigravity ACP not yet run |
| 1 | The stored inbox, behind today's mailbox | Done (`0097c1fc`) |
| 2 | An honest `agent_list` and a readable `agent_inbox` | Done (`7e6c89ee`) |
| 3a | kone's notices move into the inbox | Done (`99359d70`) |
| 3b | One ringer | Built (`1d47a55e`), behind `delivery.v2`, off by default |
| 4 | Jobs: `agent_followup` and `app_send_to_thread` | Built (`3a1c55f5`), behind `delivery.v2`, off by default |
| 5 | kone steer | Not started |
| 6 | The inbox in the app | Done (`1bb49544`, `04100edf`, `0b071123`) |
| 7 | "Still out" on reports | Done (`71567947`) |

### Phase 0: never interrupt a thread parked on the user

- **Change:** in the `AgentService.steerTurn` fallback, a thread with a parked approval or question gets the steer row queued, and no interrupt. "Send now" from the user's own queue strip is unchanged.
- **Files:** `AgentService.ts`.
- **Tests** (`agentService.queue.test.ts`, an adapter without `steerTurn`): parked → steer row queued, no interrupt; after the approval resolves, a steer interrupts; not parked → interrupts as before.
- **Risk:** low. Fixes the declined-approval bug (§0) for every path at once.

### Phase 0.5: the cancel probe

- **Change:** the probe script (§11), run by hand, never in CI. Results go into the provider capability table.
- **Files:** a new script under `packages/agent-core/scripts/`, the provider capability table.

### Phase 1: the stored inbox, behind today's mailbox

- **Schema (migration 22, `agent_inbox`):** `inbox_id` (the `msg_` id agents already see), `recipient_thread_id` (cascades with the thread), `sender_thread_id`, `sender_json`, `kind`, `urgent`, `reply_to`, `body`, `state` (unseen, handing, seen, retracted), `delivery_id`, `block_id`, `turn_id`, `seen_via` (turn, inbox, wait), `dedupe_key` (unique: a courier report keys on the child's turn, a job on the caller's turn and request id), `project_path`, `created_at`, `seen_at`. Index on recipient, state, created_at.
- **Change:** `IrcMailbox` keeps its API and stores in the table. Delivery claims, settles and releases instead of peek and mark-read. On boot, rows still being handed over go back to unseen with their block kept. No more dropping past 50. Routing is unchanged: steer if busy, wake if idle.
- **Files:** new `store/agentInbox.ts`; `conversationMigrations.ts`; `ConversationStore.ts`; `gateway/tools/irc.ts`; `ircDelivery.ts`; `apps/desktop/src/agent/agent-ipc.ts`.
- **Tests:** claim/settle/release are atomic; boot reset; the dedupe key refuses a second courier report; rows go with their thread; migration test; a delivery retried after a restart reuses its block and writes no second one; mail survives a restart and goes out on `session.started`; overflow past 8 re-arms; `waitForReply` takes its answer in one step, so a concurrent hand-over cannot deliver it too.
- **Risk:** medium, the persistence change. Mail in memory at upgrade is lost as on any quit today; nothing is backfilled.

### Phase 2: an honest `agent_list` and a readable `agent_inbox`

- **Change:** the roster comes from the store's threads and lineage, not the mailbox's registrations. `AgentService` gains an accessor for a thread's steer capability, which has no public surface today. Each row gains state, activity, how long, steer capability, unseen notes and their age (§6). `agent_inbox` takes `history` and `limit`, drops `peek`, and returns kind, sender and `replyTo`.
- **Files:** `gateway/tools/irc.ts`; new `recipientState.ts`; `AgentService.ts` (read-only accessors for parked, compacting and the open tool item); `gateway/schemas.ts`.
- **Tests:** an agent that never sent mail is listed; each state maps; inbox history and marking seen.
- **Risk:** low.

### Phase 3a: kone's notices move into the inbox

- **Change:** `queueNotice` writes a `notice` row and no longer writes the transcript; `pendingNotices` goes. The next turn claims held rows, writes them to the transcript under that turn, and settles them once the provider accepts it. The interrupted child's report to an idle parent becomes a held `report`. `tell` writes a row, ringing or not, and returns once it is stored; its `wake` flag goes.
- **Files:** `dispatch.ts`; `settleReports.ts`; `handOffLifecycle.ts`.
- **Tests:** a notice survives a restart; it is consumed only when its turn is accepted; a rejected turn keeps it; the lifecycle tests for withdraw, stop and "the user spoke directly".
- **Risk:** medium: notices reach the transcript at a different moment.

### Phase 3b: one ringer

- **Change:** `inboxDelivery.ts` replaces `ircDelivery.ts` and applies §2–§3: kind and `urgent`, answers first, at most 8, held while parked (re-checked when the user answers), re-checked on session start and when compaction ends, closed sessions brought back only for ringing kinds. `AgentService.drainQueuedTurns` asks the inbox for waiting messages when the turn slot frees; they ride in front of the user's queued row or start a turn. `agent_message` gains `urgent` and returns what happened (§6). The refusals in §2 land here: peer urgent, worker urgent, broadcast questions, two agents waiting on each other, an answer to nothing.
- **Files:** new `inboxDelivery.ts`; `AgentService.ts`; `dispatch.ts` (a turn with several senders); `senderHeader.ts`; `gateway/tools/irc.ts`; `gateway/schemas.ts`; `apps/desktop/src/agent/agent-ipc.ts`. `ircDelivery.ts` is deleted.
- **Tests:** a note never starts a turn; a question to a busy agent lands when its turn ends, in front of the user's queued message, in one turn; urgent steers on a native provider; a parked agent holds until the user answers; answers go first; a note to a closed session does not restart it; each refusal; each send result.
- **Risk:** high. Non-urgent messages stop arriving mid-turn on Claude, Codex and OpenCode. Ships behind a setting for one release.
- **As built:** the setting is `v2` in `delivery-settings.json` (`deliverySettings.ts`), read once at boot. Off, today's routing runs unchanged and `ircDelivery.ts` stays until the flip. On, the service's turn slot hands the inbox over: every turn it starts carries what waits, so a carried message settles with the turn the provider started. The `urgent` rules and the new receipts apply with the setting off too; the other refusals, and notes not ringing, only with it on. Until kone steer (Phase 5), urgent on a provider that cannot steer keeps today's fallback, and a message that falls back to the queue that way still settles under the queue's id.

### Phase 4: jobs

- **Change:** `agent_followup` and `app_send_to_thread` write `job` rows. A job rings as its own turn. `agent_followup` returns the inbox id, and `agent_wait` resolves it to the turn once handed over. `app_send_to_thread` takes `urgent` (`steer` stays as an alias) and holds a thread waiting on the user.
- **Files:** `spawnContinuation.ts`; `spawnWait.ts`; `threadSpawn.ts`; `gateway/tools/appThreads.ts`; `gateway/schemas.ts`.
- **Tests:** a follow-up to a busy child, then `agent_wait` on the returned id, settles with that turn; `app_send_to_thread` held while parked, steered when urgent.
- **Risk:** medium.
- **As built:** routing changes only with `delivery.v2` on; off, both tools send a turn as before, and the one change is that `app_send_to_thread` takes `urgent` with `steer` as its alias. On, a job's id is derived from the request's dedupe key (the caller's thread, turn and `requestId`), so a retry finds the same row and gets the same id. The ringer takes the user's queued rows first, then one job at a time, oldest first, with other waiting messages riding in front of it; an urgent job goes into the running turn, one per steer. `agent_wait` pinned to a job's id reads the child as starting while the job waits (unless the child is parked on the user), then as the turn that carried it, and is re-checked when a delivery settles, so a turn that ends before its settle is recorded is still collected. `agent_inbox` never takes a job. `app_send_to_thread` holds a job for a parked thread instead of refusing it, and answers with a delivery receipt. Both tools still bring a closed session back up before leaving the job. Carried messages are journaled in front of the turn's own block (the block moves to the end; `thread.message-journaled` carries `beforeBlockId`), so the transcript reads in the order of the turn text. The 3b note on urgent to a provider that cannot steer still holds until Phase 5.

### Phase 5: kone steer

- **Change:** §7, for providers that passed the probe. Open items are tracked with their kind, so kone waits on tool calls only. The completed tool item is recorded before the interrupt. The user's 30 s **Interrupt now** is an IPC call and a pill above the composer.
- **Files:** `AgentService.ts`; the provider capability table; `inboxDelivery.ts`; the renderer's composer.
- **Tests:** interrupts only after a tool call's `item.completed`, not on streaming text; never while parked; a provider that failed the probe lands at turn end.
- **Risk:** medium.

### Phase 6: the inbox in the app

- **Change:** IPC to list an agent's inbox and history, and an event when it changes. A per-agent inbox panel. The queue strip shows only rows the user wrote.
- **Files:** `apps/desktop/src/agent/agent-ipc.ts`; `apps/web/app/composables/session/sessionQueue.ts`; `sessionReducer.ts`; a new inbox panel component; `apps/web/app/types/desktop.d.ts`.
- **Tests:** `sessionReducer.test.ts`, `useAgent.test.ts`.
- **As built:** `agent:inbox:list` (unseen and handing) and `agent:inbox:history` (seen, newest first, 20 by default, 200 at most), shaped by `inboxView.ts`: an answer carries a one-line quote of what it replies to. The inbox store tells listeners whose inbox moved after every write that changed a row; the IPC layer streams that as `thread.inbox-changed`, never journaled. The panel is an Inbox tab in the thread-info drop-down (`AgentInboxPanel.vue`, `useAgentInbox.ts`), read-only. The strip filters on the queued row's block sender, so the raw queue still holds an agent's message back from the transcript until it runs, and a Stop hands back only the user's words. Still open: a Stop drops a queued agent message's block although its inbox row already reads seen; that goes when Phase 5 takes agent messages out of the turn queue.

### Phase 7: "still out" on reports

- **Change:** a report that rings names the work still out (§8).
- **Files:** `settleReports.ts`; `spawnControl.ts`.
- **Tests:** a report with delegates and workers still running names them; one with none adds nothing.
- **As built:** in `settleReports.ts` and `threadSpawn.ts`; `spawnControl.ts` needed no change. Still out means the parent's other hand-offs the spawn engine tracks whose current turn has not settled (running, starting, or parked on a question or approval). An agent idle between turns is not out. Under `delivery.v2`, neither is a follow-up job still waiting in its inbox. Only the courier's settle reports carry the line, and only when they ring: a held interruption leaves it off because it would be stale. A delegate's own `agent_message` report does not carry it.

### Review fixes

A review of everything since Phase 0 held `delivery.v2` back until findings 1–4 were fixed. Each fix has a regression test for its failure window.

| Finding | Fix | Commit |
|---|---|---|
| 1. A delivery the provider accepted could run twice after a crash during the checkpoint | The adapter's acceptance settles the carried inbox rows and the queued row at once; the checkpoint follows. The window inside the provider's own send, before it answers, remains: closing it needs an idempotent provider request | `029054fe` |
| 2. Urgent mail settled with a queue id on a provider that cannot steer | The ringer steers only into an announced turn on a provider that steers, and waits for `turn.started` otherwise. On a provider that cannot steer, it ends the running turn once and leaves the mail unseen for the next turn, which settles it with a real turn id. An urgent job's turn runs ahead of the user's queued messages | `087c0c6e` |
| 3. A settle or release the store could not write stranded rows in `handing` | The store answers null on a failed write. The mailbox keeps the turn and retries the write on a backoff, without resending; meanwhile a job's id already stands for its turn. A late release rings again | `eb9367ea` |
| 4. A refused inbox-only turn, or a failed restart, was never retried | Both arm the ringer's backoff (1 s, 5 s, 15 s, 60 s), then wait for something else to ring | `b3a35c0d` |
| 5. A crash could journal a message twice | A message's block id is derived from its inbox id; a retry links the block already written | `b4272778` |
| 6. Carried mail reverses queued prompts | Not reproduced. A queued row's block moves to the tail when it is claimed, so a later prompt follows the earlier one's turn. A test pins this order | `622a6f01` (test) |
| 7. Block moves collided on `blocks.seq` | Moves take one past the highest seq of any thread. The queue claim had the same collision: its row was left `promoting` until the stale timeout. It is fixed too, and now runs as one transaction with its block move | `622a6f01` |
| 8. Agent mail reads as the user's queued text on reload | Backend half: `QueuedTurnRow.sender` and `turn.queued.sender`, read from the row's block. The renderer half is Maya's | `3f923e98` |
| `agent_read` final/response looked empty to providers that read the structured half | The rendered reply is in `structuredContent.text` too | `4ae5551b` |

A re-review found 4, 5 and 7 fixed and withdrew 6; three fixes were partial:

| Finding | Fix | Commit |
|---|---|---|
| 2. A steer that found the announced turn ended, while the next send was on its way, was queued and the job settled with the queue id | The ringer's steer is live only: `steerTurn` refuses it rather than queue it, and the mail stays unseen for the backoff. A queued result says `queued: true`, and `onAccepted` never runs for one | `048b2144` |
| 1. With `delivery.v2` off, legacy delivery and held notices settled after the checkpoint | Both settle through `onAccepted`, before the checkpoint. A turn the service queued still settles to its row, which carries the messages from there | `dc9bfbf0` |
| 3. A failed settle followed by a crash replayed accepted mail at boot | Each hand-over marks its rows `sent_at` right before the provider gets the turn. At boot a row never sent is handed over again; a sent one is settled with the turn the transcript shows took it — the turn its block was steered into, or the first turn that started once it was sent. A sent row the transcript cannot settle is still released for now; holding it instead is the open question | `d2369971` (superseded below) |

A final re-review closed 2, 1 (with `delivery.v2` off) and 8, and held `delivery.v2` back on three more:

| Finding | Fix | Commit |
|---|---|---|
| 3a. A hand-over whose sent marker failed to write still reached the provider | The marker is the gate: when the store cannot write it, the send is refused before the provider is contacted, and the claim is released to the ringer's backoff. A user's turn that carries inbox mail is refused the same way and retried by the queue's backoff | `a8dbf083` |
| 3b. A sent row a restart cut off was released, and so could run twice | Migration 25 adds the `uncertain` state. At boot a sent row is seen only through the link written when the provider accepted it: its inbox block's `turn_id`. Every other sent row turns `uncertain`, and delivery skips it. The recipient gets one held notice naming the messages, with no bodies. An agent sender gets one held notice saying to send it again, and, for a job, to send `agent_followup` again with a new requestId. Both are deduplicated across restarts. `agent_inbox` lists uncertain rows flagged and marks them seen there. `agent_wait` on an uncertain job settles with `status: "uncertain"` and `handedOver: false` | `c3a453a8`, `aa7cbab4` |
| 3c. Boot reconciliation could settle a row to an unrelated turn, the first one after `sent_at` | Timestamps are no longer read. Only the acceptance link settles a row | `aa7cbab4` |
| Overlay: with symlinks refused, a codex database was copied without its write-ahead log | A database the overlay cannot link is copied with `VACUUM INTO` from a read-only connection, so changes committed to the log are kept. Sidecars are never copied, and databases are placed before their sidecars. A database the overlay created itself keeps its sidecars local, as before | `49193fe6` |

Still open:
- The window inside the provider's own send, before it answers. A crash there leaves the row `uncertain`, which now reports the problem instead of replaying the message. Closing the window needs an idempotent provider request.
- The renderer's copy of `SpawnedThreadStatus` still lacks `"uncertain"`.
- A database copied into the overlay is a snapshot. Codex's writes there do not reach the real home, and a later build does not refresh it.

## 13. Shipped while this was worked out

| Commit | What |
|---|---|
| `f5fe93f` | A delivered agent message names the blocks it carries, so a steer splits the reply where it landed, batch included, live and on reload. A queued agent message keeps its words and sender when its turn runs |
| `d4c5474` | `agent_read` reads at three depths: the final reply (default), the whole latest response with a line of what the agent did, or the transcript |
| `90bc2f6` | Hand-off tools and `agent_wait` tell agents to keep working while what they handed off runs |

Known gap left by `f5fe93f`: a batch that reaches a steer-capable provider in
the second before its turn starts falls back to the turn queue, whose row
carries one block id, so only the batch's last message moves. The row keeps
one `userBlockId` (`enqueueTurn`), the turn rebuilt from it names none, and
"Send now" passes on only that one. The inbox (§10) names every block it hands
over, which closes it.
