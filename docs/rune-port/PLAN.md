# Rune migration checkpoint

Branch: `feat/rune-port`. Worktree: `~/Developer/kone-rune`.
Base: `46a77768` on `dev`. Existing Electron and GPUI worktrees remain independent.
Rune initially evaluated at `7c4639dfdca7e2dfc8f2bd8ca83d69ba05557d24`; pin advanced to the immediate upstream fix `50feb4f` for a missing ScrollState field (see Cargo.toml for full revision).

## Authorized scope

Port the actual app to Rune: empty launcher (no project open), projects list, project overview, Studio. Exact current Electron/Vue appearance is the acceptance target: components, geometry, typography, artwork, interactions and light/dark schemes. Do not redesign. Omit git, files, space, inbox, bench and other portals. Settings is deferred until the user explicitly authorizes it after these screens are finished.

The user explicitly authorizes frequent local milestone commits. Do not push or open a PR.

## Workstreams

- Native Rust workspace, pinned framework, fonts, theme, headless scenes and tests.
- OpenCode free workers audit and implement screens using the Vue source.
- Terra medium worker implements the Studio screen and coordinates event/state contracts.
- Terra medium worker reuses agent-core via a supervised sidecar; reads sibling reference repos before backend work.
- Orchestrator integrates, reviews and verifies each result, records gaps, captures matching-size screenshots and commits milestones.

## Acceptance / resume checklist

- [ ] `cargo check`, format, clippy and native tests pass.
- [ ] Empty launcher and real open/create/clone flows.
- [ ] Projects persist, filter, pin, forget and reopen correctly.
- [ ] Project overview matches source and loads real project/conversation data.
- [ ] Studio layout and navigation match source.
- [ ] Real provider discovery/model selection, new/resumed conversation, streaming, stop, approvals and questions.
- [ ] Sidecar startup, shutdown, error propagation and persistence tests.
- [ ] Light and dark screenshots compared with Electron at equal viewport/scale.
- [ ] No excluded views or settings implementation.
- [ ] Changed TS files checked with Oxlint; repository `bun test` completed.
- [ ] Launch/package instructions and remaining limitations recorded.

## Data handling

Use an isolated Rune development data directory. Existing conversation-store recovery assumes a single live owner, so do not open the active Electron database concurrently. Production import requires an explicit safe migration design. Existing recent projects live in renderer localStorage and do not appear automatically.

## Worker handoffs

Read the other files in this folder, `apps/rune`, and the latest git log before continuing. Worker logs are temporary in `/tmp/kone-rune-*-worker.log`; checkpoint documentation and source are the durable handoff. Check actual files/tests before marking anything complete. A rendered screen is not proof of functional or pixel parity.

## Budget interruption

User raised model-budget concern. All three built-in workers were interrupted. They were incorrectly spawned with full-history forks, which inherit the parent model despite requested Terra overrides. Do not repeat: any Terra delegation must use `fork_turns: "none"` (or a bounded positive turn count), explicit `model: "gpt-6.1-terra"`, and `reasoning_effort: "medium"`. OpenCode free workers hit provider-wide 429 quota before completing screen implementations.

Current source is an intermediate implementation, not a full port or visual parity sign-off. The latest compile checks passed before interruption, but in-progress changes must be checked again. Shader, icons/Fraunces, multi-thread reducers and packaging are in progress. Full Bun suite previously had 3588 passes and one loader error; root corrected Bun test timeout argument ordering in mcpTransport.test.ts, and all 28 tests in that file then passed. Full suite has not yet been rerun. Real isolated Codex turn smoke passed per backend worker. Reference browser captures were blank due client startup problems and must not be treated as valid Electron visual baselines. Native empty screenshot captured before latest artwork changes.

Read studio-status.md for remaining Studio gaps. Packaging was being corrected to use standalone official Node rather than nonportable Homebrew-linked Node. Run/check packaging before delivering it. Settings remains deferred.
