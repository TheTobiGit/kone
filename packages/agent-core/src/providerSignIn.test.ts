import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  formatLoginCommand,
  resolveProviderSignInCommand,
  resolveProviderSignInLaunch,
  shellQuote,
  shellQuoteExecutable,
} from "./providerSignIn.js";
import type { ProviderKind, ProviderSettingsMap } from "./types.js";

// These tests never spawn anything: the resolver is pure except for the
// executable lookup, which points at a temp dir. No real CLI is involved and no
// credential file is ever read.

const temp = mkdtempSync(path.join(os.tmpdir(), "kone-signin-test-"));

afterAll(() => {
  rmSync(temp, { recursive: true, force: true });
});

function executable(name: string): string {
  const file = path.join(temp, name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return file;
}

const settings = (binaryPath?: string): ProviderSettingsMap =>
  binaryPath ? { codex: { binaryPath } } : {};

const KINDS: ProviderKind[] = [
  "codex",
  "claudeAgent",
  "cursor",
  "opencode",
  "antigravity",
  "cline",
  "droid",
];

describe("resolveProviderSignInCommand", () => {
  test("each provider's own login subcommand and how it finishes", () => {
    const expected = {
      codex: { display: "codex login", finish: "browser" },
      claudeAgent: { display: "claude auth login", finish: "browser" },
      cursor: { display: "cursor-agent login", finish: "browser" },
      opencode: { display: "opencode auth login", finish: "terminal" },
      antigravity: { display: "agy login", finish: "browser" },
      cline: { display: "cline auth", finish: "browser" },
      droid: null,
    } satisfies Record<ProviderKind, { display: string; finish: "browser" | "terminal" } | null>;

    for (const provider of KINDS) {
      const spec = expected[provider];
      expect(resolveProviderSignInCommand(provider, {})).toEqual(
        spec === null
          ? null
          : {
              provider,
              display: spec.display,
              cwd: "~",
              finish: spec.finish,
            },
      );
    }
  });

  test("a configured executable is shown exactly as typed", () => {
    const command = resolveProviderSignInCommand("codex", settings("/opt/bin/codex"));
    expect(command?.display).toBe("/opt/bin/codex login");
    expect(command?.cwd).toBe("~");
  });

  test("without an override the provider's default binary is shown", () => {
    expect(resolveProviderSignInCommand("codex", {})?.display).toBe("codex login");
    expect(resolveProviderSignInCommand("cursor", {})?.display).toBe("cursor-agent login");
  });

  test("an ambiguous cursor override is normalized like the adapter normalizes it", () => {
    expect(
      resolveProviderSignInCommand("cursor", { cursor: { binaryPath: "cursor" } })?.display,
    ).toBe("cursor-agent login");
    expect(
      resolveProviderSignInCommand("cursor", { cursor: { binaryPath: "agent" } })?.display,
    ).toBe("cursor-agent login");
  });

  test("a configured executable with spaces is shell-quoted for display", () => {
    const command = resolveProviderSignInCommand("codex", settings("/opt/My Tools/codex"));
    expect(command?.display).toBe("'/opt/My Tools/codex' login");
  });

  test("the display line is platform-appropriate (PowerShell call operator)", () => {
    const command = resolveProviderSignInCommand(
      "codex",
      { codex: { binaryPath: "C:\\Program Files\\codex.exe" } },
      "win32",
    );
    expect(command?.display).toBe("& 'C:\\Program Files\\codex.exe' login");
  });

  test("droid has no login command", () => {
    expect(resolveProviderSignInCommand("droid", {})).toBeNull();
  });
});

describe("shellQuote", () => {
  test("simple words stay bare", () => {
    expect(shellQuote("login")).toBe("login");
    expect(shellQuote("cursor-agent")).toBe("cursor-agent");
    expect(shellQuote("/opt/bin/codex")).toBe("/opt/bin/codex");
  });

  test("POSIX spaces, quotes and expansion characters are single-quoted", () => {
    expect(shellQuote("/opt/My Tools/codex")).toBe("'/opt/My Tools/codex'");
    expect(shellQuote("/opt/a$b;c&(d)/codex")).toBe("'/opt/a$b;c&(d)/codex'");
    expect(shellQuote("/opt/$HOME/$(whoami)/codex")).toBe("'/opt/$HOME/$(whoami)/codex'");
    expect(shellQuote("/opt/`id`/codex")).toBe("'/opt/`id`/codex'");
    expect(shellQuote('/opt/a"b/codex')).toBe("'/opt/a\"b/codex'");
    // An embedded apostrophe closes the quote, escapes itself, reopens.
    expect(shellQuote("/opt/it's/codex")).toBe("'/opt/it'\\''s/codex'");
  });

  test("Windows/PowerShell uses single quotes and doubles apostrophes", () => {
    expect(shellQuote("C:\\Tools\\codex.exe", "win32")).toBe("C:\\Tools\\codex.exe");
    expect(shellQuote("C:\\My Tools\\codex.exe", "win32")).toBe("'C:\\My Tools\\codex.exe'");
    expect(shellQuote("C:\\$HOME\\codex.exe", "win32")).toBe("'C:\\$HOME\\codex.exe'");
    expect(shellQuote("C:\\a'b\\codex.exe", "win32")).toBe("'C:\\a''b\\codex.exe'");
    expect(shellQuote('C:\\a"b\\codex.exe', "win32")).toBe("'C:\\a\"b\\codex.exe'");
  });

  test("a quoted Windows executable gets PowerShell's call operator", () => {
    expect(shellQuoteExecutable("codex", "win32")).toBe("codex");
    expect(shellQuoteExecutable("C:\\Tools\\codex.exe", "win32")).toBe("C:\\Tools\\codex.exe");
    expect(shellQuoteExecutable("C:\\My Tools\\codex.exe", "win32")).toBe(
      "& 'C:\\My Tools\\codex.exe'",
    );
    // POSIX command position needs no operator.
    expect(shellQuoteExecutable("/opt/My Tools/codex", "linux")).toBe("'/opt/My Tools/codex'");
  });

  test("the copy line quotes the executable and every argument", () => {
    expect(formatLoginCommand("codex", ["login"], "linux")).toBe("codex login");
    expect(formatLoginCommand("C:\\Program Files\\codex.exe", ["login", "$x"], "win32")).toBe(
      "& 'C:\\Program Files\\codex.exe' login '$x'",
    );
  });
});

describe("resolveProviderSignInLaunch", () => {
  test("returns the binary, args, home cwd and display command", () => {
    executable("signin-codex");
    const launch = resolveProviderSignInLaunch({
      provider: "codex",
      settings: { codex: { binaryPath: "signin-codex" } },
      env: { PATH: temp },
    });

    expect(launch.ok).toBe(true);
    if (!launch.ok) throw new Error(launch.message);
    expect(launch.file).toBe("signin-codex");
    expect(launch.args).toEqual(["login"]);
    expect(launch.cwd).toBe(os.homedir());
    expect(launch.command.display).toBe("signin-codex login");
    expect(launch.env.PATH).toBe(temp);
    // The banner is resolved here, not assembled by the IPC handler, and shows
    // the dim cwd plus the command the CLI is about to run.
    expect(launch.banner).toBe(
      "\x1b[2m~\x1b[0m\r\n\x1b[32m❯\x1b[0m signin-codex login\r\n\r\n",
    );
  });

  test("a cursor override of `cursor` launches cursor-agent, not the editor", () => {
    const bin = path.join(temp, "cursor-bin");
    mkdirSync(bin, { recursive: true });
    const file = path.join(bin, "cursor-agent");
    writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const launch = resolveProviderSignInLaunch({
      provider: "cursor",
      settings: { cursor: { binaryPath: "cursor" } },
      env: { PATH: bin },
    });

    expect(launch.ok).toBe(true);
    if (!launch.ok) throw new Error(launch.message);
    expect(launch.file).toBe("cursor-agent");
    expect(launch.command.display).toBe("cursor-agent login");
  });

  test("an executable path with spaces is quoted for display but spawned directly", () => {
    const bin = path.join(temp, "My Tools");
    mkdirSync(bin, { recursive: true });
    const file = path.join(bin, "codex");
    writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const launch = resolveProviderSignInLaunch({
      provider: "codex",
      settings: { codex: { binaryPath: file } },
      env: { PATH: temp },
    });

    expect(launch.ok).toBe(true);
    if (!launch.ok) throw new Error(launch.message);
    // Spawning is filename + argv, never a shell line.
    expect(launch.file).toBe(file);
    expect(launch.args).toEqual(["login"]);
    // Display, copy text and the terminal banner get the shell-quoted form.
    expect(launch.command.display).toBe(`'${file}' login`);
    expect(launch.banner).toContain(`'${file}' login`);
  });

  test("a bare name that isn't on PATH is a sentence, not a throw", () => {
    const launch = resolveProviderSignInLaunch({
      provider: "cursor",
      settings: {},
      env: { PATH: "" },
    });
    expect(launch).toMatchObject({
      ok: false,
      command: { display: "cursor-agent login" },
      message: "cursor-agent isn't on your PATH.",
    });
  });

  test("an absolute override that doesn't exist names the path", () => {
    const missing = path.join(temp, "missing-codex");
    const launch = resolveProviderSignInLaunch({
      provider: "codex",
      settings: settings(missing),
      env: { PATH: temp },
    });
    expect(launch).toMatchObject({
      ok: false,
      command: { display: `${missing} login` },
      message: `${missing} doesn't exist.`,
    });
  });

  test("droid explains that it signs in on first run", () => {
    const launch = resolveProviderSignInLaunch({
      provider: "droid",
      settings: {},
      env: { PATH: temp },
    });
    expect(launch).toEqual({
      ok: false,
      command: null,
      message: "Droid signs in on its first run — it has no login command.",
    });
  });

  test("the login env carries no browser suppressor", () => {
    executable("signin-browser-codex");
    const launch = resolveProviderSignInLaunch({
      provider: "codex",
      settings: { codex: { binaryPath: "signin-browser-codex" } },
      env: {
        PATH: temp,
        NO_BROWSER: "true",
        BROWSER: "www-browser",
        CI: "true",
      },
    });

    expect(launch.ok).toBe(true);
    if (!launch.ok) throw new Error(launch.message);
    expect(launch.env.NO_BROWSER).toBeUndefined();
    expect(launch.env.BROWSER).toBeUndefined();
    // CI is not a browser suppressor, but the resolver doesn't invent one
    // either — whatever the caller's env said is inherited as-is.
    expect(launch.env.CI).toBe("true");
  });

  test("a real user BROWSER value is left alone", () => {
    executable("signin-real-browser-codex");
    const launch = resolveProviderSignInLaunch({
      provider: "codex",
      settings: { codex: { binaryPath: "signin-real-browser-codex" } },
      env: { PATH: temp, BROWSER: "firefox" },
    });
    expect(launch.ok).toBe(true);
    if (!launch.ok) throw new Error(launch.message);
    expect(launch.env.BROWSER).toBe("firefox");
  });

  test("claude falls back to the claude on PATH when the resolved entry is a JS file", () => {
    const js = path.join(temp, "claude-cli.js");
    writeFileSync(js, "", { mode: 0o755 });
    const bin = path.join(temp, "bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(js, path.join(bin, "claude"));

    const launch = resolveProviderSignInLaunch({
      provider: "claudeAgent",
      settings: {},
      env: { PATH: bin, HOME: temp },
    });

    expect(launch.ok).toBe(true);
    if (!launch.ok) throw new Error(launch.message);
    expect(launch.file).toBe("claude");
    expect(launch.args).toEqual(["auth", "login"]);
    expect(launch.command.display).toBe("claude auth login");
  });
});
