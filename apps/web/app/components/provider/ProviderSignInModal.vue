<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  AlertCircleIcon,
  CheckmarkCircle02Icon,
  ComputerTerminal01Icon,
  Loading03Icon,
  StopCircleIcon,
} from "@hugeicons/core-free-icons";
import ProviderLogo from "~/components/provider/ProviderLogo.vue";
import TerminalPane from "~/components/terminal/TerminalPane.vue";
import { useModalExit } from "~/composables/useModalExit";
import { useProviderSignIn } from "~/composables/useProviderSignIn";
import { useSignInRun } from "~/composables/useSignInRun";
import { useSound } from "~/composables/useSound";
import { PROVIDER_BRAND } from "~/utils/modelPicker";
import type { ProviderKind } from "~/types/desktop";
import { PROVIDER_LABEL } from "~/utils/usageProviders";

// In-app provider sign-in: run the provider CLI's own login command in a kone
// PTY, right here, and re-read its health when the user says they're done.
// kone never stores a credential — the CLI writes it where it always does —
// and the transcript stays in memory, dropped when the card closes.
//
// The card is the house shell (UiModalShell + the picker's header/footer bands)
// anchored bottom-right over the composer, per mockup 01a. It owns no state of
// its own beyond focus: the run lives in useSignInRun, the terminal in
// TerminalPane, and closing goes through useProviderSignIn().closed() so focus
// returns to whatever opened it.
//
// The scrim is inert on purpose: a stray click must never kill a login that is
// mid-flight. Escape only closes while focus is outside the terminal — inside
// it, every key belongs to the CLI (opencode's provider menu uses arrows and
// Escape), with Shift+Tab the one way back out for a keyboard user.

const props = defineProps<{
  provider: ProviderKind;
}>();

const brand = PROVIDER_BRAND[props.provider];
const label = PROVIDER_LABEL[props.provider];
const titleId = useId();
const hintId = useId();

const signIn = useSignInRun({ provider: props.provider, label });
// The card reads the state and the resolved command; everything else it does
// goes back through the run (`signIn.stop()`, `signIn.check()`).
const { state, command, copied, display, bin, finish, live, session, settled } = signIn;

const { shown, closing, dismiss } = useModalExit();
const { closed } = useProviderSignIn();
const { cue } = useSound();

const cardEl = ref<HTMLElement | null>(null);
const wellEl = ref<HTMLElement | null>(null);
const paneEl = ref<{ focus: () => void } | null>(null);
const primaryEl = ref<HTMLButtonElement | null>(null);
const headerButtonEl = ref<HTMLButtonElement | null>(null);

/** The transcript hint belongs to the run, as the mockups show it: beside a
 *  login that is running, waiting, being checked, or verified. While nothing has
 *  started (idle, starting) or the run is over (failed, cancelled) it is neither
 *  true nor useful, and it is the first thing to cost the footer its single row. */
const transcriptNote = computed(() => {
  const at = state.value.phase;
  return at === "running" || at === "waiting" || at === "checking" || at === "verified";
});

// ── the footer's two written pieces ─────────────────────────────────────────
// One status line and one action set, both derived from the same union. The
// copy is the spec's table, verbatim; adding a phase means adding a case here,
// not another block of markup.

const STATUS_ICON = {
  spin: { icon: Loading03Icon, class: "signin-spin" },
  ok: { icon: CheckmarkCircle02Icon, class: "signin-ok" },
  danger: { icon: AlertCircleIcon, class: "signin-danger" },
  muted: { icon: StopCircleIcon, class: "signin-muted" },
} as const;

type StatusIcon = keyof typeof STATUS_ICON;

/** A 6px dot stands in for the icon in idle and waiting (amber + halo). */
type StatusLine = { icon?: StatusIcon; text: string; code?: string; after?: string; dot?: "idle" | "waiting" };

const statusLine = computed<StatusLine>(() => {
  const current = state.value;
  switch (current.phase) {
    case "idle":
      return { dot: "idle", text: "Ready to run ", code: display.value };
    case "starting":
      return { icon: "spin", text: "Starting ", code: bin.value, after: "…" };
    case "running":
      return { icon: "spin", text: "Running ", code: display.value, after: "…" };
    case "waiting":
      return { dot: "waiting", text: finish.value === "terminal" ? "Waiting for you in the terminal…" : "Waiting for the browser…" };
    case "checking":
      return { icon: "spin", text: `Checking with ${label}…` };
    case "verified":
      return { icon: "ok", text: current.status.authLabel ? `Signed in · ${current.status.authLabel}` : "Signed in" };
    case "failed":
      // A check failure keeps the provider's sentence; an exit names the code.
      if (current.failure.kind === "check") {
        return { icon: "danger", text: `Not signed in yet · ${current.failure.reason}` };
      }
      if (current.failure.kind === "exit") {
        return { icon: "danger", text: "", code: bin.value, after: ` exited with code ${current.failure.code ?? "?"}` };
      }
      return { icon: "danger", text: current.failure.reason };
    case "cancelled":
      return { icon: "muted", text: current.reason === "timeout" ? "Sign-in stopped after 10 minutes" : "Sign-in stopped" };
  }
});

const lineIcon = computed(() =>
  statusLine.value.icon ? STATUS_ICON[statusLine.value.icon] : null,
);

/** Primary is the filled pill; outline is the verified state's Done. */
type Action = { label: string; onClick: () => void; disabled?: boolean; variant?: "primary" | "outline" };

type FooterActions = { secondary: Action[]; primary: Action };

const noop = (): void => {};

const actions = computed<FooterActions>(() => {
  const current = state.value;
  switch (current.phase) {
    case "idle":
      return {
        secondary: [
          { label: copied.value ? "Copied" : "Copy command", onClick: copyCommand },
          { label: "Check authentication", onClick: () => signIn.check() },
        ],
        primary: { label: "Run login", onClick: runLogin },
      };
    case "starting":
      return {
        secondary: [{ label: "Check authentication", onClick: noop, disabled: true }],
        primary: { label: "Starting…", onClick: noop, disabled: true },
      };
    case "running":
    case "waiting":
      return { secondary: [{ label: "Stop", onClick: () => signIn.stop() }], primary: { label: "Check authentication", onClick: () => signIn.check() } };
    case "checking":
      return { secondary: live.value ? [{ label: "Stop", onClick: () => signIn.stop() }] : [], primary: { label: "Checking…", onClick: noop, disabled: true } };
    case "verified":
      return { secondary: [], primary: { label: "Done", onClick: requestClose, variant: "outline" } };
    case "failed": {
      const copyAction = { label: copied.value ? "Copied" : "Copy command", onClick: copyCommand };
      if (current.failure.kind === "check") {
        // A failing check never kills the CLI: while it lives, Stop stays.
        const again = live.value ? { label: "Stop", onClick: () => signIn.stop() } : { label: "Run again", onClick: runLogin };
        return { secondary: [again], primary: { label: "Check authentication", onClick: () => signIn.check() } };
      }
      return {
        secondary: [copyAction],
        primary: { label: current.failure.kind === "start" ? "Try again" : "Run again", onClick: runLogin },
      };
    }
    case "cancelled":
      return { secondary: [{ label: copied.value ? "Copied" : "Copy command", onClick: copyCommand }], primary: { label: "Run again", onClick: runLogin } };
  }
});

// ── focus ───────────────────────────────────────────────────────────────────
// Idle opens on the primary action. Once the login starts, the keyboard moves
// into the PTY, because the CLI's own prompts are what needs answering next.
function focusTerminal(): void {
  void nextTick(() => paneEl.value?.focus());
}

watch(session, (next) => {
  if (next) focusTerminal();
});

/** Shift+Tab, handed over by TerminalPane while the keyboard is in the PTY.
 *  xterm keeps every other key for the CLI; this is the one chord that gets a
 *  keyboard user back out of the terminal, onto the card's first control (the
 *  header's Cancel/Close). */
function leaveTerminal(event: KeyboardEvent): boolean {
  if (event.key !== "Tab" || !event.shiftKey) return false;
  event.preventDefault();
  headerButtonEl.value?.focus();
  return true;
}

function focusableEls(): HTMLElement[] {
  const root = cardEl.value;
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input, textarea, [tabindex]:not([tabindex="-1"])'));
}

/** True while the keyboard is inside the terminal well — the CLI owns every
 *  key there, Escape and Tab included. */
function terminalHasFocus(): boolean {
  const el = document.activeElement;
  return el != null && wellEl.value?.contains(el) === true;
}

function requestClose(): void {
  if (closing.value) return;
  // Kill the CLI now rather than after the exit plays: a login process must
  // not outlive the card that started it.
  void signIn.dispose();
  dismiss(() => closed());
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    if (terminalHasFocus()) return;
    // One Escape, one layer. The settings drawer and the global assistant
    // listen on window too, and this card stands above both; a capture-phase
    // listener that stops the event here closes only the card.
    event.preventDefault();
    event.stopImmediatePropagation();
    requestClose();
    return;
  }
  if (event.key !== "Tab") return;
  // Inside the terminal, Tab is a keystroke for the CLI (completion, forms).
  if (terminalHasFocus()) return;
  const els = focusableEls();
  const first = els[0];
  const last = els[els.length - 1];
  if (!first || !last) return;
  // SAFETY: activeElement is null or the focused element; the trap only
  // compares it against members of `els`, so HTMLElement | null is the domain.
  const active = document.activeElement as HTMLElement | null;
  const inTrap = active != null && els.includes(active);
  const atEdge = event.shiftKey ? active === first : active === last;
  if (atEdge || !inTrap) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}

onMounted(async () => {
  // Capture phase: the card is the topmost surface, so its Escape must reach
  // it before the drawer and the assistant below see the same press.
  window.addEventListener("keydown", onKeydown, true);
  void signIn.loadCommand();
  await nextTick();
  // Raise the card a frame after it mounts, so it plays its entrance rather
  // than appearing already in place (the shell holds it invisible until then).
  requestAnimationFrame(() => {
    shown.value = true;
    primaryEl.value?.focus();
  });
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown, true);
  // The page may drop the card without a gesture (project switch, reload):
  // the PTY still has to go with it.
  void signIn.dispose();
});

// ── actions ─────────────────────────────────────────────────────────────────
/** TerminalPane emits bare keystrokes; the registry keys sessions by their
 *  stable strip key, which this card only ever has one of. */
function writeTerminal(data: string): void {
  if (session.value) signIn.write(session.value.key, data);
}

function resizeTerminal(cols: number, rows: number): void {
  if (session.value) signIn.resize(session.value.key, cols, rows);
}

function runLogin(): void {
  cue("toggle");
  void signIn.run();
}

function copyCommand(): void {
  void signIn.copy().then((done) => {
    if (done) cue("copy");
  });
}

// A verified sign-in is the one outcome worth hearing from across the room;
// the card's own close already has the dismissal cue. A settled state also
// hands the keyboard back to the primary action, since the button the user was
// last on (Stop, Run login) is gone by then.
watch(state, (next, prev) => {
  if (next.phase === "verified" && prev.phase !== "verified") cue("saved");
});
watch(settled, async (done) => {
  if (!done) return;
  await nextTick();
  primaryEl.value?.focus();
});
</script>

<template>
  <UiModalShell v-slot="{ card }" :shown="shown" scrim="inert" class="z-[60] items-end justify-end p-6 max-sm:p-3">
    <div
      ref="cardEl"
      v-bind="card"
      class="modal-card signin-card relative z-20 w-full overflow-hidden"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
    >
      <div class="signin-body">
        <!-- Recessed header band with the arc scoops that flow into the walls —
             the picker/approval family signature. -->
        <div class="picker-header">
          <span class="signin-heading">
            <ProviderLogo :brand="brand" :size="16" />
            <span :id="titleId" class="signin-eyebrow">Sign in to {{ label }}</span>
          </span>
          <button ref="headerButtonEl" type="button" class="picker-action text-muted" @click="requestClose">
            {{ live ? "Cancel" : "Close" }}
          </button>
        </div>

        <div class="signin-main">
          <p class="signin-lede">
            kone runs <code>{{ display }}</code> for you, here, with the executable from your
            settings.
            {{ finish === "terminal"
              ? "Answer its questions in the terminal below."
              : "Finish in the browser it opens." }}
            The CLI keeps the credential, not kone.
          </p>

          <div ref="wellEl" class="signin-well" role="group" aria-label="Login terminal" :aria-describedby="hintId">
            <TerminalPane
              v-if="session"
              ref="paneEl"
              :session="session"
              :escape-key="leaveTerminal"
              @write="writeTerminal"
              @resize="resizeTerminal"
            />
            <!-- Nothing started: the well shows what pressing Run login will do,
                 in the terminal's own face, so the card never looks empty. Not
                 once the card is exiting — the PTY is already gone, and the
                 prompt popping back in would flash under the fade. -->
            <div v-else-if="!closing" class="signin-preview" aria-hidden="true">
              <div class="signin-preview__cwd">{{ command?.cwd ?? "~" }}</div>
              <div class="signin-preview__cmd"><span class="signin-prompt">❯</span> {{ display }}</div>
              <div class="signin-preview__hint">Nothing runs until you press {{ actions.primary.label }}.</div>
            </div>
            <p :id="hintId" class="signin-hint">Shift+Tab leaves the terminal.</p>
          </div>
        </div>

        <!-- Footer band, welded to the card's lower edge with the scoops
             flowing up into the walls (the picker footer family). -->
        <div class="picker-footer">
          <span class="signin-stateline" aria-live="polite">
            <HugeiconsIcon
              v-if="lineIcon"
              :class="lineIcon.class"
              :icon="lineIcon.icon"
              :size="13"
              :stroke-width="2"
              aria-hidden="true"
            />
            <span v-else class="signin-dot" :class="{ 'signin-dot--waiting': statusLine.dot === 'waiting' }" aria-hidden="true" />
            <span class="signin-stateline__text">{{ statusLine.text }}<code v-if="statusLine.code">{{ statusLine.code }}</code>{{ statusLine.after }}</span>
          </span>

          <span v-if="transcriptNote" class="signin-note">
            <HugeiconsIcon :icon="ComputerTerminal01Icon" :size="12" :stroke-width="1.8" aria-hidden="true" />
            Transcript isn't saved
          </span>

          <div class="signin-actions">
            <button
              v-for="action in actions.secondary"
              :key="action.label"
              type="button"
              class="picker-action text-muted"
              :disabled="action.disabled"
              @click="action.onClick"
            >{{ action.label }}</button>
            <button
              ref="primaryEl"
              type="button"
              :class="actions.primary.variant === 'outline' ? 'signin-done' : 'signin-primary'"
              :disabled="actions.primary.disabled"
              @click="actions.primary.onClick"
            >{{ actions.primary.label }}</button>
          </div>
        </div>
      </div>
    </div>
  </UiModalShell>
</template>

<style scoped>
.modal-card {
  background: var(--panel);
  border-radius: 18px;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent);
  display: flex;
  flex-direction: column;
}
/* Anchored bottom-right like mockup 01a; a full-width card on a phone. */
.signin-card { width: 100%; max-width: 600px; }

.signin-body {
  --band-bg: var(--band);
  --band-arc: 14px;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

/* ── header band ──────────────────────────────────────────────────────────── */
.picker-header {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.625rem 1rem;
  background-color: var(--band-bg);
}
.picker-header::before, .picker-header::after {
  content: "";
  position: absolute;
  width: var(--band-arc);
  height: var(--band-arc);
  top: 100%;
  pointer-events: none;
}
.picker-header::before {
  left: 0;
  background: radial-gradient(circle at bottom right, transparent var(--band-arc), var(--band-bg) 0);
}
.picker-header::after {
  right: 0;
  background: radial-gradient(circle at bottom left, transparent var(--band-arc), var(--band-bg) 0);
}

.signin-heading { display: inline-flex; align-items: center; gap: 0.5rem; min-width: 0; }
.signin-eyebrow {
  font-family: var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── body ────────────────────────────────────────────────────────────────── */
.signin-main {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 16px 12px;
  min-width: 0;
}

.signin-lede { margin: 0; font-size: 12.5px; line-height: 1.55; color: var(--muted); }
.signin-lede code { font-family: var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace); font-size: 0.95em; color: var(--ink); }

/* The terminal well: a quiet inset slab, about fourteen rows tall. */
.signin-well { box-sizing: border-box; height: 17.5rem; border-radius: 12px; background: var(--term-bg); padding: 10px 12px; box-shadow: inset 0 0 0 1px var(--line-soft); overflow: hidden; }

/* The idle preview speaks the terminal's face, so the well reads as a terminal
   that simply hasn't run anything yet. */
.signin-preview { height: 100%; display: flex; flex-direction: column; gap: 2px; font-family: var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace); font-size: 12.5px; line-height: 1.45; }
.signin-preview__cwd { color: var(--faint); }
.signin-preview__cmd { color: var(--term-ink, var(--ink)); }
.signin-prompt { color: var(--ok); }
.signin-preview__hint { color: var(--muted); }

/* Screen-reader-only: the terminal's way out, spoken with the region. */
.signin-hint {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

/* ── footer band ─────────────────────────────────────────────────────────── */
.picker-footer {
  position: relative;
  display: flex;
  align-items: center;
  /* A row when the card has room, two when it doesn't: the status line wraps
     and the actions drop to their own right-aligned row, never off the edge. */
  flex-wrap: wrap;
  gap: 1rem;
  row-gap: 8px;
  padding: 0.625rem 1rem;
  background-color: var(--band-bg);
}
.picker-footer::before, .picker-footer::after {
  content: "";
  position: absolute;
  width: var(--band-arc);
  height: var(--band-arc);
  bottom: 100%;
  pointer-events: none;
}
.picker-footer::before {
  left: 0;
  background: radial-gradient(circle at top right, transparent var(--band-arc), var(--band-bg) 0);
}
.picker-footer::after {
  right: 0;
  background: radial-gradient(circle at top left, transparent var(--band-arc), var(--band-bg) 0);
}

.signin-stateline {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  /* 12rem, not 14: at 600 the idle three-action footer is ~571px wide with a
     14rem basis, which is three pixels past the band and would wrap every wide
     card onto two rows. The status line still grows into whatever is spare. */
  flex: 1 1 12rem;
  min-width: 0;
  font-size: 12.5px;
  line-height: 1.35;
  color: var(--ink-soft);
}
.signin-stateline__text { min-width: 0; overflow-wrap: anywhere; }
.signin-stateline code { font-family: var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace); font-size: 0.95em; color: var(--ink); }

.signin-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--faint);
  flex: none;
}
/* The waiting beat: amber, with the 3px halo from 01a. */
.signin-dot--waiting {
  background: var(--warn);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--warn) 22%, transparent);
  animation: signin-pulse 1.8s ease-in-out infinite;
}

.signin-ok,
.signin-danger,
.signin-muted,
.signin-spin {
  flex: none;
}
.signin-ok { color: var(--ok); }
.signin-danger { color: var(--danger); }
.signin-muted { color: var(--muted); }
.signin-spin { color: var(--muted); animation: signin-spin 1s linear infinite; }

.signin-note {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  color: var(--muted);
  white-space: nowrap;
  flex: none;
}
@media (max-width: 519px) {
  .signin-note {
    display: none;
  }
}

.signin-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 1.1rem;
  row-gap: 8px;
  margin-inline-start: auto;
  flex: none;
  /* On a phone the actions are wider than the band; let them wrap inside
     themselves rather than push the card's scroll width past its edge. */
  max-width: 100%;
}

/* Text actions — no fill, quiet hover fade, the pickers' treatment. */
.picker-action {
  display: inline-flex;
  align-items: center;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
  cursor: pointer;
  transition: opacity 0.18s ease;
}
.picker-action:hover:not(:disabled) {
  opacity: 0.7;
}
.picker-action:disabled {
  cursor: default;
  opacity: 0.4;
}
.text-muted { color: var(--muted); }

/* Pills: the primary is the one filled one in the card — mockup 01a's Run
   login; Done, in the verified state, is 01b's outlined twin. */
.signin-primary,
.signin-done {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  padding: 6px 14px;
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
  cursor: pointer;
  transition: opacity 0.18s ease;
}
.signin-primary { border: 0; background: var(--ink); color: var(--ground); }
.signin-primary:hover:not(:disabled) { opacity: 0.85; }
.signin-primary:disabled { cursor: default; opacity: 0.4; }
.signin-done { border: 1px solid var(--line); background: transparent; color: var(--ink); }
.signin-done:hover { opacity: 0.7; }

@keyframes signin-spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes signin-pulse {
  50% {
    box-shadow: 0 0 0 5px color-mix(in srgb, var(--warn) 8%, transparent);
  }
}
/* The shell shortens its own motion; the card's pulse and spinner hold still. */
@media (prefers-reduced-motion: reduce) {
  .signin-spin,
  .signin-dot--waiting {
    animation: none;
  }
}
</style>
