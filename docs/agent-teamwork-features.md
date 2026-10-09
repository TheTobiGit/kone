# Teamwork features: what kone needs so agent fleets run well

Status: partially implemented on `teamwork` through `e6296cd` (2026-10-09),
not yet merged. §§1–3 and the minimum board in §4 shipped; later scope remains
proposed. The original “Today”/“Build” sections below are the proposal baseline.
See “Implementation and Mac handoff” at the end for current behavior. Source: the t3code-parity fleet run of 2026-10-08/09 (Chalk as
orchestrator, Iris as lead, Rowan as reviewer, and implementers Dara, Kofi and Lena)
across nine phases. Builds on `docs/agent-roles-design.md` (who may talk to whom) and
`docs/agent-delivery-design.md` (how a message arrives).

What the run cost, in numbers:
- **Relays:** 38 "RELAY to X" relays went through Chalk (another 32 mentions in Iris's
  thread), because agents couldn't reach each other.
- **Notifications:** Chalk received 101 "finished the work" notices and 11 turn failures.
  18 of Chalk's turns, and 9 of Iris's, were "nothing has changed".
- **Lost instructions:** when the run stopped, the reviewer had never seen two review
  requests, and an implementer had never seen her next assignment or a rule she needed.
  Both had been sent hours earlier.
- **Crashes:** three implementers were killed together when three full test suites ran at
  once on a 4-core, 7 GB machine. OpenCode sessions froze or reset 4+ times. The lead hit a
  session limit mid-turn and lost the only copy of a review.

The features below are ordered by how much of that each would have prevented.

---

## 1. Contracts that last as long as the job (P0)

**Today:** kone marks a contract "completed" when the contractor's first turn ends. From
then on, `agent_message` to it is refused ("work is over") or sits unread. Only the
contracting agent can reopen it, with `agent_followup`. That contradicts
`agent-roles-design.md` §3, which says a contract ends when the deliverable is reported or
withdrawn.

**Build:**
- A contract stays open until its deliverable is reported and accepted, or it is
  withdrawn. Between turns the contractor is *idle*, not *ended*.
- A `question`, `report` or `answer` to an open contractor always wakes it.
- Reporting the deliverable is an explicit act (`agent_message kind:report` flagged as
  final, or a `contract_complete` tool). Ending a turn is not.

## 2. Access shared through the contract tree (P0)

**Today:** only the contracting agent can follow up with, read, or withdraw a contractor.
Chalk contracted everyone directly so all of them could start workers, which made Chalk
the only one able to reach anyone. Iris, the lead, couldn't read the reviewer's report
after her crash.

**Build:**
- **Grants.** When contracting or delegating, the orchestrator can grant named peers
  `read`, `message` (wake-capable) or `followup` on the new agent. Example: "Iris may
  follow up with Rowan, Dara, Kofi and Lena." Grants show in `agent_list` and can be
  revoked.
- **Or lift the depth cost.** Let an agent at depth 2 start workers (one level below any
  agent, as §8 of the roles doc already says), so a lead can contract its own team and
  the tree matches the real chain of command.
- **Crew handle.** An orchestrator's contractors become a *crew*, and `to: "crew"`
  messages all of them. Today only the main agent can broadcast to `all`.

## 3. Messages that say whether they will land (P0)

**Today:** a `note` never wakes an idle agent, and nothing tells the sender it is stuck.
Agents also ended turns "waiting for the lead" and sat idle until Chalk woke them by hand
(6+ times).

**Build:**
- **Send result.** The send result says what will happen: "Rowan is idle; this note will
  wait until something wakes him. Send as a wake?" Better still, notes to an idle agent
  in an open contract wake it by default.
- **Acknowledgement.** An optional `ack_required` flag puts the message on the sender's
  watch list until the recipient opens it. `agent_list` shows "2 unacknowledged from
  you".
- **Delivery receipts.** A sender can see delivered → opened → acted on (a turn started
  after opening). That stops claims like "Rowan is starting the review" when Rowan never
  saw it.
- **Stale-instruction guard.** A message may carry `about: {branch, commit}`. On opening,
  kone checks the branch tip and adds "this branch has moved 3 commits past what this
  message refers to." Stale relays caused duplicate fixes twice in this run.

## 4. The agent board (P1)

A shared, structured workspace owned by a crew. It is to agents what the scratchpad is
to the user. The last section covers whether to build it and why.

**What it holds** (typed sections, not one free-text blob):
- **Brief and standing rules:** the plan, scope, rules every member must follow (gate
  lock, no rewrites under review, tool-output rule). Each rule is versioned, and
  members see "2 new rules since your last turn".
- **Status board:** one row per work item: item → owner → branch@commit → state
  (building / gated / in review / changes needed / approved / merged / blocked) → next
  step → updated at. Rows are written by their owners and by the lead.
- **Decisions log:** a dated, append-only record of who decided what, including user
  decisions relayed by the orchestrator. Example: "global assistant reads every thread
  (user, 2026-10-09)".
- **Artifacts:** review reports pinned to commits, gate results per commit, design notes.
  These survive any one agent's crash. Iris's lost review would have been here.

**Access:**
- The orchestrator creates a board and grants each member `read`, `write rows` (only rows
  they own) or `admin` (rules, decisions, any row).
- Grants pass down: a lead with `admin` can grant its own delegates and workers. Workers
  get read access by default when their parent is a member.
- The user always sees the board, and can edit it, in the studio next to the
  scratchpad. It is never mixed into the user's scratchpad.

**Mechanics:**
- **Writes:** revision-checked (`expectedRevision`), with per-row ownership so writers
  rarely collide.
- **Change subscriptions:** members subscribe to row or section changes. "Notify me when
  any row reaches *approved* or *blocked*" replaces most "finished the work" pings for an
  orchestrator.
- **Context:** a short board digest (rules version plus the reader's own rows) is put in
  front of each member's turn, the same way inbox messages are today.
- **Lifetime:** the board ends with the contract tree. "Export to doc" turns it into a
  handover file, like the status section we wrote by hand into
  `t3code-parity.md`.

## 5. A fleet-wide gate queue (P1)

**Today:** agents ran heavy checks at the same time and crashed the machine. The fix,
`flock ~/Developer/kone-wt/.gate.lock`, worked but couldn't be seen: reviews waited
10–20 minutes with no position shown, and every agent ran the same suites again.

**Build** (on the bench, which already queues jobs one at a time):
- **The queue.** `gate_run {worktree, commit, suites}` queues a job and returns its
  position. The result is stored against the **commit hash** and posted to the crew
  board.
- **Cached results.** The same commit and suite returns the stored result immediately, so
  a reviewer reuses the implementer's gate run instead of repeating it.
- **Resource-aware concurrency.** Run in parallel based on cores and memory, and allow
  "targeted" jobs (single test files) to jump the queue.
- **Live progress.** The current job, waiters and estimated wait show in the bench, and
  agents can see them in `agent_list`.

## 6. Recovery that keeps the thread going (P1)

**Today:** a frozen session ("wedged — session reset"), "fetch failed", a transport error
or a session limit each ended the turn. Someone then had to check the worktree, rebuild
what was going on, and restart the agent. A recovered transcript cut off an incoming
review.

**Build:**
- **Retry.** Transient transport and fetch errors are retried with backoff before the
  turn fails.
- **Resume brief.** On reset, kone adds a notice to the next turn: "you were mid-turn
  doing X; worktree Y has these uncommitted changes, and the tip is Z". Then it resumes
  automatically.
- **Inbox survives.** Messages are stored in full and redelivered after a crash; the
  inbox is already durable (`agent_inbox`), so this is the redelivery side.
- **Limit hand-off.** On a session-limit failure, offer the orchestrator a one-step
  "continue this agent on model M" that keeps the thread, the inbox and the board
  membership. The user did this by hand for Iris ("mimo, can you takeover?").

## 7. Orchestrator notifications worth reading (P1)

**Today:** every settled turn of every agent in the tree woke the orchestrator.

**Build:**
- **Subscriptions.** The orchestrator subscribes per crew. The default is milestones
  only: deliverable reported, review verdict, merge, failure, blocked on a person, and a
  question addressed to it.
- **Digest.** Everything else is folded into a digest that arrives at most every N
  minutes, or when the orchestrator next wakes.
- **Dedupe.** When the same content reaches an agent directly and through a relay, it
  appears once.
- **Settle summary.** "Nobody was waiting for this result" notices summarize and don't
  wake an orchestrator whose own work isn't blocked by them.

## 8. Branch and review guards (P2)

- **Review pins.** A review can pin a branch to a commit. While the review is open,
  kone refuses to move the branch anywhere that drops that commit (rebase or force-move),
  and says why. An implementer rewriting a branch mid-review cost a round in this run.
- **Migration reservations.** The lead reserves migration ids per work item on the board,
  and the schema test flags an id outside the reservation.
- **Worktree ownership.** A worktree records which agent owns it. Edits by another agent
  show a warning, and `agent_list` shows who is in which worktree. The lead spent a turn
  finding out who was editing `p3-limits`.

## 9. Smaller fixes

- `ask_question` dismissed without answering returns `declined`, never a timeout that
  reads like silence.
- `agent_list` shows unread counts per sender (only the totals today).
- Fleet presets: save a crew shape (roles, models, standing rules, gate commands) and
  start it on a new job in one step.
- A "self-check before review" checklist that the lead attaches to the board. kone shows
  it to an implementer when it sends a `report` that asks for review.

---

## Should agents get an agent board? Yes, with limits

**Why yes.** Most of what went wrong in this run came from state living only in messages.
Messages go stale, get dropped on idle agents, get cut off in crashes, and reach some
members but not others. Every recovery (Iris's takeover, the Mac handover) meant
rebuilding state from transcripts. A board turns "tell everyone, and hope it lands" into
"write it once where everyone reads it". It also gives the user one place to see the
fleet, instead of opening five threads.

**Why not just the scratchpad.** The scratchpad is the user's own notes. Agents writing
plans and status there would bury the user's notes and blur whose voice is whose.
Keeping the two apart is already a kone rule.

**Limits that keep it useful:**
- **Structured, not free text.** Rows, rules and decisions have owners and types, so the
  board stays a source of truth instead of becoming a second chat log.
- **Doesn't replace messages.** Questions, pushback and anything that needs a reply
  still go through the inbox. The board holds *state*; the inbox holds the *conversation*.
- **Scoped per crew.** Access is granted by the orchestrator. There is no global board
  that every agent in the project can read.
- **Changes ring, reads are quiet.** Writing a row doesn't wake anyone unless they
  subscribed to it.

**Suggested order:** contracts that last the job (§1) and wake-aware messaging (§3) come
first; they are smaller and fix the worst losses. Next, the board with status rows and
standing rules only. Then decisions and artifacts. Then the gate queue writing its
results onto the board.


## Implementation and Mac handoff (2026-10-09)

Chalk's provider is at its limit. Continue from the repository and this handoff;
no live agent response is needed to recover the finished teamwork work.

The `teamwork` branch was pushed to `origin`. Verified code pin:
`e6296cd79a43b59ab14cc716036d727d6360091c`. Later documentation-only commits
may sit above it. The original four feature commits through `2ae9305` were
never rewritten; every review fix is a new commit. This is not merged into
`linux/desktop-shell` or `t3-parity`.

On the Mac, fetch and check out a new worktree without replacing an existing
checkout:

```sh
git fetch origin
git worktree add ../kone-teamwork -b mac/teamwork origin/teamwork
cd ../kone-teamwork
bun install --frozen-lockfile
```

Review `agent-roles-design.md` §15 and `agent-delivery-design.md` §14 alongside
this section. Install/build and manual provider checks on macOS still need to
be done; Linux gates do not validate macOS native modules or live providers.

### Shipped features and fixes

| Area | Commits | Result |
|---|---|---|
| Contracts (§1) | `8039c72` | Open between turns; explicit final report or withdrawal closes; delivered means closed without acceptance; provider sessions still stop between turns |
| Delivery (§3) | `15e6cfb` | Authorized direct notes ring open contractors; outcomes, acknowledgement watch counts, receipts and branch/commit drift warnings |
| Grants/crew (§2) | `276f169` | Named read/message/followup grants, revoke, hand-off grants, roster visibility and quiet crew broadcasts; depth limits unchanged |
| Minimum board (§4) | `2ae9305` | Brief, versioned rules, owned rows, access/revision checks, worker read inheritance, held rule notices and list/event IPC |
| P1 review fix | `867036c` | Contract close and grant deletion are atomic; closed-contract grants are ignored; reopening restores no grants |
| P2 follow-up routing | `ef2fe7d`, `6a7665b` | Requester bound per job/turn before dispatch, including fast completion, concurrent requests, abandoned waits and later report retraction |
| P2 failed follow-up | `2ddad96` | Reopen only after the job is durably posted; start/write failures preserve closure |
| P2 crew broadcast | `e2390dd` | Closed contractors omitted so remaining crew members still receive broadcasts |
| Desktop gate repair | `e6296cd` | Parsing tests stub avatar fetches; two real-network timeouts also occurred on the base |

Sable's review of `2ae9305` found one P1 and three P2s; all were fixed as above.
The fixes have regression tests and full gates. They have not received a new
independent review; do that before integration.

### Migration collision: renumber at merge

Parity work occupies/reserves migrations 29–33 across its branches. These IDs are local to the
teamwork branch and must be reconciled before merging or sharing its database:

| Current ID | Change | Integration instruction |
|---|---|---|
| 29 | ContractClosed: closure timestamp/reason | **renumber at merge** |
| 30 | InboxReceipts: acknowledgement/about metadata and sender index | **renumber at merge** |
| 31 | AgentGrants | **renumber at merge** |
| 32 | CrewBoards: boards/members/rules/rows | **renumber at merge** |

Use the integration branch's next free IDs; update `SCHEMA_VERSION`, migration
registration and migration tests together. Do not simply assume 34 is free:
other phase work may add migrations before this merges. Preserve commits below
review pins; perform reconciliation as integration work.

### UI and remaining scope

- Add the studio board view via `desktop.agent.boardsList(projectPath)` and
  re-read on `board.updated`. Show the brief, membership/access, live rules,
  owned work rows, branch@commit, state and next step. User editing still needs
  mutation IPC and UI; only list IPC is supplied.
- Wire inbox `ackRequired`/`about`, receipt/watch state, contract closure and
  grants into appropriate UI surfaces. Tool presentation labels already exist.
- The minimum board has no decisions/artifacts, subscriptions, automatic
  per-turn digest, export, or end-of-contract-tree cleanup beyond owner deletion.
- §§5–9 were not implemented by this branch. Fleet gates/caching, recovery/model
  handoff, notification filtering/digests, branch guards and the smaller fleet
  features remain. Some overlap other parity work; inspect that integration
  before implementing the same behavior twice.
- Receipt “acted on” means the carrying turn ended, not that it obeyed the
  message. Opening/acknowledgement does not mean acceptance.

### Exact code-pin validation

All commands ran sequentially in the foreground through
`flock ~/Developer/kone-wt/.gate.lock`, at `e6296cd`:

| Gate | Result |
|---|---|
| `bun run check-types` | exit 0; 5/5 tasks, no cache hits |
| `bun run lint` | exit 0 |
| agent-core `bun test` | 2,674 pass / 0 fail; 152 files |
| protocol `bun test` | 124 pass / 0 fail; 13 files |
| desktop `bun test` | 405 pass / 0 fail; 38 files |
| web `bun test` | 1,498 pass / 0 fail; 114 files |
| `bun run build:desktop` | exit 0; renderer/fonts, main/preload bundles and asset staging completed |

Nuxt/vue-tsc logs a non-fatal `MODULE_NOT_FOUND` for
`vue-router/volar/sfc-route-blocks`. The package exists in the `.bun` store;
this worktree lacks the root-level symlink that lets the main checkout resolve
it from `apps/web`. Frozen install did not change that layout. Treat this as a
web typecheck plugin-resolution caveat, not a missing package download or a
teamwork TypeScript error. Check resolution again on a fresh Mac install.
An earlier build failed on a Google Fonts connection timeout; the final-tip
retry downloaded the fonts and completed without changing font handling.

Linux logs were `/tmp/wren-final-{types,lint,agentcore,protocol,desktop,web,build}.log`
and `/tmp/wren-final-gates-summary.log`; take the handoff archive if these are
needed on the Mac. The report was sent to Chalk as `agent_message kind: report`,
message `msg_1612a7a7-5123-4cd0-b2ee-bac0a2277e84`; provider limits may prevent
Chalk reading it now.
