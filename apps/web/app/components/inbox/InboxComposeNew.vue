<script setup lang="ts">
// Before a thread exists: everything you settle first, and the box you say the
// first thing in.
//
// This is deliberately not the thread view. There is no transcript, because
// there is nothing to transcribe; no orb, because an orb is something you wake
// on your way past and this pane exists only because you asked to write. What
// it is instead is the one moment where the decisions that are hard to take
// back are still free — which project, which model, how much rope the agent
// gets, who is answering. A thread inherits every one of those at its first
// turn and then mostly keeps them, so the place to offer them is here, before
// the turn, rather than as things to correct afterwards.
//
// Nothing backs the pane while you are deciding — the choices live in a draft,
// and the project's session registry does not know this surface exists. That is
// deliberate: a registry is shared with whatever else has that project open, so
// a session claimed here to give the controls something to write to would be a
// thread nobody asked for, and often not even a new one. The send is what makes
// a thread, which is what the send has always meant.
//
// It never becomes the thread view. Sending hands the thread up and this pane
// goes away, the same as if you had picked the thread out of the list — one
// surface for deciding, another for the conversation, so neither has to be
// half of the other. The session is not torn down in the handover: the reader
// asks the registry for that thread id and is given the very session started
// here, still streaming its first turn.

import { computed, onBeforeUnmount, ref } from "vue";
import { AnimatePresence } from "motion-v";
import { onClickOutside, useEventListener } from "@vueuse/core";
import AgentComposer from "~/components/agent/AgentComposer.vue";
import { bootProvider } from "~/utils/modelPicker";
import { SESSION_BRAND } from "~/types/session";
import type { ChatAttachment } from "~/types/desktop";
import type { RecentProject } from "~/composables/useRecentProjects";
import type { ThreadSession } from "~/composables/useAgent";
import type { SessionSummary } from "~/types/session";

const props = defineProps<{
  projectPath: string;
  projectName: string;
}>();

const emit = defineEmits<{
  /** Somewhere else to run this thread. Answered above, because the project is
   *  what this pane is keyed on and a pane cannot rekey itself. */
  "pick-project": [project: RecentProject];
  /** The thread exists now, and it is the inbox's to show. Carries a row the
   *  reader can open, so the portal does not have to wait for the stored list
   *  to catch up with something it just watched happen. */
  started: [row: SessionSummary, sessionKey: string];
}>();

// Constructing the registry handle spawns nothing of its own; it is the handle
// to a place, and this pane does not take anything from it until you send.
//
// `rehydrate: false` because of what the first handle to a project does: it
// spawns the boot session, and a boot session's first start reloads the
// project's most recent stored conversation into itself. That is right for a
// board opening a project — you left mid-conversation, you come back to it —
// and wrong here twice over. This pane exists to make a NEW thread, and the
// blank session it takes is that same boot session, so without this the first
// send resumes an old conversation and puts the message you just wrote at the
// end of it.
const agent = useAgent({ provider: bootProvider(), cwd: props.projectPath, rehydrate: false });

// Everything you settle before the thread exists, held here rather than in a
// session there is no reason to have yet.
const draft = useThreadDraft(props.projectPath);

// Null until the send claims one, which is the whole point of this pane.
const key = ref<string | null>(null);
const session = computed(() => agent.sessions.value.find((s) => s.key === key.value) ?? null);

onBeforeUnmount(() => {
  // Not after a handover: the reading pane pins the same session under the same
  // key, and it mounts before this unmounts. Unpinning here would take back the
  // pin it just put down, and the sweep would be free to hibernate a thread
  // sitting on screen.
  if (key.value && !handedOver.value) agent.unpinFromPane(key.value);
});

/** Take a session and put the draft in it — the moment the thread begins. */
async function claim(): Promise<ThreadSession | null> {
  await agent.newThread();
  const claimed = agent.activeKey.value;
  key.value = claimed;
  // The idle sweep evicts sessions it believes nobody is looking at, and a pane
  // holding one is exactly the case it must not evict.
  if (claimed) agent.pinToPane(claimed);
  const s = session.value;
  // Arm it. A registry spawns a boot session the first time a project is asked
  // for, and that session is inert: never started, and never told that its
  // start is merely deferred. `newThread` hands it back as the blank thread it
  // is, and a send into a thread in that state dispatches a turn the backend
  // has no session for. Idempotent — a session that already has a process keeps
  // it, so this only ever arms the one that needs arming.
  s?.deferStart();
  await composer.applyDraft();
  return s;
}

// ── where it runs ────────────────────────────────────────────────────────────
// The project is named in the question, and the name is the control: this pane
// chose a project on your behalf, so the place that admits which one it chose is
// also the place to disagree with it. Only before the first turn — afterwards
// the question is gone, and so is the choice.

const { cue } = useSound();
const { recents } = useRecentProjects();
const others = computed(() => recents.value.filter((p) => p.path !== props.projectPath));

const switcherOpen = ref(false);
const askBox = ref<HTMLElement | null>(null);
onClickOutside(askBox, () => (switcherOpen.value = false));

function toggleSwitcher(): void {
  cue(switcherOpen.value ? "collapse" : "select");
  switcherOpen.value = !switcherOpen.value;
}

function onPickProject(p: RecentProject): void {
  switcherOpen.value = false;
  if (p.path === props.projectPath) return;
  cue("open");
  emit("pick-project", p);
}

// Escape belongs to the switcher while it is up. Marked handled so the portal,
// which reads the same key as its own way out, leaves this one alone.
useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (!switcherOpen.value || e.key !== "Escape") return;
  switcherOpen.value = false;
  e.preventDefault();
});

const composer = useInboxComposer({
  agent,
  session: () => session.value,
  projectPath: props.projectPath,
  draft,
});
// The branch picker, like the model picker, is the surface's to host: it lands
// outside the composer's dock, so the composer could not own it.
const branchOpen = ref(false);

const busy = computed(() => session.value?.busy.value ?? false);
const queued = computed(() => session.value?.queuedTurns.value ?? []);
const error = computed(() => session.value?.error.value ?? null);

// ── the handover ─────────────────────────────────────────────────────────────
// The thread exists once the turn has been accepted, and not one moment before.
//
// A session carries a thread id from birth — it is minted in the renderer, not
// by the provider — so an id is no evidence at all that anything has started.
// Handing over on it raced the send: the reading pane could mount, adopt the
// session and re-point the registry at it while the send was still being
// assembled. So the handover waits for the send's own acknowledgement, which is
// the first fact that means a thread.
//
// It carries the session key as well as the row. The reader could find the same
// session by thread id, but "could find" is doing too much work for something
// this order-dependent — the key names the very session that was just started,
// with nothing to look up and nothing to race.

const sending = ref(false);
const handedOver = ref(false);

const provider = computed(() => session.value?.provider.value ?? agent.provider.value);

async function onSend(text: string, files?: File[]): Promise<void> {
  if (sending.value) return;
  sending.value = true;
  try {
    // Attachments go up before the session is claimed: a failed upload should
    // leave you looking at the message you wrote, not at a thread that exists
    // with nothing in it.
    const uploaded = await upload(files);
    const s = session.value ?? (await claim());
    if (!s) return;
    await s.send(text, uploaded);
    const id = s.threadId.value;
    const claimed = key.value;
    if (!id || !claimed) return;
    // Who is on the thread, settled on the turn that made it. Write-once, and
    // this is the only turn where the choice was still open.
    composer.settleThreadAgent(id, composer.agentId.value);
    handedOver.value = true;
    emit(
      "started",
      {
        threadId: id,
        title: s.title.value || "New thread",
        provider: provider.value,
        brand: SESSION_BRAND[provider.value],
        updatedAt: Date.now(),
        projectPath: props.projectPath,
        projectName: props.projectName,
      },
      claimed,
    );
  } finally {
    // A send that failed leaves you here, with the session's own error on the
    // line above the composer and the pane still yours to try again from.
    if (!handedOver.value) sending.value = false;
  }
}

/** In the window between the first send and the handover there is a turn in
 *  flight, so there is something to steer. */
async function onSteer(text: string, files?: File[]): Promise<void> {
  const s = session.value;
  if (!s) return;
  await s.steerTurn(text, await upload(files));
}

/** A failed attachment is dropped rather than sinking the whole message — a
 *  picture that would not upload is not a reason to lose what you typed. */
async function upload(files?: File[]): Promise<ChatAttachment[]> {
  if (!files || files.length === 0) return [];
  const results = await Promise.allSettled(files.map((f) => agent.uploadAttachment(f)));
  return results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
}
</script>

<template>
  <div class="new">
    <!-- The blank pane says what the blankness is for. A thread starts with a
         question rather than a cursor: naming the project in it is the one
         reassurance worth giving here, since this pane picked that project for
         you and nothing else on screen admits which one it landed on. -->
    <div class="new__ask">
      <div ref="askBox" class="new__askbox">
        <h2 v-if="!sending" class="new__askline">
          What should we do in
          <button
            type="button"
            class="new__askproj"
            aria-haspopup="menu"
            :aria-expanded="switcherOpen"
            @click="toggleSwitcher"
          >{{ projectName }}</button>?
        </h2>

        <!-- Said, and now waiting on the thread to exist under a name. A line
             rather than a spinner: what is happening is a process starting, and
             it is over the moment the reader takes this pane's place. -->
        <p v-else class="new__askline new__askline--quiet">
          {{ error ? error : `Starting a thread in ${projectName}…` }}
        </p>

        <!-- The popover hangs off the name it belongs to. A plain wrapper does
             the positioning, because the panel animates its own transform and
             the two would fight over the property. -->
        <div class="new__pop">
          <AnimatePresence>
            <ProjectSwitcher
              v-if="switcherOpen"
              :projects="others"
              :browse="false"
              @switch="onPickProject"
            />
          </AnimatePresence>
        </div>
      </div>
    </div>

    <div class="new__dock">
      <AgentComposer
        always-open
        :project-path="projectPath"
        :project-name="projectName"
        :branch="composer.branch.value ?? undefined"
        :branch-switchable="!sending"
        :thread-name="session?.title.value"
        :thread-id="session?.threadId.value"
        :busy="busy"
        :queued="queued"
        :agents="composer.agents.value"
        :agent-id="composer.agentId.value"
        :agent-switchable="!sending"
        :models="composer.modelOptions.value"
        :model-switchable="composer.modelSwitchable.value"
        :model-id="composer.modelId.value"
        :reasoning="composer.reasoning.value"
        :mode="composer.mode.value"
        :fast-mode="composer.fastMode.value"
        :context-window="composer.contextWindow.value"
        @send="onSend"
        @steer="onSteer"
        @remove-queued="session?.cancelQueuedTurn($event)"
        @interrupt="session?.interrupt()"
        @update:agent-id="composer.onAgentPick"
        @update:model-id="composer.onModelId"
        @update:reasoning="composer.onReasoning"
        @update:mode="composer.onMode"
        @update:fast-mode="composer.onFastMode"
        @update:context-window="composer.onContextWindow"
        @open-models="composer.openPicker"
        @open-branch="branchOpen = true"
      />
    </div>

    <!-- Switching branch here moves the working tree, which every other surface
         on this repository shares. That is the honest cost of choosing where
         the work lands before it starts, and it is why the offer closes the
         moment the thread does. -->
    <ConversationBranchPickerModal
      v-if="branchOpen"
      :project-path="projectPath"
      :refresh="composer.refreshBranch"
      @switched="branchOpen = false"
      @cancel="branchOpen = false"
    />

    <!-- The full providers → models → effort picker. It is the surface's to
         host, not the composer's: it lands outside the composer's dock, which
         is exactly why the composer has to be told it is up. -->
    <ModelPickerModal
      v-if="composer.pickerOpen.value"
      :providers="composer.pickerProviders.value"
      :active-provider="composer.provider.value"
      :model-id="composer.modelId.value"
      :reasoning="composer.reasoning.value"
      :fast-mode="composer.fastMode.value"
      :context-window="composer.contextWindow.value"
      @select="composer.onPick"
      @apply="composer.onApply"
      @cancel="composer.closePicker"
    />
  </div>
</template>

<style scoped>
.new {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.new__ask {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 24px 132px;
  text-align: center;
}
.new__askbox {
  position: relative;
}
.new__askline {
  font-family: var(--font-sans);
  font-size: 20px;
  font-weight: 500;
  letter-spacing: -0.02em;
  line-height: 1.35;
  color: var(--muted);
  text-wrap: balance;
}
.new__pop {
  position: absolute;
  top: calc(100% + 12px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 3;
  display: flex;
  justify-content: center;
}

.new__askline--quiet {
  font-size: 15px;
  font-weight: 400;
}

.new__askproj {
  font: inherit;
  letter-spacing: inherit;
  color: var(--ink-soft);
  cursor: pointer;
  transition: color 0.16s ease, text-decoration-color 0.16s ease;
  /* Underlined the way a named thing is, not the way a link is: dotted and set
     off the baseline so it reads as the one word in the line that was filled in
     rather than as something to click. */
  text-decoration: underline dotted;
  text-decoration-color: var(--line);
  text-underline-offset: 4px;
  text-decoration-thickness: 1.5px;
}
.new__askproj:hover,
.new__askproj:focus-visible {
  color: var(--ink);
  text-decoration-color: var(--muted);
  outline: none;
}

.new__dock {
  position: absolute;
  inset-inline: 0;
  bottom: 18px;
  display: flex;
  justify-content: center;
  pointer-events: none;
}
.new__dock > * {
  pointer-events: auto;
}
</style>
