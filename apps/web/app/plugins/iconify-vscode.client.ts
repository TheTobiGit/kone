import { addCollection } from "@iconify/vue";
import vscodeIcons from "@iconify-json/vscode-icons/icons.json";

// Register the VS Code file-type icon set offline, so <FileIcon> renders real
// logos without any runtime fetch (the packaged app runs under a strict CSP).
export default defineNuxtPlugin(() => {
  addCollection(vscodeIcons as Parameters<typeof addCollection>[0]);
});
