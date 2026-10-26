import { describe, expect, test } from "bun:test";

import {
  appendEditorLiteralText,
  replaceEditorWithLiteralText,
} from "./composerLiteralDraft";

// A tiny stand-in for the contenteditable field: it records the nodes the
// helpers create instead of rendering them. The point of these helpers is that
// seeded bytes enter as ONE text node and never pass through the draft
// segmenter, which is what used to turn `/skill` and `@path` selections into
// chips.
type FakeNode = { text: string; nodeType: number };

function node(text: string): FakeNode {
  return { text, nodeType: 3 };
}

class FakeEditor {
  children: FakeNode[] = [];
  cleared = 0;
  replaceChildren(): void {
    this.cleared += 1;
    this.children = [];
  }
  appendChild(child: FakeNode): void {
    this.children.push(child);
  }
}

const doc = { createTextNode: (text: string): FakeNode => node(text) };

describe("literal draft seeding", () => {
  test("replaces the field with one text node, exact bytes kept", () => {
    const editor = new FakeEditor();
    editor.children = [node("old")];

    const text = replaceEditorWithLiteralText(editor, "    const x = 1;\n\treturn x;\n", doc);

    expect(text).toBe("    const x = 1;\n\treturn x;\n");
    expect(editor.cleared).toBe(1);
    expect(editor.children).toEqual([node("    const x = 1;\n\treturn x;\n")]);
  });

  test("a /skill or @path selection stays prose, not a chip", () => {
    const editor = new FakeEditor();
    const selection = "/tdd fix this\n@src/a.ts still one block";

    replaceEditorWithLiteralText(editor, selection, doc);

    expect(editor.children).toHaveLength(1);
    expect(editor.children[0]!.text).toBe(selection);
  });

  test("appends after existing words and chips with one blank line", () => {
    const editor = new FakeEditor();
    editor.children = [node("/review keep the chips")];

    const text = appendEditorLiteralText(editor, "/review keep the chips", "  selected", doc);

    // The existing node (standing in for a chip's serialized text) is not
    // replaced; only the addition is appended.
    expect(editor.cleared).toBe(0);
    expect(editor.children[1]).toEqual(node("\n\n  selected"));
    expect(text).toBe("/review keep the chips\n\n  selected");
  });

  test("appending to an empty field replaces whitespace-only content", () => {
    const editor = new FakeEditor();
    editor.children = [node("   ")];

    const text = appendEditorLiteralText(editor, "   ", "seed\n", doc);

    expect(editor.cleared).toBe(1);
    expect(editor.children).toEqual([node("seed\n")]);
    expect(text).toBe("seed\n");
  });

  test("appending nothing leaves the field untouched", () => {
    const editor = new FakeEditor();
    editor.children = [node("kept")];

    expect(appendEditorLiteralText(editor, "kept", "", doc)).toBe("kept");
    expect(editor.children).toEqual([node("kept")]);
  });
});
