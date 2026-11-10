# Current Rune port checkpoint

## Launcher modals (Create / Open / Clone) — DONE (2026-11-10)

`launcher.rs` was rebuilt from the Vue sources (`db751a6e`, `0687658e`). The Create, Open and Clone cards now match Electron at 2x in light and dark: at rest, hovered, with an error, on the More panel and mid-clone. Measured text, panel and band edges agree to within 1 device px.

- Side-by-sides (Electron | Rune) are in `/workspace/rune-compare/`:
  - `modal-{create,open,clone}-{light,dark}.png`
  - `modal-{create,open,clone}-hover-{light,dark}.png`
  - `modal-create-err-{light,dark}.png`
  - `modal-create-more-{light,dark}.png`
  - `modal-clone-progress-{light,dark}.png`
- Shell:
  - Scrim: ground at 62% with a 4 pt backdrop blur, faded over 0.24 s (0.22,1,0.36,1).
  - Card: 448 pt, bottom-right with 24 pt inset. It is `--band` with a 14 pt-radius `--panel` body scooped into it, 18 pt corners, and a 1 pt ink 8% ring. The ring is a 1 pt wider tinted pill under the card, because Rune's box-shadow was clipped by `clip_rounded`.
  - Motion: enters on a spring (300, 22, mass 0.9) from opacity 0, y 12, scale 0.96. It exits for 240 ms (`EXIT`), then unmounts. The poll-clock `launcher::tick` drives this from `AppState::poll`.
- Focus: a transparent card is inert, so it drops the open's focus request. `tick` asks for focus again when the card shows (Electron `autofocus`).
- Linux text corrections (not applied on macOS):
  - `mono_nudge`: Liberation Mono sits 0.5 to 1 pt higher in Chrome's line boxes.
  - `ARROW_RISE`: the fallback "→" (Arimo at 104.755%) rides Geist's baseline, so it is raised 1 pt.
- Scenes: `launcher-create`, `launcher-open`, `launcher-clone`, `launcher-more`, `launcher-clone-progress`. For the progress scene, `KONE_SCENE_PROGRESS` sets where the bar is caught.
- Capture scripts (Electron):
  - `/workspace/parity-scratch/pw/modal-rt.mjs` (rest)
  - `modal-state.mjs <scheme> <which> <out> <typed> <x> <y>` (type, then hover)
  - `modal-more.mjs <scheme> <out> more|progress`
  - These use real-time waits, because modal content never renders under a paused Playwright clock. Rune scripts come from `/tmp/mkscript.py`; window coordinates = Electron + (6, 8).
- Known remaining differences:
  - Rune draws a caret in captures; Playwright hides Chrome's.
  - Geist rasterizes about 1 device px taller in Rune.
  - Mac SF Mono and the system arrow fallback are uncorrected and unverified.
  - Buttons use Rune's focus ring, not Chrome's `auto` outline.
  - The destination row reveals "Change" on hover only, not on keyboard focus-visible.
  - The repo-name input is not right-aligned.
  - The browser scrollbar is Rune's indicator, not Chrome's thin 10 px gutter thumb.
  - Browser rows have no git metadata, because the sidecar returns no repo flag.
  - Enter/exit/morph motion uses the source's parameters but was not frame-compared, because Electron is not deterministic there.
  - Not captured side by side: the create sweep, the embedded browser (Change), and the More remote sub-rows.

## Start screen (no project) — DONE (2026-11-10)

The no-project start screen matches Electron 1:1 at 2x in light and dark, at rest, on hover and mid-gesture (`30196eb1`). **Next: the projects list** (`ui/projects.rs`, `--scene projects-review`).

- Side-by-sides (Electron | Rune): `/workspace/rune-compare/start-final-{light,dark}.png`, `start-final-hover-{light,dark}.png`, `start-final-hover-light-mid250ms.png`. Mean pixel difference is about 1 of 255, and is mostly text antialiasing and plasma noise.
- `ui/start_motion.rs` holds the per-frame glyph gestures: plus stems and arms, the folder (back/paper rise plus the projective perspective(70px) flap), and the GitHub tail morph and cat transform. These follow motion's keyframes (one ease per segment, transform-box fill-box, origin 50% 50%). It also holds the rotating wordmark, with springs at stiffness 300 and damping 25, motion's rest thresholds and a 0.03 s stagger.
- The start screen runs on the **poll clock**: `StartActionsState.clock`, and hover stamps `PENDING`. Headless `--script`/`--at` therefore renders hover and gesture frames deterministically. `--scene` snapshots open settled; a live app plays the entrance (`live`).
- **App-wide finding:** Electron loads only Geist 400 and Fraunces 400 (@nuxt/fonts) with `font-synthesis: none`, so every weight renders Regular. The start screen uses 400, and Fraunces is now the static `Fraunces-Regular.ttf` (opsz 14, wght 400; the variable font was removed). Other screens should also use 400. Check whether Geist Medium/SemiBold/Bold can then be dropped.
- The plasma output is premultiplied like WebGL (`vec4(col, opacity)`), with the CSS mask applied after. Do not go back to straight alpha, because dark mode gets dimmer.
- Capture method:
  - Electron: `/workspace/parity-scratch/pw/hov.mjs <scheme> <prefix> <x> <y> <ms,...>`. This is Playwright at DPR 2, 1280×840, with `page.clock`. It waits for the wordmark's "kone.", glides in with a 12-step move and pauses the clock.
  - Rune: `--scene empty-brand --script <13-step glide> --at <t> --snap x.png --size 1292x854`, cropped at (12, 16, +2560, +1680) to remove the frame band.
  - Rune holds hover while layout (the magnet offset) moves under a *still* pointer, so a headless one-jump `move` lights the hover late. Use a glide.
- The projects page should use `rotating_wordmark` too. It currently uses the static `wordmark`.
- Known remaining differences:
  - Text antialiasing: light-on-dark Geist is slightly heavier in Rune.
  - The folder flap's stroke width is not foreshortened by the projection.
  - The plasma noise grain differs slightly, because Electron caps the canvas DPR at 1.75.
  - The magnet offset resets when the pointer leaves the window, while Electron keeps it.
  - The Settings tooltip is Rune's, not Chromium's native title tooltip.

- Frame: vendored Rune at `50feb4f` adds explicit macOS traffic-light hiding and Linux undecorated edge resize through winit; Linux X11 edge resizing was verified; band double-click did not maximize in the attempted X11 check. Mac blur, button hiding, dragging, double-click and resizing need a native run.

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
