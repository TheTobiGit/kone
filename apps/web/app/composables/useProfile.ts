import { computed } from "vue";
import { useStorage } from "@vueuse/core";

// The local, editable identity behind the profile board and the avatar chips.
// kone has no cloud account — the name/handle/avatar are derived
// from the machine user (useUser) and then overridable locally, persisted in
// localStorage. Nothing here leaves the device.
//
//   name    — display name; empty override falls back to the OS account name
//   handle  — @handle; empty override falls back to a slug of the username
//   color   — avatar accent (empty = the default ink chip)
//   image   — a compressed data-URL photo (empty = initial-on-colour)

const NAME_KEY = "kone:profile:name:v1";
const HANDLE_KEY = "kone:profile:handle:v1";
const COLOR_KEY = "kone:profile:avatarColor:v1";
const IMAGE_KEY = "kone:profile:avatarImage:v1";

// A small, restrained palette — the empty default keeps the inverted ink chip
// kone already uses; the rest are quiet accents.
export const AVATAR_COLORS = [
  { id: "", label: "Ink", value: "" },
  { id: "iris", label: "Iris", value: "#6a63f0" },
  { id: "teal", label: "Teal", value: "#2fb4a2" },
  { id: "amber", label: "Amber", value: "#d99a2b" },
  { id: "rose", label: "Rose", value: "#df6d84" },
  { id: "slate", label: "Slate", value: "#6b7280" },
] as const;

function slugHandle(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 24);
}

// The name worn over your own requests — "You" until the machine's account
// name resolves, so the face is never an empty disc. Single authority for
// the fallback: YouHead and ReplyRef read these, never their own literals.
export const YOU_FALLBACK_NAME = "You";

export function useProfile() {
  const { username, displayName: osName, resolve } = useUser();

  const nameOverride = useStorage(NAME_KEY, "");
  const handleOverride = useStorage(HANDLE_KEY, "");
  const color = useStorage(COLOR_KEY, "");
  const image = useStorage(IMAGE_KEY, "");

  // Effective values: the local override wins, else the machine-derived value.
  const name = computed(() => nameOverride.value.trim() || osName.value || "");

  const handle = computed(() => {
    const raw = handleOverride.value.trim();
    if (raw) return slugHandle(raw);
    return slugHandle(username.value ?? osName.value ?? "");
  });

  const initial = computed(() => name.value.charAt(0).toUpperCase() || "");

  // Your side of the transcript: the display name (or "You") and its initial
  // (empty when a photo draws the face instead).
  const youName = computed(() => name.value || YOU_FALLBACK_NAME);
  const youInitial = computed(() => (image.value ? "" : initial.value || YOU_FALLBACK_NAME.charAt(0)));

  const avatarStyle = computed(() =>
    image.value
      ? {
          backgroundImage: `url(${image.value})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
        }
      : {
          backgroundColor: color.value || "var(--ink)",
          color: color.value ? "#fff" : "var(--ground)",
        },
  );

  return {
    // effective (read for display)
    name,
    handle,
    initial,
    youName,
    youInitial,
    color,
    image,
    avatarStyle,
    // raw overrides (bind in the edit UI)
    nameOverride,
    handleOverride,
    // actions
    setName: (v: string) => (nameOverride.value = v),
    setHandle: (v: string) => (handleOverride.value = v),
    setColor: (v: string) => (color.value = v),
    setImage: (v: string) => (image.value = v),
    resolve,
    colors: AVATAR_COLORS,
  };
}
