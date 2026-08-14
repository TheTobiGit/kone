import { useReducedMotion, useAnimationControls } from "motion-v";

export type IconAnimationControls = ReturnType<typeof useAnimationControls>;

export interface AnimatedIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface UseIconAnimationOptions {
  // Looping gestures return to rest on mouse-leave; finite gestures finish
  // their beat and are left alone.
  loops?: boolean;
}

// Drives an animated icon: plays the `animate` variant on hover (or on demand
// via the returned handle) and honours prefers-reduced-motion. Mirrors the two
// named variants every icon component declares — `normal` (rest) and `animate`.
export function useIconAnimation(
  controls: IconAnimationControls,
  options: UseIconAnimationOptions = {},
) {
  const { loops = false } = options;
  const shouldReduceMotion = useReducedMotion();

  let isPlaying = false;
  let run = 0;

  function startAnimation() {
    if (shouldReduceMotion.value || isPlaying) return;

    isPlaying = true;
    const current = ++run;
    controls.set("normal");
    void Promise.resolve(controls.start("animate")).then(() => {
      if (run === current) isPlaying = false;
    });
  }

  function stopAnimation() {
    if (!loops) return;

    run++;
    isPlaying = false;
    void controls.start("normal");
  }

  return { startAnimation, stopAnimation };
}
