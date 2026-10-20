import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRegistry } from "../registry.js";
import { createQuestionTools, type QuestionToolOptions } from "./questions.js";
import type { GatewayToolContext } from "../schemas.js";
import { UserQuestionRequests } from "../../userQuestionRequests.js";
import type { ChatAttachment, RuntimeEvent, UserInputQuestion } from "../../types.js";

const ctx: GatewayToolContext = { threadId: "t", turnId: "turn", provider: "codex", cwd: "/tmp", requestId: 1 };

function harness() {
  const events: RuntimeEvent[] = [];
  const questions = new UserQuestionRequests((e) => events.push(e));
  const registry = createRegistry(createQuestionTools((r) => questions.ask(r)));
  const requested = () => {
    const event = events.find((e) => e.type === "user-input.requested");
    if (event?.type !== "user-input.requested") throw new Error("missing dialog request");
    return event;
  };
  return { events, questions, registry, requested };
}

test("every form's dialog answer becomes the awaited MCP tool result, without a follow-up send", async () => {
  const { events, questions, registry, requested } = harness();
  const result = registry.call(ctx, "ask_question", { questions: [
    { question: "Which color?", options: ["Blue", { label: "Green", description: "A second choice" }] },
    { question: "Which extras?", header: "Extras", options: ["Tests", "Docs", "Lint"], multiSelect: true },
    { question: "Which name?", options: ["Ada"] },
    { question: "Any details?" },
  ] });
  const event = requested();
  expect(event.questions.map((q) => [q.id, q.header, q.multiSelect])).toEqual([
    ["q0", "Question", false], ["q1", "Extras", true], ["q2", "Question", false], ["q3", "Question", false],
  ]);
  expect(event.questions[0]?.options).toEqual([{ label: "Blue" }, { label: "Green", description: "A second choice" }]);
  expect(event.questions[3]?.options).toEqual([]);
  // single pick, multi pick with a typed extra, typed custom value, free text
  questions.respond("t", event.requestId, { q0: "Green", q1: ["Tests", "Docs", " My own "], q2: "Grace", q3: "Keep it simple" });
  const reply = await result;
  expect(reply.isError).toBeUndefined();
  expect(JSON.parse(reply.content[0]!.text)).toEqual({ answers: [
    { question: "Which color?", answer: "Green" },
    { question: "Which extras?", answer: ["Tests", "Docs", "My own"] },
    { question: "Which name?", answer: "Grace" },
    { question: "Any details?", answer: "Keep it simple" },
  ] });
  expect(events.map((e) => e.type)).toEqual(["user-input.requested", "user-input.resolved"]);
  expect(registry.listTools("worker", "core").map((t) => t.name)).toContain("ask_question");
  expect(registry.listTools("assistant", "core").map((t) => t.name)).toContain("ask_question");
});

test("answers keep one shape per form whatever the dialog hands back", async () => {
  const { questions, registry, requested } = harness();
  const result = registry.call(ctx, "ask_question", { questions: [
    { question: "Pick several", options: ["A", "B"], multiSelect: true },
    { question: "Pick one", options: ["A", "B"] },
    { question: "Say something" },
  ] });
  questions.respond("t", requested().requestId, { q0: "A", q1: ["B"], q2: "   " });
  expect(JSON.parse((await result).content[0]!.text)).toEqual({ answers: [
    { question: "Pick several", answer: ["A"] },
    { question: "Pick one", answer: "B" },
    { question: "Say something", answer: null },
  ] });
});

test("a dismissed dialog returns a declined result, not an error", async () => {
  const { questions, registry, requested } = harness();
  const result = registry.call(ctx, "ask_question", { questions: [{ question: "Proceed?", options: ["Yes", "No"] }] });
  questions.respond("t", requested().requestId, {});
  const reply = await result;
  expect(reply.isError).toBeUndefined();
  expect(JSON.parse(reply.content[0]!.text)).toEqual({ declined: true, answers: [{ question: "Proceed?", answer: null }] });
});

test("a transport cancel closes the dialog and settles the call", async () => {
  const { events, registry, requested } = harness();
  const controller = new AbortController();
  const result = registry.call({ ...ctx, signal: controller.signal }, "ask_question", { questions: [{ question: "Wait?" }] });
  const { requestId } = requested();
  controller.abort();
  await result;
  const resolved = events.find((e) => e.type === "user-input.resolved");
  expect(resolved?.type === "user-input.resolved" && resolved.requestId).toBe(requestId);
});

test("the turn ending under an open question settles it as declined", async () => {
  const { questions, registry, requested } = harness();
  const result = registry.call(ctx, "ask_question", { questions: [{ question: "Still there?" }] });
  requested();
  questions.cancel("t", "turn");
  expect(JSON.parse((await result).content[0]!.text)).toEqual({ declined: true, answers: [{ question: "Still there?", answer: null }] });
});

test("invalid or idle calls never open a dialog", async () => {
  let calls = 0;
  const registry = createRegistry(createQuestionTools(async () => { calls++; return { answers: {} }; }));
  expect((await registry.call(ctx, "ask_question", { questions: [] })).isError).toBe(true);
  expect((await registry.call({ ...ctx, turnId: null }, "ask_question", { questions: [{ question: "Q?" }] })).isError).toBe(true);
  expect((await registry.call(ctx, "ask_question", { questions: [{ question: " " }] })).isError).toBe(true);
  expect(calls).toBe(0);
  expect((await createRegistry(createQuestionTools()).call(ctx, "ask_question", { questions: [{ question: "Q?" }] })).isError).toBe(true);
});

test("every session is told to ask through the tool, never by message", () => {
  const [tool] = createQuestionTools();
  expect(tool?.promptGuidelines?.join(" ")).toContain("`ask_question`");
  expect(tool?.promptGuidelines?.join(" ")).toContain("never ask the user to answer in a new message");
});

// ── images and a visual on the question, files on the answer ────────────────

function fakeOptions(overrides: Partial<QuestionToolOptions> = {}): QuestionToolOptions {
  let saved = 0;
  return {
    saveAttachment: async (upload) => {
      saved += 1;
      return {
        type: upload.mimeType.startsWith("image/") ? "image" : "file",
        id: `att_${saved}`,
        name: upload.name,
        mimeType: upload.mimeType,
        sizeBytes: Buffer.from(upload.data, "base64").length,
      };
    },
    ...overrides,
  };
}

test("a question's local images are stored and ride the question", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "kone-question-"));
  const file = path.join(dir, "before.png");
  await writeFile(file, Buffer.from([1, 2, 3]));
  let asked: UserInputQuestion[] = [];
  const registry = createRegistry(createQuestionTools(async (request) => {
    asked = request.questions;
    return { answers: { q0: "The first" } };
  }, fakeOptions()));
  const reply = await registry.call(ctx, "ask_question", { questions: [{ question: "Which layout?", images: [file] }] });
  expect(asked[0]?.images).toEqual([
    { type: "image", id: "att_1", name: "before.png", mimeType: "image/png", sizeBytes: 3 },
  ]);
  expect(JSON.parse(reply.content[0]!.text)).toEqual({ answers: [{ question: "Which layout?", answer: "The first" }] });
});

test("a question image that is missing, not an image, or unasked for fails before the dialog", async () => {
  let asked = 0;
  const ask = async () => { asked += 1; return { answers: {} }; };
  const dir = await mkdtemp(path.join(tmpdir(), "kone-question-"));
  const note = path.join(dir, "notes.txt");
  await writeFile(note, "not an image");
  const missing = path.join(dir, "missing.png");
  const registry = createRegistry(createQuestionTools(ask, fakeOptions()));
  for (const images of [[missing], [note]]) {
    const reply = await registry.call(ctx, "ask_question", { questions: [{ question: "Which?", images }] });
    expect(reply.isError).toBe(true);
    expect(reply.content[0]!.text).toContain(images[0]!);
  }
  expect(asked).toBe(0);
  const denied = await createRegistry(createQuestionTools(ask)).call(ctx, "ask_question", {
    questions: [{ question: "Which?", images: [note] }],
  });
  expect(denied.isError).toBe(true);
  expect(denied.content[0]!.text).toContain("capability_denied");
  expect(asked).toBe(0);
});

test("one bad file anywhere in the call stores none of the good ones", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "kone-question-"));
  const good = path.join(dir, "good.png");
  await writeFile(good, Buffer.from([1, 2, 3]));
  const missing = path.join(dir, "missing.png");
  let saved = 0;
  const options = fakeOptions();
  const save = options.saveAttachment;
  const registry = createRegistry(createQuestionTools(async () => ({ answers: {} }), {
    ...options,
    saveAttachment: async (upload) => { saved += 1; return save(upload); },
  }));
  for (const questions of [
    [{ question: "Which?", images: [good, missing] }],
    [{ question: "Which?", images: [good] }, { question: "And?", visual: { title: "Broken", html: `<img src="${missing}">`, height: 200 } }],
  ]) {
    const reply = await registry.call(ctx, "ask_question", { questions });
    expect(reply.isError).toBe(true);
  }
  expect(saved).toBe(0);
});

test("a question's visual is stored and measured like one visual_show shows", async () => {
  const heights: Array<[number, number]> = [[400, 300], [680, 280], [1140, 270]];
  let asked: UserInputQuestion[] = [];
  const registry = createRegistry(createQuestionTools(async (request) => {
    asked = request.questions;
    return { answers: { q0: "A" } };
  }, fakeOptions({ measure: async () => heights })));
  await registry.call(ctx, "ask_question", {
    questions: [{ question: "Which layout?", visual: { title: "Layouts", html: "<h1>Layouts</h1>", height: 9_999 } }],
  });
  expect(asked[0]?.visual).toEqual({
    attachmentId: "att_1",
    title: "Layouts",
    height: 2_000,
    heights,
  });
});

test("an answer's files come back with paths, images as blocks, and count as an answer", async () => {
  const image: ChatAttachment = { type: "image", id: "att_9", name: "shot.png", mimeType: "image/png", sizeBytes: 3 };
  const pdf: ChatAttachment = { type: "file", id: "att_10", name: "brief.pdf", mimeType: "application/pdf", sizeBytes: 5 };
  const registry = createRegistry(createQuestionTools(async () => ({
    answers: { q0: null },
    attachments: { q0: [image, pdf] },
  }), fakeOptions({
    resolveAttachmentPath: (id) => `/store/${id}.bin`,
    readAttachmentBytes: async (id) => (id === image.id ? Buffer.from([9, 8, 7]) : null),
  })));
  const reply = await registry.call(ctx, "ask_question", { questions: [{ question: "Which side is worse?" }] });
  expect(JSON.parse(reply.content[0]!.text)).toEqual({ answers: [{
    question: "Which side is worse?",
    answer: null,
    attachments: [
      { name: "shot.png", mimeType: "image/png", path: "/store/att_9.bin" },
      { name: "brief.pdf", mimeType: "application/pdf", path: "/store/att_10.bin" },
    ],
  }] });
  expect(reply.content[1]!.type).toBe("text");
  expect(reply.content[1]!.text).toContain("shot.png");
  expect(reply.content[2]).toEqual({ type: "image", data: Buffer.from([9, 8, 7]).toString("base64"), mimeType: "image/png" });
  expect(reply.content).toHaveLength(3);
});

test("a question's stored images and visual are discarded once the answer comes back", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "kone-question-"));
  const one = path.join(dir, "one.png");
  const two = path.join(dir, "two.png");
  await writeFile(one, Buffer.from([1]));
  await writeFile(two, Buffer.from([2]));
  const discarded: Array<[string, string]> = [];
  const registry = createRegistry(createQuestionTools(async () => ({ answers: { q0: "First" } }), fakeOptions({
    discardAttachment: async (id, threadId) => { discarded.push([id, threadId]); return true; },
  })));
  await registry.call(ctx, "ask_question", { questions: [
    { question: "Which?", images: [one, two] },
    { question: "Layout?", visual: { title: "Layouts", html: "<h1>Layouts</h1>", height: 200 } },
  ] });
  expect(discarded).toEqual([["att_1", "t"], ["att_2", "t"], ["att_3", "t"]]);
});

test("a declined or cancelled dialog discards the question's media too", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "kone-question-"));
  const file = path.join(dir, "shot.png");
  await writeFile(file, Buffer.from([1]));

  const declined: string[] = [];
  const declinedRegistry = createRegistry(createQuestionTools(async () => ({ answers: {} }), fakeOptions({
    discardAttachment: async (id) => { declined.push(id); return true; },
  })));
  await declinedRegistry.call(ctx, "ask_question", { questions: [{ question: "Which?", images: [file] }] });
  expect(declined).toEqual(["att_1"]);

  // A transport cancel settles the same way, with the same cleanup.
  const cancelled: string[] = [];
  const questions = new UserQuestionRequests(() => {});
  const registry = createRegistry(createQuestionTools(
    (request) => questions.ask(request),
    fakeOptions({ discardAttachment: async (id) => { cancelled.push(id); return true; } }),
  ));
  const controller = new AbortController();
  const result = registry.call(
    { ...ctx, signal: controller.signal },
    "ask_question",
    { questions: [{ question: "Wait?", images: [file] }] },
  );
  controller.abort();
  await result;
  expect(cancelled).toEqual(["att_1"]);
});

test("the user's answer files are never discarded with the question's media", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "kone-question-"));
  const file = path.join(dir, "shot.png");
  await writeFile(file, Buffer.from([1]));
  const answerFile: ChatAttachment = { type: "file", id: "att_answer", name: "brief.pdf", mimeType: "application/pdf", sizeBytes: 5 };
  const discarded: string[] = [];
  const registry = createRegistry(createQuestionTools(async () => ({
    answers: { q0: null },
    attachments: { q0: [answerFile] },
  }), fakeOptions({
    resolveAttachmentPath: (id) => `/store/${id}.bin`,
    readAttachmentBytes: async () => null,
    discardAttachment: async (id) => { discarded.push(id); return true; },
  })));
  await registry.call(ctx, "ask_question", { questions: [{ question: "Which?", images: [file] }] });
  expect(discarded).toEqual(["att_1"]);
});

test("a store failure partway through discards what was already saved", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "kone-question-"));
  const one = path.join(dir, "one.png");
  const two = path.join(dir, "two.png");
  await writeFile(one, Buffer.from([1]));
  await writeFile(two, Buffer.from([2]));
  const discarded: string[] = [];
  const options = fakeOptions({ discardAttachment: async (id) => { discarded.push(id); return true; } });
  const save = options.saveAttachment;
  let saved = 0;
  const registry = createRegistry(createQuestionTools(async () => ({ answers: {} }), {
    ...options,
    saveAttachment: async (upload) => {
      saved += 1;
      if (saved === 2) throw new Error("disk full");
      return save(upload);
    },
  }));
  const reply = await registry.call(ctx, "ask_question", { questions: [{ question: "Which?", images: [one, two] }] });
  expect(reply.isError).toBe(true);
  expect(discarded).toEqual(["att_1"]);
});
