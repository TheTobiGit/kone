<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, ref } from "vue";
import GitSpacePullRequestView from "~/components/git-space/GitSpacePullRequestView.vue";
import { matchesPullRequestRepository, PULL_REQUEST_OPENER, type PullRequestLink } from "~/utils/pullRequestLink";

const props = defineProps<{ cwd: string; link: PullRequestLink; origin: DOMRect | null }>();
const emit = defineEmits<{ close: [] }>();

// The modal's description and comments keep their own links as browser destinations.
provide(PULL_REQUEST_OPENER, null);
const project = computed(() => ({ path: props.cwd, name: props.cwd.split("/").pop() ?? props.cwd }));
const git = useProjectGit(project);
const space = useGitSpace(project, git);
const bridge = useGit();
const verified = ref(false);
let active = true;
onBeforeUnmount(() => { active = false; });
onMounted(async () => {
  // The shell can appear immediately; PR reads wait until their repository is verified.
  const repo = await bridge.github.repo(props.cwd).catch(() => null);
  if (!active) return;
  if (!matchesPullRequestRepository(props.link, repo)) {
    emit("close");
    void bridge.github.open(props.link.href);
    return;
  }
  verified.value = true;
  void space.load();
});
</script>

<template>
  <GitSpacePullRequestView :space="space" :number="link.number" :origin="origin" :ready="verified" @close="emit('close')" />
</template>
