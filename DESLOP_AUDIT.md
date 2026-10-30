# Deslop audit

Base: `dev` at `b6886c16`. Scope: Claude, Codex, Cursor and OpenCode, plus shared web UI. Excludes provider-specific work for Cline, Droid and Antigravity and `apps/web/app/pages/states/`.

Ranked findings, recorded before implementation:

1. `packages/agent-core/src/adapters/CodexAdapter.ts:244-439` — approval and sandbox policy lives inside a 2,066-line session orchestrator. This couples policy review to process/session code. Extract the cohesive pure policy functions, preserve exported entry points, and verify existing adapter tests.
2. `apps/web/app/components/agent/AgentSettingsLimits.vue:36` and `apps/web/app/components/settings/ProfileBody.vue:28` — duplicated provider label tables create shotgun surgery. Reuse `utils/usageProviders.ts` without changing labels or fallback behavior.
3. `apps/web/app/components/settings/providers/ProviderCardDeck.vue:233,258`, `ProviderModelsSection.vue:271`, and `components/provider/ProviderSignInModal.vue:554,579` — negative letter-spacing conflicts with the requested design direction. Remove it in provider-facing UI; retain semantic status and actions.
4. `packages/agent-core/src/providerSignIn.ts:141` — `defaultBinary` only forwards to `defaultProviderBinary`. Remove the identity wrapper and keep the canonical call.
5. `packages/agent-core/src/AgentService.ts` (5,189 lines), `adapters/ClaudeAdapter.ts` (2,348), and `adapters/CursorAdapter.ts` (1,788) — broad mixed responsibilities. Defer larger lifecycle decomposition because it exceeds a safe 15–20 minute chunk.
6. `packages/agent-core/src/providerRuntime.ts:215` — a cold disabled provider can fall back to its internal ID as a label. Defer correcting this observable behavior under the refactor-only constraint.
7. `packages/agent-core/src/providerChildEnv.ts:31-38` — home metadata accessors have only test callers while provider code repeats defaults. Defer pending a dependency/ownership review; moving imports into low-level home helpers can introduce coupling to settings persistence.
8. `packages/agent-core/src/adapters/OpenCodeAdapter.ts:512-575` — compressed statements hinder review. Defer formatting-only churn in favor of structural cleanup.

UI audit continuation, accepted changes, verification and deferrals are recorded below as chunks complete. No claim of exhaustive runtime coverage is made.

## UI audit continuation

The UI worker read all seven requested skills and reviewed global tokens, provider settings/sign-in, settings shells and composer chrome. These are additional source findings, ranked by risk before implementation:

- `theme/themes/kone.ts:45` and `assets/css/main.css:86`: light muted text is declared as `#9c9a94`; computed contrast against declared ground is 2.58:1. Defer palette migration and 46 faint-text consumers to a dedicated accessibility pass with rendered measurements in both themes.
- `assets/css/main.css:264` and `components/provider/ProviderSignInModal.vue:284,304`: selection is disabled globally, including sign-in commands/errors. Defer changing selection behavior under the refactor-only constraint.
- `components/ui/ExchangeConnector.vue` and `ConversationThread.vue`: a decorative elbow requires observers/timers. Defer deletion until its supported conversation layouts can be inspected in the browser.
- `components/agent/AgentComposer.vue:1681` and `components/composer/composer.css:227`: permanently hidden dormant-face SVG/italic glyphs and animation are dead code. Delete them and their orphaned motion overrides; preserve visible composer behavior.
- `components/settings/SettingsPageShell.vue:124`: non-interactive uppercase slash breadcrumbs add code-path decoration. Replace with the current pane/leaf title, retain the public breadcrumb prop and section accessible label, back action and slots.
- `assets/css/main.css:237`: blanket `font-synthesis: none` may affect custom local fonts. Defer because changing font synthesis alters user-selected typography.
- Modal chrome duplication and 81 distinct color-mix percentages: defer a broader shared-shell/token migration until supported states can be visually checked.
- Decorative italics and negative tracking elsewhere: remove negative tracking in the audited provider entry points first; defer other surfaces for scoped visual review. No Instrument Serif or section numbering was found in the reviewed scope.

## Constraints and method

DeepSeek V4.1 Flash (`opencode-go/deepseek-v4.1-flash`) audits and implements bounded chunks. The orchestrator reviews diffs before accepting them. Workers load the installed relevant `better-*` and `thermo-nuclear-code-quality-review` skills. No installed `deslop` skill was found; the user's explicit indicator list supplies that judgment.

Only changed-file-related tests and oxlint run. The orchestrator serializes affected-package typechecks. No full suite, test deletion, main-branch work, force-push or merge.

## Preview baseline

Before edits, normal web SSR returned HTTP 500: Nuxt rejects `setInterval` from `useAgent.ts:startSweep` on the server. Visual inspection uses the existing desktop SPA mode rather than changing that behavior. T3 preview navigation timed out twice at 15 seconds; browser inspection falls back to the VM browser.

## Accepted chunks

- **Codex policy ownership:** moved pure approval/sandbox policy into `adapters/codexApprovalPolicy.ts` and shared JSON probes into `adapters/codexJson.ts`. The adapter shrank from 2,066 to 1,877 lines. Existing exports, function bodies, JSON parsing quirks, fallback policies and wire shapes remain intact. The task reviewer compared relocated bodies against the base and found no runtime change or import cycle. Larger lifecycle decomposition remains deferred.
- **Provider labels:** replaced both identical local tables with imports from the canonical web table. Labels, fallback expressions and rendered markup remain intact.
- **Provider presentation:** removed five negative letter-spacing declarations from provider cards, model names and sign-in actions. The shared settings shell renders one title instead of a non-interactive slash path. Final review caught truncation of names containing ` / `; dynamic callers now pass their full title explicitly, while static paths use the last segment. The full accessible section label, existing prop API, back action, note control and slots remain. The existing glyph deliberately identifies the category. No status indicators or action controls were removed.
- **Dead code:** deleted the hidden composer face/SVG/italic glyphs, its unreferenced animation and orphaned motion overrides; removed the sign-in binary identity wrapper in favor of its existing canonical function.

## Verification evidence

All implementation and review workers used `opencode-go/deepseek-v4.1-flash`, with 15-minute implementation limits. The orchestrator inspected each diff and independently ran the scoped checks below. No tests were changed or deleted.

- Codex: `bun test src/adapters/codexAdapter.test.ts src/adapters/codexLiveness.test.ts` from `packages/agent-core`: **34 passed**. Scoped oxlint passed. Package `bun run check-types`: **passed**.
- Labels: `bun test app/utils/usageProviders.test.ts app/components/settings/providersPaneLimitToggles.test.ts` from `apps/web`: **13 passed**. Scoped oxlint passed.
- Provider presentation: `bun test app/components/provider/signInMount.test.ts app/components/settings/providersPaneLimitToggles.test.ts` from `apps/web`: **10 passed**. Scoped oxlint passed.
- Deletions: `bun test src/providerSignIn.test.ts` from `packages/agent-core`: **44 passed**; `bun test app/components/thread/ThreadColumnComposer.retention.test.ts app/components/provider/signInMount.test.ts` from `apps/web`: **11 passed**. Scoped oxlint passed (oxlint does not validate CSS). A second serialized agent-core `bun run check-types` after the deletion chunk: **passed**.
- Web typechecking: `timeout 300 bun run check-types --filter=web` completed its protocol dependency but timed out on web. After stopping the costly full-app dev server, `timeout 300 bunx --no-install nuxi typecheck` exited **143**, without type diagnostics. Neither is a passing result. The corrective title chunk receives a final serialized check, recorded separately below.
- Final corrective-chunk web check: `timeout 300 bunx --no-install nuxi typecheck` after edits settled and without the full dev server: **passed, exit 0**. This validates the complete final web tree, including labels, presentation and dead-code deletions. All package typechecks were serialized.
- Title correction: the sign-in-mount, provider-pane wiring, skills and agent composable suites passed **83 tests** across four explicitly selected files; scoped oxlint passed. Vue SFC/template syntax compilation passed for all changed Vue files. No test files were changed.
- Browser: the real `SettingsPageShell.vue` and `ProviderCardDeck.vue` were mounted in a temporary isolated Vite fixture using the shipped light/dark theme tokens. Desktop light/dark and a 320px long nested shell title were inspected; no horizontal document overflow. The back button activated with Enter; Tab produced its existing focus ring; the note opened and Escape closed it. The provider deck still selects providers and card/action text computes to normal tracking. An explicit `Client A / Website` title remains whole, with zero decorative slash elements. The full desktop app could not be verified through the baseline preview. Fixture-only controls/content are not product changes, and no fixture files are committed.
- `git diff --check`: passed. No full test suite, simultaneous typechecks, excluded-state edits or provider-only excluded work.

## Review decisions

The first task review approved the Codex extraction and identical label-table reuse. Final branch review approved all other chunks but rejected name truncation in the title simplification. The explicit optional `title` prop and four dynamic callers address that finding; the orchestrator additionally preserved the skill breadcrumb's empty-string behavior. Re-review approved the correction with no code blocker. Its typecheck caution was superseded by the final web check's exit 0, confirmed by the orchestrator. Non-blocking Codex documentation consistency notes remain deferred. The audit file is intentionally part of the PR.

## Remaining work

The deferred findings above are intentional scope boundaries, not claims of acceptable long-term health. They need separate behavior changes, dependency ownership work, or a broader rendered accessibility/design pass. The audit did not establish new actionable illegal-state or layer-first-folder fixes within the selected bounded chunks; no broad folder reshuffle was attempted. Visible status pills were retained where they communicate state or offer actions; decorative-card and color-ramp simplification remains part of the broader visual pass.
