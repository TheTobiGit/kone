import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  escapeCmdArgument,
  escapeCmdCommand,
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

/** A fresh directory under the test temp root: one PATH entry per test, so a
 *  shim in one test can never be found by another. */
function binDir(...parts: string[]): string {
  const dir = path.join(temp, ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A fake npm shim. The resolver only stats the file (an injected win32
 *  platform skips the executable bit), so plain text is enough. */
function shim(dir: string, name: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, "@echo off\r\n");
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

describe("Windows cmd.exe escaping", () => {
  test("an argument is quoted, then meta-escaped twice for a batch target", () => {
    // cross-spawn's lib/util/escape.js with doubleEscapeMetaChars: the
    // wrapping quotes are meta chars too, so they pick up a caret per pass —
    // and the second pass escapes the first pass's carets.
    expect(escapeCmdArgument("login", true)).toBe('^^^"login^^^"');
    expect(escapeCmdArgument("hello world", true)).toBe('^^^"hello^^^ world^^^"');
    expect(escapeCmdArgument('a"b', true)).toBe('^^^"a\\^^^"b^^^"');
    expect(escapeCmdArgument("a&b", true)).toBe('^^^"a^^^&b^^^"');
    expect(escapeCmdArgument("100%", true)).toBe('^^^"100^^^%^^^"');
    expect(escapeCmdArgument("a^b", true)).toBe('^^^"a^^^^b^^^"');
    expect(escapeCmdArgument("a!b", true)).toBe('^^^"a^^^!b^^^"');
    expect(escapeCmdArgument("(x)", true)).toBe('^^^"^^^(x^^^)^^^"');
    // Trailing backslashes are doubled so they can't escape the closing quote.
    expect(escapeCmdArgument("C:\\tmp\\", true)).toBe('^^^"C:\\tmp\\\\^^^"');
  });

  test("the script path only gets its meta chars escaped, never quoted", () => {
    expect(escapeCmdCommand("/tmp/Program Files/nodejs/codex.cmd")).toBe(
      "/tmp/Program^ Files/nodejs/codex.cmd",
    );
    expect(escapeCmdCommand("C:\\Program Files\\nodejs\\codex.cmd")).toBe(
      "C:\\Program^ Files\\nodejs\\codex.cmd",
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
    expect(launch.file).toBe(path.join(temp, "signin-codex"));
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
    expect(launch.file).toBe(path.join(bin, "cursor-agent"));
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
    expect(launch.file).toBe(path.join(bin, "claude"));
    expect(launch.args).toEqual(["auth", "login"]);
    expect(launch.command.display).toBe("claude auth login");
  });

  test("a .cmd shim is run through ComSpec with an escaped command line", () => {
    const dir = binDir("win-cmd");
    const file = shim(dir, "codex.cmd");

    const launch = resolveProviderSignInLaunch({
      provider: "codex",
      settings: {},
      env: { PATH: dir, ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      platform: "win32",
    });

    expect(launch.ok).toBe(true);
    if (!launch.ok) throw new Error(launch.message);
    // Spawned as cmd.exe + one pre-built command line, not as codex.cmd: a
    // batch file is not an executable CreateProcess can run.
    expect(launch.file).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(launch.args).toBe(`/d /s /c "${escapeCmdCommand(file)} ^^^"login^^^""`);
    expect(launch.args).toContain(file);
    // The display still names the provider's own binary, unescaped.
    expect(launch.command.display).toBe("codex login");
    expect(launch.banner).toContain("codex login");
  });

  test("a .bat shim gets the same cmd.exe treatment", () => {
    const dir = binDir("win-bat");
    const file = shim(dir, "codex.bat");

    const launch = resolveProviderSignInLaunch({
      provider: "codex",
      settings: {},
      env: { PATH: dir, ComSpec: "C:\\Windows\\cmd.exe" },
      platform: "win32",
    });

    expect(launch.ok).toBe(true);
    if (!launch.ok) throw new Error(launch.message);
    expect(launch.file).toBe("C:\\Windows\\cmd.exe");
    expect(launch.args).toBe(`/d /s /c "${escapeCmdCommand(file)} ^^^"login^^^""`);
  });

  test("a missing ComSpec falls back to cmd.exe", () => {
    const dir = binDir("win-no-comspec");
    shim(dir, "codex.cmd");

    const launch = resolveProviderSignInLaunch({
      provider: "codex",
      settings: {},
      env: { PATH: dir },
      platform: "win32",
    });

    expect(launch.ok).toBe(true);
    if (!launch.ok) throw new Error(launch.message);
    expect(launch.file).toBe("cmd.exe");
  });

  test("ComSpec is honoured whatever its key casing", () => {
    for (const [key, value] of [
      ["COMSPEC", "C:\\Upper\\cmd.exe"],
      ["comspec", "C:\\lower\\cmd.exe"],
    ] as const) {
      const dir = binDir(`win-comspec-${key}`);
      shim(dir, "codex.cmd");

      const launch = resolveProviderSignInLaunch({
        provider: "codex",
        settings: {},
        env: { PATH: dir, [key]: value },
        platform: "win32",
      });

      expect(launch.ok).toBe(true);
      if (!launch.ok) throw new Error(launch.message);
      expect(launch.file).toBe(value);
    }
  });

  test("a native .exe is spawned directly with the original argv", () => {
    const dir = binDir("win-exe");
    const file = shim(dir, "codex.exe");

    const launch = resolveProviderSignInLaunch({
      provider: "codex",
      settings: {},
      env: { PATH: dir, ComSpec: "C:\\Windows\\cmd.exe" },
      platform: "win32",
    });

    expect(launch.ok).toBe(true);
    if (!launch.ok) throw new Error(launch.message);
    expect(launch.file).toBe(file);
    expect(launch.args).toEqual(["login"]);
  });

  test("a shim under a path with spaces is caret-escaped in the command line", () => {
    const dir = binDir("win-spaces", "Program Files", "nodejs");
    const file = shim(dir, "codex.cmd");

    const launch = resolveProviderSignInLaunch({
      provider: "codex",
      settings: {},
      env: { PATH: `${temp};${dir}`, ComSpec: "C:\\Windows\\cmd.exe" },
      platform: "win32",
    });

    expect(launch.ok).toBe(true);
    if (!launch.ok) throw new Error(launch.message);
    expect(launch.args).toBe(`/d /s /c "${file.replace(/ /g, "^ ")} ^^^"login^^^""`);
    expect(launch.args).toContain("Program^ Files/nodejs");
  });

  test("non-Windows launches the resolved path with the original argv array", () => {
    const dir = binDir("linux-bin");
    const file = path.join(dir, "codex");
    writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const launch = resolveProviderSignInLaunch({
      provider: "codex",
      settings: {},
      env: { PATH: dir },
      platform: "linux",
    });

    expect(launch.ok).toBe(true);
    if (!launch.ok) throw new Error(launch.message);
    expect(launch.file).toBe(file);
    expect(launch.args).toEqual(["login"]);
    expect(Array.isArray(launch.args)).toBe(true);
  });

  // ── Windows launchability ────────────────────────────────────────────────
  // npm's cmd-shim writes three files per CLI side by side: `codex` (a POSIX
  // sh script), `codex.cmd` and `codex.ps1`. Only the .cmd is something
  // CreateProcess-through-cmd.exe can run; picking the extensionless script —
  // the first PATH match by name — passes validation on win32 (no X_OK there)
  // and then fails at spawn. These tests pin the PATHEXT walk that replaces
  // that first-match lookup.

  test("an npm project .bin sibling set resolves the .cmd shim, not the sh script", () => {
    const dir = binDir("win-npm-bin");
    shim(dir, "codex");
    const file = shim(dir, "codex.cmd");
    shim(dir, "codex.ps1");

    const launch = resolveProviderSignInLaunch({
      provider: "codex",
      settings: {},
      env: { PATH: dir, ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      platform: "win32",
    });

    expect(launch.ok).toBe(true);
    if (!launch.ok) throw new Error(launch.message);
    expect(launch.file).toBe("C:\\Windows\\System32\\cmd.exe");
    // Hand-derived literal, not built with the production escaping helpers:
    // this directory has no spaces, so escapeCmdCommand is identity, and
    // escapeCmdArgument("login", true) is ^^^"login^^^" (the wrapping quotes
    // pick up one caret per pass, and the second pass escapes the first's).
    expect(launch.args).toBe(`/d /s /c "${file} ^^^"login^^^""`);
  });

  test("a global npm AppData\\Roaming\\npm sibling set resolves the .cmd shim", () => {
    const dir = binDir("win-appdata", "AppData", "Roaming", "npm");
    const file = shim(dir, "codex.cmd");
    shim(dir, "codex");
    shim(dir, "codex.ps1");

    const launch = resolveProviderSignInLaunch({
      provider: "codex",
      settings: {},
      env: { PATH: dir, ComSpec: "C:\\Windows\\cmd.exe" },
      platform: "win32",
    });

    expect(launch.ok).toBe(true);
    if (!launch.ok) throw new Error(launch.message);
    expect(launch.file).toBe("C:\\Windows\\cmd.exe");
    expect(launch.args).toBe(`/d /s /c "${escapeCmdCommand(file)} ^^^"login^^^""`);
    expect(launch.args).toContain(dir);
  });

  test(".EXE wins over .CMD in one directory and is spawned directly", () => {
    const dir = binDir("win-pathext-order");
    shim(dir, "codex.cmd");
    const exe = shim(dir, "codex.exe");

    const launch = resolveProviderSignInLaunch({
      provider: "codex",
      settings: {},
      env: { PATH: dir, ComSpec: "C:\\Windows\\cmd.exe" },
      platform: "win32",
    });

    expect(launch.ok).toBe(true);
    if (!launch.ok) throw new Error(launch.message);
    expect(launch.file).toBe(exe);
    expect(launch.args).toEqual(["login"]);
  });

  test("a PATHEXT the user reordered picks the .cmd, under any key casing", () => {
    const dir = binDir("win-pathext-custom");
    const cmd = shim(dir, "codex.cmd");
    shim(dir, "codex.exe");

    for (const [key, value] of [
      ["PathExt", ".CMD;.EXE"],
      ["PATHEXT", ".CMD;.EXE"],
      ["pathext", ".CMD;.EXE"],
    ] as const) {
      const launch = resolveProviderSignInLaunch({
        provider: "codex",
        settings: {},
        env: { PATH: dir, ComSpec: "C:\\Windows\\cmd.exe", [key]: value },
        platform: "win32",
      });

      expect(launch.ok).toBe(true);
      if (!launch.ok) throw new Error(launch.message);
      expect(launch.file).toBe("C:\\Windows\\cmd.exe");
      expect(launch.args).toBe(`/d /s /c "${escapeCmdCommand(cmd)} ^^^"login^^^""`);
    }
  });

  test("only an extensionless sh script (or a .ps1) on PATH is a clear sentence", () => {
    const bare = binDir("win-bare-shim");
    const bareFile = shim(bare, "codex");
    const bareLaunch = resolveProviderSignInLaunch({
      provider: "codex",
      settings: {},
      env: { PATH: bare, ComSpec: "C:\\Windows\\cmd.exe" },
      platform: "win32",
    });

    expect(bareLaunch).toMatchObject({ ok: false });
    if (bareLaunch.ok) throw new Error("expected a failure");
    expect(bareLaunch.message).toContain(bareFile);
    expect(bareLaunch.message).toContain("isn't something Windows can run");
    // The dialog can still show what it would have run.
    expect(bareLaunch.command?.display).toBe("codex login");

    const ps1 = binDir("win-ps1-shim");
    const ps1File = shim(ps1, "codex.ps1");
    const ps1Launch = resolveProviderSignInLaunch({
      provider: "codex",
      settings: {},
      env: { PATH: ps1, ComSpec: "C:\\Windows\\cmd.exe" },
      platform: "win32",
    });

    expect(ps1Launch).toMatchObject({ ok: false });
    if (ps1Launch.ok) throw new Error("expected a failure");
    expect(ps1Launch.message).toContain(ps1File);
    expect(ps1Launch.message).toContain("isn't something Windows can run");
  });

  test("an extensionless configured path resolves through PATHEXT to the .cmd", () => {
    const dir = binDir("win-explicit");
    const bare = shim(dir, "codex");
    const cmd = shim(dir, "codex.cmd");

    const launch = resolveProviderSignInLaunch({
      provider: "codex",
      settings: { codex: { binaryPath: bare } },
      env: { PATH: temp, ComSpec: "C:\\Windows\\cmd.exe" },
      platform: "win32",
    });

    expect(launch.ok).toBe(true);
    if (!launch.ok) throw new Error(launch.message);
    expect(launch.file).toBe("C:\\Windows\\cmd.exe");
    // Another hand-derived literal: no spaces in the temp path, so only the
    // argument needs escaping.
    expect(launch.args).toBe(`/d /s /c "${cmd} ^^^"login^^^""`);
  });

  test("a configured path Windows can't run says so instead of launching it", () => {
    const dir = binDir("win-explicit-bare");
    const bare = shim(dir, "codex");
    const launch = resolveProviderSignInLaunch({
      provider: "codex",
      settings: { codex: { binaryPath: bare } },
      env: { PATH: temp, ComSpec: "C:\\Windows\\cmd.exe" },
      platform: "win32",
    });

    expect(launch).toMatchObject({ ok: false });
    if (launch.ok) throw new Error("expected a failure");
    expect(launch.message).toContain(bare);
    expect(launch.message).toContain("isn't something Windows can run");

    // The same for a non-PATHEXT extension, while a path that exists nowhere
    // keeps the plain "doesn't exist" sentence.
    const ps1 = shim(dir, "codex.ps1");
    const ps1Launch = resolveProviderSignInLaunch({
      provider: "codex",
      settings: { codex: { binaryPath: ps1 } },
      env: { PATH: temp, ComSpec: "C:\\Windows\\cmd.exe" },
      platform: "win32",
    });
    expect(ps1Launch).toMatchObject({ ok: false });
    if (ps1Launch.ok) throw new Error("expected a failure");
    expect(ps1Launch.message).toContain(ps1);
    expect(ps1Launch.message).toContain("isn't something Windows can run");

    const nowhere = path.join(dir, "codex-nowhere");
    const nowhereLaunch = resolveProviderSignInLaunch({
      provider: "codex",
      settings: { codex: { binaryPath: nowhere } },
      env: { PATH: temp, ComSpec: "C:\\Windows\\cmd.exe" },
      platform: "win32",
    });
    expect(nowhereLaunch).toMatchObject({ ok: false, message: `${nowhere} doesn't exist.` });
  });

  test("non-Windows still takes the extensionless shim beside a .cmd sibling", () => {
    const dir = binDir("linux-with-cmd-sibling");
    const file = path.join(dir, "codex");
    writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    shim(dir, "codex.cmd");
    shim(dir, "codex.exe");

    const launch = resolveProviderSignInLaunch({
      provider: "codex",
      settings: {},
      env: { PATH: dir },
      platform: "linux",
    });

    expect(launch.ok).toBe(true);
    if (!launch.ok) throw new Error(launch.message);
    expect(launch.file).toBe(file);
    expect(launch.args).toEqual(["login"]);
  });

  test("non-Windows still enforces the executable bit", () => {
    // The win32 branch has no X_OK to check (Windows has no executable bit),
    // so this pins that the PATHEXT work did not leak into the POSIX path.
    const dir = binDir("linux-not-executable");
    writeFileSync(path.join(dir, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });

    const launch = resolveProviderSignInLaunch({
      provider: "codex",
      settings: {},
      env: { PATH: dir },
      platform: "linux",
    });

    expect(launch).toMatchObject({ ok: false, message: "codex isn't executable." });
  });
});
