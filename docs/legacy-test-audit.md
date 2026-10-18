# Legacy code and test audit

Date: 2026-10-18. Base: `linux/desktop-shell` at `4dabad25`.

## Method and boundaries

Three parallel audits covered agent-core, the Nuxt renderer, and desktop/Git/protocol; a fourth review independently checked the changes. Removal required repository-wide symbol/reference searches, inspection of active callers and exports, and checks for Nuxt autoimports and template references. A name containing “legacy,” or a helper used only by tests, was not sufficient evidence by itself.

This is a targeted audit, not proof that every remaining module is reachable or every behavior is covered. The open same-provider handoff feature branch was not merged into this audit.

## Removal evidence

| Removed code | Evidence of obsolescence | Coverage preserved |
| --- | --- | --- |
| `readClaudePluginSkills`, `readFactoryPluginSkills` in `inventory/skills.ts` | Only definitions existed; no repository callers or public barrel re-exports. This is a private workspace package. The functions were explicitly deferred flattened scanners. Live inventory uses `discoverPlugins` and the grouped Claude/Factory discovery functions. | Added Claude installed-manifest and Factory marketplace regressions for the live grouped inventory. |
| Empty `pluginSkills` list and bounded ancestor-walk scaffold | The list was always empty; `MAX_PROJECT_ANCESTORS` was permanently one, so parent traversal was unreachable. | Existing explicit-project-only behavior test retained. |
| `detectFileMentionTrigger`, `detectSlashCommandTrigger`, `replaceComposerTextRange` and retired types | No runtime callers: only definitions and their own tests. `AgentComposer` uses `useComposerTrigger` → `detectToken`, then DOM `consumeToken`. Nuxt generated declarations were checked alongside source/template consumers. | All ten trigger grammar tests moved to `detectToken`; only the obsolete string-replacement test was deleted. |
| `thinkHasContent`, `requestOnLeft`, `requestHasHeader` | Only definitions. Active thinking display reads `segText`; `ConversationThread` reads `STYLE_SPECS` fields directly. | Existing segment and style behavior tests retained. |
| `sanitizeTerminalHistory`, `buildModeReplayPreamble` | Only definitions and wrapper tests. `TerminalManager` uses the chunk sanitizer and persistent mode tracker. | Full-buffer sanitization and combined-mode assertions moved to active APIs. The deleted plain-history wrapper case duplicates the tracker's existing empty-preamble test. |
| `CHROME_HEADER_HEIGHT_PX` | No source consumers. Active desktop chrome no longer uses this constant. | Existing chrome tests retained. |
| One unused lint suppression in `rewindConversationOnly.test.ts` | Baseline lint explicitly reported the suppression as unused. | Test and necessary assertion suppression retained. |

## Genuine defects and coverage corrections

- Project-script timeouts previously killed only the shell. Descendants could survive and keep stdout/stderr open, preventing the promise from settling. The fix uses a private POSIX process group, the Windows tree killer, and bounded hard-kill cleanup. Regression cases cover ordinary descendants, TERM-ignoring descendants, and redirected output.
- Three renderer test suites leaked an artificial `window`, making subsequent browser-aware imports order-dependent. Cleanup now restores the original slot or removes it if absent. The bridge/theme suites were also executed with a pre-existing sentinel window and with no window; both runs verify final restoration.
- The skill-shadowing test claimed to cover an eight-entry cap but supplied only one loser. It now supplies ten losers, verifies the eight-entry summary cap, and checks that all ten remain available with winner provenance.
- The stdio cancellation fixture observed `ServerResponse.close`, which Bun's `node:http` compatibility layer did not emit on client cancellation. A real Node HTTP server confirmed that the proxy cancels correctly. The fixture now observes a native request's abort signal with the same 400 ms deadline and no-response assertion. Disabling the proxy's cancellation call makes the updated test fail; production proxy behavior was not changed.
- The Droid gateway fixture replaced the shared subprocess module with only the older `probe` export. The live adapter also imports `probeResult`; preserving the module surface and stubbing both probe APIs repairs the import failure without executing real provider commands.

## Retained deliberately

- Database migrations, historical storage readers, provider quota fallbacks, protocol compatibility aliases, and their tests still serve active compatibility paths.
- Test reset seams and geometry helpers supply meaningful inputs/isolation for live APIs.
- Optional vendored lint rules and thinking-logo authoring helpers were retained because lack of a normal runtime caller does not establish that authoring/tooling entry points are obsolete.
- `disposeProjectRegistry` currently has no callers. Deleting cleanup would not resolve a possible lifecycle leak; its intended ownership and teardown need separate investigation.

## Validation and remaining blockers

No failing test is disabled or deleted to obtain a passing result. Checks use Bun 1.3.13 and each package's configured test entrypoint, including its SQLite preload where applicable.

| Check | Result |
| --- | --- |
| Full desktop suite | 465 passed, zero failures; 42 files, 1,014 assertions. |
| Full renderer suite | 1,575 passed, zero failures; 122 files, 5,286 assertions. Baseline: 1,576 passed; the one removed test only exercised retired string replacement. |
| Full protocol suite | 143 passed, zero failures. |
| Full Git-core suite | 68 passed, five process-table failures; all 73 tests retained. |
| Full agent-core suite, normal configured runner | 3,199 passed, four process-table failures; 200 files, 9,832 assertions. No exclusions, import errors, or timeouts; completed in 108.58 seconds. The earlier combined-run stall did not recur after the stale subprocess mock was repaired. |
| Targeted backend regression suites | 139 passed across seven files before the final no-response observer improvement; the configured Droid/cancellation pair then passed all 17 tests with that improvement. |
| Root lint | Passed, no diagnostics. |
| Root typechecks | All five configured tasks passed; renderer emitted a `vue-router/volar/sfc-route-blocks` resolution warning. |
| Desktop production build | Passed: generated renderer and bundled/staged Electron main and preload. External font-provider DNS warnings and large-chunk warnings remain. |
| Whitespace checks | `git diff --check` passed. |
| Root `bun run test --force` | Failed at Git-core; Turbo stopped dependent suites. Direct package runs above cover those suites separately. |

The environment's `/bin/ps` reports `fatal library error, lookup self` even outside Bun. Shell PIDs and the mounted `/proc` view use different namespaces. This blocks real process identity/group tests in Git-core and agent-core; their protection and assertions were preserved. Re-run them on a host with a working process table before treating the full suite as green.

The four remaining agent-core failures are `reaps a real marked orphan after its process-group leader exits`, `leaves a real unmarked replacement group running after its leader exits`, `reap escalates for a process group that ignores SIGTERM`, and `reap keeps signaling a verified group after its leader exits on SIGTERM`. These depend on the failing real process-table inspection; fake identity/race protections remain passing.
