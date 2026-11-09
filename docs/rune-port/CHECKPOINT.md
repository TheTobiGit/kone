# Current Rune port checkpoint

- Frame work in progress: inset panel and backdrop added; macOS traffic-light hiding and Linux client-side resize remain unresolved.

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

## State at handoff (Codex usage limit hit, all contractors withdrawn)

Green at this commit: `cargo fmt --check`, `cargo clippy -p kone-rune --all-targets -D warnings`, 18 native tests, release build, sidecar build + `tsc`, 4 sidecar node integration tests, 6 bun tests (identity, protocol), oxlint on sidecar.

Landed since the last checkpoint:
- Studio (Seth): every persisted project row renders and the saved focused row is restored; row reorder, pane width and maximize persist; provider mark, width/maximize controls and composer control order fixed.
- Projects/overview (Noah): `review.rs` fixtures (`--scene projects-review|overview-review`) with source-generated Dicebear guest faces (`sidecar/src/identity.ts`), session rows with identity, provider mark, metadata and the cost/tokens switch.
- Launcher (Mira): directory listing routed by request id off the UI thread; closing or navigating again invalidates stale replies; per-request clone cancellation tested with two concurrent sidecar requests.
- Sidecar (root): `history.delete` with worktree cleanup; zod `protocol.ts` validates agent.start/send/steer and studio.save; frame limit raised to 64 MiB.
- CodeGolf art (Ezra): `art/codegolf.rs` + `.wgsl` compiles and is in the module tree but is NOT yet drawn by Studio (`#[allow(dead_code)]`). API: `slot(mark, focused_and_visible, color)`, `CodeGolf::begin_frame(device_key, dt, active)`, `CodeGolf::draw(device, queue, pass, site)`; pipelines keyed by (mark, format), so Studio must hand out unique marks per visible slot; colour is sRGB with alpha.

## Next steps (in order)

1. Escape layering: in `main.rs::app_key`, call `AppState::studio_key` BEFORE the global Escape branch so Escape first collapses the composer/picker to the resting orb, and only then leaves Studio. Then add the composer/picker layer handling in `studio_key`.
2. Add a `studio-solo-review` scene: one saved pane, `composer_open = false`, bundled provider/model fixture, to compare the resting orb and solo strip against `electron-studio-light.png`.
3. Wire CodeGolf into Studio's empty-thread pane (unique mark per slot, active only when focused and visible) and drop the dead_code allow.
4. Overview: the greeting and empty-state artwork still differ from Electron; sessions are close.
5. Launcher: exact icons, scooped header/body band shapes, spring morph transitions, browser double-click/path completion.
6. Regenerate captures (`target/debug/kone-rune --scene <name> --snap ... --size 1280x840 --theme light|dark`) and diff against `/tmp/kone-rune-parity/electron-*.png` (tmp is not durable: re-capture Electron with the Playwright snippet in this doc's history if gone).
7. Rerun the full Bun suite and repackage the macOS bundle (`apps/rune/scripts/package-macos.sh`).
8. Settings pane only after the user signs off on the four screens.

## Last ownership split (all withdrawn; reuse when restarting workers)

Seth: state.rs + ui/studio.rs (next pass all project rows, column movement/zen, exact composer/art).
Noah: project_state.rs + projects/overview UI + review.rs fixtures and identity/session backend metadata.
Mira: launcher.rs + launcher-related sidecar RPC/tests (nonblocking browser, exact paths/bands/morphs/cancellation test).
Root: main.rs, ui/mod.rs, plasma.rs, theme.rs/color mixing, bridge.rs, integration/commits/testing.
