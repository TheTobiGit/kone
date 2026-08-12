import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ANTIGRAVITY_CLI_DIR_ENV,
  cliFlagValue,
  detectAntigravityCredential,
  formatAntigravityPlan,
  parseAntigravityLanguageServerLine,
  parseAntigravityLanguageServerLines,
  parseListeningPorts,
} from "./antigravity.js";
import { parseAntigravityQuotaSummary, parseAntigravityUserStatus } from "./antigravity.js";

describe("Antigravity credential detection", () => {
  test("a signed-in CLI leaves the oauth token file; presence is the whole signal", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kone-antigravity-quota-"));
    process.env[ANTIGRAVITY_CLI_DIR_ENV] = dir;
    try {
      // The negative arm isn't assertable here: detect also counts a *running*
      // agy/language-server process (the machine this test runs on may have
      // one), so only the file arm is deterministic.
      writeFileSync(path.join(dir, "antigravity-oauth-token"), "not-a-real-token");
      expect(await detectAntigravityCredential()).toBe(true);
    } finally {
      delete process.env[ANTIGRAVITY_CLI_DIR_ENV];
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Antigravity language-server discovery", () => {
  test("extracts csrf + ports from a real language_server command line", () => {
    const line =
      '/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/language_server/language_server --app_data_dir "/Users/test/.gemini/antigravity" --ide_name antigravity --csrf_token "9f2b_1KzQ8xVtR7mP4sN6wL0cJ5hE3dA8uY" --https_server_port 42319 --extension_server_port 42320 --log_file /tmp/ls.log';
    expect(parseAntigravityLanguageServerLine(line)).toEqual({
      csrfToken: "9f2b_1KzQ8xVtR7mP4sN6wL0cJ5hE3dA8uY",
      ports: [42319, 42320],
    });
  });

  test("accepts = syntax and the agy CLI's own server", () => {
    const line =
      "/usr/local/bin/agy language-server --csrf_token=abcdefghijklmnopqrstuvwxyz0123456789 --https_server_port=50001";
    expect(parseAntigravityLanguageServerLine(line)).toEqual({
      csrfToken: "abcdefghijklmnopqrstuvwxyz0123456789",
      ports: [50001],
    });
  });

  test("rejects lines without the antigravity marker or a usable csrf", () => {
    expect(parseAntigravityLanguageServerLine("--csrf_token x --https_server_port 1")).toBeNull();
    expect(
      parseAntigravityLanguageServerLine(
        "/opt/codeium/language_server --csrf_token short --https_server_port 1",
      ),
    ).toBeNull();
    expect(
      parseAntigravityLanguageServerLine(
        "/opt/antigravity/language_server --csrf_token=short-token --https_server_port 1",
      ),
    ).toBeNull();
  });

  test("needs at least one port to be usable", () => {
    const line = "/x/antigravity/language_server --csrf_token abcdefghijklmnopqrstuvwxyz123456";
    expect(parseAntigravityLanguageServerLine(line)).toBeNull();
  });

  test("returns the first matching candidate from ps output", () => {
    const lines = [
      "/usr/bin/foo",
      "/x/antigravity/language_server --csrf_token abcdefghijklmnopqrstuvwxyz123456 --extension_server_port 4444",
      "/x/antigravity-ide/language_server --csrf_token zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz --https_server_port 5555",
    ];
    expect(parseAntigravityLanguageServerLines(lines)).toEqual({
      csrfToken: "abcdefghijklmnopqrstuvwxyz123456",
      ports: [4444],
    });
  });

  test("cliFlagValue handles space and = forms, quoted values", () => {
    expect(cliFlagValue("--a one --b=two", "--a")).toBe("one");
    expect(cliFlagValue("--a one --b=two", "--b")).toBe("two");
    expect(cliFlagValue('--a "quoted value"', "--a")).toBe("quoted value");
    expect(cliFlagValue("--a=", "--a")).toBeNull();
    expect(cliFlagValue("--flag value", "--missing")).toBeNull();
  });

  test("the bare agy process needs no language_server marker or csrf", () => {
    // The app's language_server path requires the marker + a real csrf token,
    // so a bare `agy` process (which hosts the RPC in-process) only resolves
    // through the lsof-port path — exercised live on this machine.
    expect(parseAntigravityLanguageServerLine("agy")).toBeNull();
  });

  test("parseListeningPorts reads LISTEN ports from lsof output", () => {
    const output = [
      "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME",
      "agy 28532 gideonsarfo 10u IPv4 0x6c296b21601495ab 0t0 TCP 127.0.0.1:61501 (LISTEN)",
      "agy 28532 gideonsarfo 11u IPv4 0x6c9eeb6de515db09 0t0 TCP 127.0.0.1:61502 (LISTEN)",
      "other 1 root 12u IPv6 0x0 0t0 TCP *:8080 (LISTEN)",
      "curl 999 root 5u IPv4 0x0 0t0 TCP 127.0.0.1:54321 (ESTABLISHED)",
    ].join("\n");
    expect(parseListeningPorts(output)).toEqual([8080, 61501, 61502]);
  });

  test("parseListeningPorts ignores established connections and empty output", () => {
    expect(parseListeningPorts("")).toEqual([]);
    expect(parseListeningPorts("curl 1 x 5u TCP 127.0.0.1:9 (ESTABLISHED)")).toEqual([]);
  });
});

describe("Antigravity quota summary", () => {
  test("decodes the four pool buckets with remainingFraction mirrored to consumed", () => {
    const body = {
      response: {
        groups: [
          {
            buckets: [
              { bucketId: "gemini-5h", remainingFraction: 0.8, resetTime: "2026-08-01T10:00:00Z" },
              { bucketId: "gemini-weekly", remainingFraction: 0.5, resetTime: "2026-08-03T10:00:00Z" },
              { bucketId: "3p-5h", remainingFraction: 0.9 },
              { bucketId: "3p-weekly", remainingFraction: 0.25 },
            ],
          },
        ],
      },
    };
    const windows = parseAntigravityQuotaSummary(body);
    expect(windows).not.toBeNull();
    expect(windows!.map((w) => [w.id, w.label, w.state])).toEqual([
      ["gemini-5h", "Session", "active"],
      ["gemini-weekly", "Weekly", "active"],
      ["3p-5h", "Claude", "active"],
      ["3p-weekly", "Claude Weekly", "active"],
    ]);
    expect(windows!.map((w) => w.percent)).toEqual([
      expect.closeTo(0.2),
      expect.closeTo(0.5),
      expect.closeTo(0.1),
      expect.closeTo(0.75),
    ]);
    expect(windows![0]!.used).toEqual({ number: expect.closeTo(0.2), kind: "percent" });
    expect(windows![0]!.limit).toBeNull();
    expect(windows![0]!.resetsAt).toBe("2026-08-01T10:00:00.000Z");
  });

  test("accepts the bare remote payload and a full fraction reads as not started", () => {
    const windows = parseAntigravityQuotaSummary({
      groups: [{ buckets: [{ bucketId: "gemini-5h", remainingFraction: 1.0 }] }],
    });
    expect(windows).not.toBeNull();
    expect(windows![0]).toMatchObject({
      id: "gemini-5h",
      percent: 0,
      state: "notStarted",
      resetsAt: null,
    });
  });

  test("skips unknown buckets and drops buckets without a usable fraction", () => {
    const windows = parseAntigravityQuotaSummary({
      groups: [
        {
          buckets: [
            { bucketId: "gemini-image-5h", remainingFraction: 0.5 },
            { bucketId: "gemini-5h", remainingFraction: 0.5 },
            { bucketId: "gemini-weekly" },
          ],
        },
      ],
    });
    expect(windows!.map((w) => w.id)).toEqual(["gemini-5h"]);
  });

  test("duplicate bucket ids keep the first", () => {
    const windows = parseAntigravityQuotaSummary({
      groups: [
        {
          buckets: [
            { bucketId: "gemini-5h", remainingFraction: 0.8 },
            { bucketId: "gemini-5h", remainingFraction: 0.2 },
          ],
        },
      ],
    });
    expect(windows![0]!.percent).toBeCloseTo(0.2);
  });

  test("clamps out-of-range fractions and returns null for a non-summary body", () => {
    const clamped = parseAntigravityQuotaSummary({
      groups: [{ buckets: [{ bucketId: "gemini-5h", remainingFraction: 1.7 }] }],
    });
    expect(clamped![0]!.percent).toBe(0);
    expect(parseAntigravityQuotaSummary({ foo: "bar" })).toBeNull();
    expect(parseAntigravityQuotaSummary(null)).toBeNull();
  });
});

describe("Antigravity plan label", () => {
  test("prefers userTier over the Windsurf-inherited planName", () => {
    const body = {
      userStatus: {
        userTier: { name: "Google AI Ultra" },
        planStatus: { planInfo: { planName: "Pro" } },
      },
    };
    expect(parseAntigravityUserStatus(body)).toBe("Ultra");
  });

  test("falls back to planName when userTier is absent", () => {
    const body = {
      userStatus: { planStatus: { planInfo: { planName: "Google AI Pro" } } },
    };
    expect(parseAntigravityUserStatus(body)).toBe("Pro");
  });

  test("formatAntigravityPlan normalizes the known tier wordings", () => {
    expect(formatAntigravityPlan("Google AI Pro")).toBe("Pro");
    expect(formatAntigravityPlan("Gemini Code Assist in Google One AI Ultra")).toBe("Ultra");
    expect(formatAntigravityPlan("Free")).toBe("Free");
    expect(formatAntigravityPlan("  ")).toBeNull();
    expect(formatAntigravityPlan(null)).toBeNull();
    expect(formatAntigravityPlan(undefined)).toBeNull();
  });
});
