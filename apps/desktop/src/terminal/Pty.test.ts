import { describe, expect, test } from "bun:test";

import { buildPtyEnv } from "./Pty.js";

// buildPtyEnv is the pure env-building half of spawnPty — no real shells are
// spawned here, just the scrub/merge/pin pipeline the PTY child inherits.

describe("buildPtyEnv", () => {
  test("blocklist keys are removed even when present in the base env", () => {
    const env = buildPtyEnv({
      TERM: "xterm-ghostty",
      COLORTERM: "ghostty",
      NO_COLOR: "1",
      ELECTRON_RUN_AS_NODE: "1",
      PORT: "3000",
      PATH: "/usr/bin",
    });
    expect(env.TERM).not.toBe("xterm-ghostty");
    expect(env.COLORTERM).not.toBe("ghostty");
    expect(env.NO_COLOR).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.PORT).toBeUndefined();
  });

  test("TERM and COLORTERM are pinned to the embedded terminal", () => {
    const env = buildPtyEnv({ PATH: "/usr/bin" });
    expect(env.TERM).toBe("xterm-256color");
    expect(env.COLORTERM).toBe("truecolor");
  });

  test("the pin wins over both the base env and the extra env", () => {
    const env = buildPtyEnv(
      { TERM: "xterm-ghostty", COLORTERM: "ghostty" },
      { TERM: "vt100", COLORTERM: "16color" },
    );
    expect(env.TERM).toBe("xterm-256color");
    expect(env.COLORTERM).toBe("truecolor");
  });

  test("extra env wins over the base env", () => {
    const env = buildPtyEnv(
      { LANG: "en_US.UTF-8", EDITOR: "vim" },
      { EDITOR: "code --wait" },
    );
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.EDITOR).toBe("code --wait");
  });

  test("arbitrary user vars pass through untouched", () => {
    const env = buildPtyEnv({
      PATH: "/opt/homebrew/bin:/usr/bin",
      TOOLCHAIN_DIR: "/opt/toolchain",
      TOOLCHAIN_VERSION: "1.2.3",
    });
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    expect(env.TOOLCHAIN_DIR).toBe("/opt/toolchain");
    expect(env.TOOLCHAIN_VERSION).toBe("1.2.3");
  });

  test("undefined base values are dropped, not carried as undefined keys", () => {
    const env = buildPtyEnv({ HOME: "/Users/me", FOO: undefined });
    expect(env.HOME).toBe("/Users/me");
    expect("FOO" in env).toBe(false);
  });
});
