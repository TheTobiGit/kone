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

## Review: start-action magnet on pointer exit (`a0976f22`)

Independent read-only review of the commit that deleted the window-exit reset in `StartPointer::apply_start_pointer`. Source of truth is `apps/web/app/components/ui/magnet/Magnet.vue`: it listens to `mousemove` on `window`, so a pointer leaving the window delivers no event and the transform stays frozen at the last in-window sample. `StartActions.vue` passes padding 12, strength 9, 0.35 s in / 0.6 s out, and Rune already uses those values (not the component defaults of 2 / 0.3 s / 0.5 s).

- Result: the change matches the source. Both homes keep the pull; `reduced` and the launcher-`pending` guards still short-circuit; nothing else on the row changed.
- Numeric parity: pointer at content (548, 420) on the Create row gives -9.63889 px in Electron and rect.x 539.11 on target 548.75 (-9.64 pt) in Rune.
- The removed handler was near-inert: its reset only fired when the pointer left the page root while it was inside the magnet's 12 pt ring, and these rows sit mid-window, so a real exit (which crosses the window edge first) leaves a zero pull. Baseline (`a0976f22^`) and `a0976f22` renders of the same edge-exit path are pixel-identical (0 differing pixels at DPR 2).
- What the commit does change: a pointer leave *without* first passing the window edge (macOS Space switch, window hidden/minimised under the pointer) now freezes the pull instead of snapping it home, as in Electron. Headless stand-in for that: an out-of-window scripted move.

Capture scripts (same-size sheets, 2x, light):
- Electron: `node /workspace/parity-scratch/pw/magnet-exit.mjs light /tmp/me2-light` (alpha of `pw/hov.mjs`: viewport 1280x840, DPR 2, `page.clock`, wait for the `kone.` aria label, glide 12 steps to the row at content (548, 420), then glide to the left edge (0, 420)). It also prints the three transforms.
- Rune: `/tmp/kone-new-rune --scene empty-brand --size 1292x854 --theme light --script /tmp/magnet-exit.json --at 2.0 --snap raw.png`, cropped to (12, 16, +2560, +1680). Scripts are 12-step glides in window points (Electron + (6, 8)); `magnet-hover.json` stops on the row, `magnet-exit.json` continues to the page edge and then out, `magnet-synth.json` leaves straight from the row. `--tree` gives the exact `rect`/`target` pair.
- Sheets: `python3 /workspace/parity-scratch/start/pair.py out.png "left label" a.png "right label" b.png "footer"` (equal pane sizes, 5144x1770).
- Output: `/workspace/rune-compare/no-project-magnet-electron.png`, `no-project-magnet-rune.png`, and `no-project-magnet-rune-exit-proof.png` (baseline vs `a0976f22`, synthetic exit).

Limits: Playwright cannot take the pointer out of a page, so the Electron "after" pane is the frozen state at the last in-window sample rather than a real leave (a stray move outside the viewport would reset it, which the app never receives). Electron's rotating word renders blank under the paused clock, as in the earlier start-screen captures. Rune's harness has no pointer-leave event, so a synthetic leave is an out-of-window move.

## Rune launcher and populated home parity pass (2026-11-10)

Work is on `feat/rune-port`; visual parity is **not yet complete**. Captures below are Electron on the left and Rune on the right, at 2x, under `/workspace/rune-compare/`.

- Launcher: destination Change follows keyboard focus; repository name and placeholder align right. The Change browser has a 10 pt gutter and a 4 pt draggable thumb; `launcher-create-browser` and `launcher-more-remote` are deterministic fixtures. Create's sweep starts with the operation rather than the app clock (`launcher-create-progress`). Compare `modal-create-{browser,remote,progress,focus}-{light,dark}.png`. The browser's Rune caret remains visible; the Chromium reference hides it. Thumb dragging and track paging are covered by native tests; platform-specific scrollbar behavior remains unverified.
- Projects: rotating wordmark and start actions run on the populated page clock. The grid has matching row spacing, normal weight, keyboard focus ring, lift, direct pin/reveal/remove controls, sort arrow and shortcut keycap. Home sessions scroll and fade at the bottom. Compare `projects-{header,grid,card-rest,card-hover,card-press,focus,sort,sessions,empty}-{light,dark}.png` and `projects-repo-{light,dark}.png`. `projects-grid`, `projects-repo`, and `projects-changed` fixtures are available.
- Project cards now request a repository summary asynchronously when the list loads. Branch and diff counts render within the pocket, and changed papers rotate and fan. While the projects page is active, filesystem watches update summaries; stale initial reads are discarded. The peeking papers use source marks, springs and stagger, with a subset of VSCode file icons and a generic fallback for other file types. Compare `projects-card-changed-{light,dark}.png`.
- Remaining projects gaps include the profile chip, native tooltip behavior, icon animation fidelity, complete file-icon coverage, loading edge states, and full motion frame comparisons. The visible screenshots are useful checks, not a 1:1 sign-off.
- The prior worker's start-action navigation reset is preserved as WIP in `0b9882af`; its own review notes above apply. The separate orchestrator was interrupted after its review, so the WIP was committed without claiming that review completed.
- Validation in this pass: `cargo fmt --check`, `cargo clippy -p kone-rune --all-targets -- -D warnings`, 33 native tests, sidecar type check/build and 4 integration tests. Linux requires `LIBRARY_PATH=/tmp/kone-rune-libs` for linking against the installed xkbcommon runtime.

### Follow-up: project icon parity

- `525cdf2d` replaces the approximate Finder action path with Electron's source SVG and uses the correct 2.4 stroke for pinned project actions. `5dd36bdb` uses the same source pin for the pinned session heading. Compare `projects-card-actions-{light,dark}.png`. These captures show the profile chip is still absent in Rune.
- `9f3c056e` adds common language and image icons plus Electron's named brand overrides and strips line-number suffixes before resolving a file icon. The full VS Code icon catalog is still not covered.
- Pin/Finder/remove hover keyframe animations and browser-style tooltip presentation still differ. The refreshed sheets are settled hover captures, not proof of frame-by-frame animation parity.

### Follow-up: profile, sessions, and action slide

- `78fe4f5b` adds the home profile chip; compare `projects-profile-chip{,-hover}-{light,dark}.png`.
- `a2ebfee8` refines home session rows and actions; compare `projects-{sessions,session-hover}-{light,dark}.png`.
- `38c8afac` gives the project action column its source horizontal offset and 500/30 spring; settled hover comparisons are `projects-action-slide-{light,dark}.png`. These captures do not establish frame-by-frame parity.
- The native debug build and 34 tests passed after these changes. Part B remains open: session lazy-loading skeletons and entrance timing, card action icon animations and native tooltip presentation, full file-icon coverage, and motion/focus/empty-state verification still need work. Existing no-match sheets are `projects-nomatch-{light,dark}.png`.

### Follow-up: keyboard focus (2026-11-10)

- `b9f1bef6` applies the existing home focus refinements to the settings button, profile chip, sort control, and session rows. `cargo fmt --check`, the debug build, and all 34 native tests passed.
- Captures: `/workspace/rune-compare/projects-focus-followup-{light,dark}.png`. These are **not a parity sign-off**: the Electron capture focuses the project card, while the Rune script's three Tab presses now land elsewhere. Update the script for the changed focus order and compare equivalent states.
- Part B remains incomplete: session lazy-loading skeletons and entrance timing, card action icon animations and native tooltip presentation, full file-icon coverage, and equivalent-state motion/focus/empty-state checks remain open.

### Follow-up: project action icons (2026-11-10)

- Pin, Finder, and remove hover gestures sample the corresponding Vue keyframes on the projects poll clock, finish after pointer exit, ignore re-entry during a gesture, and rest under reduced motion. Hover starts on the icon itself, as in the source. Pin retains its pinned stroke weight.
- The action titles remain `Pin to top`/`Unpin`, `Reveal in Finder`, and `Remove`. Rune's existing `help` tooltips are the closest available: Linux uses Rune's element-centred popup and timing, macOS uses AppKit; Chromium's native title tooltip can differ in delay, placement, appearance and platform motion. Playwright page screenshots omit Chromium's native tooltip, so the sheets cannot establish tooltip parity. The animation tracks have not been frame-compared against Electron.
- Captures: `/workspace/rune-compare/projects-action-icons-{light,dark}.png` (settled pin hover). The Rune capture includes its tooltip; the Electron page screenshot omits its native tooltip. The paused Rune capture also omits the rotating wordmark, a known harness limitation.

### Part B: projects list — DONE (2026-11-10)

- The live grid now enters with HomeRecent's 340/13/0.85 spring, 60 ms stagger, 12 pt rise and 0.97 initial scale. Reduced motion rests the grid. The project card focus capture uses five Tab presses in Rune and the same card in Electron; no-match search and the existing empty, session skeleton and hover fixtures were checked as well.
- Final full-list sheets: `/workspace/rune-compare/projects-final-{light,dark}.png`. Equivalent card focus: `projects-focus-final-{light,dark}.png`; no-match: `projects-nomatch-final-{light,dark}.png`. Earlier empty and skeleton sheets are `projects-empty-{light,dark}.png` and `projects-skeletons-{light,dark}.png`.
- Remaining differences: Rune's native tooltip differs from Chromium's title tooltip; font rasterization and folder shading vary slightly. The final rest captures can catch the rotating wordmark at different phases. Grid entrance is timed from the page mount rather than each item's individual insertion, so a late asynchronous list or a search that reintroduces a card does not replay Electron's per-item entrance. Icon gestures and session skeleton entrance have not been compared frame by frame, and platform-specific focus/tooltip rendering remains unverified. The skeleton reference sheet uses a manually injected mask, not a real scroll-triggered Electron loading capture.
- Validation: debug build, formatting, Clippy and 37 native tests passed. The pre-existing Finder smile pivot edit was left uncommitted: its claimed origin override was not established by the resting computed-style probe.

## Overview top chrome (2026-11-11)

- Replaced the Studio tab with Electron's Overview and disabled Git segments; Cmd+B still summons Studio. The back control uses the reflected Hugeicons path, 12 pt magnet padding and 9 strength with the source in/out curves. The 30 pt profile chip, focus ring, hover scale, and the top row's entrances are present.
- Side-by-sides at 2x (Electron left): `/workspace/rune-compare/overview-chrome-{light,dark}.png` and `overview-chrome-{back,nav,profile}-{light,dark}.png`. The fixture uses the same non-repository project on each side; the rest of the Overview has not been ported in this pass.
- Remaining differences: Rune's profile model resolves only the system initial, not a user-supplied profile image; its profile action is inert while the profile surface is out of scope. The selected mark stays on Overview because Git is disabled, so its slide cannot be exercised. Back color changes are not separately timed to Electron's 0.18/0.25 s transitions; entrance and magnet motion have not been frame-compared. Rune and Chromium tooltips and text rasterization differ. The out-of-scope Overview body visibly differs in these full-screen sheets.
- Validation: debug build, `cargo fmt --check`, Clippy with `-D warnings`, and 37 native tests passed using `LIBRARY_PATH=/tmp/kone-rune-libs` for Linux linking.

## Overview greeting (overview-2, 2026-11-11)

- Copy matches `HomeGreeting.vue` word for word in all 12 states (loading, nonrepo, fresh, fresh-dirty, fresh-unstaged, clean, dirty, staged, dirty-no-stat, ahead, behind, diverged). Each has a fixture scene, `overview-<state>`.
- Letter-spacing resolves against the paragraph's 16 px, not the 30 px spans: −0.16 px on the "Hey," row and −0.32 px on the sentence (`HEY_TRACKING`, `BODY_TRACKING`). Text is Geist 400 at 30 px, and figures are mono 26/700.
- Project-name trigger: the Hugeicons `ArrowDown01Icon` drawn at 15 px with a 2.2 stroke, 3 px after "{name} ". The name sits 1 px in, and the sentence resumes 1 px past the chevron, using sized no-break spaces (`Message::gap`). On hover, the 6% ink pill fades in over 0.18 s, and the chevron turns ink and drops 1 px over 0.2 s ease.
- Lines: a 38.5 px pitch with a 0.5 pt top inset keeps each baseline within 1 pt of Chromium's (which lands 39 px, then 37 px apart, because the trigger's padding raises line 1).
- `text-wrap: pretty`: when the greedy wrap would leave a single word on the last line, `pretty_wrap` re-breaks the text Knuth–Plass style. It keeps the same line count, puts at least 2 words on the last line, and minimises squared slack. This reproduces Chromium's nonrepo breaks.
- Captures: `node /workspace/parity-scratch/pw/greeting-states2.mjs light|dark x` (Electron, which waits 1.6 s per state for the blur-in), `greeting-run.mjs <theme> <out> dirty hover`, and Rune `--scene overview-<state> --size 1292x854` (crop 12,16 → 2560x1680). Side-by-sides are `/workspace/rune-compare/overview-greeting-<state>-<theme>.png`, the sheets are `overview-greeting-states-<theme>.png`, and the dirty pair is `overview-greeting-<theme>.png`. Ink bounds match within 1 px in every state, both themes, hover included.
- Remaining differences:
  - Rune doesn't have Electron's per-segment blur and stagger reveal (360 ms opacity and blur, 22 ms per segment). Only the greet-rise is ported, because Rune can't blur individual spans.
  - Figures use Geist Mono. Electron's `ui-monospace` resolves per platform (SF Mono on macOS).
  - The hover pill's colour is within 1–2/255 of Electron's `color-mix`.
  - The Overview area below the greeting is out of this piece's scope. In these captures Electron shows "Not a git repository" there because its props are forced.

## Overview switcher (overview-3, 2026-11-11)

- Added the greeting picker with pinned/recency ordering, branch summaries, outside and Escape dismissal, project selection, launcher actions, and an All projects action. Launcher success closes the picker. Ctrl+Tab holds a recency-ordered dock, Shift reverses, Control release switches, and Escape or window blur cancels. Opening a project updates its local recency immediately.
- Captures: `/workspace/rune-compare/overview-switcher-{light,dark}.png`, `overview-switcher-hover-{light,dark}.png`, and `overview-cycle-{light,dark}.png` (Electron left, Rune right, 2x).
- Remaining differences: the picker and dock currently appear and disappear without Electron's springs or delayed exit; the dock folders do not scale or animate on selection and overflow does not scroll. Picker action icons are approximations, branch icon and focus-visible hover styling are absent, and long project lists are not scroll-limited. The requested All projects row is present in Rune but absent from the current `ProjectPickerModal.vue` reference. The picker anchor uses the review layout's fixed vertical offset and can diverge at other window sizes. The surrounding Overview body is still unfinished. Motion and platform-specific modifier behavior have not been frame-tested.
- Validation: debug build, `cargo fmt --check`, Clippy with `-D warnings`, and 37 native tests passed using `LIBRARY_PATH=/tmp/kone-rune-libs`.

## Overview folder (overview-4, 2026-11-11)

- Added the 1.15 corner folder, delayed 260/24/0.9 entrance, and the 0.95 inline folder at 1440 px (stacked below the greeting at 860 px). It reuses the project folder's first three change papers, file icons and spring fan. Hover exposes the Finder action and the inert Switch branch action; Finder calls the existing project reveal handler.
- Electron-left 2x comparisons: `/workspace/rune-compare/overview-folder-{light,dark}.png`, `overview-folder-hover-{light,dark}.png`, `overview-folder-inline-{light,dark}.png`, and `overview-folder-narrow-{light,dark}.png`. These use the non-repository fixture; the browser fixture did not provide an equivalent dirty repository, so the paper fan and branch action have not been compared side by side. The surrounding changes panel remains outside this piece.
- Remaining differences: folder gradients, inset shadows, text rasterization and Finder glyph differ slightly from Chromium; the entrance and fan springs have not been frame-compared. The actions do not reveal on keyboard focus as Electron's `:focus-within` does, and Rune's hidden action is unavailable until hover. Switch branch is intentionally inert. Platform-specific reveal behavior was not exercised in the headless capture.
- Validation: debug build, `cargo fmt --check`, Clippy with `-D warnings`, and 37 native tests passed using `LIBRARY_PATH=/tmp/kone-rune-libs`.

## Overview changes panel (overview-5, 2026-11-11)

- Replaced the placeholder with staged and changed lanes, file cards and diff totals, dots, hover actions, and per-project persisted fold toggles. Controls for out-of-scope actions are inert. Overview, Space, Files and Git tabs are drawn; Git dims for a non-repository. The initial overview status read attaches file modification times so the panel sorts recent edits first, then path.
- Captures at 2x, Electron left: `/workspace/rune-compare/overview-changes-{light,dark}.png`, `overview-changes-fold-{light,dark}.png`, and `overview-changes-hover-{light,dark}.png`. The Electron panel and greeting props were set to match the deterministic `overview-dirty` fixture; its folder remains the non-repository fixture. The fold capture leaves Electron's pointer on the header while Rune's pointer leaves it.
- Remaining differences: this is not 1:1. Fold and action reveal are immediate, not animated; the CountUp starts on the overview clock rather than the arrival of git data. Empty artwork is approximate and lacks the clean check and branch pill; overflow is text rather than a fanned bundle. Deleted and new card variants, card hover, focus-within action reveal, accurate action icons and dot sampling beyond 24 files remain incomplete. The loading branch renders no panel, matching the current Vue panel; no separate loading skeleton is present. The dark sheet shadows and positioning are approximate. Live status refreshes do not currently refresh modification times. Surrounding greeting/folder and session fixture differences are visible in these captures.
- Validation: debug build, `cargo fmt --check`, Clippy with `-D warnings`, and 37 native tests passed with `LIBRARY_PATH=/tmp/kone-rune-libs`. Sidecar type check and build passed.

## Overview switcher follow-up (overview-3b, 2026-11-11)

- Removed All projects, added static reference Hugeicons, branch glyph, row hover and focus fills, action hover arrows, a 35vh scroll viewport, and greeting-relative positioning. Compared at 1280×840 and 1000×700 against the reference on port 3004.
- Captures: `/workspace/rune-compare/overview-switcher-fix-{light,dark}.png` and `/workspace/rune-compare/overview-switcher-fix-hover-light.png` (Electron left, Rune right, 2x).
- Remaining differences: the picker still lacks UiModalShell's 420ms CSS-keyframe entrance and delayed exit. Rune's shadow API cannot express the CSS negative spread and the resulting shadow is visibly stronger. Native window inset and surrounding Overview differences remain; scrollbar appearance and long-list interaction have not been visually verified.
- Validation: debug build, `cargo fmt --check`, Clippy with `-D warnings`, and 37 native tests passed using `LIBRARY_PATH=/tmp/kone-rune-libs`.

## Dev sync: start screen (devsync-1, 2026-11-11)

- Removed the empty home's rotating wordmark; Settings remains in the top-right. The shared start actions now use the current Hugeicons paths at 18 pt and 1.7 stroke, with no hover icon gestures. Magnet, loading, entrance, and action behavior are retained. The populated home's existing wordmark is outside this piece.
- Electron-left, Rune-right 2x captures: `/workspace/rune-compare/devsync-start-{light,dark}.png` and `/workspace/rune-compare/devsync-start-hover-light.png`, against the reference server on port 3004.
- Remaining differences: text and SVG antialiasing vary slightly between renderers; the animated plasma's noise and phase differ between captures. Settings remains inert as requested; Rune's tooltip differs from Chromium's native tooltip.
- Validation: debug build, `cargo fmt --check`, Clippy with `-D warnings`, and 35 native tests passed with `LIBRARY_PATH=/tmp/kone-rune-libs`.

## Dev sync: launcher modals (devsync-2, 2026-11-11)

- Removed the scrim backdrop blur and the create/clone content morph blur. The launcher clock samples the shared frame's 240 ms opacity-only scrim, 420 ms card keyframes (including the 45% opacity keyframe), and 240 ms exit; reduced motion uses the source's 1 ms animation duration. Exit still waits 240 ms before unmounting.
- Electron-left, Rune-right 2x rest captures: `/workspace/rune-compare/devsync-modal-{create,open,clone}-{light,dark}.png`, against port 3004. Motion note: the card rises 12 pt from scale 0.96 with the source overshoot, then exits down on the source ease-in; these stills do not establish frame-by-frame parity. Rune samples on its poll clock rather than Chromium's compositor, and the two can differ by a frame.
- Remaining visible differences: Rune's caret appears in captures while Playwright hides Chromium's, and Rune's open-browser scrollbar remains visible in the rest capture while Chromium's is hidden. Text/SVG antialiasing and plasma phase vary. The existing browser has no repository metadata from the sidecar, and platform-specific rendering remains unverified.
- Validation: debug build, `cargo fmt --check`, Clippy with `-D warnings`, and 35 native tests passed with `LIBRARY_PATH=/tmp/kone-rune-libs`.

## Repeatable screenshot comparisons

The orchestrator pre-captures Electron references for each upcoming piece into `/workspace/rune-ref/<piece>/`; workers use those files instead of capturing Electron themselves. The reference server must already be running from the separate `kone-dev-ref` worktree at `http://127.0.0.1:3004`. It is not modified by these scripts. Install `playwright-core` where Node can resolve it, or set `PLAYWRIGHT_CORE` to its module directory; set `CHROME_PATH` if Chrome is not `/usr/bin/google-chrome`. Stitching requires Python Pillow.

From the repository root, for example:

```sh
cargo build -p kone-rune
SCENES=empty-brand,empty-brand-hover,launcher-create,launcher-open,launcher-clone
# Orchestrator, once per piece:
node apps/rune/scripts/parity/capture-reference.cjs start-launcher "$SCENES"
# Worker:
python3 apps/rune/scripts/parity/capture-rune.py /workspace/rune-captures/start-launcher --scenes "$SCENES"
python3 apps/rune/scripts/parity/stitch.py start-launcher /workspace/rune-captures/start-launcher --scenes "$SCENES"
```

Both capture commands write `<scene>-<theme>.png` for light and dark at 1292×854 pixels (1x); the stitcher checks dimensions and writes labelled Electron-left sheets to `/workspace/rune-compare/<piece>-<scene>-<theme>.png`. Rune renders strictly serially with a 180-second per-capture timeout (`--timeout` changes it); build first so the binary is current. `--scenes` accepts the named Rune fixtures in `main.rs`, plus `empty-brand-hover`. Reference capture currently maps `empty-brand`, `empty-brand-hover`, `launcher-create`, `launcher-open`, `launcher-clone`, `launcher-more`, and the studio-4 column-head scenes `studio-column-head`, `studio-column-head-hover`, `studio-column-head-tooltip`, `studio-column-head-meter-{calm,warm,full,open}`, `studio-column-head-handoff`, `studio-column-head-dormant`, and `studio-column-head-terminal-live`; it rejects other names. Studio-head references open the 3004 Overview, summon Studio with Control+B, and inject token usage, a worktree path, handoff marks, a dormant pane, or a terminal live-process pill as needed. Add explicit reference setup and matching hover scripts for a new piece before capturing it. The hover example glides over the first start action; other hover states need their own matching setup. The Rune image includes its window frame, so expect a small content offset from the browser viewport; prior 2x parity work cropped that frame. Animated artwork and font rasterization can also differ between renderers.

## Dev sync: projects (devsync-3, 2026-11-11)

- Removed the populated home's rotating wordmark from the leading header slot. Search, sort, the inert Settings control and profile remain in the trailing slot. Project pin, Finder and remove actions now render their settled Hugeicons paths without hover gestures; their existing behavior and action-column motion remain intact. Search and sort already use the source glyphs and sizes, and the shared start actions were synced in devsync-1.
- Electron-left, Rune-right 2x captures against port 3004: `/workspace/rune-compare/devsync-projects-{light,dark}.png` and `/workspace/rune-compare/devsync-projects-hover-light.png`. The reference server and Rune review fixture use different session rows, identities and times, so those parts of the sheets do not compare equivalent data.
- Remaining differences: folder shading and text/SVG antialiasing vary slightly; Rune tooltips differ from Chromium's native titles. Existing session fixture differences are visible in these captures. Platform-specific rendering remains unverified.
- Validation: debug build, `cargo fmt --check`, Clippy with `-D warnings`, and 35 native tests passed with `LIBRARY_PATH=/tmp/kone-rune-libs`.

## Dev sync: Overview chrome (devsync-4, 2026-11-11)

- The existing four 84 pt segments and Overview pill match the current reference geometry. Space, Files and Git are inert and dimmed in every project, per the owner preference; the pill remains on Overview because the other surfaces are not ported.
- Electron-left, Rune-right 2x non-repository captures: `/workspace/rune-compare/devsync-overview-chrome-{light,dark}.png` and `devsync-overview-chrome-hover-{light,dark}.png` (hover over Overview), against port 3004.
- Differences: Electron displays Space and Files enabled and displays Git enabled in repositories; Rune dims all three. Surrounding non-repository artwork, session identities, and renderer antialiasing also differ. No pill transition to another surface is observable while those tabs are disabled.
- Validation: debug build, `cargo fmt --check`, Clippy with `-D warnings`, and 35 native tests passed with `LIBRARY_PATH=/tmp/kone-rune-libs`.

## Dev sync: Overview greeting (devsync-5, 2026-11-11)

- The welcome row alone uses the 400 ms rise. Body words use the 420 ms word-in curve, 6 pt rise and 35 ms stagger; the project trigger moves as one unit and retains its hover pill. Segment content and occurrence keys retain unchanged Rune segments across updates, and later additions omit the page entrance delay. Reduced motion rests both animations.
- Electron-left, Rune-right 2x dirty rest and name-hover sheets: `/workspace/rune-compare/devsync-overview-greeting-{light,dark}.png` (rest above hover), against port 3004.
- Remaining differences: Rune combines some adjacent Vue segments when assembling copy, so an update can reanimate more words than Electron; departing segments disappear immediately rather than lifting out over 120 ms. Rune samples on its poll clock and draws animated words as separately painted copies of the paragraph, so individual frames and performance can differ from Chromium. The settled fixture cannot freeze a comparable entrance frame; the entrance has not been frame-compared. Font rasterization and the surrounding Overview surfaces differ.
- Validation: debug build, `cargo fmt --check`, Clippy with `-D warnings`, and 35 native tests passed using `LIBRARY_PATH=/tmp/kone-rune-libs`.

## Dev sync: Overview folder (devsync-6, 2026-11-11)

- Synced shared folder pocket and paper shadows to the current ProjectFolder: black 6%/7% in light, sunken 14% inset, 16% pocket drop and 18% paper drop in dark. Added the pocket inset highlights, corrected the Finder path, and made the Finder and inert branch controls keyboard focusable with focus-within action reveal.
- Electron-left, Rune-right 2x dirty repository rest and hover captures: `/workspace/rune-compare/devsync-overview-folder-{light,dark}.png` and `/workspace/rune-compare/devsync-overview-folder-hover-{light,dark}.png`. A throwaway Git repository has matching staged and unstaged changes; the browser fixture's Git state was populated from those changes because its web bridge does not read the local repository. Switch branch remains inert in Rune.
- Remaining differences: Chromium and Rune rasterize text, SVGs, gradients and shadows slightly differently; surrounding Overview content also differs. The existing spring entrance and fan parameters were retained, but were not frame-compared. Platform Finder reveal was not exercised. The narrow inline variant retains overview-4's layout.
- Validation: debug build, `cargo fmt --check`, Clippy with `-D warnings`, and 35 native tests passed with `LIBRARY_PATH=/tmp/kone-rune-libs`.

## Overview change cards (overview-6, 2026-11-11)

- Cards now render the file icon, deterministic diff marks, 0.7 s counts, new/empty/deleted treatments, black source-opacity shadows, keyboard focus and inert hover targets. Overflow occupies the final grid slot and displays the four-paper +N bundle with a hover fan. `overview-cards` exercises both lanes, variants and overflow.
- Electron-left, Rune-right 2x captures: `/workspace/rune-compare/overview-cards-{light,dark}.png`, `overview-cards-card-{light,dark}.png` and `overview-cards-bundle-{light,dark}.png`. Electron's panel props are injected to match the fixture; its folder still uses the browser's non-repository fixture.
- Remaining differences: hover lift, shadow and fan snap to their endpoints instead of using the source easing; reduced-motion behavior is therefore also incomplete. Deleted outlines and empty placeholders are made of straight dashes, and the deleted strikethrough is approximated. Bundle label centering and paper rotation are approximations; Rune's partial file-icon catalog and renderer antialiasing differ from Chromium. CountUp uses the overview clock rather than starting on each card's data arrival. The surrounding greeting wraps differently, shifting the lanes vertically, and the folder and navigation are outside this piece. The source card has no explicit active transform; card and bundle activation is inert.
- Validation: debug build, `cargo fmt --check`, Clippy with `-D warnings`, and 35 native tests passed with `LIBRARY_PATH=/tmp/kone-rune-libs`.

## Overview sessions (overview-7, 2026-11-11)

- Overview now confines the shared session list to its own scroll viewport, with a 44 pt bottom fade, sticky PINNED/RECENT bands and the existing row/open/pin/archive/hold-delete behavior. The shared lazy batch and skeleton mask now run on Overview as well; project changes reset the batch. The selected metric uses the source's black 8% 0 1px 2px shadow. Space and Files now have their enabled appearance while remaining inert; Git follows repository availability.
- Electron-left 2x comparisons: `/workspace/rune-compare/overview-sessions-{light,dark}.png`, `overview-sessions-hover-{light,dark}.png`, `overview-sessions-scroll-{light,dark}.png`, and `overview-sessions-skeletons-{light,dark}.png`. The skeleton reference is a manually applied source-class mask on the recent rows with its shimmer paused at 200 ms; its pinned group was removed for visibility, so its metric switch is absent. Rune's review identities differ from the reference server's identities. Scrolled captures use different input methods and may stop at slightly different offsets.
- Remaining differences: sticky handoff uses measured fixed row geometry and a separately painted header, rather than browser sticky layout; unusual text wrapping or dynamic row heights can move the handoff. Row action/identity reveal snaps instead of the source crossfade, slide and magnet motion, and hold-delete lacks the source progress animation. Session entrance and metric-swap motion are not reproduced. Skeleton gradients are sampled approximations of the CSS shimmer, and motion was not frame-compared. Renderer text/SVG antialiasing and the surrounding nonrepository artwork differ; the reference fixtures' guest faces and names differ from Rune's.
- Validation: debug build, `cargo fmt --check`, Clippy with `-D warnings`, and 35 native tests passed with `LIBRARY_PATH=/tmp/kone-rune-libs`.

## Overview away-thread pills (overview-8, 2026-11-11)

- Added an Overview-only bottom-right stack for running and unseen settled Studio turns, ordered by turn start, with provider marks, title, elapsed time after 15 seconds, hover lift and dismiss, and click-through to Studio. Dismissal lasts for the current turn; a new send resets it. Settled turns seen in Studio are suppressed. The capsule has no backdrop blur. `overview-pills` provides running and settled examples.
- Electron-left, Rune-right 2x captures using the actual Vue component with injected fake blocks: `/workspace/rune-compare/overview-pills-{light,dark}.png` and `overview-pills-hover-{light,dark}.png`. The surrounding Overview fixtures and session identities differ.
- Remaining differences: Rune's activity model does not yet expose plan tasks, progress or named tool activity to this view; running pills say Working and stay narrow. The working orb is a static outline approximation rather than Electron's animated canvas; failed/interrupted badges and labels are incomplete. Thread titles are initially taken from the sent prompt, not the generated working title; long titles do not ellipsise like CSS. Capsule color uses an sRGB approximation of Electron's oklab mix. The enter/exit spring, status crossfades, meta/close fade and width transition are not implemented; hover lift animates. Keyboard focus does not reveal the dismiss control. The elapsed clock uses whole seconds and the native font instead of the source mono slot. Platform rendering and click/dismiss behavior were not exercised in the screenshots.
- Validation: debug build, `cargo fmt --check`, Clippy with `-D warnings`, and 35 native tests passed with `LIBRARY_PATH=/tmp/kone-rune-libs`.

## Overview final pass (overview-9, 2026-11-11) — INCOMPLETE

- Added page-level changes and sessions entrance delays (130 ms and 230 ms), with reduced motion settled. Existing greeting and folder entrances remain in place.
- Captured Electron-left/Rune-right 2x whole-page dirty, clean, non-repository, loading and fresh fixtures as `/workspace/rune-compare/overview-final[-clean|-nonrepo|-loading|-fresh]-{light,dark}.png`, and the requested `overview-states` names. Electron's greeting and panel props were injected; its folder, repository navigation and sessions still use the browser fixture, so these captures do not compare identical data throughout.
- Remaining differences: the changes and session entrances animate entire blocks, not the reference's separately staggered headers, cards and rows. The carried overview-6 and overview-7 differences above remain, including count-up timing, greeting wrapping and departing segments, card detail and icons, session action/identity and metric animations, sticky handoff and skeleton shimmer. Full keyboard focus order, Escape behavior, resize and state transitions were not verified end to end. Away-thread pill differences from overview-8 also remain. Overview is not ready for a 1:1 DONE sign-off.
- Validation: debug build, `cargo fmt --check`, Clippy with `-D warnings`, and 35 native tests passed with `LIBRARY_PATH=/tmp/kone-rune-libs`.

## Studio plane shell (studio-1, 2026-11-11) — INCOMPLETE

- Studio now fades over the underlying page on summon and dismissal, refuses entry when there are no projects, and preserves the page to return to. Escape first closes the picker or composer. The vertical column-move gesture shows the source refusal text; existing saved row mounting and row shortcuts remain. Added `studio-solo-review` for a resting one-pane comparison.
- Settled one-pane comparisons at 2x, Electron left: `/workspace/rune-compare/studio-plane-{light,dark}.png`. The reference uses `/review/kone` and Rune uses the review fixture; their thread state and artwork differ.
- This is not a 1:1 completion: the fade uses smoothstep rather than CSS ease and has not been frame-compared; the page under the plane follows Rune's selected project when changing rows. Camera movement still uses scrolling rather than the source 340 ms transform; Studio Overview, row headers and the two-row overview are not implemented. The refusal lacks the source enter/exit animation. CodeGolf remains unwired, and the strip, chooser, composer and orb differ. Mid-summon and two-row captures are outstanding. Reduced-motion timing and end-to-end keyboard behavior remain unverified.
- Validation: debug build, `cargo fmt --check`, Clippy with `-D warnings`, and 35 native tests passed with `LIBRARY_PATH=/tmp/kone-rune-libs`.

## Studio bare board (studio-2, 2026-11-11) — INCOMPLETE

- Added the centered project folder, path, three chooser rows, per-option magnet and floor plasma; New thread opens a thread. Terminal and Scratchpad are drawn but inert. Added the `studio-bare-board` fixture. CodeGolf is connected to empty thread panes using separate effect marks and per-slot clocks; the compositor freezes inactive slots.
- Electron-left/Rune-right 2x captures: `/workspace/rune-compare/studio-bare-board-{light,dark}.png` and `studio-bare-board-hover-{light,dark}.png`.
- Remaining differences: chooser icons are text approximations, shortcut keycaps and folder geometry differ, home paths are not abbreviated, and the chooser's positioning and plasma phase/tuning differ. The folder hover treatment and source plasma entrance are not reproduced. CodeGolf positioning, opacity and motion have not been matched frame by frame; inactive panes and visibility transitions need further end-to-end verification. The existing studio shell and composer differences remain.
- Validation: debug build, `cargo fmt --check`, Clippy with `-D warnings`, and native tests with `LIBRARY_PATH=/tmp/kone-rune-libs`.

## Overview greeting and cards follow-up (overview-fix-1, 2026-11-11) — INCOMPLETE

- Matched the body line height to 1.25, split several sentence segments at the reference boundaries, and allowed the separately rendered diff counts to wrap between them. Card count clocks now start when a card first appears and reset when its change disappears or the project changes. Adjusted the empty dash and deleted name baseline. The serial Rune capture script accepts `--scale`.
- Settled Electron-left, Rune-right 2x captures: `/workspace/rune-compare/overview-fix-1-{light,dark}.png`. The greeting wraps like this fixture, but the staged card is still about 10 CSS px too high in Rune. The browser folder uses a different repository fixture.
- Remaining: departing greeting segments still vanish; some adjacent segments still differ from Vue. The lane shift remains, as do exact deleted borders/strikethrough, empty dash, bundle placement and rotation, full file-icon coverage, card hover motion, and individually staggered page entrances. Count clocks do not restart on lane fold/reopen. Motion was not captured at several timestamps or frame-compared. This is not a 1:1 sign-off.
- Validation: debug build, `cargo fmt --check`, Clippy with `-D warnings`, and 35 native tests passed with `LIBRARY_PATH=/tmp/kone-rune-libs`.

## Overview sessions follow-up (overview-fix-2, 2026-11-11) — INCOMPLETE

- Replaced the whole-session entrance with separately animated section headers and staggered rows, using the source 300 ms curve, 14 pt row rise, 0.985 starting scale and 30 ms stagger. Lazy rows enter settled and reduced motion skips the travel.
- Electron-left/Rune-right 2x settled comparisons: `/workspace/rune-compare/overview-fix-2-{light,dark}.png`. The reference and Rune use different session data and identities.
- Remaining: this does not finish the requested piece. Row action and identity crossfades, magnet motion, delete-hold progress, metric swap, exact shimmer, and measured sticky handoff remain as described under overview-7. Entrance timing has not been frame-compared; its handling of late data and reduced motion may differ. The surrounding overview also differs. No motion timestamps were captured.
- Validation: debug build, `cargo fmt --check`, Clippy with `-D warnings`, and 35 native tests passed with `LIBRARY_PATH=/tmp/kone-rune-libs`.

## Overview greeting and cards follow-up (overview-fix-1b, 2026-11-11)

- Moved the dirty changes panel down 10 pt, split the fresh-repository staged greeting at the Vue segment boundaries, and applied the source lane-header and individual tile entrance delays. Folding a lane clears its cards' CountUp start times so reopening starts them again. Card hover lift now uses the source spring-like easing.
- Settled Electron-left/Rune-right 2x comparisons: `/workspace/rune-compare/overview-fix-1b-{light,dark}.png`. The Electron folder fixture differs from Rune's.
- Remaining: departing greeting segments still vanish rather than lift out; bundle placement and rotation, deleted outlines and empty dash are approximations. File icons use the existing generated VS Code catalog, not a newly verified copy of all Electron assets. Fold animation and multiple timestamp comparisons remain unverified; entrances use the page clock and may differ for late-mounted lanes. The 10 pt adjustment is fixture-based and has not been verified across all responsive layouts. This pass does not establish 1:1 parity.
- Validation: debug build, `cargo fmt --check`, Clippy with `-D warnings`, and 35 native tests passed using `LIBRARY_PATH=/tmp/kone-rune-libs`.

## Overview sessions follow-up (overview-fix-2b, 2026-11-11)

- Added eased row identity expansion and the action/tally crossfade, action magnet offsets, a timed delete wash and 850 ms automatic confirmation, and the out-in metric swap. Sticky section bands now use Rune's `sticky_top`, which follows actual laid-out group boundaries and handles the handoff without a fixed row count or a separate overlay. The serial capture tool accepts `--script` and `--at` for input and time sampling.
- Electron-left/Rune-right 2x captures: `/workspace/rune-compare/overview-fix-2b-{light,dark}.png`, `overview-fix-2b-hover-{50,150,350}ms-{light,dark}.png`, and `overview-fix-2b-scroll-{light,dark}.png`. The reference and native review data have different identities. The reference clock and capture setup do not guarantee the same initial hover frame; scroll offsets are not precisely synchronized.
- Remaining differences: the skeleton shimmer is still the existing sampled gradient approximation. The action magnet only tracks pointer moves delivered inside the row, rather than window-wide moves; its behavior and the metric swap have not been frame-verified. Delete does not yet support keyboard hold or animate wash retraction on cancellation. Identity badge shading and renderer antialiasing differ, and the hover captures do not establish frame-exact timing. The sticky header's fade and dynamic-size handoff need further verification across layouts. The surrounding Overview artwork differs.
- Validation: debug build, `cargo fmt --check`, Clippy with `-D warnings`, and 36 native tests passed with `LIBRARY_PATH=/tmp/kone-rune-libs`.

## Overview pill activity follow-up (overview-fix-3, 2026-11-11)

- Studio item snapshots now retain status and structured plan tasks. Away pills derive a native-plan task and progress, show named tool activity beside it, use wider task capsules, distinguish interrupted and failed outcomes, and reveal dismissal on keyboard focus. The running outline rotates; it is not the source canvas orb. `overview-pills` exercises a task and read tool. Electron-left 2x comparisons: `/workspace/rune-compare/overview-fix-3-{light,dark}.png`.
- Remaining differences: kone-managed tasks and subtasks, full source tool vocabulary, generated titles, truncation, mono elapsed time, exact oklab colors, the canvas orb, enter/exit springs, status crossfades, width and close/meta transitions remain unmatched. The rotating outline is an approximation. Serial native captures sampled 100, 300 and 600 ms, but no equivalent reference motion sequence was captured; these do not prove motion parity. End-to-end keyboard order, Escape, resize and loading/non-repo/fresh/clean transitions were not verified in this pass. Surrounding fixture data differ. This is not a 1:1 sign-off.
- Validation: debug build, `cargo fmt --check`, Clippy with `-D warnings`, and 37 native tests passed with `LIBRARY_PATH=/tmp/kone-rune-libs`.

## Studio thread columns (studio-3, 2026-11-11)

- The solo leading pad accounts for the 14 pt seam; multi-column rails use the source half-viewport trailing pad. Focus navigation computes a centred horizontal offset from saved widths and seams. Width and zen controls retain the existing persisted pane data; the width control now recentres after cycling. Index dashes are centred and use the source widths and spacing. Column tools reveal on hover/focus; seams have the source 14×28 pt target and hover treatment. Seam activation opens an insert card, with thread insertion and inert Terminal/Scratchpad rows. Escape closes the card first. Added `studio-three-review`; the existing `studio-solo-review` already supplies the requested resting-orb fixture.
- Electron-left/Rune-right 2x captures: `/workspace/rune-compare/studio-columns-{light,dark}.png`, `studio-columns-three-{light,dark}.png`, and `studio-columns-hover-{light,dark}.png`. The three-column Electron capture injects two dormant pane entries into the source registry because the app prevents multiple blank threads; fixture identities and thread content differ from Rune.
- Remaining differences: the insert card uses approximate icons, band shape and placement, lacks outside-click and scroll dismissal and its motion is not reproduced. Unfocused columns use the source opacity and scale but do not apply saturation or animated transitions; dormant content differs. Width changes and scrolling snap rather than animate, and free-scroll release does not focus or snap the nearest column. The width control is a preset button rather than a draggable resize handle. Dash, control and seam transitions, keyboard focus order and resizing at multiple viewport widths have not been frame-verified. The existing composer, artwork and Studio shell differences remain; these captures do not establish 1:1 parity.
- Validation: debug build, `cargo fmt --check`, `cargo clippy -p kone-rune --all-targets -- -D warnings`, and 37 native tests passed with `LIBRARY_PATH=/tmp/kone-rune-libs`.

### studio-4 progress

Added deterministic meter, dormant, terminal-live and tooltip scenes and initial header rendering. Meter arc rendering, popover styling/placement, delayed tooltips, host data and actions still need parity work. Comparisons are in `/workspace/rune-compare/studio-4-studio-column-head-*.png`.

### Studio column head follow-up (studio-4, 2026-11-12)

- Live `thread.token-usage.updated` events now route known context fill and window to the correct thread, including explicit zero; Escape closes the meter before other Studio layers. Blank and side-chat threads no longer expose inapplicable fork controls, and the side-chat brand mark and calm meter colour were corrected.
- Electron-left/Rune-right 2x captures: `/workspace/rune-compare/studio-column-head-{light,dark}.png` and `studio-column-head-hover-{light,dark}.png`. The Electron session is injected with a title, worktree and busy state; Rune's fixture has different content and composer state. Prior state captures are under `studio-4-studio-column-head-*` and were made before this follow-up.
- Remaining differences: the title does not open ThreadInfoPanel; side chat, handoff and archive actions are inert; worktree, handoff and changed-hands data are fixture-only. The meter popover lacks the source shell, rows, conditional compact action, outside dismissal, keyboard and arrival motion; restored usage is not loaded. Tooltips appear immediately and only on fork controls; hover/focus transitions and keyboard access differ. Dormant and terminal headers use approximate icons and fixture-only state. Meter state captures have not been regenerated at 2x. This does not establish 1:1 parity.
- Validation: debug build, `cargo fmt --check`, Clippy with `-D warnings`, and 38 native tests passed with `LIBRARY_PATH=/tmp/kone-rune-libs`.

- Studio 4 follow-up: corrected meter positioning and card styling, and aligned the live-thread fixture with the resting dock. The Electron dormant capture still resolves to a live thread; dormant parity remains unverified. Tooltip, handoff, terminal body, and connected avatar/position still differ in the comparisons.
- Validation: `cargo fmt --check`, `cargo clippy -p kone-rune --all-targets -- -D warnings`, and 38 native tests passed with `LIBRARY_PATH=/tmp/kone-rune-libs`.

### Studio column head comparison follow-up (studio-4, 2026-11-12)

- Matched the terminal fixture to a single terminal column, removed the thread body and orb from it, and drew the source terminal icon. Added the handoff origin line, adjusted header and seam placement, used regular header title text, and moved the fork tooltip into the visible area.
- Electron-left/Rune-right captures at 2x: `/workspace/rune-compare/studio-column-head-{light,dark}.png`, `studio-column-head-hover-{light,dark}.png`, and `studio-column-head-{tooltip,meter-calm,meter-warm,meter-full,meter-open,handoff,terminal-live}-{light,dark}.png`. Reference fixtures inject usage and worktree state; the connected identity is independently generated and differs from Rune's fixture.
- Remaining differences: the reference dormant pane reattached during both attempted captures, so dormant parity remains unverified and the old dormant comparison is invalid. Rune's connected avatar is a plain dot and its name differs. The handoff line is present but its layout and icon sizes are approximate. The tooltip is now visible below the control, rather than centered above it as in Electron; delay, focus and other tooltips remain unmatched. Meter shadow, header typography and hover transitions still differ. Terminal is a blank fixture rather than a live PTY. The title info panel, fork/archive actions, live worktree and handoff data, restored context usage, meter dismissal/keyboard/compact behavior, and other limitations from the preceding studio-4 entries remain. These comparisons do not establish 1:1 parity.
- Validation: debug build, `cargo fmt --check`, `cargo clippy -p kone-rune --all-targets -- -D warnings`, and 38 native tests passed with `LIBRARY_PATH=/tmp/kone-rune-libs`.

### Studio column head meter data follow-up (studio-4, 2026-11-12)

- Context events retain input, output, total and automatic-compaction status. The meter card conditionally shows those rows, omits remaining when the window is full, and formats small counts and percentages like Electron. The full arc is a complete circle and colour thresholds use the unrounded percentage.
- Remaining differences from the preceding studio-4 entries still apply: title info, fork/archive actions and live handoff/worktree data are not connected; tooltips, keyboard access, popover dismissal and animation, dormant state and terminal behavior are not at parity. The card does not yet offer Compact or restore usage from history. This is a partial follow-up, not a 1:1 sign-off.
