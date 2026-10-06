import { z } from "zod";
import type { UserQuestionRequest } from "../../userQuestionRequests.js";
import type { UserInputAnswers, UserInputQuestion } from "../../types.js";
import { GatewayToolError, type ToolEntry } from "../schemas.js";

export type AskUser = (request: UserQuestionRequest) => Promise<UserInputAnswers>;

const option = z.union([
  z.string().trim().min(1).transform((label) => ({ label })),
  z.object({ label: z.string().trim().min(1), description: z.string().optional() }),
]);
const question = z.object({
  question: z.string().trim().min(1),
  header: z.string().trim().min(1).optional(),
  options: z.array(option).optional(),
  multiSelect: z.boolean().optional(),
});
const inputSchema = z.object({ questions: z.array(question).min(1).max(4) });

/** One answer as the tool result carries it: a list for multi-select, text for
 *  a single pick, a typed answer or free text, null when left unanswered. */
type Answer = string | string[] | null;

function normalizeAnswer(question: UserInputQuestion, raw: UserInputAnswers[string] | undefined): Answer {
  const values = (Array.isArray(raw) ? raw : raw == null ? [] : [raw])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (question.multiSelect) return values.length > 0 ? values : null;
  return values.length > 0 ? values.join(", ") : null;
}

export function createQuestionTools(askUser?: AskUser): ToolEntry[] {
  return [{
    name: "ask_question",
    description: "Ask the user one to four questions in Kone's question dialog and wait for their answers. The answers return as this tool's result, so you can continue in the same turn. Each question is single-select by default; set multiSelect to let the user pick several. Options may be strings or label/description objects, and the user can always type their own answer instead; omit options for a free-text question. In the result, a multiSelect answer is a list of strings, any other answer is a string, and an unanswered question is null. `declined: true` means the user dismissed the dialog: do not ask the same thing again, carry on or say what you need. Do not repeat the question in assistant prose.",
    promptSnippet: "Ask the user in a dialog (single-select, multi-select, or free text); their answers return as this tool's result in the same turn.",
    promptGuidelines: [
      "When you need the user to decide or tell you something before you can go on, use kone's `ask_question`: it works the same in every provider, and its answers return as the tool result in the same turn. Prefer it over provider-specific question tools, do not also write the question in your reply, and never ask the user to answer in a new message.",
    ],
    permission: "allow",
    requiresActiveTurn: true,
    inputSchema,
    jsonSchema: {
      type: "object",
      required: ["questions"],
      properties: {
        questions: {
          type: "array", minItems: 1, maxItems: 4,
          items: {
            type: "object", required: ["question"],
            properties: {
              question: { type: "string", minLength: 1 },
              header: { type: "string", description: "Short label shown above the question." },
              options: {
                type: "array",
                description: "Choices to pick from. Omit for a free-text answer; the user can always type their own answer instead.",
                items: { anyOf: [
                  { type: "string", minLength: 1 },
                  { type: "object", required: ["label"], properties: { label: { type: "string", minLength: 1 }, description: { type: "string" } } },
                ] },
              },
              multiSelect: { type: "boolean", description: "Let the user pick several options; the answer is then a list." },
            },
          },
        },
      },
    },
    async handler(ctx, raw) {
      if (!askUser || !ctx.turnId) throw new GatewayToolError("capability_denied", "No live question handler is available.");
      const input = inputSchema.parse(raw);
      const questions: UserInputQuestion[] = input.questions.map((q, index) => ({
        id: `q${index}`, question: q.question, header: q.header ?? "Question",
        options: q.options ?? [],
        multiSelect: q.multiSelect ?? false,
      }));
      const answers = await askUser({ ...ctx, turnId: ctx.turnId, questions });
      const results = questions.map((q) => ({ question: q.question, answer: normalizeAnswer(q, answers[q.id]) }));
      // A dismissed dialog (or a turn that ended under it) answers nothing at all.
      const declined = results.every((result) => result.answer === null);
      const result = declined ? { declined: true, answers: results } : { answers: results };
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  }];
}
