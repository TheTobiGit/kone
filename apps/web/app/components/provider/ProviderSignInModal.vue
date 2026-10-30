<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  AlertCircleIcon,
  CheckmarkCircle02Icon,
  Loading03Icon,
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
import { signInFooter, type SignInActionId } from "~/utils/signInFooter";

// In-app provider sign-in: run the provider CLI's own login command in a kone
// PTY, right here, and re-read its health when the user says they're done.
// kone never stores a credential — the CLI writes it where it always does —
// and the transcript stays in memory, dropped when the card closes.
//
// Variant A: the house header band, then the LIVE terminal edge to edge, then
// one footer band with a short status and the actions. There is no lede and no
// note — the transcript is the explanation. The run lives in useSignInRun, the
// terminal in TerminalPane, and closing goes through useProviderSignIn().closed()
// so focus returns to whatever opened it.
//
// The same card is mounted twice, and `contained` is the one difference: the
// page shell mounts it over the window (the composer's tray, which is not inside
// settings), and the providers pane mounts it inside its own frame, so a card
// opened from a pane stays in that pane.
//
// The scrim is inert on purpose: a stray click must never kill a login that is
// mid-flight. Escape only closes while focus is outside the terminal — inside
// it, every key belongs to the CLI (opencode's provider menu uses arrows and
// Escape), with Shift+Tab the one way back out for a keyboard user.

const props = defineProps<{
  provider: ProviderKind;
  /** Cover the settings pane that hosts this copy instead of the window. */
  contained?: boolean;
}>();

const brand = PROVIDER_BRAND[props.provider];
const label = PROVIDER_LABEL[props.provider];
const titleId = useId();
const hintId = useId();

const signIn = useSignInRun({ provider: props.provider, label });
// The card reads the state and the resolved command; everything else it does
// goes back through the run (`signIn.stop()`, `signIn.check()`).
const { state, command, copied, display, finish, live, session, settled } = signIn;

const { shown, closing, dismiss } = useModalExit();
const { closed, ticket } = useProviderSignIn();
const myTicket = ticket();
const { cue } = useSound();

const cardEl = ref<HTMLElement | null>(null);
const wellEl = ref<HTMLElement | null>(null);
const paneEl = ref<{ focus: () => void } | null>(null);
const primaryEl = ref<HTMLButtonElement | null>(null);
const headerButtonEl = ref<HTMLButtonElement | null>(null);

// ── the footer, derived once ────────────────────────────────────────────────
// One status line and one action set, both mapped from the same union in
// ~/utils/signInFooter and tested there. The card only turns an action id into
// a handler, so adding a phase adds a case to the pure mapping, not markup.

const footer = computed(() =>
  signInFooter({
    state: state.value,
    finish: finish.value,
    live: live.value,
    copied: copied.value,
  }),
);

/** The dot stands in for an icon in idle, waiting and cancelled. */
const TONE_ICON = {
  busy: { icon: Loading03Icon, class: "signin-spin" },
  ok: { icon: CheckmarkCircle02Icon, class: "signin-ok" },
  danger: { icon: AlertCircleIcon, class: "signin-danger" },
} as const;

const lineIcon = computed(() => {
  const tone = footer.value.status.tone;
  return tone === "busy" || tone === "ok" || tone === "danger" ? TONE_ICON[tone] : null;
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

/** True while the keyboard is inside the terminal — the CLI owns every key
 *  there, Escape and Tab included. */
function terminalHasFocus(): boolean {
  const el = document.activeElement;
  return el != null && wellEl.value?.contains(el) === true;
}

function requestClose(): void {
  if (closing.value) return;
  // Kill the CLI now rather than after the exit plays: a login process must
  // not outlive the card that started it.
  void signIn.dispose();
  dismiss(() => closed(myTicket));
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

/** The mapping names an intent; the card owns the effect. `satisfies` keeps the
 *  literal key set while still proving every action id has a handler. */
const handlers = {
  run: runLogin,
  stop: () => void signIn.stop(),
  check: () => void signIn.check(),
  copy: copyCommand,
  close: requestClose,
} satisfies Record<SignInActionId, () => void>;

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
  <UiModalShell
    v-slot="{ card }"
    :shown="shown"
    scrim="inert"
    :contained="contained"
    class="z-[60] items-end justify-end p-6 max-sm:p-3"
  >
    <div
      ref="cardEl"
      v-bind="card"
      class="modal-card signin-card relative z-20 w-full overflow-hidden"
      :class="{ 'signin-card--contained': contained }"
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

        <!-- The body IS the terminal: no lede, no inset well, edge to edge
             between the two bands, whose scoops round its corners. Its height
             is fixed, so the card never moves between states. -->
        <div ref="wellEl" class="signin-term" role="group" aria-label="Login terminal" :aria-describedby="hintId">
          <TerminalPane
            v-if="session"
            ref="paneEl"
            :session="session"
            :escape-key="leaveTerminal"
            screen-reader-mode
            aria-label="Sign-in terminal input"
            :aria-described-by="hintId"
            @write="writeTerminal"
            @resize="resizeTerminal"
          />
          <!-- Nothing started: the terminal shows the command at its prompt, as
               if it had been typed and was waiting for Enter. Not once the card
               is exiting — the PTY is already gone, and the prompt popping back
               in would flash under the fade. -->
          <div v-else-if="!closing" class="signin-preview" aria-hidden="true">
            <div class="signin-preview__cwd">{{ command?.cwd ?? "~" }}</div>
            <div class="signin-preview__cmd">
              <span class="signin-prompt">❯</span> {{ display }}<span class="signin-preview__cursor" />
            </div>
          </div>
          <p :id="hintId" class="signin-hint">Shift+Tab leaves the terminal.</p>
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
            <span v-else class="signin-dot" :class="{ 'signin-dot--waiting': footer.status.tone === 'waiting' }" aria-hidden="true" />
            <span class="signin-stateline__text">{{ footer.status.text }}</span>
          </span>

          <div class="signin-actions">
            <button
              v-for="action in footer.secondary"
              :key="action.id"
              type="button"
              class="picker-action text-muted"
              :disabled="action.disabled"
              @click="handlers[action.id]"
            >{{ action.label }}</button>
            <button
              ref="primaryEl"
              type="button"
              :class="footer.primary.variant === 'outline' ? 'signin-done' : 'signin-primary'"
              :disabled="footer.primary.disabled"
              @click="handlers[footer.primary.id]"
            >{{ footer.primary.label }}</button>
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
/* Anchored bottom-right like mockup 01a; a full-width card on a phone. The
   height is a ceiling, not a size: on a short viewport (or at zoom) the card
   shrinks with the terminal instead of pushing the header/Close or footer off
   the edge. The overlay's own padding is the 3rem / 1.5rem removed here. */
.signin-card {
  width: 100%;
  max-width: 560px;
  max-height: calc(100dvh - 3rem);
}
@media (max-width: 639px) {
  .signin-card { max-height: calc(100dvh - 1.5rem); }
}
/* A pane-hosted card is ceilinged by the pane, not the viewport: the overlay is
   `absolute inset-0`, so a percentage is the pane. Its padding is already
   outside the box a percentage resolves against, and this comes after the phone
   rule so a narrow viewport never reaches a pane. */
.signin-card--contained {
  max-height: 100%;
}

.signin-body {
  --band-bg: var(--band);
  --band-arc: 14px;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
}

/* ── header band ──────────────────────────────────────────────────────────── */
.picker-header {
  position: relative;
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.625rem 1rem;
  background-color: var(--band-bg);
  /* The scoops sit over the terminal below; the band owns its own corners. */
  z-index: 1;
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

/* ── body: the terminal, edge to edge ────────────────────────────────────── */
/* A preferred 19rem (17rem on a phone), not a fixed height: the terminal is
   the flex item that gives way when the card hits its viewport ceiling, so the
   header and footer always stay on screen. */
.signin-term {
  box-sizing: border-box;
  flex: 1 1 19rem;
  min-height: 0;
  padding: 18px 18px 14px;
  background: var(--term-bg);
  overflow: hidden;
  min-width: 0;
}
@media (max-width: 519px) {
  .signin-term { flex-basis: 17rem; padding: 16px 14px 12px; }
}

/* The idle preview speaks the terminal's face, so the body reads as a terminal
   that simply hasn't run anything yet. */
.signin-preview {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-family: var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace);
  font-size: 12.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow: hidden;
}
.signin-preview__cwd { color: var(--faint); }
.signin-preview__cmd { color: var(--term-ink, var(--ink)); overflow-wrap: anywhere; }
.signin-prompt { color: var(--ok); }
.signin-preview__cursor {
  display: inline-block;
  width: 0.62em;
  height: 1.05em;
  margin-inline-start: 2px;
  vertical-align: text-bottom;
  background: var(--term-cursor, var(--accent));
  opacity: 0.85;
}

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
  flex: none;
  align-items: center;
  /* A row when the card has room, two when it doesn't: the status line wraps
     and the actions drop to their own row, never off the edge. */
  flex-wrap: wrap;
  gap: 1rem;
  row-gap: 8px;
  padding: 0.625rem 1rem;
  background-color: var(--band-bg);
  z-index: 1;
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
  gap: 0.45rem;
  /* 8rem: at a phone width the status drops onto its own row above the
     actions, as in A-10; on a wide card it grows into the spare room. */
  flex: 1 1 8rem;
  min-width: 0;
  font-size: 12.5px;
  line-height: 1.35;
  color: var(--ink-soft);
}
.signin-stateline__text { min-width: 0; overflow-wrap: anywhere; }

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
.signin-spin {
  flex: none;
}
.signin-ok { color: var(--ok); }
.signin-danger { color: var(--danger); }
.signin-spin { color: var(--muted); animation: signin-spin 1s linear infinite; }

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
