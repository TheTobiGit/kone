import { describe, expect, test } from "bun:test";
import { evaluatePolicies, type PolicyAction } from "./policies.js";
import type { AgentPolicies } from "./ConversationStore.js";

function policies(over: Partial<AgentPolicies> = {}): AgentPolicies {
  return { deniedCommands: [], deniedPaths: [], ...over };
}

function command(target: string): PolicyAction {
  return { kind: "command", target };
}
function read(target: string): PolicyAction {
  return { kind: "file-read", target };
}
function change(target: string): PolicyAction {
  return { kind: "file-change", target };
}

describe("the policy enforcer", () => {
  test("an agent with no policies is allowed anything", () => {
    expect(evaluatePolicies(null, command("rm -rf /")).allowed).toBe(true);
    expect(evaluatePolicies(policies(), command("rm -rf /")).allowed).toBe(true);
    expect(evaluatePolicies(policies(), read("/etc/passwd")).allowed).toBe(true);
  });

  test("an empty target is allowed — there is nothing to weigh", () => {
    const p = policies({ deniedCommands: ["rm"] });
    expect(evaluatePolicies(p, command("   ")).allowed).toBe(true);
  });

  // ── commands ───────────────────────────────────────────────────────────────

  test("a denied command matches by case-insensitive substring", () => {
    const p = policies({ deniedCommands: ["rm -rf"] });
    const verdict = evaluatePolicies(p, command("RM -RF /tmp/build"));
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toContain("rm -rf");
  });

  test("a denied command catches an env-prefixed invocation", () => {
    const p = policies({ deniedCommands: ["git push"] });
    expect(evaluatePolicies(p, command("FOO=1 git push origin main")).allowed).toBe(false);
  });

  test("a command not on the list is allowed", () => {
    const p = policies({ deniedCommands: ["rm -rf", "curl"] });
    expect(evaluatePolicies(p, command("ls -la")).allowed).toBe(true);
  });

  test("the command list is not consulted for a file action", () => {
    const p = policies({ deniedCommands: ["secret"] });
    // 'secret' is a denied *command* substring; a read of a path that merely
    // contains it must not trip the command rule.
    expect(evaluatePolicies(p, read("/notes/secret-plan.md")).allowed).toBe(true);
  });

  test("a permission or tool action is weighed against the command list", () => {
    const p = policies({ deniedCommands: ["delete"] });
    expect(evaluatePolicies(p, { kind: "permission", target: "delete_file" }).allowed).toBe(false);
    expect(evaluatePolicies(p, { kind: "tool", target: "Delete02" }).allowed).toBe(false);
    expect(evaluatePolicies(p, { kind: "tool", target: "Read" }).allowed).toBe(true);
  });

  // ── paths: leaf ──────────────────────────────────────────────────────────────

  test("a leaf entry denies the file wherever it sits", () => {
    const p = policies({ deniedPaths: [".env"] });
    expect(evaluatePolicies(p, read("/proj/.env")).allowed).toBe(false);
    expect(evaluatePolicies(p, read("/a/b/c/.env")).allowed).toBe(false);
    expect(evaluatePolicies(p, change(".env")).allowed).toBe(false);
  });

  test("a leaf entry denies the dotfile / extension family", () => {
    const p = policies({ deniedPaths: [".env"] });
    expect(evaluatePolicies(p, read("/proj/.env.local")).allowed).toBe(false);
    expect(evaluatePolicies(p, read("/proj/.env.production")).allowed).toBe(false);
  });

  test("a leaf entry does not trip on a same-prefix but different name", () => {
    const p = policies({ deniedPaths: [".env"] });
    expect(evaluatePolicies(p, read("/proj/.environment")).allowed).toBe(true);
    expect(evaluatePolicies(p, read("/proj/environment")).allowed).toBe(true);
  });

  // ── paths: fragment ──────────────────────────────────────────────────────────

  test("a fragment entry denies any path with that whole segment", () => {
    const p = policies({ deniedPaths: ["secrets"] });
    expect(evaluatePolicies(p, read("/app/secrets/key.pem")).allowed).toBe(false);
    expect(evaluatePolicies(p, read("secrets/key.pem")).allowed).toBe(false);
    expect(evaluatePolicies(p, read("/app/secrets")).allowed).toBe(false);
  });

  test("a fragment entry does not trip on a partial segment", () => {
    const p = policies({ deniedPaths: ["env"] });
    expect(evaluatePolicies(p, read("/app/environment/x")).allowed).toBe(true);
  });

  test("a multi-segment fragment matches only a whole run of segments", () => {
    const p = policies({ deniedPaths: ["config/prod"] });
    expect(evaluatePolicies(p, read("/app/config/prod/db.json")).allowed).toBe(false);
    expect(evaluatePolicies(p, read("/app/config/production/db.json")).allowed).toBe(true);
  });

  // ── paths: glob ──────────────────────────────────────────────────────────────

  test("a single-star glob spans one segment", () => {
    const p = policies({ deniedPaths: ["*.pem"] });
    expect(evaluatePolicies(p, read("/keys/server.pem")).allowed).toBe(false);
    expect(evaluatePolicies(p, read("server.pem")).allowed).toBe(false);
    expect(evaluatePolicies(p, read("/keys/server.pub")).allowed).toBe(true);
  });

  test("a double-star glob spans separators", () => {
    const p = policies({ deniedPaths: ["**/node_modules/**"] });
    expect(evaluatePolicies(p, read("/app/node_modules/pkg/index.js")).allowed).toBe(false);
    expect(evaluatePolicies(p, read("/app/src/index.js")).allowed).toBe(true);
  });

  test("a windows-style path is normalized before matching", () => {
    const p = policies({ deniedPaths: [".env"] });
    expect(evaluatePolicies(p, read("C:\\proj\\.env")).allowed).toBe(false);
  });

  test("the path list is not consulted for a command action", () => {
    const p = policies({ deniedPaths: [".env"] });
    expect(evaluatePolicies(p, command("cat .env")).allowed).toBe(true);
  });

  test("empty entries in a list are skipped", () => {
    const p = policies({ deniedCommands: [""], deniedPaths: [""] });
    expect(evaluatePolicies(p, command("rm -rf /")).allowed).toBe(true);
    expect(evaluatePolicies(p, read("/proj/.env")).allowed).toBe(true);
  });
});
