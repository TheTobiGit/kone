import { describe, expect, test } from "bun:test";

import {
  parseCreatedSubagents,
  parseInboundMessage,
  parseInvokeSubagentSpecs,
} from "./antigravitySubagents.js";

// Every shape asserted here was captured from a real `agy` conversation.

describe("parseInvokeSubagentSpecs", () => {
  test("reads the briefs out of the doubly-encoded tool arguments", () => {
    expect(
      parseInvokeSubagentSpecs({
        Subagents:
          '[{"Model":"inherit","Prompt":"Check the tests.","Role":"Test Worker","TypeName":"research"}]',
        toolAction: '"Launching subagent"',
      }),
    ).toEqual([{ role: "Test Worker", typeName: "research", prompt: "Check the tests." }]);
  });

  test("keeps the briefs in the order they were listed", () => {
    const specs = parseInvokeSubagentSpecs({
      Subagents: '[{"Role":"First"},{"Role":"Second"},{"Role":"Third"}]',
    });
    expect(specs.map((spec) => spec.role)).toEqual(["First", "Second", "Third"]);
  });

  test("reports a real model but never the inherit sentinel", () => {
    expect(parseInvokeSubagentSpecs({ Subagents: '[{"Model":"Gemini 3.5 Pro"}]' })[0]?.model).toBe(
      "Gemini 3.5 Pro",
    );
    expect(parseInvokeSubagentSpecs({ Subagents: '[{"Model":"inherit"}]' })[0]?.model).toBeUndefined();
  });

  test("yields nothing for arguments that carry no subagents", () => {
    expect(parseInvokeSubagentSpecs({ Action: '"list"' })).toEqual([]);
    expect(parseInvokeSubagentSpecs({ Subagents: "not json" })).toEqual([]);
    expect(parseInvokeSubagentSpecs(undefined)).toEqual([]);
  });
});

describe("parseCreatedSubagents", () => {
  const result = `Created At: 2026-08-23T17:03:51Z
Completed At: 2026-08-23T17:03:51Z
Created the following subagents:
{
  "conversationId":  "6e68327d-350b-4f3a-997e-bd90676f4e48",
  "logAbsoluteUri":  "file:///home/agy/brain/6e68327d-350b-4f3a-997e-bd90676f4e48/logs/transcript.jsonl",
  "workspaceUris":  [
    "file:///home/dev/kone"
  ]
}
{
  "conversationId":  "32163a48-717a-4a2f-87e3-13175696aa04",
  "logAbsoluteUri":  "file:///home/agy/brain/32163a48-717a-4a2f-87e3-13175696aa04/logs/transcript.jsonl",
  "workspaceUris":  []
}
The subagents will send you a message when they have completed their task.`;

  test("reads every child, in order, with its transcript path", () => {
    expect(parseCreatedSubagents(result)).toEqual([
      {
        conversationId: "6e68327d-350b-4f3a-997e-bd90676f4e48",
        transcriptPath: "/home/agy/brain/6e68327d-350b-4f3a-997e-bd90676f4e48/logs/transcript.jsonl",
      },
      {
        conversationId: "32163a48-717a-4a2f-87e3-13175696aa04",
        transcriptPath: "/home/agy/brain/32163a48-717a-4a2f-87e3-13175696aa04/logs/transcript.jsonl",
      },
    ]);
  });

  test("ignores a step that is not a subagent result", () => {
    expect(parseCreatedSubagents('{"conversationId": "not-a-spawn"}')).toEqual([]);
    expect(parseCreatedSubagents(undefined)).toEqual([]);
  });
});

describe("parseInboundMessage", () => {
  const wrap = (line: string) =>
    `The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n${line}\n</SYSTEM_MESSAGE>`;

  test("reads a child's report and who sent it", () => {
    expect(
      parseInboundMessage(
        wrap(
          "[Message] timestamp=2026-08-23T17:09:49Z sender=3b365af8-2ca9-4412-b08f-f3684112ffb0 priority=MESSAGE_PRIORITY_HIGH content=Ran the suite: 982 pass.",
        ),
      ),
    ).toEqual({ sender: "3b365af8-2ca9-4412-b08f-f3684112ffb0", content: "Ran the suite: 982 pass." });
  });

  test("keeps a multi-line report whole", () => {
    expect(
      parseInboundMessage(
        wrap("[Message] sender=child-1 priority=MESSAGE_PRIORITY_HIGH content=# Report\n\n- one\n- two"),
      )?.content,
    ).toBe("# Report\n\n- one\n- two");
  });

  test("passes over the CLI talking about itself", () => {
    expect(
      parseInboundMessage(
        wrap(
          "[Message] timestamp=2026-08-23T17:03:46Z sender=system priority=MESSAGE_PRIORITY_LOW content=[Notice] All your subagents have been stopped.",
        ),
      ),
    ).toBeUndefined();
    expect(parseInboundMessage("a plain step with no message in it")).toBeUndefined();
  });
});
