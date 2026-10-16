import { describe, expect, test } from "bun:test";
import { repoImagePath } from "./markdownImageSource";

describe("repoImagePath", () => {
  test("resolves a relative src against the document's folder", () => {
    expect(repoImagePath("docs", "./img/shot.png")).toBe("docs/img/shot.png");
    expect(repoImagePath("", "logo.svg")).toBe("logo.svg");
    expect(repoImagePath("docs", "shot.png")).toBe("docs/shot.png");
  });

  test("a leading slash is repo-root relative, as GitHub reads it", () => {
    expect(repoImagePath("docs", "/assets/logo.png")).toBe("assets/logo.png");
  });

  test("`..` folds but never escapes the repo root", () => {
    expect(repoImagePath("docs/guide", "../img/a.png")).toBe("docs/img/a.png");
    expect(repoImagePath("", "../../secret.png")).toBeNull();
  });

  test("strips a query or fragment and decodes escapes", () => {
    expect(repoImagePath("", "logo.png?raw=true")).toBe("logo.png");
    expect(repoImagePath("", "my%20shot.png#top")).toBe("my shot.png");
  });

  test("remote, data, file and home paths are not repo files", () => {
    expect(repoImagePath("", "https://x/y.png")).toBeNull();
    expect(repoImagePath("", "data:image/png;base64,AAAA")).toBeNull();
    expect(repoImagePath("", "file:///tmp/a.png")).toBeNull();
    expect(repoImagePath("", "~/a.png")).toBeNull();
    expect(repoImagePath("", "//cdn.example/a.png")).toBeNull();
    expect(repoImagePath("", "C:/Users/me/a.png")).toBeNull();
  });
});
