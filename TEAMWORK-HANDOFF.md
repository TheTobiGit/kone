# Teamwork Mac handoff (2026-10-09)

The two roles/delivery design docs are tracked and updated on this branch.
The teamwork proposal and parity planning docs remain gitignored. Transfer
`kone-teamwork-mac-handoff-2026-10-09.tar.gz` from the Linux machine to the Mac;
it contains all five updated docs, the full report and the exact code-pin gate
logs. After creating the worktree below, unpack it at that worktree's root:

```sh
tar -xzf /path/to/kone-teamwork-mac-handoff-2026-10-09.tar.gz -C ../kone-teamwork
```

Start parity continuation with `T3CODE-PARITY-RESUME.md`; it is also included
in the archive as `docs/t3code-parity-resume.md`. The archive includes the
historical P6 defect harness under `handoff/parity-review/`.

The archive's `handoff/teamwork-validation/` contains the logs and report.
The ignored proposal is also reproduced as the implementation handoff below,
so this branch carries the information needed even without that archive.


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

Parity work occupies/reserves migrations 29–33 across its branches; see
`T3CODE-PARITY-RESUME.md` for the exact manifests. These IDs are local to the
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
