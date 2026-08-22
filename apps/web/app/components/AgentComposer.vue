<script setup lang="ts">
import { computed, h, nextTick, onMounted, onUnmounted, ref, render, watch } from "vue";
import { onClickOutside, onKeyStroke, useEventListener } from "@vueuse/core";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  AiBrain01Icon,
  BubbleChatTemporaryIcon,
  CornerDownRightIcon,
  DiceFaces05Icon,
  FlashIcon,
  Folder01Icon,
  GitBranchIcon,
  PlusSignIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import SphereFace from "~/components/SphereFace.vue";
import AgentBotBead from "~/components/AgentBotBead.vue";
import ProjectFileMentionMenu from "~/components/ProjectFileMentionMenu.vue";
import MentionChip from "~/components/MentionChip.vue";
import ProviderLogo from "~/components/ProviderLogo.vue";
import type { AttachmentKind, GitProjectFile, InteractionMode } from "~/types/desktop";
import { useProjectFiles } from "~/composables/useProjectFiles";
import type { QueuedTurnEntry } from "~/composables/useAgent";
import { agentIdentity } from "~/utils/agentIdentity";
import { agentForThread, GUEST_LABEL, type Agent } from "~/utils/agents";
import {
  detectFileMentionTrigger,
  formatFileMention,
  splitComposerMentionSegments,
  type FileMentionTrigger,
} from "~/utils/composerMentions";
import {
  effortForTier,
  familyForId,
  hasEffortChoice,
  type EffortTier,
  type ModelOption,
} from "~/utils/modelCatalog";

// "Agent input — states" board. One object walks four states:
//   dormant  · a calm orb at rest, breathing
//   ready    · it EXPANDS into a pill; the sleeping face fades to the field
//   typing   · the pill grows to fit the text (auto-height, never a scrollbar)
//   composing· attach context and it widens into a card; chips ride the top
// The whole thing is one surface that morphs — it expands and collapses, it
// never swaps one element out for another.
//
// It's now wired: it sends the draft to the agent session (via @send), and the
// seed turns into a stop button while a turn is in flight. Both model controls
// sit on the RIGHT of the field: the model picker (each family with its own
// provider logomark) and — only when the chosen model exposes more than one —
// The effort has no dropdown: clicking the brain CYCLES to the next real effort
// for that model and wraps. The effort is encoded into the model id we emit, so
// the parent stays oblivious to whether a provider bakes it into ids or a flag.

const props = defineProps<{
  /** Absolute project root used by the @ file picker. */
  projectPath: string;
  /** Project display name for the context tray tucked under the card. */
  projectName?: string;
  /** The checked-out branch, shown in the tray. Omit it (a non-git folder) and
   *  the chip is gone. */
  branch?: string;
  /** When true (the default), the branch chip opens the picker. Once a thread
   *  has already started, the host turns this off so the chip is only a label. */
  branchSwitchable?: boolean;
  /** The focused thread's title, parked on the far right of the tray so the
   *  left stays who and where. Empty / missing falls back to "New thread". */
  threadName?: string;
  /** The focused thread's durable id — the seed its identity is rolled from.
   *  Empty until the thread's first send, which is when it acquires a face. */
  threadId?: string | null;
  /** A turn is running — the send seed becomes a stop, Enter is inert. */
  busy?: boolean;
  /** Follow-ups durably queued behind the running turn (AgentService). The
   *  chips render from these — the host owns the queue (send while busy
   *  enqueues; cancel/steer round-trip through the bridge). */
  queued?: QueuedTurnEntry[];
  /** The full model picker is open (hosted by the parent, outside our dock).
   *  While it is, a click in it — or on its scrim — must NOT collapse us. */
  picking?: boolean;
  /** Who you can hand the turn to. Guest is never in here — it is the absence of
   *  a choice, so the menu adds it itself and an empty roster still offers it. */
  agents?: Agent[];
  /** The agent the next turn goes to, or null/undefined for a guest. */
  agentId?: string | null;
  /** When true (the default), the agent slot opens the roster. A thread has one
   *  agent for its whole life, so once it has started the host turns this off and
   *  the slot only names who is on it. */
  agentSwitchable?: boolean;
  /** The provider's models, grouped into families with real efforts. */
  models?: ModelOption[];
  /** The selected raw model id (carries the effort for a baked-suffix provider),
   *  or undefined for default. */
  modelId?: string;
  /** The current reasoning-effort tier. For a flag-based provider (Codex) this
   *  is the ONLY thing that tells a family's synthetic ladder rungs apart —
   *  they all share one `modelId`. */
  reasoning?: EffortTier;
  /** The agent's permission mode — how much it may do without asking. */
  mode?: InteractionMode;
  /** Is the model's real "fast" service tier (Codex's `serviceTiers`) active
   *  for this turn? Only meaningful when the current model has one. */
  fastMode?: boolean;
  /** The chosen context-window id (Claude's "200k"/"1m" auto-compact window).
   *  Only meaningful when the current model exposes more than one window;
   *  undefined falls back to that model's default window. */
  contextWindow?: string;
}>();

const emit = defineEmits<{
  /** The draft, plus any picked files. The parent uploads the files (scoped to
   *  the final thread) and hands the resulting metadata to the agent turn. */
  send: [text: string, files?: File[]];
  /** Steer the draft into the RUNNING turn — same turn, no new boundary. The
   *  parent routes it to the provider's live-steer channel (or the queue
   *  when the provider has none). */
  steer: [text: string, files?: File[]];
  /** Drop one durably queued follow-up (the chips' ✕). */
  "remove-queued": [queueId: string];
  interrupt: [];
  /** null hands the turn to a guest — see `agentId`. */
  "update:agentId": [id: string | null];
  "update:modelId": [id: string];
  "update:reasoning": [tier: EffortTier];
  "update:mode": [mode: InteractionMode];
  "update:fastMode": [on: boolean];
  "update:contextWindow": [id: string];
  /** Ask the host to open the full providers→models→effort picker. */
  "open-models": [];
  /** Ask the host to open the branch picker (the tray's branch chip). */
  "open-branch": [];
  /** Whether the surface is expanded into the input. The host lifts the
   *  composer's layer while it's open so the corner docks can't sit over it on
   *  a narrow window. */
  "update:open": [open: boolean];
}>();

const { cue } = useSound();

const threadLabel = computed(() => props.threadName?.trim() || "New thread");
const canSwitchBranch = computed(() => props.branchSwitchable !== false);

// ── agent (leading the context tray) ─────────────────────────────────────────
// Who the turn goes to. It sits in the tray with the project and the branch
// rather than on the button rail, because it belongs with the facts about where
// the turn lands, not with the knobs that shape it. The roster is a small
// popover rather than a cycle — you pick a colleague deliberately, you don't
// step through them.
//
// You pick on a blank thread only, the same rule the branch follows. One thread
// is one agent's work from end to end: swapping halfway would leave a transcript
// where the speaker changes but the history doesn't, and every line above the
// swap would be attributed to somebody who never wrote it.
const roster = computed<Agent[]>(() => props.agents ?? []);
/** undefined when the turn goes to a guest. Deliberately no fall back to the
 *  first of the roster: an agent is opt-in, so nobody is assigned by default. */
const currentAgent = computed(() => roster.value.find((a) => a.id === props.agentId));
const canSwitchAgent = computed(() => props.agentSwitchable !== false);

/**
 * Who is already on this thread, once it is no longer yours to change. Null while
 * the choice is still open, so the slot is a picker on a blank thread and a label
 * after that.
 *
 * A settled thread never reads "Guest": the moment it starts it is handed a name
 * and a face rolled from its own id, and that is a real identity to name, not the
 * absence of one. Guest is the word for a choice you haven't made yet — after the
 * first send there is no choice left to describe.
 */
const settledIdentity = computed(() => {
  if (canSwitchAgent.value) return null;
  const identity = agentIdentity(props.threadId);
  // A face is the proof the roll happened. Without a seed there is nothing to
  // name, so keep offering the picker rather than labelling the slot with a
  // placeholder.
  return identity.svg ? identity : null;
});

/**
 * The bot resting on the composer, or null for the rolled face.
 *
 * Whose bot it is follows the same line the tray's own slot does: on a settled
 * thread it is the agent the thread was handed to, and on a blank one it is
 * whoever is about to take the turn — so the bead shows the change the moment the
 * pick is made, and then stops moving for the life of the thread.
 *
 * A named agent with no bot falls back to the rolled face rather than to the
 * default bot. Having no bot is a real answer in the picker, and inventing one
 * here would put a creature on the composer that its maker never chose.
 */
const beadBot = computed(() => {
  const owner = canSwitchAgent.value ? currentAgent.value : agentForThread(props.threadId);
  return owner?.bot ?? null;
});

const agentMenu = ref(false);
const agentPop = ref<HTMLElement>();

/** The tray clips its own contents so it can collapse to nothing, which would
 *  also cut off a menu opening out of it. This lifts the clip for as long as the
 *  menu needs it — raised the moment it opens, dropped only once the leave
 *  transition has finished, so the menu fades out whole instead of vanishing. */
const spilling = ref(false);

function toggleAgentMenu() {
  agentMenu.value = !agentMenu.value;
  if (agentMenu.value) spilling.value = true;
  cue("toggle");
}

function pickAgent(id: string | null) {
  agentMenu.value = false;
  if (id === (currentAgent.value?.id ?? null)) return;
  emit("update:agentId", id);
  cue("select");
}

onClickOutside(agentPop, () => {
  agentMenu.value = false;
});

// A thread settling while the roster is up takes the popover down with it, and
// the clip it lifted would never be dropped, because the leave transition that
// drops it no longer has anything to run on.
watch(canSwitchAgent, (can) => {
  if (can) return;
  agentMenu.value = false;
  spilling.value = false;
});

// ── model + effort pickers (both on the right) ─────────────────────────────────
// The family comes from the model id; the effort within it comes from the
// reasoning tier (not the id — a synthetic ladder's rungs all share one id).
const catalog = computed<ModelOption[]>(() => props.models ?? []);
const currentFamily = computed(() => familyForId(catalog.value, props.modelId));
const currentEffort = computed(() => effortForTier(currentFamily.value, props.reasoning));
const showEffort = computed(() => hasEffortChoice(currentFamily.value));
// Fast mode — a plain on/off toggle for the current family's real "fast"
// service tier (Codex's `serviceTiers`), when it has one. Most models don't.
const fastTier = computed(() => currentFamily.value?.fastTier);
// Context window — a small cycle over the family's windows (Claude's 200k/1m
// auto-compact window), when it has a choice. The current one is the prop, else
// the family's own default, else the first.
const contextWindows = computed(() => currentFamily.value?.contextWindows);
const currentWindow = computed(() => {
  const windows = contextWindows.value;
  if (!windows?.length) return undefined;
  return (
    windows.find((w) => w.id === props.contextWindow) ??
    windows.find((w) => w.isDefault) ??
    windows[0]
  );
});

const modelName = computed(
  () => currentFamily.value?.label ?? props.modelId ?? "Default model",
);
// The mark beside the model name is the model's own vendor — already resolved
// on the family (a harness provider's family carries its true vendor, so an
// opencode DeepSeek model shows DeepSeek here).
const modelBrand = computed(() => currentFamily.value?.brand ?? "generic");

// The model name opens the full picker (hosted by the parent); the composer
// only displays the current family + brand.
function openModels() {
  emit("open-models");
  cue("toggle");
}
// Cycle the effort: each click steps to the next real effort for this model and
// wraps at the end. No dropdown — the brain-stack + label carry the state.
const bumping = ref(false);
function cycleEffort() {
  const fam = currentFamily.value;
  if (!fam || fam.efforts.length < 2) return;
  const idx = fam.efforts.findIndex((e) => e.tier === props.reasoning);
  const next = fam.efforts[(idx + 1) % fam.efforts.length];
  if (!next) return;
  emit("update:modelId", next.modelId);
  emit("update:reasoning", next.tier);
  cue("toggle");
  // A quick tactile bump so the step registers.
  bumping.value = false;
  void nextTick(() => {
    bumping.value = true;
    window.setTimeout(() => (bumping.value = false), 240);
  });
}
// Brain-stack: N glyphs whose count + fill climb with the tier.
function brainStack(n: number): number[] {
  return Array.from({ length: Math.max(1, n) }, (_, i) => i);
}
// Toggle the current family's fast tier on/off — a plain boolean, not a cycle.
function toggleFastMode() {
  if (!fastTier.value) return;
  emit("update:fastMode", !props.fastMode);
  cue("toggle");
}
// Cycle the context window: step to the next one for this family and wrap. Two
// windows (200k/1m) makes this a toggle; the label carries the state.
function cycleContextWindow() {
  const windows = contextWindows.value;
  if (!windows || windows.length < 2 || !currentWindow.value) return;
  const idx = windows.findIndex((w) => w.id === currentWindow.value!.id);
  const next = windows[(idx + 1) % windows.length];
  if (!next) return;
  emit("update:contextWindow", next.id);
  cue("toggle");
}

// ── permission mode (how much the agent may do without asking) ─────────────────
// This IS the approval policy — a climbing ladder of autonomy, cycled on click
// like the effort control — no dropdown. Each rung maps to a real Codex
// approval/sandbox pairing downstream (ask / accept-edits / full-access); the
// icon carries a soft hue cue, calm at the bottom and warm at the top. The
// label always names the current rung so the cycle stays discoverable. (Not
// to be confused with a provider's separate plan/build turn mode — kone
// doesn't expose that as its own toggle yet.)
type ModeMeta = { id: InteractionMode; label: string; title: string; hue: string };
const MODES: ModeMeta[] = [
  { id: "ask", label: "Ask user", title: "Ask user — reads and asks before any change", hue: "#6E8BEF" },
  { id: "accept-edits", label: "Edits only", title: "Edits only — auto-approves file edits, asks before commands", hue: "#5EAF8C" },
  { id: "full-access", label: "Full access", title: "Full access — runs everything without prompting", hue: "#D08466" },
];
const currentMode = computed(
  () => MODES.find((m) => m.id === (props.mode ?? "accept-edits")) ?? MODES[1]!,
);
const modeBump = ref(false);
function cycleMode() {
  const idx = MODES.findIndex((m) => m.id === currentMode.value.id);
  const next = MODES[(idx + 1) % MODES.length]!;
  emit("update:mode", next.id);
  cue("toggle");
  modeBump.value = false;
  void nextTick(() => {
    modeBump.value = true;
    window.setTimeout(() => (modeBump.value = false), 240);
  });
}

const open = ref(false);
watch(open, (v) => emit("update:open", v));
// `text` is the serialized value the composer sends: plain prose with each
// completed mention written back as its full @path token. The editable field is
// a contenteditable surface (below) whose DOM holds text nodes + atomic chip
// spans; `text` is derived from it, never bound to it.
const text = ref("");
const field = ref<HTMLElement | null>(null);
const surface = ref<HTMLElement | null>(null);
const dock = ref<HTMLElement | null>(null);

// ── draft persistence ────────────────────────────────────────────────────────
// The draft (text + @mention chips) is component state, so a project switch or
// a renderer reload used to wipe it. It's saved debounced to localStorage under
// the composer's identity — the project root it's bound to — and restored on
// mount. Attachments are File objects and can't survive a reload; only the
// text rides along. Cleared on send, so a consumed draft never resurrects.
const DRAFT_KEY = computed(() => `kone:draft:${props.projectPath}`);
let draftSaveTimer: number | null = null;
function scheduleDraftSave(): void {
  if (draftSaveTimer) clearTimeout(draftSaveTimer);
  draftSaveTimer = window.setTimeout(persistDraft, 350);
}
function persistDraft(): void {
  draftSaveTimer = null;
  try {
    const draft = text.value.trim();
    if (draft) window.localStorage.setItem(DRAFT_KEY.value, draft);
    else window.localStorage.removeItem(DRAFT_KEY.value);
  } catch {
    // Storage unavailable (private mode / quota) — a lost draft is not an
    // error worth surfacing; the in-memory draft still works this session.
  }
}
function restoreDraft(): void {
  try {
    const saved = window.localStorage.getItem(DRAFT_KEY.value);
    if (saved) setEditorFromText(saved);
  } catch {
    // Same: storage unavailable → start clean.
  }
}

// ── project file mentions ────────────────────────────────────────────────────
// @ opens a small project-scoped picker over the field. The field itself is a
// contenteditable surface: prose lives in plain text nodes, and a chosen file
// becomes an atomic <MentionChip> span (a type logo + the bare filename) that
// the browser deletes as one unit. On every edit we serialize the DOM back into
// `text` — chips write out as their full @path — so what the provider receives
// is unchanged even though the field shows only names.
const mentionTrigger = ref<FileMentionTrigger | null>(null);
const mentionActiveIndex = ref(0);
// The live DOM position of the active trigger (which text node, and the char
// range of the "@query" inside it) so a pick can splice a chip in exactly there.
type DomTrigger = { node: Text; start: number; end: number };
let domTrigger: DomTrigger | null = null;
const mentionQuery = computed(() => mentionTrigger.value?.query ?? "");
const mentionOpen = computed(() => open.value && mentionTrigger.value !== null && !props.busy);
const projectFiles = useProjectFiles(
  () => props.projectPath,
  () => mentionQuery.value,
);
const mentionFiles = computed(() => projectFiles.entries.value);
const mentionPending = computed(() => projectFiles.pending.value);
const mentionError = computed(() => projectFiles.error.value);

// Placeholder shows only when the field is truly empty (no prose, no chips).
const isEmpty = computed(() => text.value.trim().length === 0);

// Mint a chip element by mounting a live MentionChip into a detached host and
// handing back its root node. It's mounted live (not cloned) because the file
// icon (@iconify/vue) fills its SVG in a tick after mount — a synchronous clone
// would freeze an empty placeholder. Each chip's host is tracked so its Vue
// scope can be torn down when the field is cleared or the composer unmounts.
const chipHosts = new Set<HTMLElement>();
function makeChipEl(path: string): HTMLElement {
  const host = document.createElement("div");
  render(h(MentionChip, { path }), host);
  const chip = host.firstElementChild as HTMLElement | null;
  if (!chip) {
    render(null, host);
    const span = document.createElement("span");
    span.textContent = path;
    span.setAttribute("contenteditable", "false");
    span.dataset.mentionPath = path;
    return span;
  }
  chip.setAttribute("contenteditable", "false");
  chip.dataset.mentionPath = path;
  chipHosts.add(host);
  return chip;
}
// Unmount every live chip's Vue scope (the DOM nodes are already gone once the
// field is wiped). Called on clear/send and unmount so nothing lingers.
function disposeChips(): void {
  for (const host of chipHosts) render(null, host);
  chipHosts.clear();
}

// Walk the field's DOM into the serialized draft: text nodes verbatim, chips as
// their full @path token, and line breaks (a native <br> / block split from
// Shift+Enter) as "\n".
function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  if (el.dataset.mentionPath !== undefined) return formatFileMention(el.dataset.mentionPath);
  if (el.tagName === "BR") return "\n";
  let inner = "";
  for (const child of Array.from(el.childNodes)) inner += serializeNode(child);
  return /^(DIV|P)$/.test(el.tagName) ? `\n${inner}` : inner;
}
function serializeEditor(): string {
  const el = field.value;
  if (!el) return "";
  let out = "";
  for (const child of Array.from(el.childNodes)) out += serializeNode(child);
  // A lone bogus <br> the browser keeps in an "empty" field serializes to "\n";
  // treat a value that is only whitespace as empty so the placeholder returns.
  return out.replace(/^\n/, "");
}

// Read `text` back off the DOM after any edit, refresh the mention trigger from
// the live caret, and re-measure the surface.
function onEditorChanged(): void {
  text.value = serializeEditor();
  refreshTrigger();
  void nextTick(sync);
}

// Find an active @token at the collapsed caret, scoped to the caret's own text
// node. Reuses the shared detector so the "@ only after whitespace" rule holds.
function readDomTrigger(): { trigger: FileMentionTrigger; dom: DomTrigger } | null {
  const root = field.value;
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  if (!root || !sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE || !root.contains(node)) return null;
  const textNode = node as Text;
  const trigger = detectFileMentionTrigger(textNode.data, range.startOffset);
  if (!trigger) return null;
  return { trigger, dom: { node: textNode, start: trigger.rangeStart, end: range.startOffset } };
}

function refreshTrigger(): void {
  const found = readDomTrigger();
  domTrigger = found?.dom ?? null;
  mentionTrigger.value = found?.trigger ?? null;
}

function placeCaret(node: Node, offset: number): void {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function selectMention(file: GitProjectFile): void {
  const trig = domTrigger;
  const root = field.value;
  if (!trig || !root) return;

  // Split the trigger's text node into [before][query][after], drop the query
  // text, and drop a chip where it was. A trailing space keeps the next word off
  // the chip — reusing one already sitting after the caret so we never double it.
  const after = trig.node.splitText(trig.end);
  trig.node.splitText(trig.start);
  const parent = trig.node.parentNode;
  const queryNode = trig.node.nextSibling;
  if (!parent || !queryNode) return;
  parent.removeChild(queryNode);

  const chip = makeChipEl(file.path);
  parent.insertBefore(chip, after);

  let caretNode: Node;
  let caretOffset: number;
  if (after.nodeType === Node.TEXT_NODE && (after as Text).data.startsWith(" ")) {
    caretNode = after;
    caretOffset = 1;
  } else {
    const space = document.createTextNode(" ");
    parent.insertBefore(space, after);
    caretNode = space;
    caretOffset = 1;
  }

  root.focus();
  placeCaret(caretNode, caretOffset);
  mentionActiveIndex.value = 0;
  onEditorChanged();
}

function onFieldInput(): void {
  onEditorChanged();
}
function onFieldClick(): void {
  refreshTrigger();
}
function onFieldKeyup(): void {
  refreshTrigger();
}

function onFieldKeydown(e: KeyboardEvent): void {
  if (mentionOpen.value) {
    const count = projectFiles.entries.value.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (count) mentionActiveIndex.value = (mentionActiveIndex.value + 1) % count;
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (count) mentionActiveIndex.value = (mentionActiveIndex.value - 1 + count) % count;
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      const file = projectFiles.entries.value[mentionActiveIndex.value];
      if (file) {
        e.preventDefault();
        selectMention(file);
        return;
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      mentionTrigger.value = null;
      domTrigger = null;
      return;
    }
  }
  // Plain Enter sends. Shift+Enter falls through to the browser's native
  // line-break (it manages the caret correctly), which serializes back as "\n".
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submitOrQueue();
  }
}

// Rebuild the field's DOM from a serialized draft, parsing completed @paths back
// into chips. Used to restore a draft and to clear on send.
function setEditorFromText(value: string): void {
  const el = field.value;
  if (!el) return;
  el.replaceChildren();
  disposeChips();
  for (const segment of splitComposerMentionSegments(value)) {
    if (segment.type === "mention") el.appendChild(makeChipEl(segment.path));
    else if (segment.text) el.appendChild(document.createTextNode(segment.text));
  }
  text.value = serializeEditor();
}

function clearEditor(): void {
  field.value?.replaceChildren();
  disposeChips();
  text.value = "";
  mentionTrigger.value = null;
  domTrigger = null;
}

function focusEditorEnd(): void {
  const el = field.value;
  if (!el) return;
  el.focus();
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

// Insert plain text at the caret (used by paste + type-anywhere-to-focus),
// falling back to the field's end when there's no live selection inside it.
function insertTextAtCaret(value: string): void {
  const el = field.value;
  if (!el) return;
  const sel = window.getSelection();
  let range: Range;
  if (sel && sel.rangeCount && el.contains(sel.anchorNode)) {
    range = sel.getRangeAt(0);
    range.deleteContents();
  } else {
    range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
  }
  const node = document.createTextNode(value);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  sel?.removeAllRanges();
  sel?.addRange(range);
}

// The surface is sized imperatively so it can animate (CSS can't transition to
// `auto`). Open, it is ONE shape — a card of fixed width (CSS owns it) whose
// height follows the text. The orb expands straight into that card, so waking
// is a single move (width + corners + height together) instead of a pill that
// then has to widen per keystroke. Only the height is measured here.
const REST = 55;
const surfaceH = ref(REST);
// True only during the wake expand, so the corner-lead stagger applies then but
// not on every keystroke width change.
const opening = ref(false);
// A big/structural size change (paste, drop, wrap toggle, pill↔card) springs;
// the small per-keystroke nudges of ordinary typing stay snappy so the field
// tracks the cursor instead of wobbling behind it.
const springy = ref(false);
// Size changes below this (px) read as incremental typing → snappy, not spring.
const SPRING_MIN = 64;
let lastCard = false;

// ── attachments ────────────────────────────────────────────────────────────
// The composer holds the picked File objects locally (with an object-URL
// preview for images) and emits them on send; the parent uploads them to disk
// so they're scoped to the final thread. Limits mirror the main-process store
// (see MAX_ATTACHMENTS_PER_TURN / *_BYTES in the agent contract) so an oversize
// or over-count pick is caught here before it ever reaches an IPC round-trip.
const MAX_ATTACHMENTS = 8;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

type PendingAttachment = {
  id: number;
  file: File;
  name: string;
  kind: AttachmentKind;
  sizeBytes: number;
  /** A short uppercase badge for non-image files, e.g. "PDF", "MD". */
  ext: string;
  /** An object URL for image previews; revoked on remove / unmount. */
  previewUrl?: string;
};
let attachSeq = 0;
const attachments = ref<PendingAttachment[]>([]);
// A brief, self-clearing note when a pick is rejected (too big / too many).
const notice = ref("");
let noticeTimer: number | undefined;
function flash(msg: string) {
  notice.value = msg;
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => (notice.value = ""), 3200);
}

const fileInput = ref<HTMLInputElement | null>(null);
const dragging = ref(false);
let dragDepth = 0;

function extFor(file: File): string {
  const dot = file.name.lastIndexOf(".");
  const raw = dot > 0 ? file.name.slice(dot + 1) : "";
  return (raw || "FILE").slice(0, 4).toUpperCase();
}

// Take a FileList (picker, drop, or paste) into pending attachments, enforcing
// the count + per-kind size caps. Rejected files are skipped with a note.
function addFiles(list: FileList | File[] | null | undefined) {
  if (!list) return;
  const incoming = Array.from(list);
  if (incoming.length === 0) return;
  let added = 0;
  for (const file of incoming) {
    if (attachments.value.length >= MAX_ATTACHMENTS) {
      flash(`Up to ${MAX_ATTACHMENTS} attachments per message.`);
      break;
    }
    const kind: AttachmentKind = file.type.startsWith("image/") ? "image" : "file";
    const cap = kind === "image" ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
    if (file.size > cap) {
      flash(`"${file.name}" is too large (max ${Math.round(cap / (1024 * 1024))} MB).`);
      continue;
    }
    attachments.value.push({
      id: ++attachSeq,
      file,
      name: file.name,
      kind,
      sizeBytes: file.size,
      ext: extFor(file),
      previewUrl: kind === "image" ? URL.createObjectURL(file) : undefined,
    });
    added++;
  }
  if (added > 0) {
    cue("toggle");
    if (!open.value) void wake();
    syncSoon();
  }
}

function openFilePicker() {
  fileInput.value?.click();
}
function onFilePicked(e: Event) {
  const input = e.target as HTMLInputElement;
  addFiles(input.files);
  // Clear so re-picking the same file fires `change` again.
  input.value = "";
}

function removeAttachment(id: number) {
  const at = attachments.value.find((a) => a.id === id);
  if (at?.previewUrl) URL.revokeObjectURL(at.previewUrl);
  attachments.value = attachments.value.filter((a) => a.id !== id);
  cue("toggle");
  syncSoon();
}
function clearAttachments() {
  for (const at of attachments.value) {
    if (at.previewUrl) URL.revokeObjectURL(at.previewUrl);
  }
  attachments.value = [];
}

// ── drag & drop (over the whole dock) ────────────────────────────────────────
function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}
function onDragEnter(e: DragEvent) {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  dragging.value = true;
}
function onDragOver(e: DragEvent) {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
}
function onDragLeave() {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dragging.value = false;
}
function onDrop(e: DragEvent) {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dragging.value = false;
  addFiles(e.dataTransfer?.files);
}

// Paste — grab any files off the clipboard (a screenshot, a copied file) and
// keep the plain-text paste working when there aren't any.
function onPaste(e: ClipboardEvent) {
  const files = e.clipboardData?.files;
  if (files && files.length > 0) {
    e.preventDefault();
    addFiles(files);
    return;
  }
  // Force a plain-text paste — the field is contenteditable, so the default
  // would drop styled markup into it. Insert the text ourselves, then re-read.
  const plain = e.clipboardData?.getData("text/plain");
  if (plain) {
    e.preventDefault();
    insertTextAtCaret(plain);
    onEditorChanged();
  }
}

const hasAttachments = computed(() => attachments.value.length > 0);
const hasText = computed(() => text.value.trim().length > 0);
const armed = computed(() => hasText.value || hasAttachments.value);
// Chips only ride the card when something is actually attached.
const card = computed(() => hasAttachments.value);

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
// Size the card: the width is fixed by CSS, so all this does is read the height
// the content wants and hand it to the transition.
function sync() {
  const el = surface.value;
  const prevH = surfaceH.value;

  // The contenteditable owns its own height (it grows with its content), so we
  // just read the surface's resulting natural height — no explicit sizing here.
  surfaceH.value = open.value ? measure() : REST;

  // Spring only for the big moves: a large height jump (paste, drop, a chips row
  // appearing) or a structural change (the wake expand). An ordinary keystroke —
  // including the one that first wraps a line — is a small change and stays
  // snappy, so the field keeps up with the cursor instead of wobbling behind it.
  const jumped = Math.abs(surfaceH.value - prevH) > SPRING_MIN;
  const structural = card.value !== lastCard || opening.value;
  springy.value = jumped || structural;
  lastCard = card.value;

  // Keep the imperative class in step with the ref so the class is right for the
  // height change Vue is about to patch in (it would only land next tick).
  el?.classList.toggle("is-springy", springy.value);
}
// The card's morph is mid-flight when this fires, so measuring now would read a
// height from the wrong shape. Re-measure once it has settled.
function syncSoon() {
  void nextTick(sync);
  window.setTimeout(sync, 380);
}

async function wake() {
  if (open.value) return;
  open.value = true;
  opening.value = true;
  await nextTick();
  field.value?.focus();
  // Measure and apply the full card height NOW so the orb expands straight into
  // its final shape — width, corners and height on one move — instead of landing
  // short and growing a beat later.
  sync();
  window.setTimeout(() => (opening.value = false), 340);
}

// Collapse back to the resting orb. The draft (text + chips) stays in state, so
// waking again restores exactly what was there.
function close() {
  if (!open.value) return;
  open.value = false;
  surfaceH.value = REST;
}
onClickOutside(dock, () => {
  // The picker lives outside our dock, so its clicks read as "outside" — but it
  // is our own surface, one step removed. Don't collapse while it's up.
  if (props.picking) return;
  close();
});
onKeyStroke("Escape", () => {
  // Escape walks out one layer at a time: a popover over the bar goes first, so
  // dismissing the roster doesn't also throw away the draft behind it.
  if (agentMenu.value) {
    agentMenu.value = false;
    return;
  }
  close();
});

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
  await wake();
  focusEditorEnd();
  insertTextAtCaret(e.key);
  onEditorChanged();
}
useEventListener(window, "keydown", onGlobalKey);

/** Ship the current draft (text + attachments) as a SEND. Shared by the seed
 *  (idle) and Enter — while a turn runs Enter also sends: the host's service
 *  durably enqueues the follow-up behind the running turn instead of
 *  dropping it, so no draft is ever lost or parked locally. */
function dispatchDraft() {
  if (!armed.value) {
    void wake();
    return;
  }
  const draft = text.value.trim();
  // A turn is valid with text, attachments, or both — an attachment-only send
  // (a screenshot with no words) is allowed.
  const files = attachments.value.map((a) => a.file);
  emit("send", draft, files.length ? files : undefined);
  cue("send");
  clearEditor();
  clearAttachments();
  syncSoon();
}

function send() {
  // While a turn runs the seed is a stop button.
  if (props.busy) {
    emit("interrupt");
    cue("press");
    return;
  }
  dispatchDraft();
}

/** Enter while a turn runs — a plain SEND now (the service queues), never a
 *  stop and never a local park. */
function submitOrQueue() {
  dispatchDraft();
}

/** Steer the draft into the RUNNING turn (the seed's stop button stays a
 *  stop; this is the separate "send now" action beside it). */
function steer() {
  const draft = text.value.trim();
  const files = attachments.value.map((a) => a.file);
  if (!draft && !files.length) return;
  emit("steer", draft, files.length ? files : undefined);
  cue("send");
  clearEditor();
  clearAttachments();
  syncSoon();
}

/** The chip label — the queued prompt's own words, or a compact attachment
 *  note for attachment-only follow-ups. */
function queuedLabel(entry: QueuedTurnEntry): string {
  if (entry.input) return entry.input;
  return "Queued message";
}

onMounted(() => {
  restoreDraft();
  sync();
});
onUnmounted(() => {
  window.clearTimeout(noticeTimer);
  if (draftSaveTimer) {
    window.clearTimeout(draftSaveTimer);
    persistDraft();
  }
  disposeChips();
  for (const at of attachments.value) {
    if (at.previewUrl) URL.revokeObjectURL(at.previewUrl);
  }
});
watch(text, scheduleDraftSave);
watch(
  [mentionQuery, () => projectFiles.entries.value.length],
  () => {
    mentionActiveIndex.value = Math.min(
      mentionActiveIndex.value,
      Math.max(0, projectFiles.entries.value.length - 1),
    );
  },
);

async function setDraft(draft: string) {
  await wake();
  await nextTick();
  setEditorFromText(draft);
  focusEditorEnd();
  syncSoon();
}

defineExpose({ wake, setDraft });
</script>

<template>
  <div
    ref="dock"
    class="dock"
    :class="{ 'dock--drag': dragging }"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <!-- Off-screen file picker, opened by the attach control. Accepts anything;
         images become vision blocks, everything else an on-disk path block. -->
    <input
      ref="fileInput"
      type="file"
      multiple
      class="file-input"
      aria-hidden="true"
      tabindex="-1"
      @change="onFilePicked"
    />

    <div v-if="mentionOpen" class="mention-picker" @mousedown.stop>
      <ProjectFileMentionMenu
        :files="mentionFiles"
        :query="mentionQuery"
        :active-index="mentionActiveIndex"
        :pending="mentionPending"
        :error="mentionError"
        @highlight="mentionActiveIndex = $event"
        @select="selectMention"
      />
    </div>

    <!-- Queued follow-ups — while a turn runs, Enter sends and the host's
         service durably queues the draft behind the running turn. The chips
         render from the `queued` prop (the backend's turn.queued /
         turn.promoted / turn.queued-cancelled events drive the list); the ✕
         cancels one row (remove-queued → agent:queue-cancel). -->
    <Transition name="queue">
      <div v-if="queued?.length" class="queue" role="region" aria-label="Queued messages">
        <span class="queue__head">Queued</span>
        <div
          v-for="item in queued"
          :key="item.queueId"
          class="queue__item"
          :title="`Queued #${item.position} · ${queuedLabel(item)}`"
        >
          <span class="queue__pos">{{ item.position }}</span>
          <span class="queue__text">{{ queuedLabel(item) }}</span>
          <button
            type="button"
            class="queue__remove"
            :aria-label="`Remove queued message`"
            :title="`Remove queued message`"
            @click.stop="emit('remove-queued', item.queueId)"
          >
            <svg class="queue__x" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3.5 3.5L8.5 8.5M8.5 3.5L3.5 8.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            </svg>
          </button>
        </div>
      </div>
    </Transition>

    <!-- One surface, morphing. Closed it's the orb; open it's the card. -->
    <div
      ref="surface"
      class="surface"
      :class="{ 'is-open': open, 'is-card': card, 'is-opening': opening, 'is-springy': springy }"
      :style="{ height: surfaceH + 'px' }"
      role="button"
      :aria-label="open ? undefined : 'Wake the agent'"
      @click="onSurfaceClick"
    >
      <!-- Resting bead: a face that looks up at you and follows the pointer in.
           It keeps its own size and place through the wake — the card simply
           grows out of it and closes over it, and it's still sitting there
           underneath when the card folds back down.

           An agent with a bot rests under its bot instead, in the same footprint
           and with the same behaviour: this is the composer, which is where an
           agent is working rather than speaking, so the mark here is the creature
           it works through. A guest has none, so a guest keeps the rolled face. -->
      <div class="orbfx" aria-hidden="true">
        <AgentBotBead v-if="beadBot" :bot="beadBot" :size="REST" :covered="open" />
        <SphereFace v-else :size="REST" :covered="open" />
      </div>

      <!-- White panel: the sleeping face and the field share it, cross-fading. -->
      <div class="panel">
        <!-- Attachment chips ride the top of the card, inside the white body
             and on the field's own left margin. Images show a thumbnail; other
             files show an uppercase extension badge. -->
        <Transition name="fade">
          <div v-if="open && (hasAttachments || notice)" class="chips">
            <div
              v-for="at in attachments"
              :key="at.id"
              class="chip"
              :class="{ 'chip--image': at.kind === 'image' }"
              :title="at.name"
            >
              <img
                v-if="at.kind === 'image' && at.previewUrl"
                class="chip__thumb"
                :src="at.previewUrl"
                :alt="at.name"
              />
              <span v-else class="chip__badge">{{ at.ext }}</span>
              <span class="chip__name">{{ at.name }}</span>
              <!-- The ✕ is the only remove target — the thumbnail and name are
                   inert, so clicking a chip's body never drops the attachment. -->
              <button
                type="button"
                class="chip__remove"
                :aria-label="`Remove ${at.name}`"
                :title="`Remove ${at.name}`"
                @click.stop="removeAttachment(at.id)"
              >
                <svg class="chip__x" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M3.5 3.5L8.5 8.5M8.5 3.5L3.5 8.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
                </svg>
              </button>
            </div>
            <span v-if="notice" class="chips__notice">{{ notice }}</span>
          </div>
        </Transition>

        <!-- Dormant face -->
        <div class="face" aria-hidden="true">
          <svg class="face__eyes" viewBox="0 0 104 104">
            <path d="M32 52 Q40 58 48 52" fill="none" stroke="#241C46" stroke-width="3" stroke-linecap="round" opacity="0.85" />
            <path d="M56 52 Q64 58 72 52" fill="none" stroke="#241C46" stroke-width="3" stroke-linecap="round" opacity="0.85" />
          </svg>
          <span class="face__z face__z--near">z</span>
          <span class="face__z face__z--far">z</span>
        </div>

        <!-- Field · the text alone. Every control now lives in the bar below it,
             inside the card, so the composer is one object on the ground rather
             than a pill with satellites floating either side. -->
        <div class="field">
          <!-- The field is a contenteditable surface: prose lives in text nodes
               and each completed @mention is an atomic MentionChip span (a type
               logo + the bare filename) the browser deletes as one unit. What we
               send is serialized off this DOM — chips written back as full @paths
               — so display and value can differ without any twin/overlay. -->
          <div class="field__ed">
            <!-- Placeholder overlay, not a ::before: it sits above the empty
                 field but takes no layout, so the caret stays at the true left
                 edge (a pseudo-element would push the cursor after the label). -->
            <span v-if="isEmpty" class="field__placeholder" aria-hidden="true">Ask anything…</span>
            <div
              ref="field"
              class="field__input"
              contenteditable="true"
              role="textbox"
              aria-multiline="true"
              aria-label="Ask anything"
              :tabindex="open ? 0 : -1"
              @keydown="onFieldKeydown"
              @input="onFieldInput"
              @click="onFieldClick"
              @keyup="onFieldKeyup"
              @focus="onFieldClick"
              @paste="onPaste"
            />
          </div>
        </div>

        <!-- The bar — every control, on one rail along the card's floor. Left is
             what the turn may DO (attach context, autonomy rung); right is what
             will do it (model, effort, tier, window) and the send seed. It rides
             in from below as the card opens, a beat after the field. -->
        <div class="bar" :class="{ 'is-shown': open }" :inert="!open">
          <div class="bar__group">
            <!-- Attach — opens the file picker. Drag-drop and paste feed the
                 same pending list. -->
            <button
              type="button"
              class="barbtn attach"
              aria-label="Attach files"
              title="Attach files, documents, or images"
              @click.stop="openFilePicker"
            >
              <HugeiconsIcon :icon="PlusSignIcon" :size="17" :stroke-width="2" />
            </button>

            <!-- Permission mode — no dropdown. Clicking cycles up the autonomy
                 ladder (Ask → Edits → Full) and wraps; the hued icon + label
                 carry it. -->
            <button
              type="button"
              class="barbtn mode"
              :class="{ 'mode--bump': modeBump }"
              :style="{ '--mode-hue': currentMode.hue }"
              :aria-label="currentMode.title"
              :title="currentMode.title"
              @click.stop="cycleMode"
            >
              <svg class="mode__icon" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <!-- Ask · a chat bubble with a question (the agent asks first) -->
                <template v-if="currentMode.id === 'ask'">
                  <path d="M3 5.2c0-.9.7-1.6 1.6-1.6h8.8c.9 0 1.6.7 1.6 1.6v4.6c0 .9-.7 1.6-1.6 1.6H8l-3 2.4V11.4H4.6c-.9 0-1.6-.7-1.6-1.6Z" />
                  <path d="M7.6 6.7a1.4 1.4 0 1 1 1.9 1.3c-.5.3-.7.6-.7 1.1" />
                  <path d="M8.8 10.7v.02" />
                </template>
                <!-- Edits · a pencil (auto-applies edits) -->
                <template v-else-if="currentMode.id === 'accept-edits'">
                  <path d="M11.4 3.7 14.3 6.6 6.9 14H4v-2.9Z" />
                  <path d="M10.4 4.7 13.3 7.6" />
                </template>
                <!-- Full access · a shield (no limits, nothing held back) -->
                <template v-else>
                  <path d="M9 2.6 14 4.6V9C14 12 11.9 14 9 15.4 6.1 14 4 12 4 9V4.6Z" />
                </template>
              </svg>
              <span class="mode__label">{{ currentMode.label }}</span>
            </button>
          </div>

          <div class="bar__group bar__group--end">
            <!-- Model — the name opens the full providers→models→effort picker. -->
            <button type="button" class="barbtn model" @click.stop="openModels">
              <ProviderLogo :brand="modelBrand" :size="15" />
              <span class="model__name">{{ modelName }}</span>
            </button>

            <!-- Effort — no dropdown. Clicking the brain steps to the next real
                 effort for this model and wraps. -->
            <button
              v-if="showEffort && currentEffort"
              type="button"
              class="barbtn effort"
              :class="{ 'effort--bump': bumping }"
              :aria-label="`Reasoning effort: ${currentEffort.label}. Click to change.`"
              :title="`Reasoning effort · ${currentEffort.label}`"
              @click.stop="cycleEffort"
            >
              <span class="stack" :class="{ 'stack--glow': currentEffort.glow }">
                <HugeiconsIcon
                  v-for="i in brainStack(currentEffort.brains)"
                  :key="i"
                  :icon="AiBrain01Icon"
                  :size="15"
                  :stroke-width="2"
                  :style="{ color: currentEffort.hue }"
                />
              </span>
              <span class="effort__label">{{ currentEffort.label }}</span>
            </button>

            <!-- Fast mode — a plain on/off for the model's real "fast" service
                 tier, when it has one. -->
            <button
              v-if="fastTier"
              type="button"
              class="barbtn fast"
              :class="{ 'fast--on': fastMode }"
              :aria-pressed="Boolean(fastMode)"
              :aria-label="`${fastTier.label}: ${fastMode ? 'on' : 'off'}. Click to toggle.`"
              @click.stop="toggleFastMode"
            >
              <HugeiconsIcon :icon="FlashIcon" :size="15" :stroke-width="2" />
            </button>

            <!-- Context window — a small cycle over the model's windows
                 (Claude's 200k/1m auto-compact window). -->
            <button
              v-if="currentWindow"
              type="button"
              class="barbtn ctxwin"
              :aria-label="`Context window: ${currentWindow.label}. Click to change.`"
              :title="`Context window · ${currentWindow.label}`"
              @click.stop="cycleContextWindow"
            >
              {{ currentWindow.label }}
            </button>

            <!-- Steer — while a turn runs the seed is a stop and Enter queues;
                 this is the third path: inject the draft into the LIVE turn (no
                 new boundary). The provider's steer channel delivers it when it
                 builds its next request; providers without one queue it first. -->
            <button
              v-if="busy && open"
              type="button"
              class="steer"
              :class="{ 'steer--armed': armed }"
              :disabled="!armed"
              :aria-label="'Send now — steer the running turn'"
              :title="'Send now — steer the running turn'"
              :tabindex="open ? 0 : -1"
              @mousedown.prevent
              @click.stop="steer"
            >
              <HugeiconsIcon :icon="CornerDownRightIcon" :size="16" :stroke-width="2" />
            </button>
            <button
              type="button"
              class="seed"
              :class="{ 'seed--armed': armed || busy, 'seed--busy': busy }"
              :aria-label="busy ? 'Stop' : 'Send'"
              :tabindex="open ? 0 : -1"
              @mousedown.prevent
              @click.stop="send"
            >
              <!-- Stop square while a turn runs; the send arrow otherwise. -->
              <svg v-if="busy" class="seed__stop" viewBox="0 0 18 18" aria-hidden="true">
                <rect x="5" y="5" width="8" height="8" rx="2" fill="var(--accent-ink)" />
              </svg>
              <svg v-else class="seed__arrow" viewBox="0 0 18 18" aria-hidden="true">
                <path d="M9 14V4.2M9 4.2L4.3 8.9M9 4.2L13.7 8.9" fill="none" stroke="var(--accent-ink)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Context tray — who takes the turn and where it lands: agent, project,
         branch, thread. It's tucked BEHIND the card and only its bottom strip
         shows, so it reads as the ground the composer is standing on rather than
         another control bar. The agent and the branch are pickers on a blank
         thread only; once the thread has started they are labels, same as the
         project. The thread name sits on the far right so the left stays who and
         where, and the right names the conversation. -->
    <div
      class="tray"
      :class="{ 'is-shown': open, 'is-spilling': spilling }"
      :inert="!open"
      aria-label="Turn context"
    >
      <!-- Who takes the turn. It leads the tray because a person is a bigger
           fact about a turn than a place is. Guest is a row in the menu rather
           than an empty state: not handing the work to anybody in particular is
           a choice you make on purpose, and it is the one you start with.

           On a thread that has already started this is just a label — one agent
           per thread — and it names the face the thread is actually wearing, so
           a thread nobody was picked for reads as the agent it was rolled, not
           as a guest slot that is still open. -->
      <span
        v-if="settledIdentity"
        class="tray__item"
        :title="`${settledIdentity.name} is on this thread`"
      >
        <!-- Decorative: the name is right beside it, and a rolled face carries the
             generator's own title and licence text inside the SVG, which is read
             out in full otherwise. -->
        <span class="tray__face" aria-hidden="true" v-html="settledIdentity.svg" />
        <span class="tray__label tray__label--strong">{{ settledIdentity.name }}</span>
      </span>
      <div v-else ref="agentPop" class="tray__who">
        <Transition name="menu" @after-leave="spilling = false">
          <div v-if="agentMenu" class="menu menu--agent" role="menu">
            <button
              type="button"
              class="opt"
              :class="{ 'opt--on': !currentAgent }"
              role="menuitemradio"
              :aria-checked="!currentAgent"
              @click.stop="pickAgent(null)"
            >
              <span class="opt__logo">
                <HugeiconsIcon :icon="DiceFaces05Icon" :size="15" :stroke-width="1.8" />
              </span>
              <span class="opt__stack">
                <span class="opt__label">{{ GUEST_LABEL }}</span>
                <span class="opt__vendor">A name and face for this thread</span>
              </span>
              <HugeiconsIcon
                v-if="!currentAgent"
                class="opt__check"
                :icon="Tick02Icon"
                :size="14"
                :stroke-width="2.2"
                aria-hidden="true"
              />
            </button>
            <button
              v-for="a in roster"
              :key="a.id"
              type="button"
              class="opt"
              :class="{ 'opt--on': a.id === currentAgent?.id }"
              role="menuitemradio"
              :aria-checked="a.id === currentAgent?.id"
              @click.stop="pickAgent(a.id)"
            >
              <span class="opt__face" aria-hidden="true" v-html="a.svg" />
              <span class="opt__stack">
                <span class="opt__label">{{ a.name }}</span>
                <span class="opt__vendor">{{ a.role }}</span>
              </span>
              <HugeiconsIcon
                v-if="a.id === currentAgent?.id"
                class="opt__check"
                :icon="Tick02Icon"
                :size="14"
                :stroke-width="2.2"
                aria-hidden="true"
              />
            </button>
          </div>
        </Transition>
        <button
          type="button"
          class="tray__item tray__item--action"
          :tabindex="open ? 0 : -1"
          aria-haspopup="menu"
          :aria-expanded="agentMenu"
          :aria-label="`${currentAgent?.name ?? GUEST_LABEL} is taking the turn. Change who takes it.`"
          :title="
            currentAgent
              ? `${currentAgent.name} — ${currentAgent.role}`
              : `${GUEST_LABEL} — a name and face for this thread only`
          "
          @click.stop="toggleAgentMenu"
        >
          <span v-if="currentAgent" class="tray__face" aria-hidden="true" v-html="currentAgent.svg" />
          <HugeiconsIcon v-else :icon="DiceFaces05Icon" :size="13" :stroke-width="1.8" />
          <span class="tray__label tray__label--strong">
            {{ currentAgent?.name ?? GUEST_LABEL }}
          </span>
        </button>
      </div>
      <span v-if="projectName" class="tray__item">
        <HugeiconsIcon :icon="Folder01Icon" :size="13" :stroke-width="1.8" />
        <span class="tray__label tray__label--strong">{{ projectName }}</span>
      </span>
      <button
        v-if="branch && canSwitchBranch"
        type="button"
        class="tray__item tray__item--action"
        :aria-label="`On ${branch}. Switch branch.`"
        :title="`On ${branch} — click to switch branch`"
        @click.stop="emit('open-branch')"
      >
        <HugeiconsIcon :icon="GitBranchIcon" :size="13" :stroke-width="1.8" />
        <span class="tray__label">{{ branch }}</span>
      </button>
      <span
        v-else-if="branch"
        class="tray__item"
        :title="`On ${branch}`"
      >
        <HugeiconsIcon :icon="GitBranchIcon" :size="13" :stroke-width="1.8" />
        <span class="tray__label">{{ branch }}</span>
      </span>
      <span
        class="tray__item tray__item--end"
        :title="threadLabel"
      >
        <HugeiconsIcon :icon="BubbleChatTemporaryIcon" :size="13" :stroke-width="1.8" />
        <span class="tray__label">{{ threadLabel }}</span>
      </span>
    </div>
  </div>
</template>

<style scoped>
.dock {
  /* Accent rings (drag, armed, busy) ride the same metal, not a hue. */
  --chrome-ring: 138 141 149;

  /* A column now: the card, with the context tray tucked in behind its floor. */
  display: flex;
  flex-direction: column;
  align-items: center;
  position: relative;
  /* Fill the width the fixed bar gives us, capped so the reading measure stays
     comfortable on wide screens and leaving a small gutter on narrow ones. The
     resting orb (55px) still centres within this track. */
  width: min(100% - 32px, 680px);
  animation: dock-rise 440ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
  animation-delay: var(--proj-enter-composer, 0ms);
}

/* The picker is anchored to the field rather than the viewport so it follows
   the composer's morph on both the overview and board surfaces. */
.mention-picker {
  position: absolute;
  z-index: 30;
  left: 200px;
  bottom: calc(100% + 12px);
  pointer-events: auto;
}

/* The queued-message panel — a small card riding above the dock while a turn
   runs. Same surface language as the chips: quiet, rounded, ink-tinted. */
.queue {
  position: absolute;
  left: 0;
  bottom: calc(100% + 12px);
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 260px;
  max-width: 380px;
  padding: 8px;
  border-radius: 14px;
  background: var(--raised);
  box-shadow:
    rgb(0 0 0 / 0.10) 0 8px 28px -6px,
    rgb(0 0 0 / 0.06) 0 2px 8px -2px,
    var(--line) 0 0 0 1px;
  pointer-events: auto;
}
.queue__head {
  padding: 0 6px 2px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}
.queue__pos {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 8%, transparent);
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
}
.queue__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--ink) 5%, transparent);
}
.queue__text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--ink);
}
.queue__remove {
  display: inline-flex;
  flex: none;
  padding: 2px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--faint);
  cursor: pointer;
}
.queue__remove:hover {
  background: color-mix(in srgb, var(--ink) 8%, transparent);
  color: var(--ink);
}
.queue__x {
  display: block;
}
.queue-enter-active,
.queue-leave-active {
  transition: opacity 0.18s ease, transform 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}
.queue-enter-from,
.queue-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
@keyframes dock-rise {
  from {
    opacity: 0;
    transform: translateY(28px) scale(0.88);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
/* Dragging files over the dock: a soft chrome ring on the surface invites the
   drop. No border/heavy shadow — a low, calm glow in kone's idiom. */
.dock--drag .surface {
  box-shadow: rgb(var(--chrome-ring) / 0.30) 0 0 0 3px;
}

/* A brighter chrome ring in dark, so the drag/armed/busy glows keep their
   weight off the near-black ground. Everything else follows the theme. */
html.dark .dock {
  --chrome-ring: 168 171 179;
}

/* ── The morphing surface ─────────────────────────────────────────────────── */
/* At rest it's a 52px orb. Open, it becomes the gradient rim around a white
   field. Width, corner radius, rim padding and height all ease together, so the
   orb visibly expands and collapses. */
.surface {
  position: relative;
  /* Above the tray, which is tucked in behind its bottom edge. */
  z-index: 1;
  overflow: hidden;
  /* Own compositing layer — keeps the rounded-corner clip of the gradient rim
     crisp instead of aliased. */
  transform: translateZ(0);
  isolation: isolate;
  width: 55px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 50%;
  cursor: pointer;
  pointer-events: auto;
  /* Collapse: it shrinks back to the orb first, then the corners round off into
     a circle last — the mirror of the expand's anticipation. */
  transition:
    width 0.4s cubic-bezier(0.22, 1, 0.36, 1),
    height 0.4s cubic-bezier(0.22, 1, 0.36, 1),
    padding 0.22s ease 0.16s,
    border-radius 0.26s ease 0.18s,
    border-color 0.22s ease;
}
/* At rest the surface carries no gradient — the face IS the mark, and it bleeds
   past the box (no circular clip). The rim returns only as the pill edge once it
   opens. */
.surface:not(.is-open) {
  overflow: visible;
  background-image: none;
}
.surface.is-open {
  /* One open shape. It fills the dock's responsive track (full width up to the
     680px cap) and only grows downward as the text runs on — nothing about the
     frame moves while you type. */
  width: 100%;
  padding: 0;
  border-radius: 26px;
  border-color: var(--line);
  background-image: none;
  /* Soft and low — just enough to lift the card off the page and read the tray
     as sitting under it. Never a heavy drop. */
  box-shadow:
    rgb(0 0 0 / 0.07) 0 10px 26px -12px,
    rgb(0 0 0 / 0.05) 0 2px 6px -3px;
  cursor: default;
  display: flex;
  flex-direction: column;
  /* Open + everyday sizing: width tracks the text and height follows. This is
     the typing curve — short and snappy with no overshoot, so per-keystroke
     nudges keep up with the cursor instead of wobbling behind it. */
  transition:
    border-radius 0.13s cubic-bezier(0.4, 0, 0.2, 1),
    padding 0.13s ease,
    width 0.12s cubic-bezier(0.4, 0, 0.2, 1),
    height 0.14s cubic-bezier(0.4, 0, 0.2, 1),
    border-color 0.2s ease;
}
/* Big/structural moves (paste, drop, first/last wrap, pill↔card) overshoot and
   settle back — a little spring so a large size change feels physical. */
.surface.is-open.is-springy {
  transition:
    border-radius 0.13s cubic-bezier(0.4, 0, 0.2, 1),
    padding 0.13s ease,
    width 0.34s cubic-bezier(0.34, 1.56, 0.64, 1),
    height 0.42s cubic-bezier(0.34, 1.56, 0.64, 1),
    border-color 0.2s ease;
}
/* Only through the wake expand: corners square off to the input's radius first,
   then the body stretches out — so it never passes through an ellipse. Placed
   after .is-springy so it wins during opening (both classes are on then). */
.surface.is-open.is-opening {
  transition:
    border-radius 0.13s cubic-bezier(0.4, 0, 0.2, 1),
    padding 0.13s ease,
    width 0.42s cubic-bezier(0.34, 1.56, 0.64, 1) 0.09s,
    height 0.42s cubic-bezier(0.34, 1.56, 0.64, 1) 0.09s,
    border-color 0.2s ease;
}
/* White field body. Transparent at rest so the orb reads as a solid marble.
   Its corners track the surface's on the same curve so the gradient rim keeps an
   even thickness all the way through the morph. */
.panel {
  position: relative;
  /* Over the bead, so the opening card closes across the face. */
  z-index: 1;
  height: 100%;
  border-radius: inherit;
  background: transparent;
  transition: background-color 0.28s ease, border-radius 0.13s cubic-bezier(0.4, 0, 0.2, 1);
}
.surface.is-open .panel {
  display: flex;
  flex-direction: column;
  background: var(--field);
  /* Opaque from the first frame of the wake, so the card is a solid thing
     growing over the face rather than a haze the face shows through; the slower
     base curve then lets the face come back gently on the way in. */
  transition: background-color 0.06s ease, border-radius 0.13s cubic-bezier(0.4, 0, 0.2, 1);
  border-radius: 26px;
  flex: 1 1 auto;
  min-height: 0;
  height: auto;
}

/* ── Resting bead ─────────────────────────────────────────────────────────── */
/* Pinned to the bead's own footprint at the bottom of the surface — the edge
   that doesn't move as the card grows — so the face holds still while the card
   opens out of it. It sits under the field, not over it: the card covering the
   face is the whole effect. */
.orbfx {
  position: absolute;
  bottom: 0;
  left: 50%;
  z-index: 0;
  transform: translateX(-50%);
  pointer-events: none;
}

/* ── Dormant face ─────────────────────────────────────────────────────────── */
/* Retired: the particle globe is the resting mark now, so the sleeping eyes/z
   would only poke out past the orb. Kept in the DOM but hidden. */
.face {
  position: absolute;
  inset: 0;
  display: none;
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
  color: #b0b2b8;
}
.face__z--near { right: 8px; top: 6px; font-size: 12px; }
.face__z--far { right: 1px; top: -2px; font-size: 9px; color: #c6c8ce; }
@keyframes breathe {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.04); }
}

/* ── Field ────────────────────────────────────────────────────────────────── */
/* Fades in a beat after the expand begins so text never appears mid-squeeze. */
.field {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  height: 100%;
  /* The text sits high in the card with air under it — the bar below owns the
     floor, so the field never pads down into it. */
  padding: 16px 14px 4px;
  opacity: 0;
  transition: opacity 0.18s ease;
}
.surface.is-open .field {
  flex: 1 1 auto;
  min-height: 0;
  height: auto;
  opacity: 1;
  transition: opacity 0.2s ease 0.08s;
}
.surface:not(.is-open) .field { flex: none; }
/* Closed, the panel is an invisible sheet lying over the face — its editor would
   otherwise hand the bead a text cursor. Nothing in it is reachable until the
   card is open anyway, so it stops taking the pointer entirely. */
.surface:not(.is-open) .panel { pointer-events: none; }
/* The contenteditable field. It flows text nodes + atomic chip spans, wrapping
   at the card's fixed width and growing its own height — no textarea, no
   overlay, and no per-keystroke width chase. */
/* The input's box: positioned so its text (and caret) paint above the
   placeholder overlay below. */
.field__ed {
  position: relative;
  flex: 0 0 auto;
  min-width: 0;
  /* Open at two rows of room so the field never starts as a single cramped
     line — text starts at the top and grows down from there. */
  min-height: 50px;
  display: flex;
  align-items: flex-start;
}
.field__input {
  position: relative;
  z-index: 1;
  flex: 1 1 0;
  width: 100%;
  min-width: 0;
  min-height: 50px;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--ink);
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 22px;
  letter-spacing: normal;
  /* The card's width is fixed, so text simply wraps and the card grows down. */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  max-height: 260px;
  overflow-x: hidden;
  overflow-y: auto;
  cursor: text;
}
.field__input:focus { outline: 0; }
/* Placeholder overlay — shown only while the field is empty. It's a sibling
   overlay (not ::before) so it never pushes the caret: an empty field's caret
   stays at the true left edge under the label, and clearing the draft returns
   the cursor to the start instead of leaving it after the text. */
.field__placeholder {
  position: absolute;
  left: 0;
  /* Sit on the first line so it lines up with the top-anchored caret. */
  top: 0;
  color: var(--placeholder);
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 22px;
  white-space: nowrap;
  pointer-events: none;
  user-select: none;
}

/* ── The bar ──────────────────────────────────────────────────────────────── */
/* One rail across the card's floor holding every control. Borderless, in kone's
   idiom — the marks and labels carry the state, nothing draws a container. It
   rises in from below as the card opens, just behind the field. */
.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex: 0 0 auto;
  padding: 0 8px 9px 8px;
  opacity: 0;
  transform: translateY(6px);
  pointer-events: none;
  transition: opacity 0.18s ease, transform 0.26s cubic-bezier(0.22, 1, 0.36, 1);
}
.bar.is-shown {
  opacity: 1;
  transform: none;
  pointer-events: auto;
  transition:
    opacity 0.22s ease 0.12s,
    transform 0.3s cubic-bezier(0.22, 1, 0.36, 1) 0.12s;
}
.bar__group {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
}
/* The right group must be free to shrink — a long model name gives way before
   the send seed ever gets pushed off the card's edge. */
.bar__group--end { gap: 4px; flex: 0 1 auto; }

/* Every control on the bar wears the same clothes: a bare 30px-tall slot whose
   ink lifts on hover. Only the send seed breaks it. */
.barbtn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex-shrink: 0;
  height: 30px;
  padding: 0 7px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--ink-soft);
  cursor: pointer;
  opacity: 0.78;
  transition: opacity 0.2s ease, background-color 0.2s ease, transform 0.15s ease;
}
.barbtn:hover {
  opacity: 1;
  background: color-mix(in srgb, var(--ink) 6%, transparent);
}
.barbtn:active { transform: scale(0.95); }

/* ── Context tray ─────────────────────────────────────────────────────────── */
/* Who takes the turn and where it lands — agent, project, branch, thread —
   tucked in behind the card so only its bottom strip shows. It's ground, not
   chrome: a quieter surface, smaller type, and no hairline anywhere. */
.tray {
  display: flex;
  align-items: center;
  gap: 4px;
  /* Narrower than the card, so it reads as something the card is standing on
     rather than a second bar bolted to its bottom. */
  width: calc(100% - 26px);
  /* No z-index of its own, on purpose. A flex item honours z-index even while
     it is statically positioned, so any value here makes the tray a stacking
     context — and the roster opening out of it would then be pinned under the
     card no matter how high its own layer went. The card is already lifted above
     the tray by its own z-index, which is all the tuck needs. */
  overflow: hidden;
  height: 0;
  margin-top: 0;
  padding: 0 14px;
  border-radius: 0 0 18px 18px;
  background: var(--sunken);
  opacity: 0;
  transform: translateY(-8px);
  pointer-events: none;
  transition:
    height 0.26s cubic-bezier(0.22, 1, 0.36, 1),
    margin-top 0.26s cubic-bezier(0.22, 1, 0.36, 1),
    opacity 0.2s ease,
    transform 0.28s cubic-bezier(0.22, 1, 0.36, 1);
}
.tray.is-shown {
  /* Taller than it shows: the card's rounded floor covers the top 14px, so the
     tray reads as one slab the composer is resting on. */
  height: 40px;
  margin-top: -14px;
  opacity: 1;
  transform: none;
  pointer-events: auto;
  transition:
    height 0.3s cubic-bezier(0.22, 1, 0.36, 1) 0.06s,
    margin-top 0.3s cubic-bezier(0.22, 1, 0.36, 1) 0.06s,
    opacity 0.24s ease 0.14s,
    transform 0.3s cubic-bezier(0.22, 1, 0.36, 1) 0.1s;
}
.tray__item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  /* Sit on the strip that shows, not on the covered half. */
  margin-top: 12px;
  padding: 3px 6px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--faint);
  font-family: var(--font-sans);
  font-size: 11.5px;
  line-height: 14px;
  white-space: nowrap;
}
.tray__label {
  color: var(--ink);
  opacity: 0.62;
  max-width: 148px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tray__label--strong { opacity: 0.86; }
.tray__item--action {
  cursor: pointer;
  transition: background-color 0.2s ease;
}
.tray__item--action:hover {
  background: color-mix(in srgb, var(--ink) 7%, transparent);
}
.tray__item--action:hover .tray__label { opacity: 0.9; }
.tray__item--end {
  margin-left: auto;
  min-width: 0;
}
.tray__item--end .tray__label {
  max-width: 220px;
}

/* The one tray slot that opens something. It's a positioning frame only — the
   button inside keeps the row's own metrics, so the agent lines up with the
   project and the branch instead of sitting a pixel off them. */
.tray__who {
  position: relative;
  display: flex;
  /* The offset that keeps every tray slot on the strip that shows has to live on
     the frame, not the button: the tray centres its items with their margins
     counted in, so leaving it inside would set the agent a row above the rest. */
  margin-top: 12px;
}
.tray__who > .tray__item { margin-top: 0; }
/* Big enough to read as a face rather than a dot, and level with the glyphs
   beside it: the marble has no stroke and no counters, so at their nominal size
   it reads optically smaller than they do. */
.tray__face {
  display: block;
  flex: none;
  width: 14px;
  height: 14px;
}
.tray__face :deep(svg) { display: block; width: 100%; height: 100%; }
/* Lifted only while the roster is up — see `spilling`. */
.tray.is-spilling { overflow: visible; }

/* ── Send seed ────────────────────────────────────────────────────────────── */
.seed {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  margin-left: 4px;
  border: 0;
  padding: 0;
  border-radius: 50%;
  cursor: pointer;
  background: var(--accent);
  transition: box-shadow 0.3s ease, transform 0.2s ease;
}
.seed--armed {
  box-shadow: rgb(var(--chrome-ring) / 0.16) 0 0 0 4px;
}
.seed:hover { transform: scale(1.06); }
.seed:active { transform: scale(0.94); }
.seed__arrow { width: 15px; height: 15px; }

/* Steer — the secondary "send now" beside the seed while a turn runs. A
   quiet round sibling: same pill language, no sheen, ink-tinted; disabled
   (empty field) it reads as part of the rail. */
.steer {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  margin-right: 4px;
  border: 1px solid var(--line);
  border-radius: 50%;
  background: color-mix(in srgb, var(--ink) 5%, transparent);
  color: var(--muted);
  cursor: pointer;
  transition: box-shadow 0.3s ease, transform 0.2s ease, color 0.2s ease;
}
.steer--armed {
  color: var(--ink);
  box-shadow: rgb(var(--chrome-ring) / 0.12) 0 0 0 3px;
}
.steer:hover:not(:disabled) { transform: scale(1.06); }
.steer:active:not(:disabled) { transform: scale(0.94); }
.steer:disabled {
  opacity: 0.45;
  cursor: default;
}

/* ── Chips ────────────────────────────────────────────────────────────────── */
/* Attachment chips ride above the text, on the field's own left margin so the
   card reads as one column: chips, then prose, then the bar. */
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 14px 14px 0;
}
/* With chips up top the field's own lead-in would double the gap. */
.surface.is-card .field { padding-top: 10px; }
.chip {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 5px 0 8px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--chip);
  color: var(--faint);
}
.chip--image { padding-left: 4px; }
/* Extension badge for non-image files — a soft neutral tile, no loud colour
   (kone stays calm and borderless). */
.chip__badge {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 20px;
  padding: 0 5px;
  border-radius: 6px;
  background: var(--line);
  color: var(--ink);
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: 8.5px;
  letter-spacing: 0.02em;
  line-height: 1;
}
/* Image preview thumbnail. */
.chip__thumb {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  border-radius: 6px;
  object-fit: cover;
  display: block;
}
.chip__name {
  color: var(--ink);
  font-size: 13px;
  font-weight: 500;
  line-height: 16px;
  max-width: 104px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The remove target — a padded button around the ✕ so it's easy to hit and
   only it drops the attachment. Ink lifts and a soft tile appears on hover. */
.chip__remove {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--faint);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease, transform 0.15s ease;
}
.chip__remove:hover { background: var(--line); color: var(--ink); }
.chip__remove:active { transform: scale(0.9); }
.chip__x { width: 12px; height: 12px; flex-shrink: 0; }
.chips__notice {
  align-self: center;
  color: var(--faint);
  font-size: 12px;
  line-height: 16px;
}

/* ── Model ────────────────────────────────────────────────────────────────── */
/* Which model will answer — the vendor mark plus the family name, opening the
   full picker. It's the one control allowed to give up width on a narrow card. */
.model { flex: 0 1 auto; min-width: 0; gap: 7px; }
.model__name {
  color: var(--ink);
  font-size: 12.5px;
  font-weight: 500;
  line-height: 16px;
  white-space: nowrap;
  min-width: 0;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── Permission mode (autonomy ladder) ────────────────────────────────────── */
/* The hued icon carries the rung and a neutral label names it. Cycles on click,
   with a tactile pop. */
.mode { color: var(--mode-hue, var(--muted)); opacity: 0.92; }
.mode__icon { width: 15px; height: 15px; }
.mode__label {
  color: var(--ink);
  font-size: 12.5px;
  font-weight: 500;
  line-height: 16px;
  white-space: nowrap;
}
.mode--bump .mode__icon { animation: effort-pop 0.24s cubic-bezier(0.34, 1.5, 0.64, 1); }

/* ── Attach control ───────────────────────────────────────────────────────── */
/* The card's one bare glyph: a plus, opening the file picker. */
.attach { width: 30px; padding: 0; }
/* The real <input type=file> is off-screen; the attach button drives it. */
.file-input {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

/* ── Effort control (brain-stack) ─────────────────────────────────────────── */
/* The stack shows how hard it will think; the label names the rung, so the
   cycle is readable at a glance rather than something you have to count. */
.effort { gap: 6px; opacity: 0.9; }
.effort__label {
  color: var(--ink);
  font-size: 12.5px;
  font-weight: 500;
  line-height: 16px;
  white-space: nowrap;
}
/* Each cycle step gives the stack a quick tactile pop. */
.effort--bump .stack { animation: effort-pop 0.24s cubic-bezier(0.34, 1.5, 0.64, 1); }

/* ── Fast mode toggle ─────────────────────────────────────────────────────── */
.fast { width: 28px; padding: 0; color: var(--ink); opacity: 0.66; }
.fast--on {
  color: var(--boost);
  opacity: 1;
  filter: drop-shadow(0 0 4px color-mix(in srgb, var(--boost) 50%, transparent));
}

/* ── Context-window cycle ─────────────────────────────────────────────────── */
.ctxwin {
  min-width: 32px;
  color: var(--ink);
  font: 500 11px/1 var(--font-mono, ui-monospace, monospace);
  letter-spacing: 0.02em;
  opacity: 0.66;
}
@keyframes effort-pop {
  0% { transform: scale(0.82); }
  60% { transform: scale(1.12); }
  100% { transform: scale(1); }
}
/* The brains overlap into a tight cluster; a soft halo blooms at the top tier. */
.stack { display: inline-flex; align-items: center; }
.stack > :deep(svg) { margin-left: -6px; }
.stack > :deep(svg:first-child) { margin-left: 0; }
.stack--glow > :deep(svg) { filter: drop-shadow(0 0 3px currentColor); }

/* ── Popovers (agent roster · model picker · reasoning dial) ──────────────── */
.pop { position: relative; display: flex; }
.menu {
  position: absolute;
  bottom: calc(100% + 10px);
  z-index: 40;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 6px;
  border-radius: 14px;
  background: var(--raised);
  box-shadow:
    rgb(0 0 0 / 0.10) 0 8px 28px -6px,
    rgb(0 0 0 / 0.06) 0 2px 8px -2px,
    var(--line) 0 0 0 1px;
}
.menu--model { right: 0; min-width: 232px; max-width: 320px; max-height: 340px; overflow-y: auto; }
/* The roster opens from the tray's own left edge and grows rightward, so it
   stays over the composer it belongs to rather than hanging off it. Wide enough
   that no row's description wraps: every row here carries one, and a two-line
   row beside a one-line row makes an even list look ragged. */
.menu--agent { left: 0; min-width: 274px; max-width: 320px; }
.menu--agent .opt__vendor { white-space: nowrap; }
.menu__empty {
  margin: 0;
  padding: 10px 12px;
  color: var(--faint);
  font-size: 13px;
}
.opt {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 10px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  cursor: pointer;
  text-align: left;
  transition: background-color 0.14s ease;
}
.opt:hover { background: var(--hover); }
.opt--on { background: var(--hover); }
.opt__logo {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  background: var(--hover);
}
/* An agent's face takes the slot a provider logomark would, at the same measure
   but with no tile behind it — the marble is already a solid round shape, and
   putting it on a tile would read as a logo in a box. */
.opt__face {
  display: block;
  flex-shrink: 0;
  width: 26px;
  height: 26px;
}
.opt__face :deep(svg) { display: block; width: 100%; height: 100%; }
.opt__stack { display: flex; flex-direction: column; gap: 1px; flex: 1 1 auto; min-width: 0; }
.opt__label { flex: 1 1 auto; color: var(--ink); font-size: 13.5px; font-weight: 500; }
.opt__stack .opt__label { flex: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.opt__vendor { color: var(--faint); font-size: 11px; line-height: 1.2; }
.opt__hint { color: var(--faint); font-family: var(--font-mono); font-size: 11px; white-space: nowrap; }
.opt--model { align-items: center; }
.opt .stack { flex-shrink: 0; }
.opt__check { width: 14px; height: 14px; flex-shrink: 0; color: var(--accent); }

.menu-enter-active { transition: opacity 0.16s ease, transform 0.18s cubic-bezier(0.22, 1, 0.36, 1); }
.menu-leave-active { transition: opacity 0.12s ease, transform 0.12s ease; }
.menu-enter-from, .menu-leave-to { opacity: 0; transform: translateY(6px) scale(0.98); }

/* ── Stop glyph (seed while a turn runs) ──────────────────────────────────── */
.seed__stop { width: 15px; height: 15px; }
.seed--busy { animation: seed-pulse 1.8s ease-in-out infinite; }
@keyframes seed-pulse {
  0%, 100% { box-shadow: color-mix(in srgb, var(--accent-ink) 60%, transparent) 0 1px 2px inset, rgb(var(--chrome-ring) / 0.10) 0 0 0 3px; }
  50% { box-shadow: color-mix(in srgb, var(--accent-ink) 60%, transparent) 0 1px 2px inset, rgb(var(--chrome-ring) / 0.28) 0 0 0 6px; }
}

.fade-enter-active { transition: opacity 0.24s ease 0.08s; }
.fade-leave-active { transition: opacity 0.14s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

@media (prefers-reduced-motion: reduce) {
  .surface, .panel, .face, .field, .seed { transition-duration: 0.01s; transition-delay: 0s; }
  .dock { animation: none; }
  .face { animation: none; }
  .seed--busy { animation: none; }
  .bar, .tray { transition-duration: 0.01s; transition-delay: 0s; }
  .fade-enter-active, .fade-leave-active { transition-duration: 0.01s; }
  .menu-enter-active, .menu-leave-active { transition-duration: 0.01s; }
}
</style>
