<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { onClickOutside, onKeyStroke, useEventListener } from "@vueuse/core";

// "Agent input — Iris states" board. One object walks four states:
//   dormant  · a calm iris orb at rest, breathing
//   ready    · it EXPANDS into a pill; the sleeping face fades to the field
//   typing   · the pill grows to fit the text (auto-height, never a scrollbar)
//   composing· attach context and it widens into a card; chips ride the top
// The whole thing is one surface that morphs — it expands and collapses, it
// never swaps one element out for another. Look-and-feel only; no agent yet.

const { cue } = useSound();

const open = ref(false);
const text = ref("");
const field = ref<HTMLTextAreaElement | null>(null);
const surface = ref<HTMLElement | null>(null);
const dock = ref<HTMLElement | null>(null);
const mirror = ref<HTMLElement | null>(null);

// The surface is sized imperatively so it can animate (CSS can't transition to
// `auto`). It grows WIDE first — the pill widens to hold the text up to MAX_W —
// and only once it's capped does it grow TALL (the text wraps, height follows).
// The resting orb is the same height as the open single-line pill, so opening
// changes only width + corners, never height.
const REST = 55;
const MIN_W = 360;
const MAX_W = 720;
// Each side control slot (matches .side width in CSS) — reserved so the pill
// never grows wide enough to push them off the window.
const SIDE_W = 140;
// Horizontal budget around the text: left pad + gap + send seed + right pad + rim.
const EXTRAS = 78;
const surfaceH = ref(REST);
const surfaceW = ref(MIN_W);
// Multi-line — pin the send seed to the bottom instead of centring it.
const isTall = ref(false);
// True only during the wake expand, so the corner-lead stagger applies then but
// not on every keystroke width change.
const opening = ref(false);

type Chip = { id: number; name: string; kind: "pdf" | "ts" | "folder"; count?: number };
const chipPool: Omit<Chip, "id">[] = [
  { name: "brief.pdf", kind: "pdf" },
  { name: "useDroidBridge.ts", kind: "ts" },
  { name: "droid/", kind: "folder", count: 12 },
];
const chips = ref<Chip[]>([]);
let chipSeq = 0;

const hasChips = computed(() => chips.value.length > 0);
const hasText = computed(() => text.value.trim().length > 0);
const armed = computed(() => hasText.value || hasChips.value);
const card = computed(() => hasChips.value);

// The card keeps a fixed comfortable width (chips define it); the pill sizes to
// its text. `undefined` lets CSS own the width (52 at rest, clamp for the card).
const widthStyle = computed(() =>
  open.value && !card.value ? `${surfaceW.value}px` : undefined,
);

// The widest the pill may get: MAX_W, but never so wide the side controls would
// leave the window.
function maxW(): number {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  return Math.max(MIN_W, Math.min(MAX_W, vw - 2 * SIDE_W - 40));
}
// The hidden mirror carries the same text at the same type, unwrapped, so its
// width is how wide the pill *wants* to be. Clamp it into [MIN_W, cap].
function measureWidth(): number {
  const m = mirror.value;
  if (!m) return MIN_W;
  return Math.max(MIN_W, Math.min(maxW(), Math.round(m.offsetWidth) + EXTRAS));
}
// Read the surface's natural height at its current (settled) width.
function measure(): number {
  const el = surface.value;
  if (!el) return REST;
  const prev = el.style.height;
  el.style.height = "auto";
  const h = el.offsetHeight;
  el.style.height = prev;
  return h;
}
// Size the pill: width to fit the text first, then — with that width applied —
// grow the textarea and measure the height it needs.
function sync() {
  const el = surface.value;
  const ta = field.value;
  // Width first: the pill widens to fit the text, up to the cap.
  const cap = maxW();
  let desired = cap;
  if (open.value && !card.value) {
    const m = mirror.value;
    desired = (m ? m.offsetWidth : 0) + EXTRAS;
    surfaceW.value = Math.max(MIN_W, Math.min(cap, Math.round(desired)));
    if (el) el.style.width = `${surfaceW.value}px`;
  }
  // Wrap (and grow tall) only once the card is up or the pill has hit its cap —
  // so a letter never flashes onto the next row while there's still width to
  // grow into. Set imperatively so the height measure below reads it correctly.
  const wrap = card.value || (open.value && desired > cap);
  isTall.value = wrap;
  if (ta) {
    ta.style.whiteSpace = wrap ? "pre-wrap" : "nowrap";
    ta.style.height = "0px";
    ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`;
  }
  surfaceH.value = open.value ? measure() : REST;
}
// A width change (open, pill↔card) is mid-flight when it fires, so measuring
// now would read the wrong wrap. Re-measure once the morph has settled.
function syncSoon() {
  void nextTick(sync);
  window.setTimeout(sync, 380);
}

async function wake() {
  if (open.value) return;
  open.value = true;
  opening.value = true;
  // Hold the single-line pill height through the expand; correct once landed.
  surfaceH.value = REST;
  await nextTick();
  surfaceW.value = measureWidth();
  field.value?.focus();
  window.setTimeout(sync, 300);
  window.setTimeout(() => (opening.value = false), 340);
}

// Collapse back to the resting orb. The draft (text + chips) stays in state, so
// waking again restores exactly what was there.
function close() {
  if (!open.value) return;
  open.value = false;
  surfaceH.value = REST;
}
onClickOutside(dock, close);
onKeyStroke("Escape", () => close());

function onSurfaceClick() {
  if (!open.value) {
    void wake();
    return;
  }
  field.value?.focus();
}

// Type anywhere on the project page and the input catches it: the first
// keystroke wakes the composer and lands in the field, so you can just start
// writing. We only claim a plain printable character — never a shortcut combo,
// a key pressed while another field is focused, or one hit while a file detail
// is up (the composer is inert then).
async function onGlobalKey(e: KeyboardEvent) {
  if (open.value || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
  // Single printable char only — "a", "1", "?" pass; "Enter"/"Tab"/arrows don't.
  if (e.key.length !== 1) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
  // A file detail is open → the composer is inert; leave the keystroke alone.
  if (dock.value?.closest("[inert]")) return;
  e.preventDefault();
  text.value += e.key;
  await wake();
  const ta = field.value;
  if (ta) ta.setSelectionRange(ta.value.length, ta.value.length);
}
useEventListener(window, "keydown", onGlobalKey);

function addChip() {
  chips.value.push({ id: chipSeq++, ...chipPool[chips.value.length % chipPool.length]! });
  cue("toggle");
  field.value?.focus();
  syncSoon();
}
function removeChip(id: number) {
  chips.value = chips.value.filter((c) => c.id !== id);
  cue("toggle");
  syncSoon();
}

function send() {
  if (!armed.value) {
    void wake();
    return;
  }
  cue("success");
  text.value = "";
  chips.value = [];
  syncSoon();
}

onMounted(sync);
// Typing changes height at a settled width — measure immediately.
watch(text, () => nextTick(sync));
</script>

<template>
  <div ref="dock" class="dock" :class="{ 'dock--tall': isTall }">
    <!-- Hidden twin of the text, unwrapped — its width is how wide the pill
         wants to be. Kept in the same type as the textarea. -->
    <div ref="mirror" class="mirror" aria-hidden="true">{{ (text || "Ask anything…") + " " }}</div>

    <!-- Controls sit beside the input, not in it. +/image hug its left; they
         fade in as it opens and ride outward on the surface's growing edge. -->
    <div class="side side--lead" :class="{ 'is-shown': open }" :inert="!open">
      <button type="button" class="ibtn" aria-label="Add context" @click.stop="addChip">
        <svg viewBox="0 0 18 18" aria-hidden="true">
          <path d="M9 4.5V13.5M4.5 9H13.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
      </button>
      <button type="button" class="ibtn" aria-label="Attach image">
        <svg viewBox="0 0 18 18" aria-hidden="true">
          <rect x="3" y="4" width="12" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.5" />
          <circle cx="6.6" cy="7.4" r="1.1" fill="currentColor" />
          <path d="M4 12.5L7.5 9.5L10 11.5L12 10L14 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>

    <!-- One surface, morphing. Closed it's the iris orb; open it's the field. -->
    <div
      ref="surface"
      class="surface"
      :class="{ 'is-open': open, 'is-card': card, 'is-opening': opening }"
      :style="{ height: surfaceH + 'px', width: widthStyle }"
      role="button"
      :aria-label="open ? undefined : 'Wake the agent'"
      @click="onSurfaceClick"
    >
      <!-- Context chips ride the gradient at the top of the card -->
      <Transition name="fade">
        <div v-if="hasChips" class="chips">
          <button
            v-for="chip in chips"
            :key="chip.id"
            type="button"
            class="chip"
            @click.stop="removeChip(chip.id)"
          >
            <span v-if="chip.kind === 'pdf'" class="chip__badge chip__badge--pdf">PDF</span>
            <span v-else-if="chip.kind === 'ts'" class="chip__badge chip__badge--ts">TS</span>
            <svg v-else class="chip__folder" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2 4.5C2 3.7 2.7 3 3.5 3H6L7.5 4.5H12.5C13.3 4.5 14 5.2 14 6V11C14 11.8 13.3 12.5 12.5 12.5H3.5C2.7 12.5 2 11.8 2 11V4.5Z" fill="#F0B54A" />
            </svg>
            <span class="chip__name">{{ chip.name }}</span>
            <span v-if="chip.count != null" class="chip__count">{{ chip.count }}</span>
            <svg class="chip__x" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3.5 3.5L8.5 8.5M8.5 3.5L3.5 8.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            </svg>
          </button>
        </div>
      </Transition>

      <!-- White panel: the sleeping face and the field share it, cross-fading. -->
      <div class="panel">
        <!-- Dormant face -->
        <div class="face" aria-hidden="true">
          <svg class="face__eyes" viewBox="0 0 104 104">
            <path d="M32 52 Q40 58 48 52" fill="none" stroke="#241C46" stroke-width="3" stroke-linecap="round" opacity="0.85" />
            <path d="M56 52 Q64 58 72 52" fill="none" stroke="#241C46" stroke-width="3" stroke-linecap="round" opacity="0.85" />
          </svg>
          <span class="face__z face__z--near">z</span>
          <span class="face__z face__z--far">z</span>
        </div>

        <!-- Field · just the text and the send seed; the +/image/model controls
             live beside the surface, not inside it. -->
        <div class="field" :class="{ 'field--tall': isTall }">
          <textarea
            ref="field"
            v-model="text"
            class="field__input"
            rows="1"
            placeholder="Ask anything…"
            :tabindex="open ? 0 : -1"
            @keydown.enter.exact.prevent="send"
          />
          <button
            type="button"
            class="seed"
            :class="{ 'seed--armed': armed }"
            aria-label="Send"
            :tabindex="open ? 0 : -1"
            @mousedown.prevent
            @click.stop="send"
          >
            <svg class="seed__arrow" viewBox="0 0 18 18" aria-hidden="true">
              <path d="M9 14V4.2M9 4.2L4.3 8.9M9 4.2L13.7 8.9" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </div>
      </div>
    </div>

    <!-- The model picker sits beside the input on the right. -->
    <div class="side side--trail" :class="{ 'is-shown': open }" :inert="!open">
      <button type="button" class="model">
        <svg class="model__logo" viewBox="0 0 24 24" aria-hidden="true">
          <path d="m4.714 15.956 4.717-2.647.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.696-.0729-2.337-.0971-2.265-.1214-.5707-.1215-.5343-.7042.055-.3522.48-.3218.686.061 1.518.103 2.277.158 1.651.097 2.447.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.836l-2.55-1.688-1.336-.9714-.7225-.4918-.3643-.4614-.1578-1.8.656-.7225.88.607.225.607.893.686 1.906 1.475 2.489 1.834.364.303.146-.1032.018-.0728-.164-.2733-1.354-2.447-1.445-2.489-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.134 6.7 0l.9957.134.419.364.619 1.415 1.002 2.228 1.554 3.3.455.899.243.832.091.255h.1579v-.1457l.1275-1.706.237-2.95.231-2.696.079-.7589.376-.9107.747-.4918.583.279.48.686-.668.443-.2853 1.852-.5586 2.902-.3643 1.943h.2125l.2429-.2429.983-1.305 1.651-2.64.729-.8196.85-.9046.546-.4311h1.032l.759 1.129-.34 1.166-1.063 1.348-.8804 1.141-1.263 1.7-.7893 1.36.73.109.188-.0183 2.853-.607 1.542-.2794 1.84-.3157.832.389.91.395-.3278.807-1.967.486-2.307.461-3.436.814-.425.03.486.061 1.548.146.662.036h1.621l3.18.225.789.522.474.638-.79.486-1.214.619-1.639-.3886-3.825-.9107-1.311-.3279h-.1822v.1093l1.093 1.069 2.003 1.809 2.507 2.331.127.577-.3218.455-.34-.0486-2.204-1.657-.85-.7468-1.925-1.621h-.1275v.17l.4432.65 2.344 3.521.121 1.081-.17.352-.6071.212-.6679-.1214-1.372-1.925L14.38 17.959l-1.141-1.943-.1397.079-.674 7.255-.3156.37-.7286.279-.6071-.4614-.3218-.7468.322-1.475.389-1.925.316-1.53.285-1.9.17-.6314-.0121-.0425-.1397.018-1.433 1.967-2.18 2.945-1.724 1.846-.4128.164-.7164-.3704.067-.6618.401-.5889 2.386-3.036 1.439-1.882.929-1.087-.0062-.1579h-.0546l-6.338 4.116-1.129.146-.4857-.4554.061-.7467.231-.2429 1.906-1.311Z" fill="#D97757" />
        </svg>
        <span class="model__name">Opus 4.8</span>
        <svg class="model__chev" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 4.8L6 7.8L9 4.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
/* The canonical iris — one conic sweep, plus a sheen the send seed layers on top
   so it reads as a glossy marble. */
.dock {
  --iris: conic-gradient(
    in oklab from 205deg at 50% 50%,
    oklab(65.3% 0.048 -0.161) 0%,
    oklab(65.5% -0.02 -0.155) 20%,
    oklab(79.6% -0.1 -0.046) 40%,
    oklab(89.9% 0.019 0.087) 60%,
    oklab(79.3% 0.1 0.069) 80%,
    oklab(65.3% 0.048 -0.161) 100%
  );
  --sheen: radial-gradient(
    ellipse 125% 125% at 30% 24% in oklab,
    oklab(100% 0 0 / 85%) 0%,
    oklab(100% 0 0 / 0%) 42%
  );
  --surface: #ffffff;
  --field-ink: #17171a;
  --placeholder: #b7b4ae;
  --btn: #ffffff;
  --btn-border: rgb(0 0 0 / 0.08);
  --btn-ink: #55555a;
  --chip: #fbfaf9;
  --chip-ink: #3a3a3e;
  --chip-x: #b0aea9;

  display: flex;
  flex-direction: row;
  align-items: center;
  width: max-content;
}
/* When the pill grows tall, the side controls drop to the bottom with the send
   seed (the padding lines them up with the seed's inset). */
.dock--tall { align-items: flex-end; }
.dock--tall .side { padding-bottom: 12px; }

/* ── Side controls ────────────────────────────────────────────────────────── */
/* Equal-width slots flank the surface so it stays screen-centred; the controls
   hug the pill and fade/slide in as it opens. */
.side {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  width: 140px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.26s ease, transform 0.32s cubic-bezier(0.22, 1, 0.36, 1);
}
.side--lead { justify-content: flex-end; gap: 8px; padding-right: 10px; transform: translateX(10px); }
.side--trail { justify-content: flex-start; padding-left: 10px; transform: translateX(-10px); }
.side.is-shown {
  opacity: 1;
  transform: none;
  pointer-events: auto;
  transition: opacity 0.22s ease 0.1s, transform 0.28s cubic-bezier(0.22, 1, 0.36, 1) 0.1s;
}

@media (prefers-color-scheme: dark) {
  .dock {
    --surface: #161619;
    --field-ink: #f4f4f5;
    --placeholder: #6b6b72;
    --btn: #1f1f23;
    --btn-border: rgb(255 255 255 / 0.1);
    --btn-ink: #c4c4c8;
    --chip: #202024;
    --chip-ink: #e6e6e8;
    --chip-x: #7a7a80;
  }
}

/* ── The morphing surface ─────────────────────────────────────────────────── */
/* At rest it's a 52px iris orb. Open, it becomes the gradient rim around a white
   field. Width, corner radius, rim padding and height all ease together, so the
   orb visibly expands and collapses. */
.surface {
  position: relative;
  overflow: hidden;
  /* Own compositing layer — keeps the rounded-corner clip of the gradient rim
     crisp instead of aliased. */
  transform: translateZ(0);
  isolation: isolate;
  width: 55px;
  padding: 0;
  border-radius: 50%;
  background-image: var(--iris);
  cursor: pointer;
  pointer-events: auto;
  /* Collapse: it shrinks back to the orb first, then the corners round off into
     a circle last — the mirror of the expand's anticipation. */
  transition:
    width 0.4s cubic-bezier(0.22, 1, 0.36, 1),
    height 0.4s cubic-bezier(0.22, 1, 0.36, 1),
    padding 0.22s ease 0.16s,
    border-radius 0.26s ease 0.18s;
}
.surface.is-open {
  width: 360px; /* fallback; the pill's real width is driven inline to fit text */
  padding: 2.5px;
  border-radius: 32px;
  cursor: default;
  /* Open + everyday sizing: width tracks the text and height follows, snappy
     with no delay so typing feels responsive. */
  transition:
    border-radius 0.13s cubic-bezier(0.4, 0, 0.2, 1),
    padding 0.13s ease,
    width 0.16s cubic-bezier(0.22, 1, 0.36, 1),
    height 0.22s cubic-bezier(0.22, 1, 0.36, 1);
}
/* Only through the wake expand: corners square off to the input's radius first,
   then the body stretches out — so it never passes through an ellipse. */
.surface.is-open.is-opening {
  transition:
    border-radius 0.13s cubic-bezier(0.4, 0, 0.2, 1),
    padding 0.13s ease,
    width 0.28s cubic-bezier(0.22, 1, 0.36, 1) 0.09s,
    height 0.28s cubic-bezier(0.22, 1, 0.36, 1) 0.09s;
}
.surface.is-card {
  width: clamp(400px, 56vw, 720px);
  border-radius: 26px;
}

/* White field body. Transparent at rest so the orb reads as a solid marble.
   Its corners track the surface's on the same curve so the gradient rim keeps an
   even thickness all the way through the morph. */
.panel {
  position: relative;
  height: 100%;
  border-radius: inherit;
  background: transparent;
  transition: background-color 0.28s ease, border-radius 0.13s cubic-bezier(0.4, 0, 0.2, 1);
}
.surface.is-open .panel {
  background: var(--surface);
  border-radius: 29.5px;
}
.surface.is-card .panel { border-radius: 23.5px; }

/* ── Dormant face ─────────────────────────────────────────────────────────── */
.face {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  opacity: 1;
  transition: opacity 0.18s ease;
  pointer-events: none;
  animation: breathe 5.5s ease-in-out infinite;
}
.surface.is-open .face { opacity: 0; transition: opacity 0.16s ease; }
.face__eyes { width: 55px; height: 55px; }
.face__z {
  position: absolute;
  font-style: italic;
  font-weight: 600;
  color: #b4b0be;
}
.face__z--near { right: 8px; top: 6px; font-size: 12px; }
.face__z--far { right: 1px; top: -2px; font-size: 9px; color: #c8c4d0; }
@keyframes breathe {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.04); }
}

/* ── Field ────────────────────────────────────────────────────────────────── */
/* Fades in a beat after the expand begins so text never appears mid-squeeze. */
.field {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 100%;
  padding: 8px 8px 8px 20px;
  opacity: 0;
  transition: opacity 0.18s ease;
}
.surface.is-open .field { opacity: 1; transition: opacity 0.2s ease 0.08s; }
/* Single line: text and seed sit centred. Once it wraps, the seed drops to the
   bottom while the text fills upward. */
.field--tall { align-items: flex-end; }
.surface.is-card .field {
  flex-direction: column;
  align-items: stretch;
  gap: 14px;
  padding: 14px 14px 14px 20px;
}
.field__input {
  flex: 1 1 0;
  width: 100%;
  min-width: 0;
  border: 0;
  outline: 0;
  resize: none;
  background: transparent;
  color: var(--field-ink);
  font-family: var(--font-sans);
  font-size: 16px;
  line-height: 20px;
  max-height: 240px;
  overflow: hidden;
  cursor: text;
}
.surface.is-card .field__input { flex: 0 0 auto; line-height: 25px; white-space: pre-wrap; }
.field__input::placeholder { color: var(--placeholder); }

/* Off-screen twin of the text at the textarea's type — measured to size the
   pill's width. Kept in sync with .field__input's font/size/line-height. */
.mirror {
  position: absolute;
  left: -9999px;
  top: 0;
  visibility: hidden;
  pointer-events: none;
  white-space: pre;
  font-family: var(--font-sans);
  font-size: 16px;
  line-height: 20px;
}

/* ── Send seed ────────────────────────────────────────────────────────────── */
.seed {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  border: 0;
  padding: 0;
  border-radius: 50%;
  cursor: pointer;
  background-image: var(--sheen), var(--iris);
  box-shadow: rgb(255 255 255 / 0.6) 0 1px 2px inset;
  transition: box-shadow 0.3s ease, transform 0.2s ease;
}
.surface.is-card .seed { width: 36px; height: 36px; align-self: flex-end; }
.seed--armed {
  box-shadow:
    rgb(255 255 255 / 0.6) 0 1px 2px inset,
    rgb(139 124 240 / 0.16) 0 0 0 4px;
}
.seed:hover { transform: scale(1.06); }
.seed:active { transform: scale(0.94); }
.seed__arrow { width: 15px; height: 15px; }
.surface.is-card .seed__arrow { width: 16px; height: 16px; }

/* ── Chips ────────────────────────────────────────────────────────────────── */
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 13px 14px 11px;
}
.chip {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 9px 0 8px;
  border: 1px solid var(--btn-border);
  border-radius: 9px;
  background: var(--chip);
  color: var(--chip-x);
  cursor: pointer;
}
.chip__badge {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  color: #fff;
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: 7.5px;
  line-height: 1;
}
.chip__badge--pdf { background: #f04438; }
.chip__badge--ts { background: #3178c6; font-size: 8px; }
.chip__folder { width: 16px; height: 16px; flex-shrink: 0; }
.chip__name { color: var(--chip-ink); font-size: 13px; font-weight: 500; line-height: 16px; }
.chip__count { color: var(--chip-x); font-family: var(--font-mono); font-size: 11px; line-height: 14px; }
.chip__x { width: 12px; height: 12px; flex-shrink: 0; }

/* ── Side control buttons (bare on the ground, beside the pill) ───────────── */
/* No pill, no border, no shadow — just the mark, in kone's borderless idiom.
   Hover only lifts the ink, it never draws a container. */
.ibtn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--btn-ink);
  cursor: pointer;
  opacity: 0.72;
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.ibtn svg { width: 18px; height: 18px; }
.ibtn:hover { opacity: 1; transform: translateY(-1px); }
.ibtn:active { transform: translateY(0) scale(0.96); }
.model {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 4px;
  border: 0;
  background: transparent;
  color: #9a9a97;
  cursor: pointer;
  opacity: 0.82;
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.model:hover { opacity: 1; transform: translateY(-1px); }
.model__logo { width: 15px; height: 15px; flex-shrink: 0; }
.model__name { color: var(--chip-ink); font-size: 13px; font-weight: 500; line-height: 16px; }
.model__chev { width: 12px; height: 12px; flex-shrink: 0; }

.fade-enter-active { transition: opacity 0.24s ease 0.08s; }
.fade-leave-active { transition: opacity 0.14s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

@media (prefers-reduced-motion: reduce) {
  .surface, .panel, .face, .field, .seed { transition-duration: 0.01s; transition-delay: 0s; }
  .face { animation: none; }
  .side { transition-duration: 0.01s; transition-delay: 0s; }
  .fade-enter-active, .fade-leave-active { transition-duration: 0.01s; }
}
</style>
