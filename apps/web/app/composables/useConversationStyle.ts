import { useStorage } from "@vueuse/core";
import {
  DEFAULT_CONVERSATION_STYLE,
  isConversationStyle,
  type ConversationStyle,
} from "~/utils/conversationStyle";

// The look every conversation is drawn in — one module-scope ref, like
// useResponsePrefs, so every thread on screen and the Conversation settings page
// share it: pick a style and the threads behind the drawer already wear it.
//
// A stored value that no longer names a style reads the default rather than
// drawing a thread in a layout that doesn't exist.
const style = useStorage<ConversationStyle>("kone.conversation.style", DEFAULT_CONVERSATION_STYLE, undefined, {
  listenToStorageChanges: true,
  serializer: {
    read: (raw) => (isConversationStyle(raw) ? raw : DEFAULT_CONVERSATION_STYLE),
    write: (value) => value,
  },
});

function set(next: ConversationStyle): void {
  style.value = next;
}

export function useConversationStyle() {
  return { style, set };
}
