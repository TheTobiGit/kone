import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ANTIGRAVITY_ACP_BROWSER_MARKER,
  ANTIGRAVITY_ACP_DEFAULT_AUTH,
  ANTIGRAVITY_ACP_SIGN_IN_REQUIRED_MESSAGE,
  antigravityAcpAuthConfigIssue,
  antigravityAcpAuthLabel,
  antigravityAcpProfileSettings,
  buildAntigravityAcpEnv,
  buildAntigravityAcpSpawnInput,
  buildAntigravityBrowserCommand,
  ensureAntigravityAcpProfile,
  isAntigravitySignInRequiredError,
  parseAntigravityAuthUrl,
  parseAntigravityBrowserLine,
  resolveAntigravityAcpProfileDir,
  resolveAntigravityAcpSharedProfile,
  type AntigravityAcpProfile,
} from "./antigravityAcpProfile.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kone-antigravity-acp-"));
}

describe("antigravityAcpAuthConfigIssue", () => {
  test("personal sign-in never needs config", () => {
    expect(antigravityAcpAuthConfigIssue(ANTIGRAVITY_ACP_DEFAULT_AUTH)).toBeNull();
  });

  test("enterprise needs a project and a location", () => {
    expect(
      antigravityAcpAuthConfigIssue({ authMethod: "oauth-business", gcpProject: "", gcpLocation: "" }),
    ).not.toBeNull();
    expect(
      antigravityAcpAuthConfigIssue({
        authMethod: "oauth-business",
        gcpProject: "my-project",
        gcpLocation: "us-central1",
      }),
    ).toBeNull();
  });

  test("labels name the method", () => {
    expect(antigravityAcpAuthLabel("oauth-personal")).toBe("Google account");
    expect(antigravityAcpAuthLabel("oauth-business")).toBe("Gemini Enterprise");
  });
});

describe("antigravityAcpProfileSettings", () => {
  test("names the method and carries the GCP pair, never a credential", () => {
    const settings = antigravityAcpProfileSettings({
      authMethod: "oauth-business",
      gcpProject: "my-project",
      gcpLocation: "us-central1",
    });
    // SAFETY: this file wrote the JSON above, so its top-level shape is known.
    const parsed = JSON.parse(settings) as { auth: { type: string }; gcp: { project: string } };
    expect(parsed.auth.type).toBe("oauth-business");
    expect(parsed.gcp.project).toBe("my-project");
    expect(settings).not.toContain("key");
    expect(settings).not.toContain("token");
  });

  test("omits the gcp block for personal sign-in", () => {
    expect(antigravityAcpProfileSettings(ANTIGRAVITY_ACP_DEFAULT_AUTH)).not.toContain("gcp");
  });
});

describe("ensureAntigravityAcpProfile", () => {
  test("creates the profile layout and rewrites settings on every call", () => {
    const root = tempDir();
    const profileDir = resolveAntigravityAcpProfileDir(root);
    const first = ensureAntigravityAcpProfile(profileDir, ANTIGRAVITY_ACP_DEFAULT_AUTH, "linux");
    expect(first.geminiHome).toBe(path.resolve(profileDir));
    expect(fs.statSync(first.acpDirectory).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(first.acpDirectory, "settings.json"), "utf8")).toContain(
      "oauth-personal",
    );
    const second = ensureAntigravityAcpProfile(
      profileDir,
      { authMethod: "oauth-business", gcpProject: "p", gcpLocation: "l" },
      "linux",
    );
    expect(fs.readFileSync(path.join(second.acpDirectory, "settings.json"), "utf8")).toContain(
      "oauth-business",
    );
  });
});

describe("buildAntigravityBrowserCommand", () => {
  test("reports the URL on stderr and never opens a browser", () => {
    const command = buildAntigravityBrowserCommand("/Applications/kone", "darwin");
    expect(command).toContain(ANTIGRAVITY_ACP_BROWSER_MARKER);
    expect(command).toContain("%s");
  });
});

describe("parseAntigravityBrowserLine", () => {
  test("reads the suppressor helper's stderr marker", () => {
    const url = "https://accounts.google.com/o/oauth2/v2/auth?state=x";
    expect(
      parseAntigravityBrowserLine(`${ANTIGRAVITY_ACP_BROWSER_MARKER}${JSON.stringify(url)}`),
    ).toBe(url);
  });

  test("reads the server's native stdout prefix", () => {
    const url = "https://accounts.google.com/o/oauth2/v2/auth?state=x";
    expect(
      parseAntigravityBrowserLine(`Open the following link to authenticate the ACP server: ${url}`),
    ).toBe(url);
  });

  test("ignores ordinary output", () => {
    expect(parseAntigravityBrowserLine("some log line")).toBeNull();
    expect(parseAntigravityBrowserLine(`${ANTIGRAVITY_ACP_BROWSER_MARKER}not json`)).toBeNull();
  });
});

describe("buildAntigravityAcpEnv", () => {
  test("isolated mode points the server at the kone profile and strips ambient credentials", async () => {
    const profile: AntigravityAcpProfile = {
      geminiHome: "/tmp/kone-antigravity-test",
      acpDirectory: "/tmp/kone-antigravity-test/antigravity-acp",
      platform: "darwin",
      browserCommand: "browser-stub",
    };
    const env = await buildAntigravityAcpEnv(profile, "/tmp/harness", {
      PATH: "/usr/bin",
      HOME: "/Users/someone",
      GEMINI_API_KEY: "leak",
      GOOGLE_CLOUD_PROJECT: "leak",
      GEMINI_HOME: "/Users/someone/.gemini",
    });
    expect(env.GEMINI_HOME).toBe(profile.geminiHome);
    expect(env.AGY_ACP_FORCE_FILE_STORAGE).toBe("1");
    expect(env.ANTIGRAVITY_HARNESS_PATH).toBe("/tmp/harness");
    expect(env.BROWSER).toBe("browser-stub");
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.GOOGLE_CLOUD_PROJECT).toBeUndefined();
    expect(env.HOME).toBe("/Users/someone");
  });

  test("shared mode passes GEMINI_HOME through so the server finds the CLI login", async () => {
    const profile = resolveAntigravityAcpSharedProfile("darwin", "/Applications/kone");
    expect(profile.geminiHome).toBeNull();
    expect(profile.acpDirectory).toBeNull();
    const env = await buildAntigravityAcpEnv(profile, "/tmp/harness", {
      PATH: "/usr/bin",
      GEMINI_HOME: "/Users/someone/.gemini",
      GEMINI_API_KEY: "leak",
    });
    expect(env.GEMINI_HOME).toBe("/Users/someone/.gemini");
    expect(env.AGY_ACP_FORCE_FILE_STORAGE).toBeUndefined();
    expect(env.ANTIGRAVITY_HARNESS_PATH).toBe("/tmp/harness");
    expect(env.BROWSER).toBe(profile.browserCommand);
    expect(env.GEMINI_API_KEY).toBeUndefined();
  });

  test("shared mode leaves GEMINI_HOME unset when the user has none", async () => {
    const profile = resolveAntigravityAcpSharedProfile("darwin", "/Applications/kone");
    const env = await buildAntigravityAcpEnv(profile, "/tmp/harness", { PATH: "/usr/bin" });
    expect(env.GEMINI_HOME).toBeUndefined();
  });
});

describe("buildAntigravityAcpSpawnInput", () => {
  test("linux builds take the empty --uid flag, others take no args", () => {
    const base = {
      executable: { executablePath: "/bin/agy_acp_server.par", harnessPath: "/bin/harness" },
      cwd: "/work",
      env: {},
    };
    expect(
      buildAntigravityAcpSpawnInput({
        ...base,
        profile: { geminiHome: "", acpDirectory: "", platform: "linux", browserCommand: "" },
      }).args,
    ).toEqual(["--uid="]);
    expect(
      buildAntigravityAcpSpawnInput({
        ...base,
        profile: { geminiHome: "", acpDirectory: "", platform: "darwin", browserCommand: "" },
      }).args,
    ).toEqual([]);
  });
});

describe("parseAntigravityAuthUrl", () => {
  const good =
    "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=abc123&redirect_uri=http%3A%2F%2F127.0.0.1%3A5312%2F";

  test("accepts the exact Google loopback shape", () => {
    const parsed = parseAntigravityAuthUrl(good);
    expect(parsed?.state).toBe("abc123");
    expect(parsed?.redirectUri).toBe("http://127.0.0.1:5312/");
  });

  test("rejects anything else", () => {
    expect(parseAntigravityAuthUrl("https://evil.example/auth?state=x")).toBeNull();
    expect(parseAntigravityAuthUrl(good.replace("response_type=code", "response_type=token"))).toBeNull();
    expect(parseAntigravityAuthUrl(good.replace("127.0.0.1", "localhost"))).toBeNull();
    expect(parseAntigravityAuthUrl("")).toBeNull();
  });
});

describe("isAntigravitySignInRequiredError", () => {
  test("recognizes the server's auth failure code", () => {
    expect(isAntigravitySignInRequiredError({ code: -32000, message: "authenticate() required" })).toBe(
      true,
    );
    expect(
      isAntigravitySignInRequiredError({ message: ANTIGRAVITY_ACP_SIGN_IN_REQUIRED_MESSAGE }),
    ).toBe(true);
    expect(isAntigravitySignInRequiredError({ code: -32601, message: "Method not found" })).toBe(false);
    expect(isAntigravitySignInRequiredError(null)).toBe(false);
    expect(isAntigravitySignInRequiredError("nope")).toBe(false);
  });
});
