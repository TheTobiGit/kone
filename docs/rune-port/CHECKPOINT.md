# Current Rune port checkpoint

Worktree `/Users/gideonsarfo/Developer/kone-rune`, branch `feat/rune-port`. User authorizes frequent local commits; no push/PR. User requires exact current Electron UI. Settings is deferred; git/files/space/other portals omitted.

## Delegation policy

Use kone MCP for ALL delegated workers/contracts. Explicit provider `codex`, model `gpt-6.1-terra`, effort `medium`. Do not use built-in collaboration subagents or Sol. OpenCode free models are preferred for bounded work when available. Tested both DeepSeek V4.1 routes: `opencode/deepseek-v4.1-flash-free` rejected free quota exhausted; `opencode-go/deepseek-v4.1-flash` rejected invalid credential. No Go route is currently labelled free in the local model catalog. Do not assume a successful spawn means a successful model turn.

Kone `agent_followup` failed with “child thread stopped while starting” on several completed workers/contracts; a follow-up queued successfully while Seth's contract was still open. Read agent inbox/list before starting duplicate work. Source is shared across workers, so coordinate file ownership.

## Implemented and checked

- Pinned Rune at upstream fix revision `50feb4fe1cd28e28e7f2c6865c59c856e9a14f64`.
- Native empty launcher, project list and overview, custom launcher dialogs and Studio thread rail.
- Exact bundled Geist/Fraunces; Geist Mono added after numeric/mono glyph review.
- Source plasma shader port to WGSL; GPU compile defects fixed and actual PNG renders. A bounded 20fps loop is attached only when focused, reduced motion handled by Rune loop engine.
- Sidecar supervises existing agent-core under standalone Node, not Electron. Isolated Rune data directory; Rust now honors `KONE_RUNE_DATA_DIR`.
- Nonblocking pipe writer, bounded JSON frames, error propagation, child reaping.
- Project recents/pin/forget/sort, repository status, home and per-project sessions, create/clone, advanced create and cancellation RPCs.
- Studio saved layouts/history, drafts/streaming state per thread, background event routing, thread focus/new/close/width, catalog provider/model pickers and effort/mode selection. Global Cmd+B/Escape and projects Cmd+K wired in main.
- Sidecar exit settles parked threads and in-flight launcher.
- macOS bundle packages checksum-verified official standalone Node and native SDK dependencies. A bundle relocated to `/tmp` was smoke-tested for sidecar initialization/headless rendering; final package must be regenerated after current changes.

## Validation so far

13 native tests passed before latest refinement pass, including two-column input/render behavior. Sidecar build, TypeScript, Oxlint and 3 sidecar integration tests passed. Full Bun suite passed 3591 tests per two workers; root first run found a pre-existing test-call syntax error (fixed) and then sidecar runner/cwd errors (fixed). Rerun at final integration. `cargo clippy -D warnings` flagged default-initializer/nested-if style issues being corrected. Run `cargo fmt --check`, clippy, native tests and full Bun suite after workers finish.

## Visual verification

Valid source and native captures in `/tmp/kone-rune-parity`. Electron/Vue reference server on localhost:3003, running from this worktree in `KONE_DESKTOP=1` mode. Browser plugin initialization fails due classic-level native ABI; standalone local Playwright used as fallback after that failure. Original reference captures were blank; do not use earlier blank images. Later captures wait for entrance animations. Native CLI `target/debug/kone-rune --scene studio-review --snap /tmp/review.png --theme light --size 1280x840` renders isolated two-pane fixtures without sidecar setup. Other scenes empty/projects/overview/studio; additional populated fixture scenes planned.

A major folder-color discrepancy was fixed by replacing linear-light `Color::mix` with `theme::mix_srgb` for CSS-authored `color-mix(in srgb,...)` stops. Do not undo this. Exact visual parity has NOT been achieved/signed off: source session avatars/rows, Studio composer/orb/row tiling and advanced controls, launcher motion/scoops/browser behavior still being refined.

## Active refinement ownership

Seth: state.rs + ui/studio.rs (next pass all project rows, column movement/zen, exact composer/art).
Noah: project_state.rs + projects/overview UI + review.rs fixtures and identity/session backend metadata.
Mira: launcher.rs + launcher-related sidecar RPC/tests (nonblocking browser, exact paths/bands/morphs/cancellation test).
Root: main.rs, ui/mod.rs, plasma.rs, theme.rs/color mixing, bridge.rs, integration/commits/testing.
