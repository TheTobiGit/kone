<script setup lang="ts">
import type { PendingApproval, PendingUserInput } from "~/composables/agentTypes";
import type { ApprovalDecision, UserInputAnswers } from "~/types/desktop";

// The focused thread's live asks, in one place: the mid-turn question and the
// parked tool approval both land bottom-centre over the composer's spot, each
// in the pickers' contained shell so the scrim dims only the owning thread.
// Answering either resolves the parked request and the turn continues; the
// subagent shell, when it already shows the same approval inline, owns that
// ask instead and this overlay's approval modal stays down.

const props = withDefaults(
  defineProps<{
    /** The agent's live mid-turn question, or null when none is parked. */
    userInput: PendingUserInput | null;
    /** The head of the pending-approval queue, or null when none is parked. */
    approval: PendingApproval | null;
    /** The full pending-approval queue — enables the modal's position readout
     *  and digit shortcuts. Absent means the single-ask behaviour. */
    approvalQueue?: PendingApproval[];
    /** True while the subagent shell renders the same approval inline — the
     *  approval modal stays down so one ask never has two answer spots. */
    shellSuppressesApproval?: boolean;
    /** True while the host surface must not answer in place (the studio's
     *  overview grid). Renders nothing — keeps that guard in one place. */
    suppressed?: boolean;
  }>(),
  {
    approvalQueue: undefined,
    shellSuppressesApproval: false,
    suppressed: false,
  },
);

const emit = defineEmits<{
  /** The question's answers, keyed by question id — resolves the parked call. */
  answer: [requestId: string, answers: UserInputAnswers];
  /** The question was dismissed — the caller answers it empty (declined). */
  cancel: [requestId: string];
  /** The approval decision — resolves the parked provider request. */
  decide: [requestId: string, decision: ApprovalDecision];
}>();
</script>

<template>
  <UiUserInputModal
    v-if="props.userInput && !props.suppressed"
    contained
    :request-id="props.userInput.requestId"
    :questions="props.userInput.questions"
    @answer="(requestId, answers) => emit('answer', requestId, answers)"
    @cancel="(requestId) => emit('cancel', requestId)"
  />
  <AgentApprovalModal
    v-if="props.approval && !props.shellSuppressesApproval && !props.suppressed"
    contained
    :request-id="props.approval.requestId"
    :approval="props.approval.approval"
    :queue="props.approvalQueue"
    @decide="(requestId, decision) => emit('decide', requestId, decision)"
  />
</template>
