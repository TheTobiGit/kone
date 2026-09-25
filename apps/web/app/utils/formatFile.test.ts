import { describe, expect, test } from "bun:test";
import { formatFileSize } from "./formatFile";

describe("formatFileSize", () => {
  test("bytes stay bytes", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(512)).toBe("512 B");
  });

  test("kilobytes keep one decimal under 10", () => {
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(10240)).toBe("10 KB");
  });

  test("megabytes keep one decimal under 10", () => {
    expect(formatFileSize(1572864)).toBe("1.5 MB");
    expect(formatFileSize(10485760)).toBe("10 MB");
  });
});
