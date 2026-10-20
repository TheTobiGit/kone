import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { clampVisualHeight } from "@kone/protocol/visual-render";
import { getAttachmentStore } from "../../AttachmentStore.js";
import type { UserQuestionReply, UserQuestionRequest } from "../../userQuestionRequests.js";
import {
  CLAUDE_NATIVE_IMAGE_MIME_TYPES,
  MAX_IMAGE_ATTACHMENT_BYTES,
  type ChatAttachment,
  type QuestionVisual,
  type UploadAttachmentInput,
  type UserInputAnswerAttachments,
  type UserInputAnswers,
  type UserInputQuestion,
} from "../../types.js";
import {
  GatewayToolError,
  VISUAL_SHOW_JSON_SCHEMA,
  VisualShowInputSchema,
  type GatewayToolContent,
  type VisualShowInput,
} from "../schemas.js";
import type { GatewayToolContext, ToolEntry } from "../schemas.js";
import {
  IMAGE_MIME_BY_EXT,
  inlineLocalImages,
  MEASURE_BUDGET_MS,
  measureWithin,
  visualFileName,
  type VisualMeasurer,
} from "./visual.js";

export type AskUser = (request: UserQuestionRequest) => Promise<UserQuestionReply>;

/** Question images and the visual an agent may attach need somewhere to live,
 *  and a measurement to reserve their height; both are the same store and
 *  measurer the visual tools use. */
export interface QuestionToolOptions {
  saveAttachment: (input: UploadAttachmentInput) => Promise<ChatAttachment>;
  measure?: VisualMeasurer;
  measureBudgetMs?: number;
  /** Where an answered attachment lives on disk — the store by default, a
   *  fake in tests. */
  resolveAttachmentPath?: (id: string) => string | null;
  /** An answered attachment's bytes, for the image blocks a vision model reads
   *  natively — the store by default. */
  readAttachmentBytes?: (id: string) => Promise<Buffer | null>;
}

/** At most this many images per question. A dialog is a decision, not a
 *  gallery. */
const MAX_QUESTION_IMAGES = 4;

/** Fields a question visual shares with `visual_show`, so the two cannot drift:
 *  the same html/title/height rules, limits included. */
const questionVisual = VisualShowInputSchema;

const option = z.union([
  z.string().trim().min(1).transform((label) => ({ label })),
  z.object({ label: z.string().trim().min(1), description: z.string().optional() }),
]);
const question = z.object({
  question: z.string().trim().min(1),
  header: z.string().trim().min(1).optional(),
  options: z.array(option).optional(),
  multiSelect: z.boolean().optional(),
  images: z.array(z.string().trim().min(1)).max(MAX_QUESTION_IMAGES).optional(),
  visual: questionVisual.optional(),
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

/** Read one local image an agent named, ready to store. The path is checked
 *  before anything is asked: a question that promises a screenshot nobody can
 *  see is worse than a tool call that fails here. */
async function readQuestionImage(file: string, threadId: string): Promise<UploadAttachmentInput> {
  const mimeType = IMAGE_MIME_BY_EXT[path.extname(file).toLowerCase()];
  if (!mimeType) {
    throw new GatewayToolError(
      "invalid_input",
      `${file} is not an image: a question image must end in ${Object.keys(IMAGE_MIME_BY_EXT).join(", ")}.`,
    );
  }
  if (!path.isAbsolute(file)) {
    throw new GatewayToolError("invalid_input", `${file} is not an absolute path. Name the image by its full path.`);
  }
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) {
    throw new GatewayToolError("invalid_input", `No image file at ${file}. Check the path.`);
  }
  if (info.size > MAX_IMAGE_ATTACHMENT_BYTES) {
    throw new GatewayToolError(
      "invalid_input",
      `${file} is ${Math.ceil(info.size / (1024 * 1024))} MB; a question image can be at most ${MAX_IMAGE_ATTACHMENT_BYTES / (1024 * 1024)} MB. Scale it down or crop it first.`,
    );
  }
  const data = await readFile(file).catch(() => null);
  if (!data) throw new GatewayToolError("invalid_input", `Could not read ${file}.`);
  return { threadId, name: path.basename(file), mimeType, data: data.toString("base64") };
}

/** A question's visual, ready to store: the upload, and the record it becomes
 *  once stored, short of the attachment id. */
type PreparedVisual = { upload: UploadAttachmentInput; record: Omit<QuestionVisual, "attachmentId"> };

/** Prepare a question's visual exactly as `visual_show` would: local images
 *  embedded and measured within the budget. The record rides the question, not
 *  the reply, so nothing is emitted for it. */
async function prepareQuestionVisual(
  ctx: GatewayToolContext,
  visual: VisualShowInput,
  options: QuestionToolOptions,
): Promise<PreparedVisual> {
  const { html, missing } = await inlineLocalImages(visual.html);
  if (missing.length) {
    throw new GatewayToolError(
      "invalid_input",
      `No file at: ${missing.join(", ")}. Fix or remove those image paths, then attach the visual again.`,
    );
  }
  const heights = await measureWithin(
    options.measure,
    html,
    options.measureBudgetMs ?? MEASURE_BUDGET_MS,
    ctx.signal,
  );
  const record: PreparedVisual["record"] = { title: visual.title, height: clampVisualHeight(visual.height) };
  if (heights) record.heights = heights;
  return {
    upload: {
      threadId: ctx.threadId,
      name: visualFileName(visual.title),
      mimeType: "text/html",
      data: Buffer.from(html, "utf8").toString("base64"),
    },
    record,
  };
}

/** One answer's attachments as the result lists them: name, type, and where the
 *  agent can read the file itself. */
type AnswerAttachment = { name: string; mimeType: string; path: string };

/** One question's entry in the result. */
type AnswerResult = { question: string; answer: Answer; attachments?: AnswerAttachment[] };

export function createQuestionTools(askUser?: AskUser, options?: QuestionToolOptions): ToolEntry[] {
  return [{
    name: "ask_question",
    description: "Ask the user one to four questions in Kone's question dialog and wait for their answers. The answers return as this tool's result, so you can continue in the same turn. Each question is single-select by default; set multiSelect to let the user pick several. Options may be strings or label/description objects, and the user can always type their own answer instead; omit options for a free-text question. When seeing the choices helps the user decide — design variants side by side, a chart of tradeoffs — a question may carry images (absolute paths to local image files, at most 4) or one live visual (self-contained HTML). The user may answer with images or files of their own: the result lists each one's name, type and path, and images are shown to you when your model can see them. In the result, a multiSelect answer is a list of strings, any other answer is a string, and an unanswered question is null. `declined: true` means the user dismissed the dialog: do not ask the same thing again, carry on or say what you need. Do not repeat the question in assistant prose.",
    promptSnippet: "Ask the user in a dialog (single-select, multi-select, or free text); their answers return as this tool's result in the same turn. A question can carry images or a visual, and the user can answer with files.",
    promptGuidelines: [
      "When you need the user to decide or tell you something before you can go on, use kone's `ask_question`: it works the same in every provider, and its answers return as the tool result in the same turn. Prefer it over provider-specific question tools, do not also write the question in your reply, and never ask the user to answer in a new message.",
      "When the choice is easier to see than to read — design variants side by side, a chart of tradeoffs, a screenshot of the state in question — attach images by absolute path or one visual (checked with visual_preview first) to the `ask_question` question. The user can attach images or files to their answer; the result names each with a path, and images come back for you to look at.",
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
              images: {
                type: "array", maxItems: MAX_QUESTION_IMAGES, items: { type: "string" },
                description: "Absolute paths to local image files shown with the question, at most 4. Use them when seeing the options decides faster: design variants, a screenshot of the state, a chart.",
              },
              visual: {
                ...VISUAL_SHOW_JSON_SCHEMA,
                description: "One live visual shown with the question, for choices that are easier to see than to read. Check it with visual_preview first.",
              },
            },
          },
        },
      },
    },
    async handler(ctx, raw) {
      if (!askUser || !ctx.turnId) throw new GatewayToolError("capability_denied", "No live question handler is available.");
      const input = inputSchema.parse(raw);
      const save = options?.saveAttachment;
      const wantsFiles = input.questions.some((q) => q.images?.length || q.visual);
      if (wantsFiles && !save) {
        throw new GatewayToolError("capability_denied", "This kone cannot attach images or visuals to a question.");
      }
      // Every question's media is read and checked before any of it is stored:
      // a call that fails on its third image leaves no files behind for the
      // first two, which no dialog or history would ever reach. A call with no
      // media opens its dialog without waiting on anything.
      const prepared = wantsFiles
        ? await Promise.all(input.questions.map(async (q) => ({
          images: await Promise.all((q.images ?? []).map((file) => readQuestionImage(file, ctx.threadId))),
          visual: q.visual ? await prepareQuestionVisual(ctx, q.visual, options!) : undefined,
        })))
        : [];
      const questions: UserInputQuestion[] = [];
      for (const [index, q] of input.questions.entries()) {
        const built: UserInputQuestion = {
          id: `q${index}`, question: q.question, header: q.header ?? "Question",
          options: q.options ?? [],
          multiSelect: q.multiSelect ?? false,
        };
        const media = prepared[index];
        if (!media) {
          questions.push(built);
          continue;
        }
        if (media.images.length) {
          built.images = [];
          for (const upload of media.images) built.images.push(await save!(upload));
        }
        if (media.visual) {
          const saved = await save!(media.visual.upload);
          built.visual = { attachmentId: saved.id, ...media.visual.record };
        }
        questions.push(built);
      }
      const reply = await askUser({ ...ctx, turnId: ctx.turnId, questions });
      const answerAttachments: UserInputAnswerAttachments = reply.attachments ?? {};
      const resolvePath =
        options?.resolveAttachmentPath ?? ((id: string) => getAttachmentStore().resolveAbsPath(id));
      const readBytes =
        options?.readAttachmentBytes ?? ((id: string) => getAttachmentStore().readBytes(id));
      const results = questions.map((q) => {
        const files = answerAttachments[q.id] ?? [];
        const result: AnswerResult = {
          question: q.question,
          answer: normalizeAnswer(q, reply.answers[q.id]),
        };
        if (files.length > 0) {
          result.attachments = files.map((file) => ({
            name: file.name,
            mimeType: file.mimeType,
            path: resolvePath(file.id) ?? file.id,
          }));
        }
        return result;
      });
      // A dismissed dialog (or a turn that ended under it) answers nothing at
      // all. An answer carrying only files still counts: the user did reply.
      const declined = results.every((result) => result.answer === null && !result.attachments?.length);
      const result = declined ? { declined: true, answers: results } : { answers: results };
      const content: GatewayToolContent[] = [{ type: "text", text: JSON.stringify(result) }];
      // The JSON names every file by path; a vision model also gets the images
      // themselves, as blocks it can look at, each led by the question it
      // answers so several questions' images never blur together.
      for (const q of questions) {
        for (const file of answerAttachments[q.id] ?? []) {
          if (!CLAUDE_NATIVE_IMAGE_MIME_TYPES.has(file.mimeType)) continue;
          const bytes = await readBytes(file.id);
          if (!bytes) continue;
          content.push({ type: "text", text: `Image ${JSON.stringify(file.name)}, attached to the answer to: ${q.question}` });
          content.push({ type: "image", data: bytes.toString("base64"), mimeType: file.mimeType });
        }
      }
      return { content };
    },
  }];
}
