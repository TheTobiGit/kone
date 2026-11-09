# Rune migration checkpoint

Branch: `feat/rune-port`. Worktree: `~/Developer/kone-rune`.
Base: `46a77768` on `dev`. Existing Electron and GPUI worktrees remain independent.
Rune pinned revision: `7c4639dfdca7e2dfc8f2bd8ca83d69ba05557d24`.

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
