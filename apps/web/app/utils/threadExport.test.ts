import { describe, expect, test } from "bun:test";

import type { ThreadExportOutcome } from "~/types/desktop";
import {
  exportFailureMessage,
  exportFileBasename,
  formatExportBytes,
  THREAD_EXPORT_FORMAT_LABELS,
  THREAD_EXPORT_FORMATS,
  threadExportExtension,
  threadExportFilename,
} from "./threadExport";

describe("threadExportFilename", () => {
  test("slugs the title and wears the format extension", () => {
    expect(threadExportFilename("How do I reverse a list?", "thread-abc123", "markdown")).toBe(
      "how-do-i-reverse-a-list.md",
    );
    expect(threadExportFilename("How do I reverse a list?", "thread-abc123", "json")).toBe(
      "how-do-i-reverse-a-list.json",
    );
  });

  test("an empty title falls back to the thread id", () => {
    expect(threadExportFilename("", "thread-abc123", "markdown")).toBe("thread-thread-a.md");
    expect(threadExportFilename(null, "thread-abc123", "json")).toBe("thread-thread-a.json");
    expect(threadExportFilename("!!!", "thread-abc123", "markdown")).toBe("thread-thread-a.md");
  });

  test("long titles truncate without a trailing dash, and never carry a path", () => {
    const name = threadExportFilename(`${"a".repeat(200)}`, "thread-abc123", "markdown");
    expect(name).toBe(`${"a".repeat(60)}.md`);
    expect(name.includes("/")).toBe(false);
    expect(threadExportFilename("../escape attempt", "thread-abc123", "markdown")).toBe(
      "escape-attempt.md",
    );
  });
});

describe("threadExportExtension", () => {
  test("markdown suggests md, json suggests json", () => {
    expect(threadExportExtension("markdown")).toBe("md");
    expect(threadExportExtension("json")).toBe("json");
  });
});

describe("export format choice", () => {
  test("offers markdown first, with finished labels", () => {
    expect([...THREAD_EXPORT_FORMATS]).toEqual(["markdown", "json"]);
    expect(THREAD_EXPORT_FORMAT_LABELS.markdown).toBe("Markdown");
    expect(THREAD_EXPORT_FORMAT_LABELS.json).toBe("JSON");
  });
});

describe("exportFailureMessage", () => {
  test("success carries nothing to explain", () => {
    const outcome: ThreadExportOutcome = {
      ok: true,
      path: "/tmp/a.md",
      bytes: 12,
      format: "markdown",
    };
    expect(exportFailureMessage(outcome)).toBeNull();
  });

  test("blocked threads read in the shared predicate's own words", () => {
    expect(
      exportFailureMessage({ ok: false, reason: "no-completed-turns", message: "stale" }),
    ).toBe("Nothing to export yet: this thread has no completed turns.");
    expect(
      exportFailureMessage({ ok: false, reason: "thread-running", message: "stale" }),
    ).toBe(
      "Thread is still running: wait for the current turn to finish before exporting.",
    );
    expect(
      exportFailureMessage({ ok: false, reason: "thread-not-found", message: "stale" }),
    ).toBe("Thread not found: it may have been deleted.");
  });

  test("write failures stand as the backend wrote them", () => {
    expect(
      exportFailureMessage({ ok: false, reason: "write-failed", message: "Could not write the export: EACCES" }),
    ).toBe("Could not write the export: EACCES");
  });
});

describe("formatExportBytes", () => {
  test("bytes stay bare, kilobytes take one decimal", () => {
    expect(formatExportBytes(0)).toBe("0 B");
    expect(formatExportBytes(512)).toBe("512 B");
    expect(formatExportBytes(2048)).toBe("2.0 KB");
    expect(formatExportBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  test("the unknowable reads as zero, never blank", () => {
    expect(formatExportBytes(Number.NaN)).toBe("0 B");
    expect(formatExportBytes(-1)).toBe("0 B");
  });
});

describe("exportFileBasename", () => {
  test("keeps the last segment on either separator", () => {
    expect(exportFileBasename("/Users/a/thread-one.md")).toBe("thread-one.md");
    expect(exportFileBasename("C:\\Users\\a\\thread-one.json")).toBe("thread-one.json");
    expect(exportFileBasename("thread-one.md")).toBe("thread-one.md");
  });
});
