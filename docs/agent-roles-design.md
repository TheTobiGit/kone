# Agent roles, relationships and messaging

Status: roles implemented on `feat/agent-roles`; teamwork extensions implemented
on `teamwork` through `e6296cd` (2026-10-09), not yet merged. See §13 for the
original departures and §15 for current contract/grant behavior.

kone agents should feel like co-workers: they have an identity, take on large
pieces of work, and hand parts of it to others. This document fixes the roles,
the relationships between them, how they talk, how a stop moves through them,
and how all of it shows up in the app.

Provider-native subagents (Claude's Task/Agent tool, Antigravity's
`invoke_subagent`) are out of scope for behaviour. The provider owns them. kone
only displays them.

## 1. Roles

| | **Agent** (co-worker) | **Worker** |
|---|---|---|
| Identity | Name, role, personality, standing instructions | None, just a task |
| Scope | A large piece of work (e.g. "own the auth frontend") | A short, bounded task (e.g. "find where sessions are validated") |
| Can start kone agents | Yes | **No** |
| Can start kone workers | Yes | **No** |
| Can use its provider's native subagents | Yes | Yes |
| Lifetime | Saved, or for one task (contractor) | One task |

The agent handing off work decides which kind fits: a multi-part feature that
needs its own planning goes to an agent, a bounded lookup or edit goes to a
worker.

Workers may split their own task with native subagents. That keeps the kone
thread tree small, on the assumption that each provider caps its own nesting
(Claude's Task subagents, for one, are documented as unable to spawn
subagents). That assumption has to be checked per provider (§12).

### Where they come from

| | Saved (built-in or user-added) | Ad-hoc (made up by an agent) |
|---|---|---|
| Agent | **Teammate**: an agent on the project team | **Contractor**: identity written by the contracting agent, for this job only |
| Worker | **Worker preset** | A brief the starting agent writes |

## 2. Relationships

| Relationship | Between | Terms |
|---|---|---|
| **Delegation** | Agent → teammate | **delegator** / **delegate** |
| **Contract** | Agent → contractor | **contracting agent** / **contractor** |
| **Parent / child** | Agent → worker | **parent** / **child** |

- Agents are never "children". "Child" only ever means a worker.
- A contract is a kind of delegation. Messaging, asking back and stopping apply
  to both. They differ only in where the identity comes from and how long it
  lasts.
- In code, avoid `client` for the contracting side (clash with HTTP clients).
  Use names like `contractedByThreadId`.

```
You
 └─ Main agent
     ├─ ⇢ Frontend Auth     contractor (Main agent is its contracting agent)
     │     ├─ worker        child of Frontend Auth
     │     └─ worker        child of Frontend Auth
     ├─ ⇢ Backend           delegate (teammate)
     └─ worker              child of Main agent
```

## 3. Contracts

When an agent contracts someone, it writes the terms:

- **Identity:** name, role, instructions (same shape as `AgentPersona`).
- **Scope:** what is and is not in the job.
- **Deliverable:** what is handed back.
- **Done criteria:** how both sides know the job is finished.

The contract ends when the deliverable is reported or the contracting agent
withdraws it. The contractor then goes away. The user, and only the user, can
**hire** a contractor. That UI action saves it to the team as a teammate with
the identity it already has. Agents cannot grow the team on their own.

## 4. Senders

Every turn input carries a sender, stored on the block and rendered into the
prompt:

| Sender | Meaning | How the receiver treats it |
|---|---|---|
| `user` | The user typed it | The authority. Follow it, ask the user when unsure |
| `agent` | Another agent (name, thread id, relationship) | Depends on the relationship, below |
| `system` | kone itself (wake reports, stop notices) | Information about the situation, never an instruction from the user |

How an `agent` sender is treated, by relationship:

| From | Treat as |
|---|---|
| Delegator / contracting agent | Work handed down: its interpretation of what the user wants, which can be wrong. May be questioned or pushed back on |
| Peer agent | Information, not orders |
| Worker (to its parent) | Results to check, not instructions |

The delegate's first brief is an `agent` message from its delegator, not a user
message.

## 5. Messaging

One tool, `agent_message`, available across every relationship. It replaces
`agent_notify`.

### Addresses

| `to` | Means |
|---|---|
| `delegator` | Whoever delegated to you, or contracted you |
| `delegates` / a name | Teammates and contractors you brought in |
| `parent` | For a worker: the agent that started it |
| `children` / a name | Your workers |
| `main` | The root of your tree |
| an agent id | Any agent on the project (unrelated peers) |
| `all` | Broadcast. **Main agent only** |

### Kinds

| `kind` | Meaning | Receiver is told |
|---|---|---|
| `note` | FYI, no reply expected | Fold it in if useful |
| `question` | Needs an answer | X is waiting on you |
| `pushback` | Disagrees with the task, proposes something else | Your delegate disagrees; decide or ask the user |
| `report` | Deliverable or result | Results to check, not instructions |
| `answer` | Reply to a question (`replyTo` required) | Answer to what you asked |

- A `question` does not pause the sender by default. `wait: true` parks it until
  the answer arrives.
- Every delivered message carries a header naming the sender, its relationship
  and the kind, e.g. `From Frontend Auth — your contractor (login UI) · question`.

### Who can message whom

| Sender | Can message |
|---|---|
| Main agent / delegator / contracting agent | Everyone in its tree, and peers |
| Delegate / contractor | Its delegator, its own delegates and children, `main`, and peers |
| Worker | **Only its `parent`**, and only with `report` or `question` (for blocked cases). No sibling messaging |

### Escalating to the user

A delegate or contractor that needs something only the user can answer asks
its delegator (`question` to `delegator`). The delegator answers from its own
context, asks the user, or changes the task. Questions climb one level at a
time, so only the agent the user is talking to ever asks the user.

### Loop cap

The existing cap (a pair trading 16 messages with nobody else involved is
refused) stays, except that `question` → `answer` pairs between a delegate and
its delegator do not count toward it.

## 6. The user talking to a delegate directly

Delegates and contractors are full threads, so the user can open one and type.

- The sender is `user`. The agent treats it as the authority, above its
  delegator's instructions.
- kone sends the delegator a quiet `system` note ("the user spoke to Frontend
  Auth directly"). The delegator decides whether to check in.

## 7. Stopping

### Children

Stopping an agent stops its workers outright. This includes a delegate: when it
stops, its own workers stop with it.

### Delegates are always told

| Delegator event | Delegate is told | Default behaviour |
|---|---|---|
| Turn interrupted by the user | "Your delegator was stopped mid-turn by the user" | Keep working. The report waits until the delegator runs again |
| Archived or deleted | "Your delegator is gone" | Finish or wrap up, then report to the **user's inbox** |
| Withdrew this task (`agent_withdraw`) | "Your delegator withdrew this task" | Stop, leave a short note of what was done, start nothing new |

All three arrive as `system` messages. The delegate decides what to do: finish,
wrap up with partial results, or ask.

The "archived or deleted" row cannot happen while archive and delete refuse a
subtree with any agent mid-turn (§13), so no user's inbox is built
(`agent-delivery-design.md` §11).

### The stop chain

When the user stops an agent **that has delegates or contractors running**:

1. The agent's turn ends, as today.
2. kone gives it a limited **decision turn**: a `system` message listing the
   agents working because of it, with their task and progress.
3. For each one it chooses **continue**, **stop**, or **ask the user**
   (`agent_keep_or_stop`). It cannot start new work in this turn.
4. Each delegate it stops gets the same decision turn for its own delegates,
   one link at a time down the chain.
5. Workers never get a decision. They stop with their parent.

- Delegates keep running while a decision is pending.
- If the stopped agent has no delegates running, it is a normal stop with no
  decision turn.
- **Stop everything** skips the decisions and stops the whole chain.
- The user gets one summary: what was kept and what was stopped.
- A result whose delegator is gone goes to the user's inbox. Work is never
  silently lost.

## 8. Limits

Replace the flat `MAX_SPAWN_DEPTH = 2` with two separate limits:

- **Delegation depth:** how long an agent → agent chain may get.
- **Workers per agent:** how many children an agent may have running.

Workers are always allowed as one level below any agent, and never go deeper.
The existing live-thread caps (`MAX_LIVE_CHILDREN_PER_PARENT`,
`MAX_LIVE_SPAWNED_THREADS`) stay as global backstops. Values are set during
implementation.

## 9. Tools

Only agents see the starting tools. Workers never do.

**Starting work**

| Tool | Does | Replaces |
|---|---|---|
| `agent_directory` | Teammates, worker presets and models, plus remaining limits | `agent_targets` |
| `agent_delegate` | Hand work to a teammate | same |
| `agent_contract` | Contract a new agent: identity, scope, deliverable, done criteria | new |
| `worker_start` | Start a worker from a brief, or from a preset (`preset:`) | `agent_spawn`, `agent_spawn_preset` |
| `worker_start_batch` | Start several workers at once | `agent_spawn_batch` |

**Following up on work you started**

| Tool | Does | Replaces |
|---|---|---|
| `agent_followup` | Send a tracked turn to a delegate, contractor or worker | `agent_ask` |
| `agent_wait` | Wait for them to settle or ask something | same |
| `agent_read` | Read their final reply, their whole latest response (with a line of what they did), or their transcript | same |
| `agent_withdraw` | Take the work back (delegate or contractor wraps up; a worker is stopped) | `agent_cancel` |
| `agent_answer` | Answer a question or approval they are parked on | same, widened |
| `agent_decline` | Decline an approval they are parked on | same |

**Talking and stopping**

| Tool | Does | Replaces |
|---|---|---|
| `agent_message` | Relationship-aware messaging (§5) | `agent_notify` |
| `agent_list`, `agent_inbox` | Who can be messaged; catch up on messages | same |
| `agent_keep_or_stop` | Decision turn only: continue, stop or ask, per delegate | new |

`agent_followup` / `agent_wait` stay separate from messaging: they track a turn
whose final result is collected. Messages are lighter and do not come back
through `agent_wait`.

## 10. Frontend

### Where things appear

| Kind | Studio | Inbox | Own thread |
|---|---|---|---|
| Main agent | Column | Sidebar | Yes |
| Delegate | Its own column | Sidebar | Yes |
| Contractor | Its own column | Sidebar | Yes |
| kone worker | Its agent's **Subagents dock** | Subagents dock | No |
| Native subagent | Subagents dock | Subagents dock | No |

- Workers join native subagent runs in the existing dock
  (`ThreadSubagentDock.vue` / `AgentSubagentDock.vue`) instead of becoming
  threads. Opening a worker to see its details is a later design.
- Delegate and contractor columns and sidebar rows show their link, e.g.
  "Frontend Auth · contracted by Main agent".

### Voices in a thread

Every message is one of: **user**, **this agent**, **another agent** (with that
agent's avatar, name and relationship), or a **system** notice (a quiet centred
divider).

Rule for every style: nothing but the user's own messages ever sits on the user
side.

| Style | User | This agent | Another agent |
|---|---|---|---|
| Kone / Kone Quiet | Bubble on the right | Reply on the left | Bubble on the left with avatar, name, tinted edge |
| Timeline | Face on the rail | Agent face on the rail | Other agent's face on the rail, name and relationship tag |
| Thread (Slack) | Row | Indented reply | Its own row with avatar and name, not indented |
| Chat (WhatsApp) | Right tailed bubble | Left tailed bubble | Left bubble with the sender's name on top, as in a group chat |
| Channel (Discord) | Face, coloured name | Agent face and name | Other agent's face in its own colour; an `answer` quotes what it answers |
| Prompt (terminal) | `>` command | Output | Prefixed line, e.g. `[Frontend Auth → you]` |

### Indicators in the agent's reply

The hand-off line in the reply (`SpawnWorkerMark.vue`, first person, one line
per hand-off, with the agent's reason under it) says which kind of hand-off
happened:

| Event | Line | Visual |
|---|---|---|
| Worker from a brief | "I gave a worker a task: Audit the migration tests" | Generic worker glyph, no name or face. Click opens it in the Subagents dock |
| Worker from a preset | "I gave a Reviewer worker a task: …" | Worker glyph plus the preset name |
| Delegation | "I delegated to Ada: Build the /users endpoint" | Ada's roster face. Click opens her thread |
| Contract | "I contracted Frontend Auth: Build the login UI" | The contractor's face, a "contractor" tag. Click opens its thread |
| Withdrawn | "I withdrew the task from Ada" | Muted |
| Decision turn result | "Kept Frontend Auth running · stopped Backend" | One summary line |

Workers lose the generated names and faces they have today ("I spawned Theo"):
they have no identity.

The other end of each hand-off gets a marker at the top of its thread (like
`HandoffMark`): "Delegated by Main agent" or "Contracted by Main agent", with
the brief shown as that agent's message below it.

Activity-step labels (`koneToolPresentation.ts`) follow the same words:

| Tool | Running / done / failed |
|---|---|
| `worker_start` | Giving a worker a task / Gave a worker a task / Couldn't start a worker |
| `worker_start_batch` | Giving workers tasks / Gave workers tasks / Couldn't start workers |
| `agent_delegate` | Delegating to a teammate / Delegated to a teammate / Couldn't delegate |
| `agent_contract` | Contracting an agent / Contracted an agent / Couldn't contract an agent |
| `agent_withdraw` | Withdrawing work / Withdrew work / Couldn't withdraw work |
| `agent_message` | Messaging an agent / Messaged an agent / Couldn't message the agent (verb varies by kind: "Asking", "Pushing back to", "Reporting to") |
| `agent_keep_or_stop` | Deciding on running agents / Decided on running agents / Couldn't decide |
| `agent_directory` | Checking who can take work (unchanged wording) |

Thread-level tools (`app_start_thread`, `app_stop_thread`, `app_archive_thread`,
`app_delete_thread`) keep their wording. They act on the user's threads, not
on hand-offs.

## 11. Mapping onto the current code

| Area | Today | Change |
|---|---|---|
| Relationships | `RelationshipToParent = "subagent" \| "delegation" \| "side_chat"` (`types.ts`) | Add `"contract"`. `"subagent"` means worker |
| Identity | `AgentPersona` bound via `bindThreadAgent`, rendered by `renderAgentIdentity` | Contractors bind a persona written by the contracting agent, kept off the team roster |
| Spawn tools | `gateway/tools/spawn.ts` | Rename and split per §9. Hide starting tools from workers |
| Guards | `spawnGuards.ts`: prompt → depth → breadth → … | Add a role check (workers cannot start kone threads). Split depth per §8 |
| Senders | Only `<irc>` deliveries are tagged (`ircDelivery.ts` `renderIncoming`). Spawn briefs and `agent_ask` follow-ups go in as plain input (`spawnContinuation.ts`) | Store a sender on every turn input and render it in the prompt |
| Asking back | `agent_spawn` says children "cannot ask you anything" | `agent_message` with `question` / `pushback`; `agent_answer` widened |
| Messaging | `gateway/tools/irc.ts`: `parent`, `main`, `all`, ids; 16-message loop cap | Relationship addresses, kinds, worker restrictions, `all` for main only |
| Late results | `subagentWake.ts` frames returning subagents as a report | Keep; reuse for `system` notices |
| Worker threads | Spawned children are real threads | Workers render in the Subagents dock, not as threads |
| Conversation styles | `utils/conversationStyle.ts` (seven styles) | Add the "another agent" voice and system divider to each |
| Agent guidance prompt | `apps/web/app/utils/agents.ts` tells agents to call `agent_targets`, `agent_spawn_preset`, `agent_spawn_batch` | Rewrite for the new tools and the agent-versus-worker decision |
| Hand-off indicators | `SpawnWorkerMark.vue` ("I spawned Theo", "I asked Ada"); labels in `koneToolPresentation.ts`; spawn record in `@kone/protocol/spawn-record` | New wording per §10; workers lose names and faces; the record carries the hand-off kind (worker / delegation / contract) |

## 12. Implementation notes

- **Senders** are stored as `blocks.sender_json` (migration 15; NULL = the
  user). An agent-sent turn is dispatched under a `<from_agent>` header, a kone
  notice under `<kone_notice>`, and delivered agent messages inside
  `<agent_messages>`. Every block kone writes on someone else's behalf is
  announced to renderers as `thread.message-journaled`. The renderer's send and
  steer IPC always strip a sender, so only the main process can set one.
- **Workers** are threads with the `"subagent"` edge. The hand-off tools are
  `agentsOnly`: hidden from a worker's tools/list and host context, refused if
  called anyway, and the spawn guard has a role rung behind them.
- **Delegation depth** (`MAX_DELEGATION_DEPTH = 2`) counts only agent children;
  any agent may start workers.
- **Queued notices**: `dispatcher.queueNotice` journals a kone notice and rides
  it in front of the thread's next turn, so an idle agent is told without being
  woken.

## 13. Where the build departs from the design

- **A contract is a delegation edge plus terms.** The relationship stays
  `"delegation"` and the terms live in `threads.contract_json` (migration 16),
  because widening the relationship CHECK means rebuilding `threads`. Code asks
  `meta.contract` to tell a contractor from a teammate.
- **`worker_start` replaces both `agent_spawn` and `agent_spawn_preset`**
  (a brief, optionally from a preset). `worker_start_batch` takes workers only;
  a teammate in a batch is refused per item and pointed at `agent_delegate`.
- **A delegator can't disappear mid-work.** Archive and delete already take the
  whole subtree and refuse while any descendant is mid-turn, so the "delegator
  is gone" notice (§7) has no case to fire in; that behaviour was kept.
- **Hire is built in the renderer** from the existing roster calls (create the
  agent, add it to the project team, bind the thread); no new backend.
- **Stop everything** is a bar above the composer whenever delegates or
  contractors are working for the thread, backed by `agent:stop-chain`.

## 14. Open items

- For every provider (Claude, Codex, Cursor, Droid, Cline, OpenCode,
  Antigravity), check whether it has native subagents, whether they can nest,
  and whether kone can see them. Where nesting is possible, decide whether kone
  caps it for workers. Claude, OpenCode and Antigravity already have adapter
  support for native subagents; the others have almost none.
- Pick values for the delegation-depth and workers-per-agent limits.
- Design the expanded view of a worker opened from the Subagents dock.


## 15. Teamwork extensions shipped on `teamwork` (2026-10-09)

Code pin: `e6296cd79a43b59ab14cc716036d727d6360091c`. The implementation
and handoff are recorded in `docs/agent-teamwork-features.md`.

- A contract stays open between turns. Its provider session may stop, but a
  ringing message can resume it. Turn completion does not close the contract.
- The contractor explicitly delivers with `agent_message kind: report,
  final: true` to its contracting agent; withdrawal also closes the contract.
  Delivered means closed, with no separate acceptance step.
- Closing the contract and deleting every grant targeting it is one durable
  transaction. Reach helpers ignore lingering grants on closed contracts.
  An agent up the chain can reopen it with a new follow-up; reopening occurs
  only after the job is durably accepted, and restores no old grants. Peer
  access requires explicit new grants.
- An ancestor can share `read`, `message`, or `followup` access through
  `agent_grant`, or the `grants` field of `agent_contract`/`agent_delegate`.
  `message` includes read; `followup` includes read and message, and permits
  following up and waiting. A grant does not confer withdrawal authority.
  Delegation depth limits stay as they were.
- Peer follow-up results are bound to the requesting peer per job/turn before
  dispatch. Concurrent requests and a provider turn that finishes before its
  send returns cannot replace that recipient. Collection and abandoned waits
  use the same turn-specific recipient; later collection retracts its report.
- `to: "crew"` broadcasts a quiet note to the orchestrator's agents, or from
  a member to its delegator and fellow members. Workers and closed contractors
  are omitted from the crew's agent list.
- `agent_list` exposes grants. Contract/grant UI remains to be designed.

Migrations 29 (contract closure) and 31 (grants) are **renumber at merge**:
`t3-parity` already occupies 29–33. Do not install this branch's schema over
an existing t3-parity database before reconciliation. See the teamwork doc
for all four colliding migrations and the exact gate results.
