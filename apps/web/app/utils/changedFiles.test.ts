import { describe, expect, test } from "bun:test";

import type { AssistantBlock, ThreadBlock } from "~/composables/useAgent";
import type { RuntimeItem, RuntimeItemStatus } from "~/types/desktop";
import { deriveChangedFiles } from "./changedFiles";

let n = 0;
function toolItem(
  name: string,
  text: string,
  status: RuntimeItemStatus = "completed",
  detail?: string,
): RuntimeItem {
  return { itemId: `i${n++}`, kind: "tool_call", status, name, text, ...(detail ? { detail } : {}) };
}

function assistant(items: RuntimeItem[]): AssistantBlock {
  return {
    id: `b${n++}`,
    role: "assistant",
    turnId: `t${n++}`,
    items,
    state: "completed",
    at: 0,
  };
}

function user(text: string): ThreadBlock {
  return { id: `u${n++}`, role: "user", text, at: 0 };
}

describe("deriveChangedFiles", () => {
  test("classifies write / edit / delete tools by family", () => {
    const { files } = deriveChangedFiles([
      assistant([
        toolItem("write_to_file", "docs/example.md"),
        toolItem("edit_file", "app/components/example.vue"),
        toolItem("rm", "tmp/scratch.log"),
      ]),
    ]);
    expect(files.map((f) => [f.name, f.kind])).toEqual([
      ["example.md", "created"],
      ["example.vue", "edited"],
      ["scratch.log", "removed"],
    ]);
  });

  test("ignores non-mutating tools (read / list / grep / bash)", () => {
    const { files } = deriveChangedFiles([
      assistant([
        toolItem("read_file", "a.ts"),
        toolItem("list_dir", "app"),
        toolItem("grep_search", "foo · 3 matches"),
        toolItem("bash", "bun test"),
      ]),
    ]);
    expect(files).toEqual([]);
  });

  test("one row per path — created survives a later edit", () => {
    const { files } = deriveChangedFiles([
      assistant([
        toolItem("write_to_file", "new.ts"),
        toolItem("edit_file", "new.ts"),
      ]),
    ]);
    expect(files).toHaveLength(1);
    expect(files[0]?.kind).toBe("created");
  });

  test("removal is terminal for a path", () => {
    const { files } = deriveChangedFiles([
      assistant([toolItem("edit_file", "gone.ts"), toolItem("rm", "gone.ts")]),
    ]);
    expect(files).toHaveLength(1);
    expect(files[0]?.kind).toBe("removed");
  });

  test("splits name and dir", () => {
    const { files } = deriveChangedFiles([
      assistant([toolItem("edit_file", "app/components/Foo.vue"), toolItem("write", "README.md")]),
    ]);
    expect(files[0]).toMatchObject({ name: "Foo.vue", dir: "app/components" });
    expect(files[1]).toMatchObject({ name: "README.md", dir: "" });
  });

  test("streaming flags the live write and the whole state", () => {
    const { files, streaming } = deriveChangedFiles([
      assistant([
        toolItem("write_to_file", "done.ts", "completed"),
        toolItem("edit_file", "live.ts", "in-progress"),
      ]),
    ]);
    expect(streaming).toBe(true);
    expect(files.find((f) => f.name === "done.ts")?.streaming).toBe(false);
    expect(files.find((f) => f.name === "live.ts")?.streaming).toBe(true);
  });

  test("strips the tool-name prefix the mock adds to the target", () => {
    const { files } = deriveChangedFiles([
      assistant([
        toolItem("edit_file", "edit_file: app/components/Foo.vue"),
        toolItem("rm", "rm: tmp/scratch.log"),
      ]),
    ]);
    expect(files[0]).toMatchObject({ name: "Foo.vue", dir: "app/components", kind: "edited" });
    expect(files[1]).toMatchObject({ name: "scratch.log", dir: "tmp", kind: "removed" });
  });

  test("counts +/− from the diff detail, per file and aggregate", () => {
    const { files, totalAdded, totalRemoved } = deriveChangedFiles([
      assistant([
        toolItem(
          "edit_file",
          "edit_file: a.vue",
          "completed",
          "@@ -1,3 +1,4 @@\n-  old line\n+  new line\n+  extra line\n",
        ),
        toolItem("write_to_file", "b.ts", "completed", "+ export const x = 1;\n+ export const y = 2;\n"),
      ]),
    ]);
    expect(files[0]).toMatchObject({ name: "a.vue", added: 2, removed: 1 });
    expect(files[1]).toMatchObject({ name: "b.ts", added: 2, removed: 0 });
    expect(totalAdded).toBe(4);
    expect(totalRemoved).toBe(1);
  });

  test("diff headers refine a generic edit tool into create / remove", () => {
    const { files } = deriveChangedFiles([
      assistant([
        toolItem(
          "edit_file",
          "src/new.ts",
          "completed",
          "diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.ts\n+export const x = 1;\n",
        ),
        toolItem(
          "edit_file",
          "src/gone.ts",
          "completed",
          "diff --git a/src/gone.ts b/src/gone.ts\ndeleted file mode 100644\n--- a/src/gone.ts\n+++ /dev/null\n-export const y = 2;\n",
        ),
        toolItem(
          "edit_file",
          "src/keep.ts",
          "completed",
          "@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n",
        ),
      ]),
    ]);
    expect(files.map((f) => [f.name, f.kind])).toEqual([
      ["new.ts", "created"],
      ["gone.ts", "removed"],
      ["keep.ts", "edited"],
    ]);
  });

  test("accumulates across turns, user blocks skipped", () => {
    const { files } = deriveChangedFiles([
      user("do a thing"),
      assistant([toolItem("edit_file", "one.ts")]),
      user("now another"),
      assistant([toolItem("write_to_file", "two.ts")]),
    ]);
    expect(files.map((f) => f.name)).toEqual(["one.ts", "two.ts"]);
  });
});
