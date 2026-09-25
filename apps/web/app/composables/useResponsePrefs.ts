import { useStorage } from "@vueuse/core";
import {
  DEFAULT_DISPLAYS,
  readDisplays,
  withChoice,
  type ConversationSurface,
  type ResponseDisplays,
  type ResponsePick,
  type StoredDisplays,
} from "~/utils/responseDisplay";

// How agent turns read, per surface — per-install feel knobs on the same shelf
// as the strip's centering (see useStripPrefs). One module-scope ref so every
// thread on screen and the Conversation settings page share one reactive value:
// pick an option and the threads behind the drawer already obey, with no reload
// and no props threaded across.
//
// Stored whole and read back choice by choice (readDisplays), so a surface or a
// choice added later reads its default rather than nothing. The meaning of each
// choice lives in `~/utils/responseDisplay`.
const displays = useStorage<ResponseDisplays>("kone.conversation.displays", DEFAULT_DISPLAYS, undefined, {
  listenToStorageChanges: true,
  mergeDefaults: (stored: StoredDisplays) => readDisplays(stored),
});

/** Change one choice on one surface. The other surfaces keep their identity,
 *  so only threads reading this one replan. */
function set(surface: ConversationSurface, pick: ResponsePick): void {
  displays.value = { ...displays.value, [surface]: withChoice(displays.value[surface], pick) };
}

/** Put one surface back to how it started. */
function reset(surface: ConversationSurface): void {
  displays.value = { ...displays.value, [surface]: DEFAULT_DISPLAYS[surface] };
}

export function useResponsePrefs() {
  return { displays, set, reset };
}
