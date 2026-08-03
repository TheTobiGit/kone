import { addCollection } from "@iconify/vue";

// The full VS Code icon set is ~3.7 MB of JSON; statically importing it dragged a
// synchronous parse of the whole collection onto the main thread before first
// paint. It's pulled in with a dynamic import instead, which Vite splits into its
// own lazy chunk, and registered exactly once — concurrent callers share a single
// in-flight promise instead of racing to add the same set.
let registration: Promise<void> | null = null;

/** Ensure the offline `vscode-icons` collection is registered. Safe to call from
 *  anywhere, any number of times; duplicates and racers collapse into one load. */
export function ensureVscodeIcons(): Promise<void> {
  if (!registration) {
    registration = import("@iconify-json/vscode-icons/icons.json")
      .then(({ default: vscodeIcons }) => {
        addCollection(vscodeIcons as Parameters<typeof addCollection>[0]);
      })
      .catch((error) => {
        // Don't poison the shared promise for the whole session — let a transient
        // failure be retried on the next call.
        registration = null;
        throw error;
      });
  }
  return registration;
}
