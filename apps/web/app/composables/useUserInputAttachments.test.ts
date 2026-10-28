import { describe, expect, test } from "bun:test";

import type { ChatAttachment, UserInputQuestion } from "~/types/desktop";
import { USER_INPUT_ATTACHMENT_LIMIT } from "~/utils/userInputAnswers";
import { useUserInputAttachments } from "./useUserInputAttachments";

function question(id: string, patch: Partial<UserInputQuestion> = {}): UserInputQuestion {
  return { id, header: id, question: `Question ${id}?`, options: [], ...patch };
}

function attachment(id: string): ChatAttachment {
  return { type: "file", id, name: `${id}.txt`, mimeType: "text/plain", sizeBytes: 1 };
}

function answerFile(name: string): File {
  return new File([name], name, { type: "text/plain" });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("answer file uploads", () => {
  test("uploads each file independently per question", async () => {
    const first = deferred<ChatAttachment>();
    const second = deferred<ChatAttachment>();
    const seen: string[] = [];
    const { attachments, attachmentAnswers, uploadingAny, attachFiles } =
      useUserInputAttachments({
        upload: (file) => {
          seen.push(file.name);
          return file.name === "a.txt" ? first.promise : second.promise;
        },
      });

    attachFiles(question("q0"), [answerFile("a.txt")]);
    attachFiles(question("q1"), [answerFile("b.txt")]);
    expect(seen).toEqual(["a.txt", "b.txt"]);
    expect(uploadingAny.value).toBe(true);
    expect(attachmentAnswers.value).toEqual({});

    first.resolve(attachment("a"));
    await flush();
    expect(attachments.q0).toEqual([attachment("a")]);
    expect(attachments.q1).toBeUndefined();
    expect(attachmentAnswers.value).toEqual({ q0: [attachment("a")] });
    expect(uploadingAny.value).toBe(true);

    second.resolve(attachment("b"));
    await flush();
    expect(attachments.q1).toEqual([attachment("b")]);
    expect(attachmentAnswers.value).toEqual({
      q0: [attachment("a")],
      q1: [attachment("b")],
    });
    expect(uploadingAny.value).toBe(false);
  });

  test("counts in-flight rows against the dialog-wide cap and reopens it on removal", async () => {
    const uploads: string[] = [];
    const discarded: ChatAttachment[] = [];
    const { attachFiles, attachedTotal, attachments, removeAttachment, uploadErrors } =
      useUserInputAttachments({
        upload: async (file) => {
          uploads.push(file.name);
          return attachment(file.name.replace(".txt", ""));
        },
        discard: async (file) => {
          discarded.push(file);
        },
      });

    const overCap = Array.from({ length: USER_INPUT_ATTACHMENT_LIMIT + 2 }, (_, i) =>
      answerFile(`f${i}.txt`),
    );
    attachFiles(question("q0"), overCap);
    attachFiles(question("q1"), [answerFile("extra.txt")]);

    expect(uploads).toHaveLength(USER_INPUT_ATTACHMENT_LIMIT);
    expect(uploadErrors.q1).toBe(`You can attach up to ${USER_INPUT_ATTACHMENT_LIMIT} files.`);
    await flush();
    expect(attachedTotal.value).toBe(USER_INPUT_ATTACHMENT_LIMIT);

    removeAttachment("q0", attachments.q0![0]!.id);
    expect(discarded.map((file) => file.id)).toEqual(["f0"]);
    expect(attachedTotal.value).toBe(USER_INPUT_ATTACHMENT_LIMIT - 1);

    attachFiles(question("q1"), [answerFile("extra.txt")]);
    expect(uploadErrors.q1).toBeUndefined();
    expect(uploads).toHaveLength(USER_INPUT_ATTACHMENT_LIMIT + 1);
    await flush();
    expect(attachments.q1).toEqual([attachment("extra")]);
  });

  test("a failed row reports on its own question and leaves the others uploading", async () => {
    const good = deferred<ChatAttachment>();
    const bad = deferred<ChatAttachment>();
    const { attachFiles, attachments, uploadErrors } = useUserInputAttachments({
      upload: (file) => (file.name === "bad.txt" ? bad.promise : good.promise),
    });

    attachFiles(question("q0"), [answerFile("bad.txt")]);
    attachFiles(question("q1"), [answerFile("good.txt")]);
    bad.reject(new Error("disk full"));
    await flush();

    expect(uploadErrors.q0).toBe("disk full");
    expect(uploadErrors.q1).toBeUndefined();

    good.resolve(attachment("good"));
    await flush();
    expect(attachments.q1).toEqual([attachment("good")]);
  });
});

describe("answer file outcomes", () => {
  test("Cancel hands back landed files and a file that lands afterwards", async () => {
    const landed = deferred<ChatAttachment>();
    const late = deferred<ChatAttachment>();
    const discarded: ChatAttachment[] = [];
    const { attachments, attachFiles, discardAll, uploading } = useUserInputAttachments({
      upload: (file) => (file.name === "landed.txt" ? landed.promise : late.promise),
      discard: async (file) => {
        discarded.push(file);
      },
    });

    attachFiles(question("q0"), [answerFile("landed.txt")]);
    attachFiles(question("q1"), [answerFile("late.txt")]);
    landed.resolve(attachment("landed"));
    await flush();
    expect(attachments.q0).toEqual([attachment("landed")]);

    discardAll();
    expect(discarded.map((file) => file.id)).toEqual(["landed"]);
    expect(attachments.q0).toEqual([]);
    expect(uploading.q0).toEqual([]);

    late.resolve(attachment("late"));
    await flush();
    expect(discarded.map((file) => file.id)).toEqual(["landed", "late"]);
    expect(attachments.q1).toBeUndefined();
  });

  test("Send keeps landed files and still takes back a late landing", async () => {
    const landed = deferred<ChatAttachment>();
    const late = deferred<ChatAttachment>();
    const discarded: ChatAttachment[] = [];
    const { attachments, attachFiles, transferToAnswer, dispose } = useUserInputAttachments({
      upload: (file) => (file.name === "landed.txt" ? landed.promise : late.promise),
      discard: async (file) => {
        discarded.push(file);
      },
    });

    attachFiles(question("q0"), [answerFile("landed.txt")]);
    attachFiles(question("q1"), [answerFile("late.txt")]);
    landed.resolve(attachment("landed"));
    await flush();
    transferToAnswer();
    dispose();
    expect(discarded).toEqual([]);
    expect(attachments.q0).toEqual([attachment("landed")]);

    late.resolve(attachment("late"));
    await flush();
    expect(discarded.map((file) => file.id)).toEqual(["late"]);
    expect(attachments.q1).toBeUndefined();
  });

  test("unmounting without an outcome hands every landed file back", async () => {
    const first = deferred<ChatAttachment>();
    const second = deferred<ChatAttachment>();
    const discarded: ChatAttachment[] = [];
    const { attachments, attachFiles, dispose } = useUserInputAttachments({
      upload: (file) => (file.name === "a.txt" ? first.promise : second.promise),
      discard: async (file) => {
        discarded.push(file);
      },
    });

    attachFiles(question("q0"), [answerFile("a.txt"), answerFile("b.txt")]);
    first.resolve(attachment("a"));
    second.resolve(attachment("b"));
    await flush();

    dispose();
    expect(discarded.map((file) => file.id)).toEqual(["a", "b"]);
    expect(attachments.q0).toEqual([]);
  });

  test("removing a chip hands that file back and the outgoing map only names questions with files", async () => {
    const discarded: ChatAttachment[] = [];
    const { attachments, attachmentAnswers, attachFiles, hasAnswerAttachments, removeAttachment } =
      useUserInputAttachments({
        upload: async (file) => attachment(file.name.replace(".txt", "")),
        discard: async (file) => {
          discarded.push(file);
        },
      });

    attachFiles(question("q0"), [answerFile("a.txt")]);
    await flush();
    expect(attachmentAnswers.value).toEqual({ q0: [attachment("a")] });
    expect(hasAnswerAttachments.value).toBe(true);

    removeAttachment("q0", "a");
    expect(discarded.map((file) => file.id)).toEqual(["a"]);
    expect(attachments.q0).toEqual([]);
    expect(attachmentAnswers.value).toEqual({});
    expect(hasAnswerAttachments.value).toBe(false);
  });
});

describe("answer files that cannot be attached", () => {
  test("a fixed-choice question never starts an upload", async () => {
    const uploads: string[] = [];
    const { attachFiles, attachedTotal } = useUserInputAttachments({
      upload: async (file) => {
        uploads.push(file.name);
        return attachment(file.name);
      },
    });

    attachFiles(question("q0", { fixedChoice: true, options: [{ label: "Yes" }] }), [
      answerFile("a.txt"),
    ]);
    expect(uploads).toEqual([]);
    expect(attachedTotal.value).toBe(0);
  });

  test("a dialog without an uploader accepts nothing", () => {
    const { attachFiles, attachedTotal, uploadErrors } = useUserInputAttachments({});

    attachFiles(question("q0"), [answerFile("a.txt")]);
    expect(attachedTotal.value).toBe(0);
    expect(uploadErrors.q0).toBeUndefined();
  });
});
