import { describe, expect, test } from "bun:test";

import { isSnoozed, limitFailureFromError, snoozeUntilReset } from "./limitState.js";

const NOW = 1_800_000_000_000;
const LATER = NOW + 3_600_000;

describe("limitFailureFromError", () => {
  test("a quota failure carries the provider reset when the payload has one", () => {
    const result = limitFailureFromError(
      { status: 429, resetsAt: new Date(LATER).toISOString() },
      NOW,
    );
    expect(result.limited).toBe(true);
    expect(result.resetAt).toBe(LATER);
  });

  test("a quota failure with no reset stays limited with a null reset", () => {
    expect(limitFailureFromError({ message: "usage limit reached" }, NOW)).toEqual({
      limited: true,
      resetAt: null,
    });
  });

  test("a reset already in the past is not a reset", () => {
    expect(limitFailureFromError({ status: 429, resetsAt: new Date(NOW - 1).toISOString() }, NOW)).toEqual({
      limited: true,
      resetAt: null,
    });
  });

  test("a non-quota failure is not limited", () => {
    expect(limitFailureFromError(new Error("connection reset"), NOW)).toEqual({
      limited: false,
      resetAt: null,
    });
  });
});

describe("isSnoozed", () => {
  const base = { snoozedUntil: LATER, snoozedAt: NOW, parked: false, latest: null };

  test("a future snooze with nothing else is snoozed", () => {
    expect(isSnoozed(base, NOW)).toBe(true);
  });

  test("an expired or absent snooze is not snoozed", () => {
    expect(isSnoozed({ ...base, snoozedUntil: NOW }, NOW)).toBe(false);
    expect(isSnoozed({ ...base, snoozedUntil: null }, NOW)).toBe(false);
  });

  test("a parked approval or question wakes it", () => {
    expect(isSnoozed({ ...base, parked: true }, NOW)).toBe(false);
  });

  test("a completion after the snooze wakes it", () => {
    expect(
      isSnoozed({ ...base, latest: { state: "completed", at: NOW + 1, limit: false } }, NOW),
    ).toBe(false);
  });

  test("a fresh non-limit failure wakes it", () => {
    expect(
      isSnoozed({ ...base, latest: { state: "failed", at: NOW + 1, limit: false } }, NOW),
    ).toBe(false);
  });

  test("the limit failure that set the snooze does not wake it", () => {
    expect(
      isSnoozed({ ...base, latest: { state: "failed", at: NOW + 1, limit: true } }, NOW),
    ).toBe(true);
  });

  test("an interrupt or a failure before the snooze never wakes it", () => {
    expect(
      isSnoozed({ ...base, latest: { state: "interrupted", at: NOW + 1, limit: false } }, NOW),
    ).toBe(true);
    expect(
      isSnoozed({ ...base, latest: { state: "failed", at: NOW - 1, limit: false } }, NOW),
    ).toBe(true);
  });
});

describe("snoozeUntilReset", () => {
  test("a future reset is the deadline; anything else is null", () => {
    expect(snoozeUntilReset(LATER, NOW)).toBe(LATER);
    expect(snoozeUntilReset(NOW, NOW)).toBeNull();
    expect(snoozeUntilReset(null, NOW)).toBeNull();
  });
});
