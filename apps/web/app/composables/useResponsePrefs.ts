import { useStorage } from "@vueuse/core";
import {
  DEFAULT_DISPLAYS,
  type ConversationSurface,
  type ResponseDisplay,
} from "~/utils/responseDisplay";

// How agent turns read, per surface — per-install feel knobs on the same shelf
// as the strip's centering (see useStripPrefs). One module-scope ref so every
// thread on screen and the Conversation settings page share one reactive value:
// pick an option and the threads behind the drawer already obey, with no reload
// and no props threaded across.
//
// Stored whole, merged over the defaults, so a surface or a choice added later
// reads its default rather than nothing. The meaning of each choice lives in
// `~/utils/responseDisplay`.
const displays = useStorage<Record<ConversationSurface, ResponseDisplay>>(
  "kone.conversation.displays",
  DEFAULT_DISPLAYS,
  undefined,
  {
    listenToStorageChanges: true,
    mergeDefaults: (stored, defaults) => {
      const out = { ...defaults };
      for (const surface of Object.keys(defaults) as ConversationSurface[]) {
        const s = stored?.[surface];
        if (!s) continue;
        out[surface] = {
          live: { ...defaults[surface].live, ...s.live },
          done: { ...defaults[surface].done, ...s.done },
        };
      }
      return out;
    },
  },
);

/** Change one choice on one surface. */
function set<P extends keyof ResponseDisplay, K extends keyof ResponseDisplay[P]>(
  surface: ConversationSurface,
  phase: P,
  key: K,
  value: ResponseDisplay[P][K],
): void {
  const current = displays.value[surface];
  displays.value = {
    ...displays.value,
    [surface]: { ...current, [phase]: { ...current[phase], [key]: value } },
  };
}

export function useResponsePrefs() {
  return { displays, set };
}
