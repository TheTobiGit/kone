# P5 design: lead review (Rill, 2026-10-09)

Verdict: approved as the basis for P5. No code until P4 is merged into t3-parity. Decisions and changes:

1. **Shape of a queued switch.** Every queued row carries the selection that was current when it was queued (provider, model, knobs). A pick made while a turn runs with nothing queued is stored as the thread's *pending selection* and applied at turn end with no turn. Do not add prompt-less "switch rows" to the queue.
2. **Backend only.** Add the backend API (enqueue with selection, set pending selection, IPC). Leave the composer's immediate `switchProvider` / interrupt behaviour as is; the composer change is section 3 item 10 and is the user's call.
3. **Model/option change mark.** Derive it from what each turn ran on, if turn rows already store provider/model/knobs. Add a table only if they don't, and say which in the plan.
4. **Remembered options.** A store table keyed by provider + model is fine. One migration; the lead renumbers it at merge.
5. **Self-switch tool.** As designed: next turn only, never interrupts, clamped to the pin + fallbacks, availability and eligibility. Refusals are isError text, tested through target:'assistant'.
6. **P1 interplay.** A provider switch whose replay cannot fit refuses at delivery with the P1 reason; the row fails and the queue continues. Test it.
