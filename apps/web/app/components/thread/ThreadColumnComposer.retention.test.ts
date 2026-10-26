import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The Add-to-Composer regression was a mounting decision, not a data bug: the
// wrapper stayed alive while the inner composer was torn down for a parked ask,
// so every proxy resolved after delivering nothing. These assertions pin the
// two halves of the fix — the composer stays mounted (hidden, inert) and the
// wrapper/row report a failure rather than swallowing a missing handle.
//
// Component mounting is not available in this suite (no Vue test renderer and
// no new dependencies); the data paths that can be exercised without a DOM live
// in their own unit suites (composerLiteralDraft, columnComposerDock,
// useComposerReferences, useComposerDraft).

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

test("a parked ask hides the column composer instead of unmounting it", () => {
  const column = source("./ThreadColumnComposer.vue");

  // The old gate is gone: the card and its AgentComposer stay in the tree.
  expect(column).not.toContain('v-if="!asking"');
  expect(column).toContain("col-composer--parked");
  expect(column).toContain(':inert="asking"');
  // The inner composer is told it is off screen, so its global keystroke
  // handler and Escape registration stand down while the ask owns input.
  expect(column).toContain(':inactive="asking"');
});

test("the hidden composer ignores the global keystroke and Escape", () => {
  const composer = source("../agent/AgentComposer.vue");

  expect(composer).toContain("inactive");
  expect(composer).toMatch(/if \(props\.inactive\) return;/);
  expect(composer).toContain("!props.inactive");
});

test("the dock report hands the spot back to the ask", () => {
  const column = source("./ThreadColumnComposer.vue");
  expect(column).toContain("columnComposerDockState");
  expect(column).toContain("asking");
});

test("New Thread seeds the field literally, while queue restore keeps setDraft", () => {
  const column = source("./ThreadColumnComposer.vue");
  expect(column).toContain("seedDraft");

  const composer = source("../agent/AgentComposer.vue");
  expect(composer).toContain("seedDraft");
  expect(composer).toContain("setEditorFromLiteralText");
  expect(composer).toContain("appendEditorLiteralText");
  // Queue restore and refusal restore still re-chip from the saved skills.
  expect(composer).toContain("skills.restoreEditorFromText(draft, saved)");
});

test("a missing row handle is reported, not silently dropped", () => {
  const row = source("../studio/StudioRow.vue");
  const addReference = row.slice(row.indexOf("addReference: async"), row.indexOf("},\n});"));
  expect(addReference).toContain("if (!handle)");
  expect(addReference).toContain("flashRowNotice");
});
