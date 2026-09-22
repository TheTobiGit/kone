<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { onClickOutside, onKeyStroke, useEventListener } from "@vueuse/core";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  Note01Icon,
  AiBrain01Icon,
  AlertCircleIcon,
  BubbleChatTemporaryIcon,
  Directions01Icon,
  FlashIcon,
  Folder01Icon,
  GitBranchIcon,
  PlusSignIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import SphereFace from "~/components/agent/SphereFace.vue";
import AgentBotBead from "~/components/agent/AgentBotBead.vue";
import AgentQueueStrip from "~/components/agent/AgentQueueStrip.vue";
import AgentPickerModal from "~/components/agent/AgentPickerModal.vue";
import ProjectFileMentionMenu from "~/components/composer/ProjectFileMentionMenu.vue";
import SlashCommandMenu from "~/components/composer/SlashCommandMenu.vue";
import ProviderLogo from "~/components/provider/ProviderLogo.vue";
import type { AttachmentKind, InteractionMode, ProviderStatus, ThreadEnvMode } from "~/types/desktop";
import type { QueuedTurnEntry } from "~/composables/useAgent";
import { useComposerAttachments } from "~/composables/useComposerAttachments";
import { useComposerDraft } from "~/composables/useComposerDraft";
import { useComposerMentions } from "~/composables/useComposerMentions";
import { useComposerSlash } from "~/composables/useComposerSlash";
import { useComposerTrigger } from "~/composables/useComposerTrigger";
import type { MentionItem, MentionProject, SlashCommandItem } from "~/utils/composerMentions";
import { SLASH_COMMANDS } from "~/composables/useComposerSlash";
import { createMentionKindResolver, parseLeadingSlashCommand } from "~/utils/composerMentions";
import { isWorkspacePending } from "~/utils/threadWorkspace";
import { agentIdentity } from "~/utils/agentIdentity";
import { agentForThread, GUEST_LABEL, type Agent } from "~/utils/agents";
import { isRouterId, JEV_LABEL } from "~/utils/agentRouting";
import {
  describeModelId,
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
// seed is a stop button while a turn is in flight — until there is a draft,
// when it becomes a send that queues behind the running turn. Both model controls
// sit on the RIGHT of the field: the model picker (each family with its own
// provider logomark) and — only when the chosen model exposes more than one —
// The effort has no dropdown: clicking the brain CYCLES to the next real effort
// for that model and wraps. The effort is encoded into the model id we emit, so
// the parent stays oblivious to whether a provider bakes it into ids or a flag.

const props = defineProps<{
  /** Which surface this is: a turn spoken into a thread, or a job filed on the
   *  bench. It selects the affordance set and nothing else — the name field,
   *  the park control and the project picker on a job; the queued-turn strip,
   *  the stop square and the thread label on a turn.
   *
   *  One discriminant rather than a bag of booleans, because these affordances
   *  only ever arrive in those two bundles, and six flags that are always set
   *  together say less than one word. Every *capability* stays its own prop
   *  (`compactable`, `agentSwitchable`, `branchSwitchable`, …) because those do
   *  vary from host to host within a kind.
   *
   *  This was a second 2,000-line component until it wasn't: the job composer
   *  was a copy of this file with ten props left unpassed. */
  kind?: "turn" | "job";
  /** Absolute project root used by the @ file picker. */
  projectPath: string;
  /** Leave the context tray off. It is tucked in under the card everywhere
   *  else; a surface where every slot on it is already settled — one agent, one
   *  place, one conversation, none of them switchable — asks for it gone, since
   *  the strip would only be restating what the surface itself already is.
   *
   *  Stated as the exception rather than as `contextTray: true`, because Vue
   *  hands an absent boolean prop `false` rather than `undefined`: a
   *  default-on flag reads as off at every call site that doesn't mention it,
   *  which is most of them. */
  hideContextTray?: boolean;
  /** Project display name for the context tray tucked under the card. */
  projectName?: string;
  /** The checked-out branch, shown in the tray. Omit it (a non-git folder) and
   *  the chip is gone. */
  branch?: string;
  /** When true (the default), the branch chip opens the picker. Once a thread
   *  has already started, the host turns this off so the chip is only a label —
   *  a running session cannot be moved to another directory, so offering the
   *  control would be offering something that cannot be honoured. */
  branchSwitchable?: boolean;
  /** The directory this conversation works in, when it is not the project's own
   *  checkout. Absent is the ordinary case and shows nothing. */
  worktreePath?: string | null;
  /** What this conversation asked for. A worktree choice with no directory yet
   *  is still being built — the tray derives that from these two facts at the
   *  mark, rather than taking it as a separate flag. */
  envMode?: ThreadEnvMode | null;
  /** The focused thread's title, parked on the far right of the tray so the
   *  left stays who and where. Empty / missing falls back to "New thread". */
  threadName?: string;
  /** The focused thread's durable id — the seed its identity is rolled from.
   *  Empty until the thread's first send, which is when it acquires a face. */
  threadId?: string | null;
  /** A turn is running — the send seed becomes a stop, Enter is inert. */
  busy?: boolean;
  /** Follow-ups durably queued behind the running turn (AgentService). The
   *  strip above the card renders from these — the host owns the queue (send
   *  while busy enqueues; cancel/steer round-trip through the bridge). */
  queued?: QueuedTurnEntry[];
  /** The full model picker is open (hosted by the parent, outside our dock).
   *  While it is, a click in it — or on its scrim — must NOT collapse us. */
  picking?: boolean;
  /** Stay open, always. For a surface whose only purpose is writing: there is
   *  nothing else on it to look at, so there is nothing to collapse back to,
   *  and a resting orb there would charge a click for a decision already made.
   *  An open card covers the orb, so this suppresses it along with the
   *  click-outside and Escape collapses. */
  alwaysOpen?: boolean;
  /** Who you can hand the turn to. Guest is never in here — it is the absence of
   *  a choice, so the menu adds it itself and an empty roster still offers it. */
  agents?: Agent[];
  /** The agent the next turn goes to, or null/undefined for a guest.
   *
   *  It can also hold the router's sentinel id — see `~/utils/agentRouting`.
   *  The picker is one radio group and this is where its answer lives, so
   *  "let Jev decide" travels on the same channel as "let Maya do it". Nothing
   *  here resolves it to an agent: with the router selected nobody is working
   *  the turn yet, and the slot says so. */
  agentId?: string | null;
  /** What the router decided on the last send, already worded — null when it
   *  has decided nothing. Shown whatever it decided, including "nothing
   *  matched": a router that only spoke up when it found a specialist would be
   *  indistinguishable, on the common path, from one that was silently
   *  broken. */
  routingNote?: string | null;
  /** When true (the default), the agent slot opens the roster. A thread has one
   *  agent for its whole life, so once it has started the host turns this off and
   *  the slot only names who is on it. */
  agentSwitchable?: boolean;
  /** The provider's models, grouped into families with real efforts. */
  models?: ModelOption[];
  /** When true (the default), the model name opens the full picker. The host
   *  turns it off when there is only one model to be had — a pinned agent, one
   *  visible model — and the slot is then only a label. */
  modelSwitchable?: boolean;
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
  /** Why the turn cannot go anywhere right now — the provider's CLI is missing,
   *  signed out, or wedged — or null when it can. Set, and Enter stops being a
   *  send: the draft is KEPT, because the refusal is about the machine, not
   *  about what was written. Rendered in the composer's own top strip (below),
   *  not on a host banner; this only gates the send. */
  blockedReason?: string | null;
  /** The provider's last known health, for the top strip's tone. Null when no
   *  provider is active — the hard stop. */
  healthStatus?: ProviderStatus | null;
  /** A re-check is in flight; the strip's action reads as busy. */
  healthChecking?: boolean;
  /** Projects the @ picker offers above files. Set by surfaces with no project
   *  of their own — the global assistant — so a mention can still point the
   *  turn at somewhere real. Everywhere else this stays empty and @ means
   *  files in the current project. */
  mentionProjects?: MentionProject[];
  /** File search needs a real project on disk. The global assistant has none,
   *  so it turns this off and its @ picker names projects only. */
  disableFileMentions?: boolean;
  /** Whether the `/compact` row is offered. False hides it where no host
   *  handles the emit — the picker row and the send-time parse alike. */
  compactable?: boolean;
  /** Whether the `/new` row is offered. False hides it where no host
   *  handles the emit — the picker row and the send-time parse alike. */
  creatable?: boolean;
}>();

const emit = defineEmits<{
  /** The draft, plus any picked files. The parent uploads the files (scoped to
   *  the final thread) and hands the resulting metadata to the agent turn. */
  send: [text: string, files?: File[]];
  /** File the job — the `kind: "job"` commit. `intent` is its two halves:
   *  queue it to run next, or park it as a draft nobody will start. The title
   *  may be empty; the store derives one from the body, and deriving a second
   *  one here would be two rules for one field. */
  file: [
    job: { title: string; body: string; intent: "queued" | "draft" },
    files?: File[],
  ];
  /** Ask the host to choose the project this job runs in. */
  "open-project": [];
  /** Drop one durably queued follow-up (the strip's Stop button). */
  "remove-queued": [queueId: string];
  /** Dispatch a queued follow-up immediately (steer into running turn or send). */
  "send-now": [entry: QueuedTurnEntry];
  /** Reorder the queued follow-ups. */
  "reorder-queued": [queueIds: string[]];
  interrupt: [];
  /** null hands the turn to a guest, and the router's sentinel hands the
   *  choice to Jev — see `agentId`. */
  "update:agentId": [id: string | null];
  "update:modelId": [id: string];
  "update:reasoning": [tier: EffortTier];
  "update:mode": [mode: InteractionMode];
  "update:fastMode": [on: boolean];
  "update:contextWindow": [id: string];
  /** Ask the host to open the full providers→models→effort picker. */
  "open-models": [];
  /** Ask the host to compact the thread, with an optional focus the user
   *  typed after `/compact`. */
  compact: [focus: string];
  /** Ask the host to open the branch picker (the tray's branch chip). */
  "open-branch": [];
  /** ask the host to start a new thread. carries no payload — the pending
   *  draft is dropped, never carried over to the fresh thread. */
  "new-thread": [];
  /** Whether the surface is expanded into the input. The host lifts the
   *  composer's layer while it's open so the corner docks can't sit over it on
   *  a narrow window. */
  "update:open": [open: boolean];
  /** The draft as typed, for hosts that work ahead of the send — Jev routes a
   *  paused draft so the choice is ready when send lands. Raw text, untrimmed:
   *  the host normalises before comparing it with a send. */
  "update:draft": [text: string];
  /** Re-probe providers (the top strip's action). */
  recheck: [];
}>();

const { cue } = useSound();

// Top strip: the send-block reason, in the tray's quiet clothes. Null provider
// (nothing installed) and not-installed are the hard stop; everything else is
// a warning — a signed-out CLI is one terminal command away from working.
const healthSevere = computed(
  () => !props.healthStatus || props.healthStatus.readiness === "not-installed",
);
// No active provider: the model slot wears every provider's mark greyed rather
// than a single live one, so the empty state reads as "nothing to run on".
const noProvider = computed(() => !props.healthStatus);
const providerMarks = ["codex", "claude", "cursor", "opencode", "droid", "antigravity"] as const;

const threadLabel = computed(() => props.threadName?.trim() || "New thread");

/** A job is written on a bench that spans every project, so being aimed at one
 *  is something it acquires rather than something it inherits from the surface
 *  it was opened on. A turn is always spoken inside a project already open. */
const isJob = computed(() => props.kind === "job");
const hasProject = computed(() => props.projectPath.trim().length > 0);

/** What the row is called in the list. Quiet until written in: a job that is
 *  only a sentence long does not need naming twice, so leaving it blank is an
 *  ordinary way to file one. */
const title = ref("");
const TITLE_MAX = 80;
const hasTitle = computed(() => title.value.trim().length > 0);
const canSwitchBranch = computed(() => props.branchSwitchable !== false);
const showTray = computed(() => !props.hideContextTray);

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
/** Whether the slot is holding the router rather than an agent. Never both:
 *  the sentinel is not in the roster, so `currentAgent` is undefined here. */
const isRouting = computed(() => isRouterId(props.agentId));
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

/**
 * The avatar next to the name in the tray. Uses the agent's photo avatar if they
 * have one, or falls back to their SVG drawn face. Null is the guest/solo picker,
 * which keeps the flash icon.
 */
const trayAvatar = computed<{ photo?: string; svg?: string } | null>(() => {
  if (!canSwitchAgent.value && settledIdentity.value) {
    if (settledIdentity.value.avatar) return { photo: settledIdentity.value.avatar };
    if (settledIdentity.value.svg) return { svg: settledIdentity.value.svg };
    return null;
  }
  if (currentAgent.value) {
    if (currentAgent.value.avatar?.src) return { photo: currentAgent.value.avatar.src };
    if (currentAgent.value.svg) return { svg: currentAgent.value.svg };
    return null;
  }
  return null;
});

const agentPickerOpen = ref(false);
const agentTriggerEl = ref<HTMLElement | null>(null);

function openAgentPicker() {
  if (!canSwitchAgent.value) return;
  agentPickerOpen.value = true;
  cue("toggle");
}

function pickAgent(id: string | null) {
  agentPickerOpen.value = false;
  if (id === (props.agentId ?? null)) return;
  emit("update:agentId", id);
  cue("select");
}

watch(canSwitchAgent, (can) => {
  if (can) return;
  agentPickerOpen.value = false;
});

// ── model + effort pickers (both on the right) ─────────────────────────────────
// The family comes from the model id; the effort within it comes from the
// reasoning tier (not the id — a synthetic ladder's rungs all share one id).
const catalog = computed<ModelOption[]>(() => props.models ?? []);
const canSwitchModel = computed(() => props.modelSwitchable !== false);
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

const desc = computed(() => describeModelId(props.modelId, catalog.value));
// Display resolves through the strict description while an id is pinned — the
// family falls back to the first entry, which would name a model that never
// ran for a stale id. With no id pinned the family's default still stands.
const modelName = computed(
  () => (props.modelId ? desc.value.name : (currentFamily.value?.label ?? "Default model")),
);
const modelBrand = computed(
  () => (props.modelId ? desc.value.brand : (currentFamily.value?.brand ?? desc.value.brand)),
);

// The model name opens the full picker (hosted by the parent); the composer
// only displays the current family + brand. With nothing to switch to the slot
// is inert, so a click can't raise a picker holding a single row.
function openModels() {
  if (!canSwitchModel.value) return;
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

// ── composer modules (mentions, attachments, draft) ──────────────────────────
const {
  draftKey: DRAFT_KEY,
  scheduleDraftSave,
  persistDraft,
  restoreDraft,
  clearDraft,
} = useComposerDraft({
  getProjectPath: () => props.projectPath,
  getText: () => text.value,
  setEditorFromText: (val) => setMentionEditorFromText(val),
});

const mentionKindResolver = computed(() =>
  createMentionKindResolver(props.mentionProjects ?? []),
);

// ── slash commands (`/…`) ───────────────────────────────────────────────────
// The six switchable flags stay six flags — they also drive non-slash UI (the
// model button, the tray pickers, the mention search), and every host already
// binds them individually. One `capabilities` object would churn four call
// sites for no behavior gain. The single choke point is below instead: the
// gates feed BOTH the `/` menu filter and the send-time dispatch through the
// one command table, so a row can never be offered where its send-time twin
// would refuse to run.
const { slashItemsFor, isSlashAllowed } = useComposerSlash({
  canSwitchAgent: () => canSwitchAgent.value,
  canSwitchModel: () => canSwitchModel.value,
  canCompact: () => props.compactable !== false,
  canBranch: () => canSwitchBranch.value,
  canCreate: () => props.creatable !== false,
});

// ── one trigger state for both markers ──────────────────────────────────────
// One token lives under the caret and carries one first character, so `@` and
// `/` share a single trigger value — the menus are mutually exclusive in
// state, never by which keystroke handler runs first.
const trigger = useComposerTrigger<MentionItem | SlashCommandItem>({
  field,
  isOpen: () => open.value,
  markers: ["@", "/"],
  // @ names files, so it hides while a turn runs; `/` rows are local UI,
  // never a send, so a running turn must not hide them.
  blocked: (marker) => marker === "@" && (props.busy ?? false),
  resolveItems: (active) =>
    active.marker === "@" ? mentionItemsFor(active.query) : slashItemsFor(active.query),
  applyItem: (item) => acceptTriggerItem(item),
  onCommit: () => submitOrQueue(),
  onMutated: () => handleEditorChanged(),
});

const {
  mentionPending,
  mentionError,
  projectFiles,
  mentionItemsFor,
  makeChipEl,
  disposeChips,
  serializeNode,
  serializeEditor,
  syncEditorText,
  applyMention,
  setEditorFromText: setMentionEditorFromText,
  clearEditor: clearMentionEditor,
  focusEditorEnd,
  insertTextAtCaret,
} = useComposerMentions({
  field,
  text,
  query: () => trigger.queryFor("@"),
  projectPath: () => props.projectPath,
  onSync: sync,
  projects: () => props.mentionProjects ?? [],
  fileMentionsEnabled: () => !props.disableFileMentions,
  resolveMentionKind: (path) => mentionKindResolver.value(path),
  placeCaret: (node, offset) => trigger.placeCaret(node, offset),
});

/** A picked row runs in place of a send. Most consume the token and never
 *  emit it as prompt text — `/agent` keeps the draft, since the roster picks
 *  who takes it. Unknown names never reach here from the menu (it only lists
 *  the table), and at send time they fall through to the provider. */
function runSlashCommand(name: string, focus: string, opts: { fromMenu: boolean }): boolean {
  const def = SLASH_COMMANDS[name];
  if (!def || !isSlashAllowed(name)) return false;
  if (!def.keepDraft) {
    if (opts.fromMenu && !def.clearsAll) trigger.consumeToken();
    else {
      clearComposerEditor();
      clearAttachments();
      syncSoon();
    }
  }
  if (opts.fromMenu && !def.silent) cue("select");
  switch (name) {
    case "compact":
      emit("compact", focus);
      return true;
    case "agent":
      openAgentPicker();
      return true;
    case "branch":
      emit("open-branch");
      return true;
    case "new":
      emit("new-thread");
      return true;
    case "model":
      openModels();
      return true;
    default:
      return false;
  }
}

/** One row in, from either surface: the keyboard path (by index) and the
 *  mouse path (by item) meet here. The marker decides the kind — the menus
 *  only ever offer their own. */
function acceptTriggerItem(item: MentionItem | SlashCommandItem): void {
  const active = trigger.trigger.value;
  if (!active) return;
  if (active.marker === "@" && "kind" in item) {
    applyMention(item, trigger.consumeToken());
    return;
  }
  if (active.marker === "/" && "name" in item && !("kind" in item)) {
    runSlashCommand(item.name, "", { fromMenu: true });
  }
}

/** The trigger's rows, narrowed per menu — the shell lists one marker's rows
 *  at a time, so each menu reads only its own half of the union. */
const mentionMenuItems = computed<MentionItem[]>(() =>
  trigger.marker.value === "@"
    ? trigger.items.value.filter((item): item is MentionItem => "kind" in item)
    : [],
);
const slashMenuItems = computed<SlashCommandItem[]>(() =>
  trigger.marker.value === "/"
    ? trigger.items.value.filter((item): item is SlashCommandItem => !("kind" in item))
    : [],
);
const triggerMenuOpen = computed(
  () => trigger.open.value && trigger.marker.value !== null,
);

/** Re-serialize the field and refresh the one trigger state after any DOM
 *  mutation — the single fan-in the five per-marker wrappers collapsed to. */
function handleEditorChanged(): void {
  syncEditorText();
  trigger.refreshTrigger();
}

function onComposerInput(): void {
  handleEditorChanged();
}

function onComposerClick(): void {
  trigger.refreshTrigger();
}

function onComposerKeyup(): void {
  trigger.refreshTrigger();
}

function onComposerKeydown(e: KeyboardEvent): void {
  trigger.onKeydown(e);
}

/** Drop the draft for the trigger (a send, or a consumed command). */
function clearComposerEditor(): void {
  clearMentionEditor();
  trigger.dismiss();
}

const isEmpty = computed(() => text.value.trim().length === 0);
const askLabel = computed(() => (isJob.value ? "What should this job do?" : "Ask anything…"));
const seedLabel = computed(() => {
  if (!isJob.value) return props.busy && !armed.value ? "Stop" : "Send";
  return hasProject.value ? "Queue this job" : "Choose a project first";
});

const {
  attachments,
  notice,
  fileInput,
  dragging,
  hasAttachments,
  flash,
  addFiles,
  openFilePicker,
  onFilePicked,
  removeAttachment,
  clearAttachments,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
} = useComposerAttachments({
  isOpen: () => open.value,
  wake,
  syncSoon,
});

function onPaste(e: ClipboardEvent) {
  const files = e.clipboardData?.files;
  if (files && files.length > 0) {
    e.preventDefault();
    addFiles(files);
    return;
  }
  const plain = e.clipboardData?.getData("text/plain");
  if (plain) {
    e.preventDefault();
    insertTextAtCaret(plain);
    handleEditorChanged();
  }
}

const REST = 55;
const surfaceH = ref(REST);
const opening = ref(false);
const springy = ref(false);
const SPRING_MIN = 64;
let lastCard = false;

const hasText = computed(() => text.value.trim().length > 0);
const armed = computed(
  () => hasText.value || hasAttachments.value || (isJob.value && hasTitle.value),
);
/** Whether the primary commit would actually land. A turn only needs writing;
 *  a job also needs somewhere to run, and queuing an unaimed one would file
 *  something the dispatcher can never pick up. */
const commitReady = computed(() => (isJob.value ? armed.value && hasProject.value : armed.value));
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

const closing = ref(false);
const closingH = ref(REST);
let closeTimer: ReturnType<typeof setTimeout> | null = null;

async function wake() {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  closing.value = false;
  if (open.value) {
    field.value?.focus();
    return;
  }
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

// Fade away back to the resting orb with no movement. The draft (text + chips)
// stays in state, so waking again restores exactly what was there.
function close() {
  if (props.alwaysOpen) return;
  if (!open.value) return;
  if (closeTimer) clearTimeout(closeTimer);
  closingH.value = surfaceH.value;
  open.value = false;
  closing.value = true;
  closeTimer = setTimeout(() => {
    closing.value = false;
    surfaceH.value = REST;
    closeTimer = null;
  }, 200);
}
onClickOutside(
  dock,
  (event) => {
    // The picker lives outside our dock, so its clicks read as "outside" — but it
    // is our own surface, one step removed. Don't collapse while it's up.
    if (props.picking || agentPickerOpen.value) return;
    const target = event.target;
    if (target instanceof Element && target.closest("[data-agent-dock]")) {
      return;
    }
    close();
  },
  {
    ignore: ["[data-agent-dock]"],
  },
);
onKeyStroke("Escape", () => {
  // Escape walks out one layer at a time: a modal/picker over the bar goes first, so
  // dismissing the picker doesn't also throw away the draft behind it.
  if (agentPickerOpen.value) {
    agentPickerOpen.value = false;
    return;
  }
  close();
});

/** The agent picker's Escape, taken in the capture phase so one press closes
 *  one layer: without this the surface behind the composer — a portal that
 *  answers Escape of its own — would take the same press and leave too. */
function onEscapeCapture(event: KeyboardEvent): void {
  if (!agentPickerOpen.value) return;
  event.stopPropagation();
  agentPickerOpen.value = false;
}

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
  // SAFETY: a non-element target would fail the contentEditable and tag-name probes below,
  // so the keystroke is ignored either way.
  const t = e.target as HTMLElement | null;
  if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
  // A file detail is open → the composer is inert; leave the keystroke alone.
  if (dock.value?.closest("[inert]")) return;
  e.preventDefault();
  await wake();
  focusEditorEnd();
  insertTextAtCaret(e.key);
  handleEditorChanged();
}
useEventListener(window, "keydown", onGlobalKey);

/** Ship the current draft (text + attachments) as a SEND. Shared by the seed
 *  (idle) and Enter — while a turn runs Enter also sends: the host's service
 *  durably enqueues the follow-up behind the running turn instead of
 *  dropping it, so no draft is ever lost or parked locally. */
function dispatchDraft(intent: "queued" | "draft" = "queued") {
  if (!armed.value) {
    void wake();
    return;
  }
  // A leading `/model`, `/compact`, `/agent`, `/branch` or `/new` (with or
  // without trailing prose) is a local command, not a prompt: consume it,
  // run it, and never emit it as turn text. Any other `/...` falls through
  // to the provider, which owns its own commands. Local UI first, so these
  // work even while the provider is unreachable. The menu-pick path runs
  // through the same table and the same gates — one command, one rule.
  const slash = parseLeadingSlashCommand(text.value);
  if (slash && runSlashCommand(slash.name, slash.focus, { fromMenu: false })) return;
  // Queuing an unaimed job would file something the dispatcher can never pick
  // up. Refused rather than silently downgraded to a draft: which shelf it
  // lands on is the user's decision, not a fallback.
  if (isJob.value && intent === "queued" && !hasProject.value) {
    cue("error");
    emit("open-project");
    return;
  }
  // Nothing to send it to. Return before clearComposerEditor() below — a send refused
  // for a reason the user hasn't fixed yet must not also cost them their draft.
  if (props.blockedReason) {
    cue("error");
    return;
  }
  const draft = text.value.trim();
  // A turn is valid with text, attachments, or both — an attachment-only send
  // (a screenshot with no words) is allowed.
  const files = attachments.value.map((a) => a.file);

  if (isJob.value) {
    emit("file", { title: title.value.trim(), body: draft, intent }, files.length ? files : undefined);
    title.value = "";
  } else {
    emit("send", draft, files.length ? files : undefined);
  }

  cue("send");
  clearComposerEditor();
  clearAttachments();
  syncSoon();
}

/** Park it. The other half of the job commit: same draft, the shelf nobody
 *  dispatches from. */
function park() {
  dispatchDraft("draft");
}

function send() {
  // While a turn runs the seed is a stop — until there is a draft, when it
  // becomes a send: typing arms it, and the send queues behind the running
  // turn rather than interrupting it.
  if (props.busy && !armed.value) {
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

// Edit arrives from the queue strip: drop the queued row, then park its text
// back in the field so it can be reworked and sent fresh.
async function onQueueEdit(entry: QueuedTurnEntry) {
  emit("remove-queued", entry.queueId);
  await setDraft(entry.input || "");
}
onMounted(() => {
  restoreDraft();
  sync();
  if (props.alwaysOpen) void wake();
});
onUnmounted(() => {
  if (closeTimer) clearTimeout(closeTimer);
  persistDraft();
  disposeChips();
  clearAttachments();
});
watch(text, scheduleDraftSave);
// Let hosts work ahead of the send off the same text. Emitted raw — the host
// decides what is worth warming, so a keystroke here never costs a call by
// itself.
watch(text, (draft) => emit("update:draft", draft));

async function setDraft(draft: string) {
  await wake();
  await nextTick();
  setMentionEditorFromText(draft);
  trigger.dismiss();
  focusEditorEnd();
  syncSoon();
}

function focus() {
  if (!open.value) {
    void wake();
    return;
  }
  field.value?.focus();
}

defineExpose({ wake, setDraft, focus });
</script>

<template>
  <div
    ref="dock"
    class="dock"
    :class="{ 'dock--drag': dragging, 'dock--job': isJob }"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
    @keydown.capture.escape="onEscapeCapture"
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

    <div v-if="triggerMenuOpen" class="mention-picker" @mousedown.stop>
      <ProjectFileMentionMenu
        v-if="trigger.marker.value === '@'"
        :items="mentionMenuItems"
        :query="trigger.query.value"
        :active-index="trigger.activeIndex.value"
        :pending="mentionPending"
        :error="mentionError"
        @highlight="trigger.setActiveIndex($event)"
        @select="acceptTriggerItem"
      />
      <SlashCommandMenu
        v-else-if="trigger.marker.value === '/'"
        :items="slashMenuItems"
        :query="trigger.query.value"
        :active-index="trigger.activeIndex.value"
        @highlight="trigger.setActiveIndex($event)"
        @select="acceptTriggerItem"
      />
    </div>

    <!-- Queued follow-ups live in the strip above the card; the composer only
         forwards its reports (cancel / send-now / reorder) and handles an
         edit by parking the row's text back in the field. -->
    <AgentQueueStrip
      v-if="!isJob"
      :queued="queued"
      @remove-queued="emit('remove-queued', $event)"
      @send-now="emit('send-now', $event)"
      @edit="onQueueEdit"
      @reorder-queued="emit('reorder-queued', $event)"
    />

    <!-- Top tray — the send-block reason, hanging off the TOP of the card the
         way the context tray hangs off its floor. Same slab, same small type,
         same calm dot: ground, not chrome. Only rendered while blocked, so an
         unblocked composer is exactly what it was. -->
    <div
      v-if="open && blockedReason"
      class="tray tray--top"
      :class="{ 'is-shown': open && !closing, 'is-closing': closing, 'tray--severe': healthSevere }"
      role="status"
      aria-label="Provider status"
    >
      <span class="tray__item">
        <HugeiconsIcon :icon="AlertCircleIcon" :size="13" :stroke-width="1.8" class="tray__alert" />
        <span class="tray__label">{{ blockedReason }}</span>
      </span>
      <button
        type="button"
        class="tray__item tray__item--action"
        :tabindex="open ? 0 : -1"
        :disabled="healthChecking"
        @click.stop="emit('recheck')"
      >
        <span class="tray__label tray__label--strong">{{ healthChecking ? "Checking…" : "Check again" }}</span>
      </button>
    </div>

    <!-- One surface, morphing. Closed it's the orb; open it's the card. -->
    <div
      ref="surface"
      class="surface"
      :class="{ 'is-open': open, 'is-card': card, 'is-opening': opening, 'is-closing': closing, 'is-springy': springy }"
      :style="{ height: (open ? surfaceH : (closing ? closingH : REST)) + 'px' }"
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
        <!-- Name · what the row is called in the list. It sits above the body
             rather than beside it because that is the order it is read back in,
             and it is quiet until written in: a job that is only a sentence
             long does not need naming twice, so leaving it blank is an
             ordinary way to file one. -->
        <div v-if="isJob" class="title" :class="{ 'is-shown': open && !closing }">
          <input
            v-model="title"
            type="text"
            class="title__input"
            placeholder="Name this job"
            aria-label="Job name"
            :tabindex="open ? 0 : -1"
            :maxlength="TITLE_MAX"
            @keydown.enter.prevent="field?.focus()"
            @click.stop
          />
        </div>

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
            <span v-if="isEmpty" class="field__placeholder" aria-hidden="true">{{ askLabel }}</span>
            <div
              ref="field"
              class="field__input"
              contenteditable="true"
              role="textbox"
              aria-multiline="true"
              :aria-label="askLabel"
              :tabindex="open ? 0 : -1"
              @keydown="onComposerKeydown"
              @input="onComposerInput"
              @click="onComposerClick"
              @keyup="onComposerKeyup"
              @focus="onComposerClick"
              @paste="onPaste"
            />
          </div>
        </div>

        <!-- The bar — every control, on one rail along the card's floor. Left is
             what the turn may DO (attach context, autonomy rung); right is what
             will do it (model, effort, tier, window) and the send seed. It rides
             in from below as the card opens, a beat after the field. -->
        <div class="bar" :class="{ 'is-shown': open && !closing }" :inert="!open || closing">
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
            <!-- Model — the name opens the full providers→models→effort picker,
                 or is a plain label when there is only the one model. -->
            <button
              v-if="canSwitchModel"
              type="button"
              class="barbtn model"
              @click.stop="openModels"
            >
              <ProviderLogo :brand="modelBrand" :size="15" />
              <span class="model__name">{{ modelName }}</span>
            </button>
            <span
              v-else-if="noProvider"
              class="barbtn model barbtn--fixed model--empty"
              title="No provider installed"
            >
              <span class="model__marks" aria-hidden="true">
                <ProviderLogo v-for="b in providerMarks" :key="b" :brand="b" :size="12" />
              </span>
            </span>
            <span v-else class="barbtn model barbtn--fixed" :title="`Running on ${modelName}`">
              <ProviderLogo :brand="modelBrand" :size="15" />
              <span class="model__name">{{ modelName }}</span>
            </span>

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

            <!-- Park it. The quieter of a job's two commits, and deliberately a
                 plain word next to the seed rather than a second disc: filing a
                 draft and queuing one are not equal weights, and two discs side
                 by side would say they were. -->
            <button
              v-if="isJob && armed"
              type="button"
              class="barbtn park"
              aria-label="Save as draft"
              title="Save as a draft — nothing will start it"
              :tabindex="open ? 0 : -1"
              @mousedown.prevent
              @click.stop="park"
            >
              <HugeiconsIcon :icon="Note01Icon" :size="15" :stroke-width="1.9" />
              <span class="park__label">Draft</span>
            </button>

            <!-- The seed. On a turn: a stop while one runs and the field is
                 empty, a send the moment there is a draft (typing arms it — the
                 send queues behind the running turn). On a job it is never a
                 stop, because nothing runs behind this composer; it stays dim
                 until the job could actually be picked up. -->
            <button
              type="button"
              class="seed"
              :class="{ 'seed--armed': commitReady, 'seed--dim': isJob }"
              :aria-label="seedLabel"
              :title="isJob ? seedLabel : undefined"
              :tabindex="open ? 0 : -1"
              @mousedown.prevent
              @click.stop="send"
            >
              <!-- Stop square while a turn runs with nothing to send; the send
                   arrow otherwise. A job has no turn to stop. -->
              <svg v-if="!isJob && busy && !armed" class="seed__stop" viewBox="0 0 18 18" aria-hidden="true">
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
      v-if="showTray"
      class="tray"
      :class="{ 'is-shown': open, 'is-closing': closing }"
      :inert="!open"
      aria-label="Turn context"
    >
      <!-- Who takes the turn. It leads the tray because a person is a bigger
           fact about a turn than a place is. Guest is a row in the menu rather
           than an empty state: not handing the work to anybody in particular is
           a choice you make on purpose, and it is the one you start with.

           On a thread that has already started this is just a label — one agent
           per thread — and it names who is actually on it, so a thread nobody
           was picked for reads as the agent it was rolled, not as a guest slot
           that is still open. The mark is the bot when there is one, matching
           the bead this strip sits under. -->
      <span
        v-if="!canSwitchAgent && settledIdentity"
        class="tray__item"
        :title="`${settledIdentity.name} is on this thread`"
      >
        <img
          v-if="trayAvatar?.photo"
          class="tray__avatar"
          :src="trayAvatar.photo"
          alt=""
          draggable="false"
        />
        <span
          v-else-if="trayAvatar?.svg"
          class="tray__face"
          aria-hidden="true"
          v-html="trayAvatar.svg"
        />
        <span class="tray__label tray__label--strong">{{ settledIdentity.name }}</span>
      </span>
      <button
        v-else
        ref="agentTriggerEl"
        type="button"
        class="tray__item tray__item--action"
        :tabindex="open ? 0 : -1"
        :aria-label="
          isRouting
            ? `${JEV_LABEL} will choose who takes the turn. Change who takes it.`
            : `${currentAgent?.name ?? GUEST_LABEL} is taking the turn. Change who takes it.`
        "
        :title="isRouting ? JEV_LABEL : (currentAgent?.name ?? GUEST_LABEL)"
        @click.stop="openAgentPicker"
      >
        <HugeiconsIcon v-if="isRouting" :icon="Directions01Icon" :size="13" :stroke-width="1.8" />
        <img
          v-else-if="trayAvatar?.photo"
          class="tray__avatar"
          :src="trayAvatar.photo"
          alt=""
          draggable="false"
        />
        <span
          v-else-if="trayAvatar?.svg"
          class="tray__face"
          aria-hidden="true"
          v-html="trayAvatar.svg"
        />
        <HugeiconsIcon v-else :icon="FlashIcon" :size="13" :stroke-width="1.8" />
        <span class="tray__label tray__label--strong">
          {{ isRouting ? JEV_LABEL : (currentAgent?.name ?? GUEST_LABEL) }}
        </span>
      </button>
      <span
        v-if="routingNote"
        class="tray__item tray__item--routing"
        :title="routingNote"
      >
        <HugeiconsIcon :icon="Directions01Icon" :size="13" :stroke-width="1.8" />
        <span class="tray__label">{{ routingNote }}</span>
      </span>
      <!-- Where it runs. A picker on a job and a label on a turn: a turn is
           spoken inside a project that is already open, but a job is written on
           a bench that spans all of them, so being aimed is something it
           acquires. Unset is the state a fresh job opens in, and it names
           itself as the thing still missing rather than rendering nothing. -->
      <button
        v-if="isJob"
        type="button"
        class="tray__item tray__item--action"
        :class="{ 'tray__item--wanted': !hasProject }"
        :tabindex="open ? 0 : -1"
        :aria-label="hasProject ? `Runs in ${projectName}. Change project.` : 'Choose the project this job runs in'"
        :title="hasProject ? `Runs in ${projectName}` : 'Choose the project this job runs in'"
        @click.stop="emit('open-project')"
      >
        <HugeiconsIcon :icon="Folder01Icon" :size="13" :stroke-width="1.8" />
        <span class="tray__label tray__label--strong">
          {{ hasProject ? projectName : "Choose project" }}
        </span>
      </button>
      <span v-else-if="projectName" class="tray__item">
        <HugeiconsIcon :icon="Folder01Icon" :size="13" :stroke-width="1.8" />
        <span class="tray__label tray__label--strong">{{ projectName }}</span>
      </span>
      <!-- Switchable only before the first send, which is also the only moment
           the workspace can be chosen — so this one control asks both halves of
           "where does this work land". -->
      <button
        v-if="branch && canSwitchBranch"
        type="button"
        class="tray__item tray__item--action"
        :aria-label="`On ${branch}. Choose where this conversation works.`"
        :title="`On ${branch} — click to choose where this conversation works`"
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
      <!-- Frozen once the thread has started: the same words, with nothing that
           implies you can still change them. Renders nothing for a conversation
           in the project's own checkout. -->
      <span v-if="worktreePath || isWorkspacePending({ envMode, worktreePath })" class="tray__item">
        <ThreadWorkspaceMark
          class="tray__workspace"
          :worktree-path="worktreePath"
          :env-mode="envMode"
        />
      </span>
      <span
        v-if="!isJob"
        class="tray__item tray__item--end"
        :title="threadLabel"
      >
        <HugeiconsIcon :icon="BubbleChatTemporaryIcon" :size="13" :stroke-width="1.8" />
        <span class="tray__label">{{ threadLabel }}</span>
      </span>
    </div>

    <!-- Partner / Solo Mode Picker in the app's modal shell -->
    <AgentPickerModal
      v-if="agentPickerOpen && canSwitchAgent"
      :anchor-el="agentTriggerEl"
      :agents="roster"
      :active-agent-id="isRouting ? agentId ?? null : currentAgent?.id ?? null"
      @select="pickAgent"
      @cancel="agentPickerOpen = false"
    />
  </div>
</template>

<style scoped src="../composer/composer.css"></style>

<style scoped>
/* The one tray item that reports a decision rather than naming a setting, so
   it carries the second accent to say it isn't another thing you can click. */
.tray__item--routing {
  color: var(--accent-2);
}

/* Top tray — the mirror of the context tray below, hung off the card's head
   instead of its floor. Same slab (sunken, narrower than the card), same small
   type, same calm dot. The card's rounded crown covers the tray's bottom 14px,
   so it reads as one slab the composer is hanging from. Severe (no provider,
   not installed) wears the danger dot; warnings wear the warn dot. */
.tray--top {
  --tray-tone: var(--warn);
  border-radius: 18px 18px 0 0;
  margin-top: 0;
  margin-bottom: 0;
  padding-top: 0;
  padding-bottom: 0;
  /* The slab itself carries the tone — a wash of warn/danger over the sunken
     ground — so no dot is needed. */
  background: color-mix(in srgb, var(--tray-tone) 12%, var(--sunken));
  /* Items ride the VISIBLE top of the slab, not its vertical centre: the card
     covers the tray's bottom 14px, so centred content gets its baseline cut. */
  align-items: flex-start;
}
.tray--top.tray--severe {
  --tray-tone: var(--danger);
}
.tray--top.is-shown {
  height: 40px;
  margin-top: 0;
  margin-bottom: -14px;
  opacity: 1;
  transform: none;
  pointer-events: auto;
  transition:
    height 0.3s cubic-bezier(0.22, 1, 0.36, 1) 0.06s,
    margin-bottom 0.3s cubic-bezier(0.22, 1, 0.36, 1) 0.06s,
    opacity 0.24s ease 0.14s;
}
.tray--top.is-closing {
  height: 40px;
  margin-top: 0;
  margin-bottom: -14px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.18s ease;
}
/* Sit on the strip that shows (the top), not the covered bottom half. The long
   health sentence flexes to fill and ellipsises instead of truncating at the
   tray's 148px chip width. */
.tray--top .tray__item {
  margin-top: 0;
  margin-bottom: 0;
  padding-top: 9px;
  padding-bottom: 0;
}
.tray--top .tray__item:first-child {
  flex: 1;
  min-width: 0;
}
.tray--top .tray__label {
  max-width: none;
}
.tray__alert {
  flex: none;
  color: var(--tray-tone);
}
.tray--top .tray__item:last-child {
  margin-left: auto;
}
.tray--top .tray__item--action {
  margin-top: 7px;
  margin-bottom: 2px;
  padding-top: 2px;
  padding-bottom: 2px;
  border-radius: 0;
}
.tray--top .tray__item--action:hover {
  background: transparent;
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-color: color-mix(in srgb, var(--tray-tone) 65%, transparent);
}
.tray--top .tray__item--action:disabled {
  opacity: 0.45;
  cursor: default;
}
.tray--top .tray__item--action:hover .tray__label {
  opacity: 0.9;
}
.tray--top .tray__item--action:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--tray-tone) 42%, transparent);
}
/* Empty model slot: every provider's mark, greyed and inert. */
.model__marks {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  opacity: 0.38;
  filter: grayscale(1);
}
</style>
