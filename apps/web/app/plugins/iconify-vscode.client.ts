import { ensureVscodeIcons } from "~/utils/vscodeIcons";

// Register the VS Code file-type icon set offline, so <FileIcon> renders real
// logos without any runtime fetch (the packaged app runs under a strict CSP).
// The set itself is huge, so it's scheduled off the hydration path — the idle
// callback fires only after first paint — and <FileIcon> kicks the same helper
// on mount when an icon is needed in the very first frame.
export default defineNuxtPlugin(() => {
  if ("requestIdleCallback" in window) {
    requestIdleCallback(() => void ensureVscodeIcons());
  } else {
    setTimeout(() => void ensureVscodeIcons(), 0);
  }
});
