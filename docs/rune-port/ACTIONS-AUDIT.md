# Rune actions audit

Scope: launcher/start and Create/Open/Clone, projects list, project Overview, and Studio in Electron `kone-dev-ref/apps/web` (`origin/dev`) versus Rune `kone-rune/apps/rune/src`. Settings and visual work are excluded. Status describes the effect, not whether a control is drawn. OUT-OF-SCOPE means the source action enters Settings, git, space, files, inbox, or bench surfaces/actions; these remain drawn but inert by the agreed scope. Counts below count the grouped action rows in the registers, so each row is one auditable action family.

## Summary

| Screen | IMPLEMENTED | PARTIAL | MISSING | OUT-OF-SCOPE | Total |
|---|---:|---:|---:|---:|---:|
| Launcher/start | 6 | 3 | 0 | 1 | 10 |
| Projects list | 8 | 2 | 1 | 1 | 12 |
| Project Overview | 5 | 4 | 1 | 5 | 15 |
| Studio | 10 | 8 | 1 | 3 | 22 |

## Launcher/start

| Action / Electron source | Rune status and end-to-end result |
|---|---|
| Start Create/Open/Clone cards, hover and click: `components/home/HomeEmpty.vue` (actions); `components/project/CreateProjectModal.vue:98-139`; `components/project/ProjectPickerModal.vue:96-108`; `composables/useGitClone.ts` | IMPLEMENTED. `ui/empty.rs` opens modal or invokes folder dialog; `launcher.rs` submits create/open/clone RPCs and `state.rs` consumes responses into projects/navigation. |
| Create name, destination browse/selection, git/remote toggles, More, visibility and submit: `CreateProjectModal.vue:72-139,315-521`; `composables/useCreateProject.ts` | IMPLEMENTED. Inputs and options are represented in launcher state and submitted by `projects.create`; destination list/completion uses sidecar. |
| Open picker: recent-project select, new-folder submodal, cancel/outside/Escape: `ProjectPickerModal.vue:66-119,151-204` | IMPLEMENTED. `projects.open`/`projects.remember` and page navigation are connected. |
| Clone URL, destination, progress, cancel and result: `useGitClone.ts`; `CreateProjectModal.vue:135-139` | PARTIAL. RPC and per-request cancellation exist, but inspect `launcher.rs:418-626` for path/remote-field coverage before changing; the browser and sidecar do not provide Git metadata flags for listed directories, and remote subrows have capture/verification limits. |
| Create/Open/Clone keyboard submit, Escape and focus traversal: `CreateProjectModal.vue:153-190`; `ProjectPickerModal.vue:106-143` | IMPLEMENTED. Launcher key handling in `launcher.rs` consumes modal Escape/Enter and focus movement. |
| Start magnet hover/press gestures: `HomeEmpty.vue`; `components/ui/start-actions/StartActions.vue` | IMPLEMENTED. Rune pointer handlers in `ui/empty.rs` stamp and animate these gestures. |
| Global open Studio, conversation search, assistant, zoom, settings chords: `pages/index.vue:310-368`; shortcut definitions `composables/useShortcuts.ts:1-341` | PARTIAL. Rune supports selected global navigation/chords in `main.rs:1295` and `state.rs`; the Electron search/assistant/zoom and settings actions are not all implemented. Settings target is out of scope. |
| Settings/profile entry from launcher: `HomeRecent.vue:144,194`; `HomeGreeting.vue:254` | OUT-OF-SCOPE. Rune settings/profile control is inert or omitted. |
| Native browser path selection, folder double-click and path completion: `CreateProjectModal.vue:315-399`; `ProjectPickerModal.vue` | PARTIAL. Sidecar directory listing and completion are wired, but Rune browser interaction/keyboard semantics are not fully equivalent; see checkpoint's capture limits. |
| Modal dismissal by scrim, close button and cancel: `CreateProjectModal.vue:98-101,261`; `ProjectPickerModal.vue:92-119,151` | IMPLEMENTED. `launcher.rs` closes/cancels the active request and invalidates stale browser replies. |

## Projects list

| Action / Electron source | Rune status and end-to-end result |
|---|---|
| Open project row by click/Enter: `components/home/HomeRecent.vue:234`; `pages/index.vue` project open handler | IMPLEMENTED. `ui/projects.rs` calls `open_project`, loading the selected project and Overview. |
| Sort recent projects: `HomeRecent.vue:64,172`; `composables/useRecentProjects.ts` | IMPLEMENTED. Rune cycles sort in `ui/projects.rs` and persists recents through project state/sidecar. |
| Pin/unpin project: `HomeRecent.vue:123,269`; `useRecentProjects.ts` | IMPLEMENTED. `pin_project` updates metadata and persistence. |
| Reveal project in file manager: `HomeRecent.vue:286`; `composables/useReveal.ts` | IMPLEMENTED. Rune `reveal_project` routes to the sidecar reveal action. |
| Forget project: `HomeRecent.vue:303`; `useRecentProjects.ts` | IMPLEMENTED. Rune forgets the recent and persisted metadata. |
| Search/filter project rows: `HomeRecent.vue` search field and filtering | PARTIAL. Rune draws a search field (`ui/projects.rs`) but it is not connected to project filter state. |
| Sort/pin/reveal/forget context/side controls: `HomeRecent.vue:269-303` | IMPLEMENTED. Separate Rune row controls have callbacks; pointer hover only reveals the same affordances. |
| Project-card hover/pressed gesture and click: `HomeRecent.vue:234`; `StartActions.vue` | IMPLEMENTED. Hover/press are UI state; click opens project. |
| Recent session open and keyboard activation: `HomeRecentSessions.vue:338-340` | IMPLEMENTED. Rune session rows request `history.thread` and open the corresponding Studio thread. |
| Session pin/archive row menu: `HomeRecentSessions.vue:442-474` | PARTIAL. Rune supports the displayed pin/archive actions through sidecar/store, but menu parity and confirmation/hold semantics differ. |
| Session metric cost/tokens switch: `HomeRecentSessions.vue:309-317` | IMPLEMENTED. Rune toggles metric and animates the value. |
| Session delete/forget action: `HomeRecentSessions.vue:442-474` and session menu handlers | MISSING. Rune has a press-and-hold visual delete affordance in `ui/projects.rs`, but source delete semantics/confirmation and destructive effect are not equivalent. |
| Profile/settings and app-wide portals from project list: `HomeRecent.vue:144,194`; `pages/index.vue:316-365` | OUT-OF-SCOPE. Settings, inbox and assistant portal entry points are outside this piece. |

## Project Overview

| Action / Electron source | Rune status and end-to-end result |
|---|---|
| Back to projects / close project: `components/project/ProjectView.vue:150-166,594` | IMPLEMENTED. Rune back navigation clears selected project and returns to Projects. |
| Project switcher open, choose recent project, dismiss: `ProjectView.vue:127-130,129-138,797-800`; `ProjectSwitcher.vue` | IMPLEMENTED. Rune switcher state and selection update the selected project and persist recents. |
| Ctrl/Cmd+Tab project cycling: `ProjectView.vue:140-146`; `composables/useProjectCycle.ts` | PARTIAL. Rune has project switching, but the Electron cycling overlay/ordered wrap behavior is not fully equivalent. |
| Open Studio/summon from Overview and open a recent session: `ProjectView.vue:245-261`; `HomeRecentSessions.vue:338-340` | IMPLEMENTED. Rune opens the selected thread and navigates to Studio. |
| Reveal current project folder: `ProjectView.vue:267-269`; `useReveal.ts` | IMPLEMENTED. Sidecar reveal request reaches the OS file manager. |
| Greeting/profile chip: `ProjectView.vue:644`; `HomeGreeting.vue:254-285` | OUT-OF-SCOPE. Profile destination is Settings/account surface. |
| Main surface tabs: Overview, Git, Files, Space: `ProjectView.vue:194-214,626` | PARTIAL. Overview navigation works. Git, Files and Space are intentionally inert/out of scope (counted separately below). |
| Git surface and branch picker: `ProjectView.vue:175-180,271-289,731,867`; `ProjectCycleSwitcher.vue` | OUT-OF-SCOPE. Git branch actions are excluded. |
| Files surface, file open/peek and editor actions: `ProjectView.vue:182-187,491-543` | OUT-OF-SCOPE. Files and editor surface are excluded. |
| Space surface and usage actions: `ProjectView.vue:189-192,211-213` | OUT-OF-SCOPE. Space surface is excluded. |
| Overview session rows, metric switch and archive/pin: `HomeRecentSessions.vue:309-317,338-340,442-474` | PARTIAL. Rune opens sessions and switches metric, but archive/pin/confirmation actions are not all source-equivalent. |
| Overview folder/branch hover tools: `ProjectView.vue:731-742,867-878` | PARTIAL. Reveal works; branch picker is out of scope and some hover affordances remain inert. |
| Git staging, discard, commit, file peek callbacks: `ProjectView.vue:460-543` | OUT-OF-SCOPE. Git surface actions are excluded. |
| `useShortcuts` type-to-compose, global search and zoom on Overview: `useShortcuts.ts:292-340`; `pages/index.vue:316-365` | MISSING. Rune has no equivalent type-to-compose/global search/zoom behavior on Overview. |
| Escape/back and click-away for picker/peek: `ProjectView.vue:127,566,594` | IMPLEMENTED. Rune closes its switcher/overlay and returns to the correct in-scope page layer. |

## Studio

| Action / Electron source | Rune status and end-to-end result |
|---|---|
| Toggle Studio, close/leave and summon: `pages/index.vue:327-331`; `AppStudio.vue:625-627,641-653` | IMPLEMENTED. `main.rs`/`state.rs` switch page and preserve Studio state. |
| Studio overview zoom, row navigation and row selection: `AppStudio.vue:286-393,495-539,701`; `ThreadStrip.vue` | IMPLEMENTED. Rune overview, focus and selection state are handled in `state.rs` and `ui/studio.rs`. |
| New thread and start agent: `AppStudio.vue:568`; `StudioRow.vue:1187-1225,1523-1528`; `state.rs:1989,2570` | IMPLEMENTED. `agent.start` request/result flow is connected. |
| Composer draft/edit, choose provider/model/effort/mode, send: `ThreadColumnComposer.vue:143-233`; `StudioRow.vue:1041-1187`; `useAgent.ts`; `state.rs:2491-2600` | PARTIAL. Rune sends agent requests and maintains drafts/options, but attachments, mentions, slash commands, and the full Electron composer tool ecosystem differ or are stubbed. |
| Steer running agent / stop / queue send-now, edit, cancel: `useAppSteering.ts`; `ThreadStrip.vue:539-564`; `ui/studio.rs:4436-4449`; `state.rs:2600` | IMPLEMENTED. Rune sends `agent.steer` and queue methods. Verify key dispatch/queue transition details when extending. |
| Agent stream, approvals, user-input prompts and activity controls: `AgentActivity.vue`, `ApprovalPrompt.vue`; `StudioRow.vue:1453-1478`; `state.rs:2608-2626` | PARTIAL. Main event and response RPC paths exist; some interactive activity/tool controls and approval variants differ. |
| Rename Studio title: `AppStudio.vue` title editor; `useStudioPersistence.ts` | PARTIAL. Rune title editing is local state and Studio layout persistence; no equivalent durable title RPC/persistence confirmed. |
| Close pane / close thread and focus fallback: `StudioRow.vue:515-530`; `ThreadStrip.vue:661`; `useStripPaneActions.ts` | IMPLEMENTED. Rune updates layout, focused pane and persisted layout. |
| Archive thread/pane: `StudioRow.vue:530-547,821-839`; `ThreadStrip.vue:564`; sidecar history APIs | IMPLEMENTED. Rune routes archive and history cleanup through sidecar. |
| Hand-off and branch-fork pickers: `StudioRow.vue:579-679`; `useThreadHandoff.ts`; `ThreadStrip.vue:554` | PARTIAL. Provider/model handoff flow exists, but source hand-off marks, edit-fork/branch-fork chain semantics are incomplete/different. |
| Project row switcher and project-menu selection: `AppStudio.vue:324-376`; `StudioRow.vue:641-653` | IMPLEMENTED. Rune menu selection changes the project row and persists layout. |
| Insert thread/terminal/scratchpad from seams: `ThreadStrip.vue:810-869`; `StudioRow.vue:679-727` | IMPLEMENTED. Rune inserts panes and project-scoped scratchpad/terminal state. |
| Terminal input, resize, restart, close: `ThreadStrip.vue:626-646`; `useTerminal.ts` | PARTIAL. Sidecar PTY lifecycle and input/resize/restart work; full xterm keyboard, selection, paste and VT behavior are not equivalent. |
| Scratchpad edit, formatting, copy/export/clear: `useScratchpad.ts`; `ThreadStrip.vue:696,716`; Rune `ui/studio.rs` scratchpad controls | PARTIAL. Persistence/edit/format controls are present, but clipboard/export/clear affordances include stub/no-op handlers and not all effects match source. |
| Thread content toolbar actions (copy, fork, branch, scratchpad, open linked thread): `ThreadStrip.vue:696-703`; `StudioRow.vue:547-643,686-727` | PARTIAL. Some actions route to scratchpad or thread navigation; fork/branch and clipboard behavior are not all equivalent. |
| Conversation search, context meter, title info, activity panel popovers: `AppStudio.vue`; `ThreadStrip.vue:592`; source thread components | PARTIAL. Rune implements local overlays and some RPCs, but search result coverage and some info actions differ. |
| Width cycle, maximize/zen, pane drag/reorder, resize and row movement: `ThreadStrip.vue:626-646`; `useStripKeyboard.ts`; `useStripPaneActions.ts` | IMPLEMENTED. Rune updates width/zen/focus/order and persists layout. |
| Keyboard shortcuts for focus rows/panes, overview, new thread/terminal/scratchpad, move, maximize: `useShortcuts.ts:1-291`; `AppStudio.vue:495-612`; `useStripKeyboard.ts` | PARTIAL. Core focus/overview/new pane keys exist; Rune lacks Electron's configurable shortcut registry, several bindings/selection modes, and exact modifier mapping. |
| Open file, git/scratchpad portals and embedded Git actions: `StudioRow.vue:861-925,1731`; `ThreadStrip.vue:703` | OUT-OF-SCOPE. File and git targets are excluded; Rune leaves these actions inert. |
| Settings controls reached from Studio provider/account controls: `AgentComposer.vue`; `useAgentSettings.ts` | OUT-OF-SCOPE. Settings and provider setup surfaces are excluded. |
| Inbox/bench portals and related thread handoff destinations: `pages/index.vue:316-350`; `usePortals.ts`; `useBench.ts` | OUT-OF-SCOPE. Portal destinations are excluded. |
| Escape layers, outside click, tooltip hover/focus, card click and pointer movement: `AppStudio.vue`; `ThreadStrip.vue`; `useShortcuts.ts:292-300` | IMPLEMENTED. Rune layer dismissal and hover/focus handlers are wired. |
| Composer file picker/attachments, mention/skill/model menus and keyboard traversal: `AgentComposer.vue`; `useComposerAttachments.ts`; `useComposerMentions.ts`; `useComposerSlash.ts` | MISSING. Rune does not provide the complete Electron picker and attachment interaction set. |

## Proposed implementation pieces

Capture convention for every piece: take matching before and after Rune native captures at 1280×840 in light and dark, plus Electron reference at `127.0.0.1:3004` with the matching screen/state. Use existing `--scene` fixtures and add a deterministic interaction script/fixture only where needed; compare before/after behavior as well as screenshots. Actions with external effects (filesystem, agent, clipboard) require a safe fixture or stub sidecar and an explicit result assertion in the capture notes. The actions pass makes no visual redesign changes.

1. **actions-1 — Project open, switch and back navigation** — Wire/verify project row open, Overview project switcher selection, back-to-list, Studio summon/close and recent-session open end to end. Electron: `HomeRecent.vue:234`, `ProjectView.vue:150-166,127-138,245-261`, `AppStudio.vue:625-653`. Rune: `ui/projects.rs`, `ui/overview.rs`, `ui/studio.rs`, `main.rs`, `state.rs`, `project_state.rs`. Verify Projects → Overview → Studio → same thread and back using populated `projects`/`overview` and `studio-review` scenes before/after.
2. **actions-2 — Create project workflow** — Align destination picker, option toggles, validation, submit, error/cancel and resulting navigation. Electron: `CreateProjectModal.vue:72-139,153-190,261-521`, `useCreateProject.ts`. Rune: `launcher.rs`, `ui/empty.rs`, `state.rs`, sidecar project RPC. Verify create default, advanced options, invalid name, success and cancel captures using launcher scenes and a temporary directory fixture.
3. **actions-3 — Open project picker and directory browser** — Complete list/select, nested folders, completion, keyboard traversal, cancel/outside/Escape, path normalization and recent update. Electron: `ProjectPickerModal.vue:66-119,151-204`; `CreateProjectModal.vue:104-112,315`. Rune: `launcher.rs`, `state.rs`, sidecar project RPC. Verify empty/populated/nested directory fixtures with `launcher-open` and create-browser captures.
4. **actions-4 — Clone workflow and cancellation** — Match URL validation, destination/options, progress, cancel and result/error semantics. Electron: `useGitClone.ts`, `CreateProjectModal.vue:135-139,386-399`. Rune: `launcher.rs`, `state.rs`, sidecar clone RPC. Verify local fixture remote, invalid URL, progress, cancellation and successful clone with before/after launcher-clone captures.
5. **actions-5 — Projects list controls and session actions** — Connect search/filter and bring pin/reveal/forget, session pin/archive/delete confirmation, metric switch and row keyboard behavior to matching source effects. Electron: `HomeRecent.vue:64-129,172-303`; `HomeRecentSessions.vue:309-340,442-474`; `useRecentProjects.ts`. Rune: `ui/projects.rs`, `project_state.rs`, `state.rs`, sidecar history/project RPC. Verify query zero/one/many results and safe fixture session pin/archive/delete before/after projects captures.
6. **actions-6 — Overview navigation and overview sessions** — Finish project cycle shortcut behavior and session archive/pin/delete actions; ensure active row/session opens same Studio pane. Electron: `ProjectView.vue:140-166,245-261,797-800`; `HomeRecentSessions.vue:338-474`; `useProjectCycle.ts`. Rune: `ui/overview.rs`, `state.rs`, `project_state.rs`. Verify keyboard cycle wrap, open session, archive and metric state using overview capture and scripted key sequence.
7. **actions-7 — Studio agent start, send and steer** — Close any remaining gaps in start defaults, draft/send, running-agent steer, stop and queue actions. Electron: `StudioRow.vue:1187-1225,1523-1528`; `ThreadColumnComposer.vue:143-233`; `useAgent.ts`; `useAppSteering.ts`. Rune: `ui/composer.rs`, `ui/studio.rs`, `state.rs`, sidecar agent RPC. Verify with deterministic fake agent stream, recording start/send/steer/queue RPCs and Studio before/after captures.
8. **actions-8 — Studio rename, close, archive and persistence** — Make title edit durable/source-equivalent and verify close fallback, archive cleanup and restored focused pane. Electron: `StudioRow.vue:515-547,821-839`; `useStudioPersistence.ts`; `AppStudio.vue` title editor. Rune: `ui/studio.rs`, `state.rs`, sidecar `studio`/history methods. Verify rename across reload, close among multiple panes, archive with safe fixture and paired Studio captures.
9. **actions-9 — Studio hand-off and fork actions** — Complete hand-off chain selection, edit fork, branch fork, continuation and resulting thread placement. Electron: `StudioRow.vue:579-679`; `useThreadHandoff.ts`; `ThreadStrip.vue:539-564,696-703`. Rune: `ui/studio.rs`, `state.rs`, sidecar agent/history RPC. Verify against fake provider/model catalogs and deterministic fake thread responses; capture picker, confirmation and resulting pane.
10. **actions-10 — Studio pickers and composer tools** — Implement remaining file/attachment, mention/skill, slash, model/provider and keyboard picker semantics for in-scope composer actions; keep excluded destinations inert. Electron: `AgentComposer.vue`; `useComposerAttachments.ts`; `useComposerMentions.ts`; `useComposerSlash.ts`; `useComposerDraft.ts`. Rune: `ui/composer.rs`, `ui/studio.rs`, `state.rs`, sidecar protocol as required. Verify each picker open/select/cancel and submitted payload using fixture files/catalogs with before/after Studio captures.
11. **actions-11 — Studio terminal and scratchpad action parity** — Close PTY key/selection gaps and wire scratchpad copy/export/clear to source behavior; retain existing save conflict handling. Electron: `useTerminal.ts`; `useScratchpad.ts`; `ThreadStrip.vue:626-646,696,716`. Rune: `terminal.rs`, `ui/studio.rs`, `state.rs`, sidecar terminal/scratchpad RPC. Verify terminal write/resize/restart/close and scratchpad copy/export/clear with safe fixture captures.
12. **actions-12 — Shortcut inventory and polish** — Match remaining in-scope `useShortcuts` bindings, modifiers, key routing, configurable mapping where applicable, and type-to-compose; document excluded global portals. Electron: `composables/useShortcuts.ts:1-341,596-710`; `pages/index.vue:316-368`; `AppStudio.vue:495-612`; `StudioRow.vue`; `ThreadStrip.vue`. Rune: `main.rs`, `state.rs`, `ui/projects.rs`, `ui/overview.rs`, `ui/studio.rs`, `ui/composer.rs`. Verify every binding by deterministic key scripts on empty/projects/overview/studio scenes, capturing each resulting state before and after.
