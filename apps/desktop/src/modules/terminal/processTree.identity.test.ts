import { beforeEach, describe, expect, test } from "bun:test";

import {
  createProcessTreeKiller,
  parseProcessCommandMap,
  resetProcessTreeKillStateForTests,
  type ProcessChildrenMap,
  type ProcessTreeCapture,
  type ProcessTreeKiller,
  type TerminalKillSignal,
} from "./processTree.js";

// Deterministic fake-driven tests for the tree killer's identity guard and
// command parsing. No live processes here — the injected signalPid /
// readCurrentCommands fakes make the reuse logic testable without touching the
// host process table (that is processTree.test.ts's job).

/** A killer wired to recording fakes and the two recordings each test asserts
 *  on: every signalled pid + signal, and every pid list handed to the re-read. */
type FakeKiller = {
  killer: ProcessTreeKiller;
  signaled: Array<{ pid: number; signal: TerminalKillSignal }>;
  readPidLists: number[][];
};

/** Build a killer wired to recording fakes. `readCurrentCommands` is passed
 *  through so each test controls what the identity re-read returns; every
 *  signalled pid and every pid list handed to the re-read is recorded. */
function makeFakeKiller(
  readCurrentCommands: (pids: readonly number[]) => Map<number, string> | null,
): FakeKiller {
  const signaled: Array<{ pid: number; signal: TerminalKillSignal }> = [];
  const readPidLists: number[][] = [];
  const killer = createProcessTreeKiller({
    captureChildrenMap: (): ProcessChildrenMap => new Map(),
    readCurrentCommands: (pids) => {
      readPidLists.push([...pids]);
      return readCurrentCommands(pids);
    },
    signalPid: (pid, signal) => {
      signaled.push({ pid, signal });
    },
  });
  return { killer, signaled, readPidLists };
}

describe("parseProcessCommandMap", () => {
  test("maps indented pid + full command lines, collapsing inner whitespace", () => {
    const map = parseProcessCommandMap(
      "        102 bun run dev -- --watch\n        103 /bin/zsh -l\n",
    );
    expect(map).toEqual(
      new Map([
        [102, "bun run dev -- --watch"],
        [103, "/bin/zsh -l"],
      ]),
    );
  });

  test("skips malformed and empty lines without throwing", () => {
    const map = parseProcessCommandMap(
      "   \n" +
        "garbage line\n" +
        "        999  \n" +
        "   -12 some command\n" +
        "\n" +
        "        104 node --version\n",
    );
    expect(map).toEqual(new Map([[104, "node --version"]]));
  });
});

describe("createProcessTreeKiller", () => {
  beforeEach(() => {
    resetProcessTreeKillStateForTests();
  });

  test("SIGKILL signals only pids whose live command still matches the capture", () => {
    const { killer, signaled, readPidLists } = makeFakeKiller(
      () =>
        new Map([
          [102, "bun run dev"],
          [103, "node unrelated-process.js"],
        ]),
    );

    const tree: ProcessTreeCapture = {
      descendants: [
        { pid: 102, command: "bun run dev" },
        { pid: 103, command: "tsdown --watch" },
      ],
      captureComplete: true,
      rootCommand: "zsh",
    };

    killer.signal({ rootPid: 100, signal: "SIGKILL", tree });

    // The pid still exists but its command no longer matches the capture, so
    // SIGKILL would hit a different process that reused the pid.
    expect(signaled.map((entry) => entry.pid)).toEqual([102]);
    expect(signaled.every((entry) => entry.signal === "SIGKILL")).toBe(true);
    expect(new Set(readPidLists[0])).toEqual(new Set([102, 103, 100]));
  });

  test("SIGTERM signals the tree deepest-first without a command re-read", () => {
    const { killer, signaled } = makeFakeKiller(() => {
      throw new Error("SIGTERM should not read current commands");
    });

    const tree: ProcessTreeCapture = {
      descendants: [
        { pid: 102, command: "bun run dev" },
        { pid: 103, command: "tsdown --watch" },
      ],
      captureComplete: true,
      rootCommand: "zsh",
    };

    expect(() =>
      killer.signal({ rootPid: 100, signal: "SIGTERM", tree, includeRoot: true }),
    ).not.toThrow();
    expect(signaled.map((entry) => entry.pid)).toEqual([103, 102, 100]);
    expect(signaled.every((entry) => entry.signal === "SIGTERM")).toBe(true);
  });

  test("inspect reports only descendants whose command still matches", () => {
    const { killer } = makeFakeKiller(
      () =>
        new Map([
          [102, "bun run dev"],
          [103, "node unrelated-process.js"],
        ]),
    );

    const tree: ProcessTreeCapture = {
      descendants: [
        { pid: 102, command: "bun run dev" },
        { pid: 103, command: "tsdown --watch" },
      ],
      captureComplete: true,
      rootCommand: "zsh",
    };

    expect(killer.inspect(tree)).toEqual({
      verified: true,
      survivors: [{ pid: 102, command: "bun run dev" }],
    });
  });

  test("inspect fails closed when the command re-read returns null", () => {
    const { killer } = makeFakeKiller(() => null);

    const tree: ProcessTreeCapture = {
      descendants: [
        { pid: 102, command: "bun run dev" },
        { pid: 103, command: "tsdown --watch" },
      ],
      captureComplete: true,
      rootCommand: "zsh",
    };

    expect(killer.inspect(tree)).toEqual({
      verified: false,
      survivors: [
        { pid: 102, command: "bun run dev" },
        { pid: 103, command: "tsdown --watch" },
      ],
    });
  });

  test("SIGKILL with includeRoot false never signals the root, even when identity matches", () => {
    const { killer, signaled } = makeFakeKiller(
      () =>
        new Map([
          [103, "tsdown --watch"],
          [100, "zsh"],
        ]),
    );

    const tree: ProcessTreeCapture = {
      descendants: [{ pid: 103, command: "tsdown --watch" }],
      captureComplete: true,
      rootCommand: "zsh",
    };

    killer.signal({ rootPid: 100, signal: "SIGKILL", tree, includeRoot: false });

    expect(signaled.map((entry) => entry.pid)).toEqual([103]);
  });

  test("SIGKILL still reaches the root when the identity re-read fails", () => {
    const { killer, signaled } = makeFakeKiller(() => null);

    const tree: ProcessTreeCapture = {
      descendants: [{ pid: 103, command: "tsdown --watch" }],
      captureComplete: true,
      rootCommand: "zsh",
    };

    killer.signal({ rootPid: 100, signal: "SIGKILL", tree });

    // Unverifiable descendants are left alone — one of them may be a recycled
    // pid. The root is the pid the caller spawned and is escalating on, so a
    // force kill that cannot confirm anything must still reach it rather than
    // become a silent no-op.
    expect(signaled.map((entry) => entry.pid)).toEqual([100]);
  });

  test("SIGKILL reaches the root when the capture never learned its command", () => {
    const { killer, signaled } = makeFakeKiller(() => new Map([[100, "zsh"]]));

    const tree: ProcessTreeCapture = {
      descendants: [],
      captureComplete: false,
      rootCommand: null,
    };

    killer.signal({ rootPid: 100, signal: "SIGKILL", tree });

    expect(signaled.map((entry) => entry.pid)).toEqual([100]);
  });

  test("SIGKILL skips a root whose command changed under it", () => {
    const { killer, signaled } = makeFakeKiller(() => new Map([[100, "node other.js"]]));

    const tree: ProcessTreeCapture = {
      descendants: [],
      captureComplete: true,
      rootCommand: "zsh",
    };

    killer.signal({ rootPid: 100, signal: "SIGKILL", tree });

    expect(signaled).toEqual([]);
  });

  test("an empty descendant tree inspects as verified with no survivors", () => {
    const { killer } = makeFakeKiller(() => {
      throw new Error("no descendants means no re-read");
    });

    expect(
      killer.inspect({ descendants: [], captureComplete: true, rootCommand: null }),
    ).toEqual({ verified: true, survivors: [] });
  });
});
