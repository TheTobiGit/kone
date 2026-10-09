# P5 design: provider and model switching (no code — design only)

Author: Dara. Sources read: t3code `ProviderSwitchService.ts` + `ProviderSelectionTransition.ts`
(`~/Developer/opensource/t3code/apps/server/src/orchestration-v2`), t3code `Orchestrator.ts`
(dispatch of queued runs, `thread.model-selection-updated` / `thread.provider-switched`
events), t3code `QueuedRunOrder.ts`, `modelSelection.ts` / `model.ts` (ModelSelection =
`{ instanceId, model, options? }`), kone `handIn.ts`, `store/handIns.ts`, `store/threads.ts`
(`setThreadSelection`, `model_selection_json`), `dispatch.ts`, `AgentService.ts` queue drain,
`useModelCommit.ts` + `useAgent.ts` (`switchProvider` → `handIn`, interrupts when busy),
`modelPicker.ts` (global last-used keys), `handoffMarkers.ts`, `rosterRecord.ts` (agent model
pin + fallbacks), gateway `appProviders.ts` / `registry.ts` (assistant target strips
structuredContent; refusals are isError text).

## 1. Where kone stands today

- A thread's committed selection is `threads.provider` + `threads.model` + `model_selection_json`
  (effort / serviceTier / contextWindow / mode). The picker persists it per thread via
  `agent:set-thread-selection`, and globally via localStorage last-used keys
  (`kone:provider/model/reasoning`; the assistant has isolated keys).
- Changing provider today calls `switchProvider` → `handIn`, which **interrupts the running
  turn** (`if (busy.value) await interrupt()`), stops the old session, writes a
  `thread_hand_ins` row (retargets the thread, drops old resume ids, sets
  `bootstrap_status = 'pending'`), and starts the target session on the same thread id. The
  next turn replays the transcript as a one-shot bootstrap. Model-only changes ride the
  running turn (every adapter takes a model change on the turn that carries it).
- Queued follow-ups are durable rows promoted in order at turn end (the drain). Nothing
  carries a per-row provider/model selection yet: every queued row runs on the thread's
  current owner.
- The timeline already marks hand-ins (`handInsForThread`, `HandoffMark` "Handed from/to").
  There is no mark for model/option-only changes between turns.

## 2. Queued switches ride delivery order at turn end via hand-in

Model it on t3code's shape, in kone's terms:

- **Each queued row carries its own selection.** When the user picks a new provider/model
  while a turn runs, the composer no longer calls `switchProvider` immediately. Instead it
  enqueues a switch row (or tags the next queued follow-up) with the full target
  `{ provider, model, effort, serviceTier, contextWindow, mode }`. Several picks queue
  several rows, in order — exactly like steers.
- **At turn end, the drain delivers rows in queue order, and a row whose selection differs
  from the thread's current owner triggers a hand-in before it runs.** This is the
  `ProviderSwitchService.plan` moment: compare row selection vs `threads.*` current;
  if equal, run as today; if different, run `handInThread` (stop old session, write the
  hand-in row, start target session on the same thread id, bootstrap pending) and then
  deliver the row into the new session. The hand-in row is the durable proof of the
  boundary, and a crash between rows resumes from the stored owner — the same guarantee
  `handInThread` already gives ("reopening starts the session that could not start").
- **Same-provider model/option changes need no hand-in.** Adapters already apply model and
  config options on the turn that carries them, so a queued row that only changes model or
  knobs on the same provider runs without stopping the session. This mirrors t3code's
  `apply_on_next_turn` vs `restart_session` / `create_with_handoff` split; kone's two
  cases are "hand-in" (provider changed) and "carry on the turn" (same provider).
- **Eligibility is checked at enqueue and re-checked at delivery.** `handInEligibility`
  (unknown thread, no-op target) refuses immediately at pick time so the composer can
  disable or explain; the drain re-checks before each hand-in because an earlier queued
  switch may have already moved the thread there (second identical pick becomes a no-op,
  not an error — it just runs).
- **Rejected switches never strand a turn.** If the target provider is unavailable at
  delivery, the row fails with the reason in its turn error and the thread stays on its
  current owner (t3code's `reject` plan). The queue continues past it.

## 3. Remembering options per provider + model

Today the memory is two places with different keys: per-thread `model_selection_json`
(exact) and one global last-used triple (lossy — switching provider forgets the effort you
used with that provider last time).

- Add a store table, e.g. `provider_model_options(provider, model, effort, service_tier,
  context_window, mode, updated_at)`, upserted whenever a turn is sent or a picker choice
  commits. Key is provider + model; value is the knob set that ran with it.
- Read path, in order: explicit pick on the row/thread → remembered knobs for that
  provider + model → thread's current knobs → global default. So returning to
  codex/gpt-x restores the effort you used with it, not the effort from the claude turn in
  between. The assistant's isolated last-used keys stay as they are (a different scope:
  assistant vs board).
- IPC getter/setter plus inclusion in the hand-in target fallback (`handIn.ts` already
  falls back to `meta.selection`; remembered knobs fill what neither the row nor the
  thread names). Backend only — no settings UI in this phase (same split as the P1 budget
  cap: store + IPC getter/setter, UI later).

## 4. Timeline event for model/option changes

- Hand-ins already mark the boundary (`thread_hand_ins` rows, "Handed from/to"). Provider
  switches delivered from the queue therefore show up with no new event work — but the
  mark text should name the from→to provider/model, not just the direction.
- Model-only and option-only changes between turns (no hand-in row) need a lightweight
  mark of their own: e.g. `ModelChangedMark { at, fromModel, toModel, changedKnobs }`
  sourced from a new `thread_model_changes` table or from turn spans, grouped onto
  exchanges by the same `groupMarks` helper `handoffMarkers.ts` provides. t3code emits
  `thread.model-selection-updated` vs `thread.provider-switched` for exactly this split;
  kone's equivalent is hand-in mark vs model-change mark.
- The merge-back line (`Block id: …`, system notice) is the pattern for the text: name
  what changed and what it applies to.

## 5. Self-switch gateway tool, clamped to what the user allows

- New assistant-target tool, e.g. `app_switch_provider`, taking
  `{ provider?, model?, effort?, mode?, serviceTier?, contextWindow? }` for the agent's
  **own** thread and applying to its **next** turn only (queued switch row when a turn is
  running, direct selection update when idle — never an interrupt; agents must not be able
  to stop the user's running turn out from under it).
- Clamp, in order: (a) the thread's agent pin — a pinned `model`/`modelFallbacks`
  (`rosterRecord.ts`) is the user's statement of what the agent runs on, so a self-switch
  outside the pin + fallbacks is refused; unpinned agents may pick any available provider;
  (b) provider availability (same check `app_start_thread` uses — never start on what the
  install cannot reach); (c) `handInEligibility` no-op rule. Refusals are isError text
  naming the reason (running-turn interrupt refused, outside pin, unavailable, no-op),
  tested through the `target: 'assistant'` mapping with structuredContent stripped.
- The tool records into the remembered-options table like any other commit, so an agent's
  switch teaches the same memory.

## 6. Position relative to P1 (hand-in budget) and P4 (forks)

- **P1:** every queued switch that changes provider is a hand-in, and every hand-in
  replays history under the P1 budget (`handoffBudget`, whole-message selection, omitted
  ids recorded, refuse-if-it-cannot-fit). A switch whose replay cannot fit refuses at
  delivery with the P1 reason instead of truncating — the thread stays where it is. The
  budget cap provider setting P1 added is the same cap the switch replay sizes with.
- **P4:** a fork's first send chooses its provider/model (lazy session, source's as
  placeholder). That choice is a selection, not a switch: no hand-in row, no queue. But a
  **queued switch on a fork before its first message** just retargets the placeholder
  (nothing to hand in — no session, no transcript), and `mergeBackFork` is selection-blind
  (it writes a text summary either way). Fork `supportsFork` capability and native targets
  are untouched by switching; a hand-in clears `conversation_id`/`resume_session_at`,
  which also clears any native fork binding — by design, since those name the old
  provider's conversation.

## 7. Files to touch and tests

Backend only; no visual UI (composer shows the pending switch — that display is §3 UI).

| Area | Files | Tests |
|---|---|---|
| Queued selection rows | queue store (`queuedTurns.ts` or equivalent), `AgentService.ts` drain, `dispatch.ts` send path | enqueue-while-running keeps order; two switches apply in order; no-op second pick runs without hand-in; crash between rows resumes on stored owner |
| Hand-in at delivery | `handIn.ts` (delivery entry reusing `handInThread`), eligibility re-check | unavailable target fails the row, thread stays; replay-too-long refuses with P1 reason |
| Remembered options | new `store/providerModelOptions.ts` + migration (next free id — renumber at merge per ledger), `ConversationStore.ts` wiring, `setThreadSelection` read-through | round-trip per provider+model; returning restores effort; IPC getter/setter |
| Timeline mark | `thread_model_changes` store or turn-span derivation, mark grouping beside `handoffMarkers.ts` (backend payload + IPC; no new visuals) | mark appears for model-only change, absent when nothing changed; hand-in mark names from→to |
| Self-switch tool | new `gateway/tools/appProvidersSwitch.ts` (or inside `appProviders.ts`), schemas, assistant target | through `target:'assistant'`: text carries new selection; refusals (outside pin, unavailable, no-op, running-turn interrupt refused) are isError text; no structuredContent |
| Gates | — | `bun run check-types`, `bun run lint`, affected `bun test` suites via `gate.sh`, on the exact tip |

Migration numbering: take the next free id in this branch and leave renumbering to the
lead at merge (29–33 are occupied/reserved across parity work; never reuse a rung).
