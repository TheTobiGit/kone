import { useDocumentVisibility } from "@vueuse/core";
import { useReducedMotion } from "motion-v";
import { computed } from "vue";

export function useMotionPreference() {
  const prefersReducedMotion = useReducedMotion();
  const documentVisibility = useDocumentVisibility();

  const isDocumentVisible = computed(
    () => documentVisibility.value === "visible",
  );

  const shouldAnimate = computed(
    () => !prefersReducedMotion.value && isDocumentVisible.value,
  );

  const shouldRunContinuousMotion = computed(
    () => !prefersReducedMotion.value && isDocumentVisible.value,
  );

  const scrollBehavior = computed<ScrollBehavior>(() =>
    prefersReducedMotion.value ? "auto" : "smooth",
  );

  return {
    prefersReducedMotion,
    isDocumentVisible,
    shouldAnimate,
    shouldRunContinuousMotion,
    scrollBehavior,
  };
}
