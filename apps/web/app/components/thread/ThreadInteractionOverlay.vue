<script setup lang="ts">
import type { PendingApproval, PendingUserInput, UserInputOwner } from "~/composables/agentTypes";
import type {
  ApprovalDecision,
  ChatAttachment,
  UserInputAnswerAttachments,
  UserInputAnswers,
} from "~/types/desktop";

// The focused thread's live asks, in one place: the mid-turn question and the
// parked tool approval both land bottom-centre over the composer's spot, each
// in the pickers' contained shell so the scrim dims only the owning thread.
// Answering either resolves the parked request and the turn continues.

const props = withDefaults(
  defineProps<{
    /** The agent's live mid-turn question, or null when none is parked. */
    userInput: PendingUserInput | null;
    /** The head of the pending-approval queue, or null when none is parked. */
    approval: PendingApproval | null;
    /** The full pending-approval queue — enables the modal's position readout
     *  and digit shortcuts. Absent means the single-ask behaviour. */
    approvalQueue?: PendingApproval[];
    /** True while the host surface must not answer in place (the studio's
     *  overview grid). Renders nothing — keeps that guard in one place. */
    suppressed?: boolean;
    /** The owning session's attachment uploader, so answer files can be
     *  stored before the answer is sent. Absent hides the attach affordances. */
    upload?: (file: File) => Promise<ChatAttachment>;
    /** The session the question belongs to, handed back with its answer so
     *  the host answers that session, not whichever is in front. */
    owner?: UserInputOwner;
    /** Forget an answer file the user removed or never sent. Same session as
     *  `upload`; absent leaves those files to the startup sweep. */
    discard?: (attachment: ChatAttachment) => Promise<void>;
  }>(),
  {
    approvalQueue: undefined,
    suppressed: false,
    upload: undefined,
    owner: undefined,
    discard: undefined,
  },
);

const emit = defineEmits<{
  /** The question's answers, keyed by question id — resolves the parked call.
   *  `attachments` carries stored files for the questions that have them. */
  answer: [
    requestId: string,
    answers: UserInputAnswers,
    attachments: UserInputAnswerAttachments | undefined,
    owner: UserInputOwner | undefined,
  ];
  /** The question was dismissed — the caller answers it empty (declined). */
  cancel: [requestId: string, owner: UserInputOwner | undefined];
  /** The approval decision — resolves the parked provider request. */
  decide: [requestId: string, decision: ApprovalDecision];
}>();
</script>

<template>
  <!-- Keyed by the asking session too: provider request ids are unique only
       within a thread, and two threads' questions must never share a dialog's
       drafts or files. -->
  <UiUserInputModal
    v-if="props.userInput && !props.suppressed"
    :key="`${props.owner?.key ?? ''}\u0000${props.userInput.requestId}`"
    contained
    :request-id="props.userInput.requestId"
    :questions="props.userInput.questions"
    :upload="props.upload"
    :discard="props.discard"
    :owner="props.owner"
    @answer="
      (requestId, answers, attachments, owner) =>
        emit('answer', requestId, answers, attachments, owner)
    "
    @cancel="(requestId, owner) => emit('cancel', requestId, owner)"
  />
  <AgentApprovalModal
    v-if="props.approval && !props.suppressed"
    contained
    :request-id="props.approval.requestId"
    :approval="props.approval.approval"
    :queue="props.approvalQueue"
    @decide="(requestId, decision) => emit('decide', requestId, decision)"
  />
</template>
