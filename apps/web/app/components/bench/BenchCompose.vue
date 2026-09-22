<script setup lang="ts">
// Writing a job: the composer plus everything its controls need to be real.
//
// The composer itself only reports picks; something has to own them. On a
// thread that owner is the session, and every control writes straight into the
// conversation it belongs to. A job has no session — nothing is running, and
// nothing will be until the runner takes it off the queue — so the picks live
// in a draft here and are frozen into the job's `target` when it is filed.
// That freeze is the whole point of asking on this surface: a job is dispatched
// with nobody watching, so how much rope the agent gets has to be answered by
// the person who filed it, at the moment they filed it.
//
// The project is chosen here too, which is the one thing this pane has that the
// thread composers do not. They are keyed on a project that is already open;
// the bench spans every project, so a job starts aimed at nothing and acquires
// its checkout the same way it acquires its model. Everything downstream reads
// the choice through a getter rather than a remount, so picking a project does
// not cost you the words you have already written.

import { computed, ref } from "vue";
import AgentComposer from "~/components/agent/AgentComposer.vue";
import ModelPickerModal from "~/components/model/ModelPickerModal.vue";
import ProjectPickerModal from "~/components/project/ProjectPickerModal.vue";
import { useBench } from "~/composables/useBench";
import { bootProvider } from "~/utils/modelPicker";
import type { RecentProject } from "~/composables/useRecentProjects";
import type { ChatAttachment, JobTarget, ThreadEnvMode } from "~/types/desktop";

const emit = defineEmits<{
  /** The job is on the bench. The portal closes the composer on this — the
   *  list behind it is already re-read by the time it arrives. */
  filed: [];
}>();

const { cue } = useSound();
const bench = useBench();

// ── where it runs ────────────────────────────────────────────────────────────
// Unset until chosen. Nothing downstream is keyed on it in a way that would
// throw work away when it changes: the agent handle resolves its cwd through a
// getter, and the roster and the catalog take one too.
const project = ref<RecentProject | null>(null);
const projectPath = computed(() => project.value?.path ?? "");
const projectName = computed(() => project.value?.name ?? "");

const projectOpen = ref(false);
const branchOpen = ref(false);

function onPickProject(picked: RecentProject): void {
  projectOpen.value = false;
  project.value = picked;
  // A worktree choice belongs to the checkout it was made against, so a new
  // project starts back at that project's own branch. The branch label follows
  // the path on its own.
  workspace.value = { mode: "local", branch: null };
}

// The handle to the project's session registry. Constructing it spawns nothing
// — and this pane never claims a session at all, because filing a job is not
// starting one. It is here because the model catalog and the send gate are read
// through it.
const agent = useAgent({
  provider: bootProvider(),
  cwd: () => projectPath.value,
  rehydrate: false,
});

// Every choice the job will carry, held here until it is filed.
const draft = useThreadDraft(projectPath);

// No session, ever: `useInboxComposer` already has the draft path for a surface
// deciding before there is anything to decide into, and a job never leaves it.
const composer = useInboxComposer({
  agent,
  session: () => null,
  projectPath,
  draft,
});

// ── which checkout ───────────────────────────────────────────────────────────
// Local or a worktree of its own, answered before the job is filed because it
// is part of what the runner is handed. Nothing is built here: a worktree is
// made by the run, so a job parked as a draft and deleted a week later leaves
// no directory behind.
type WorkspaceChoice = { mode: ThreadEnvMode; branch: string | null };
const workspace = ref<WorkspaceChoice>({ mode: "local", branch: null });

function onWorkspacePick(choice: WorkspaceChoice): void {
  workspace.value = choice;
  branchOpen.value = false;
  if (choice.mode === "local") void composer.refreshBranch();
}

/** The branch the work lands on: a picked worktree branch while there is one,
 *  otherwise what the project's checkout is actually on. */
const branch = computed(() =>
  workspace.value.mode === "worktree" && workspace.value.branch
    ? workspace.value.branch
    : (composer.branch.value ?? undefined),
);

// ── filing ───────────────────────────────────────────────────────────────────

const filing = ref(false);

/** The picks, frozen. Read off the draft rather than off any session, because
 *  there is none — this is the only copy. Null provider means no active
 *  provider, so there is nothing to file: the caller guards this before
 *  calling. */
function currentTarget(): JobTarget {
  const p = draft.provider.value;
  if (!p) throw new Error("No provider selected");
  const target: JobTarget = { provider: p };
  if (draft.model.value) target.model = draft.model.value;
  if (draft.reasoning.value) target.effort = draft.reasoning.value;
  target.mode = draft.mode.value;
  if (workspace.value.mode === "worktree") {
    const ws: NonNullable<JobTarget["workspace"]> = { mode: "worktree" };
    if (workspace.value.branch) ws.branch = workspace.value.branch;
    target.workspace = ws;
  }
  return target;
}

async function onFile(
  job: { title: string; body: string; intent: "queued" | "draft" },
  files?: File[],
): Promise<void> {
  if (filing.value) return;
  // Queuing needs somewhere to run. The composer already refuses this and opens
  // the picker; the same check stands here because a draft can be filed without
  // a project and then queued from the list.
  if (job.intent === "queued" && !projectPath.value) {
    projectOpen.value = true;
    return;
  }
  // Null provider means blocked send with no model — nothing to file against.
  // The composer already refuses this; guarded here so the freeze below never
  // indexes a null provider.
  if (!draft.provider.value) return;
  filing.value = true;
  try {
    // Uploaded before the row is written: a failed upload should leave you
    // looking at what you wrote, not at a job missing half its context. What
    // comes back is the bytes-free metadata the job row keeps — the files
    // themselves are already on disk by then, and the job carries the list to
    // its opening turn rather than asking again at dispatch, when there is
    // nobody to ask.
    const attachments = await upload(files);
    const row = await bench.file({
      projectPath: projectPath.value,
      title: job.title,
      body: job.body,
      target: currentTarget(),
      queue: job.intent === "queued",
      attachments,
    });
    if (!row) return;
    cue("send");
    emit("filed");
  } finally {
    filing.value = false;
  }
}

/** Escape walks out one layer at a time. Taken on the way DOWN, before any of
 *  the pickers' own listeners, so the order is decided here rather than by
 *  which window listener happened to be registered first — and stopped, so the
 *  portal behind us does not read the same press as "leave the bench" and
 *  throw away the draft along with the picker. */
function onEscapeCapture(event: KeyboardEvent): void {
  if (!projectOpen.value && !branchOpen.value && !composer.pickerOpen.value) return;
  event.stopPropagation();
  projectOpen.value = false;
  branchOpen.value = false;
  composer.closePicker();
}

/** A failed attachment is dropped rather than sinking the job — a picture that
 *  would not upload is not a reason to lose what you wrote. */
async function upload(files?: File[]): Promise<ChatAttachment[]> {
  if (!files || files.length === 0) return [];
  const results = await Promise.allSettled(files.map((f) => agent.uploadAttachment(f)));
  return results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
}
</script>

<template>
  <div class="compose" @keydown.capture.escape="onEscapeCapture">
    <AgentComposer
      kind="job"
      always-open
      :project-path="projectPath"
      :project-name="projectName"
      :disable-file-mentions="!projectPath"
      :branch="branch"
      :env-mode="workspace.mode"
      :worktree-path="null"
      :agents="composer.agents.value"
      :agent-id="composer.agentId.value"
      :models="composer.modelOptions.value"
      :model-switchable="composer.modelSwitchable.value"
      :model-id="composer.modelId.value"
      :reasoning="composer.reasoning.value"
      :mode="composer.mode.value"
      :fast-mode="composer.fastMode.value"
      :context-window="composer.contextWindow.value"
      :picking="composer.pickerOpen.value"
      :blocked-reason="composer.sendBlockedReason.value"
      :health-status="composer.sendBlockedStatus.value"
      :health-checking="composer.recheckingProviders.value"
      @file="onFile"
      @open-project="projectOpen = true"
      @open-branch="branchOpen = true"
      @open-models="composer.openPicker"
      @update:agent-id="composer.onAgentPick"
      @update:model-id="composer.onModelId"
      @update:reasoning="composer.onReasoning"
      @update:mode="composer.onMode"
      @update:fast-mode="composer.onFastMode"
      @update:context-window="composer.onContextWindow"
      @recheck="composer.recheckProviders"
    />

    <ProjectPickerModal
      v-if="projectOpen"
      class="compose__projects"
      :current-path="projectPath || undefined"
      @select="onPickProject"
      @cancel="projectOpen = false"
    />

    <!-- Asking where the work will land, not moving anything: the worktree is
         built by the run, not by the answer. -->
    <ConversationBranchPickerModal
      v-if="branchOpen && projectPath"
      mode="select"
      :project-path="projectPath"
      @picked="onWorkspacePick"
      @cancel="branchOpen = false"
    />

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
.compose {
  position: relative;
}
.compose__banner {
  margin-bottom: 0.5rem;
}
/* The project picker is a tray, not a window overlay: it hangs off the slot
   that opened it. Above the card rather than below, because below is the foot
   of the pane and the pane clips — there is a whole bench of room upwards. */
.compose__projects {
  position: absolute;
  left: 0;
  bottom: calc(100% + 8px);
  z-index: 2;
}
</style>
