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

## Chunk: settings/provider presentation simplification

Scope: `SettingsPageShell.vue`, `ProviderCardDeck.vue`, `ProviderModelsSection.vue`, `ProviderSignInModal.vue` (apps/web/app). No other file touched.

- Finding 3 (accepted): removed the four negative tracking declarations — `ProviderCardDeck.vue` `.pp__cardname` (`-0.2px`) and `.pp__pill` (`-0.1px`), `ProviderModelsSection.vue` `.pp__modelname` (`-0.1px`), `ProviderSignInModal.vue` `.picker-action` and `.signin-primary/.signin-done` (`-0.01em`). No replacement tracking value was introduced; UI text sits at `0`. The positive `0.02em` on the sign-in eyebrow is untouched.
- `SettingsPageShell.vue:100`: the trail (`group / pane / nested`, three spans, two slash spans, `crumb` object model) is replaced by one title computed from the last non-empty segment of the existing `breadcrumb` prop. `Ecosystem / Providers` reads `Providers`; `Ecosystem / Skills / foo` reads `foo`; `Workspaces / <name>` reads the name. Public props (`breadcrumb`, `breadcrumbIcon`, `label`, `scroll`, `open`), `back` event, note control, `#actions/#lede/#foot/#overlay` slots, `label ?? breadcrumb` section label, `tabindex` gating and the split masthead are unchanged. Removed `.sps__eyebrow`, `.sps__crumb`, `.sps__slash`, `.sps__pane`, `.sps__crumbglyph`; the masthead text is now `.sps__title` at 13px/500, `--ink`, unitless 1.3, with the same `--muted` glyph and no new colors, dividers, pills or helper text.
- Verification (this chunk): `bunx oxlint` on the four files — exit 0, no findings. `bun test app/components/provider/signInMount.test.ts app/components/settings/providersPaneLimitToggles.test.ts` — 10 pass, 0 fail, 43 expect() calls. Typecheck and rendered inspection are owned by the orchestrator; no browser verification is claimed here.
- Residual risk: the masthead line box grows from ~10px to ~17px (13px × 1.3), which only a rendered pane can confirm costs nothing from the fixed-height provider deck; the section aria-label still carries the full trail, so removing the visible path keeps orientation for AT but not for sighted wayfinding, which the back action covers.
