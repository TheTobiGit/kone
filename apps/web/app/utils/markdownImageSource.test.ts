import { describe, expect, test } from "bun:test";
import { classifyImageSource, type ImageSource } from "./markdownImageSource";

const local = (path: string): ImageSource => ({ kind: "local", path });
const blocked: ImageSource = { kind: "blocked" };

describe("classifyImageSource", () => {
  test("web, data, blob and app schemes load as written", () => {
    for (const src of [
      "https://example.com/a.png",
      "data:image/png;base64,AAAA",
      "blob:app://kone/1234",
      "attachment://att_123/shot.png",
      "kone-page://abc/thumb.png",
      "HTTPS://EXAMPLE.COM/A.PNG",
    ]) {
      expect(classifyImageSource(src, "/proj")).toEqual({ kind: "direct", src });
    }
  });

  test("an absolute POSIX path is local, decoded", () => {
    expect(classifyImageSource("/tmp/foo.png")).toEqual(local("/tmp/foo.png"));
    expect(classifyImageSource("/tmp/my%20shot.png")).toEqual(local("/tmp/my shot.png"));
  });

  test("a Windows drive path is local", () => {
    expect(classifyImageSource("C:\\Users\\me\\shot.png")).toEqual(local("C:\\Users\\me\\shot.png"));
    expect(classifyImageSource("d:/shots/a%20b.png")).toEqual(local("d:/shots/a b.png"));
  });

  test("a file URL is decoded to its path", () => {
    expect(classifyImageSource("file:///tmp/foo%20bar.png")).toEqual(local("/tmp/foo bar.png"));
    expect(classifyImageSource("file://localhost/tmp/a.png")).toEqual(local("/tmp/a.png"));
    expect(classifyImageSource("FILE:///tmp/a.png")).toEqual(local("/tmp/a.png"));
    expect(classifyImageSource("file:///C:/Users/me/a.png")).toEqual(local("C:/Users/me/a.png"));
  });

  test("a file URL on another host, or naming no file, is blocked", () => {
    expect(classifyImageSource("file://server/share/a.png")).toEqual(blocked);
    expect(classifyImageSource("file:///")).toEqual(blocked);
  });

  test("a relative path joins the working directory", () => {
    expect(classifyImageSource("./x.png", "/proj")).toEqual(local("/proj/x.png"));
    expect(classifyImageSource("x.png", "/proj/")).toEqual(local("/proj/x.png"));
    expect(classifyImageSource("docs/../shots/x.png", "/proj")).toEqual(local("/proj/shots/x.png"));
    expect(classifyImageSource("../up.png", "/proj/app")).toEqual(local("/proj/up.png"));
    expect(classifyImageSource("a%20b.png", "/proj")).toEqual(local("/proj/a b.png"));
    expect(classifyImageSource(".\\x.png", "C:\\proj")).toEqual(local("C:\\proj\\x.png"));
  });

  test("a relative path with no working directory is blocked", () => {
    expect(classifyImageSource("./x.png")).toEqual(blocked);
    expect(classifyImageSource("x.png", null)).toEqual(blocked);
    expect(classifyImageSource("x.png", "")).toEqual(blocked);
  });

  test("home-relative, unknown schemes, fragments, queries and empties are blocked", () => {
    for (const src of [
      "~/Desktop/a.png",
      "~",
      "http://example.com/a.png",
      "javascript:alert(1)",
      "ftp://x/a.png",
      "#frag",
      "?q=1",
      "",
      "   ",
      "//example.com/a.png",
      "\\\\server\\share\\a.png",
    ]) {
      expect(classifyImageSource(src, "/proj")).toEqual(blocked);
    }
  });
});
