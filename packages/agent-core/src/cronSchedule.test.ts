import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { nextOccurrence, parseCron } from "./cronSchedule.js";

const date = (value: string) => new Date(value);
function inTimezone(zone: string, expression: string, after: string): string {
  const moduleUrl = new URL("./cronSchedule.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["-e", `const { nextOccurrence } = await import(${JSON.stringify(moduleUrl)}); console.log(nextOccurrence(${JSON.stringify(expression)}, new Date(${JSON.stringify(after)})).toISOString())`], {
    encoding: "utf8",
    env: { ...process.env, TZ: zone },
  });
  if (child.status !== 0) throw new Error(child.stderr);
  return child.stdout.trim();
}

describe("cron schedules", () => {
  it("supports lists, ranges and steps", () => {
    expect(nextOccurrence("5,10-20/5 8-10/2 * * *", date("2025-01-01T08:05:00"))).toEqual(date("2025-01-01T08:10:00"));
    expect([...parseCron("*/15 * * * *").minute.values]).toEqual([0, 15, 30, 45]);
  });
  it("uses the day-of-month OR day-of-week rule when both are restricted", () => {
    expect(nextOccurrence("0 9 13 * 1", date("2025-01-13T09:01:00"))).toEqual(date("2025-01-20T09:00:00"));
  });
  it("keeps stepped wildcards in DOM/DOW wildcard semantics", () => {
    expect(nextOccurrence("0 9 */1 * 1", date("2025-01-06T09:01:00"))).toEqual(date("2025-01-13T09:00:00"));
    expect(nextOccurrence("0 9 13 * */2", date("2025-01-01T00:00:00"))).toEqual(date("2025-02-13T09:00:00"));
  });
  it("handles month ends and leap day", () => {
    expect(nextOccurrence("0 0 31 * *", date("2025-04-01T00:00:00"))).toEqual(date("2025-05-31T00:00:00"));
    expect(nextOccurrence("0 0 29 2 *", date("2025-03-01T00:00:00"))).toEqual(date("2028-02-29T00:00:00"));
  });
  it("skips nonexistent New York spring times and fires ambiguous fall times once", () => {
    expect(inTimezone("America/New_York", "30 2 * * *", "2025-03-09T05:00:00Z")).toBe("2025-03-10T06:30:00.000Z");
    expect(inTimezone("America/New_York", "30 1 * * *", "2025-11-02T05:45:00Z")).toBe("2025-11-03T06:30:00.000Z");
  });
  it("handles Europe/London DST changes", () => {
    expect(inTimezone("Europe/London", "30 1 * * *", "2025-03-30T00:00:00Z")).toBe("2025-03-31T00:30:00.000Z");
    expect(inTimezone("Europe/London", "30 1 * * *", "2025-10-26T00:45:00Z")).toBe("2025-10-27T01:30:00.000Z");
  });
  it("rejects unsupported or malformed expressions clearly", () => {
    for (const expression of ["@daily", "* * * * * *", "0 0 * JAN *", "60 * * * *", "*/0 * * * *"]) {
      expect(() => parseCron(expression)).toThrow();
    }
  });
});
