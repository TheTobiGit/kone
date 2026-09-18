import { describe, expect, it } from "bun:test";
import { formatThemeChange } from "@kone/protocol/theme-summary";
import {
  isAppearanceToolName,
  isRecordedAppearanceCall,
  useThemeSummaryReading,
} from "./useThemeSummaryReading";
import type { RuntimeItem } from "~/types/desktop";

function item(fields: Partial<RuntimeItem> = {}): RuntimeItem {
  return {
    itemId: "item-1",
    kind: "tool_call",
    status: "completed",
    text: "",
    name: "app_set_theme",
    ...fields,
  };
}

function record(to: string, from: string | null): string {
  return formatThemeChange({ to, from, summary: `Applied theme "${to}".` });
}

describe("useThemeSummaryReading", () => {
  it("recovers both ends of a change from the stored record, without parsing the sentence", () => {
    const reading = useThemeSummaryReading(item({ detail: record("nocturne", "moss") }));

    expect(reading.toTheme.value?.id).toBe("nocturne");
    expect(reading.fromTheme.value?.id).toBe("moss");
    expect(reading.has.value).toBe(true);
    expect(reading.toColors.value).not.toBeNull();
    expect(reading.fromColors.value).not.toBeNull();
  });

  it("recovers a change that displaced nothing", () => {
    const reading = useThemeSummaryReading(item({ detail: record("forge", null) }));

    expect(reading.toTheme.value?.id).toBe("forge");
    expect(reading.fromTheme.value).toBeNull();
    expect(reading.has.value).toBe(true);
  });

  it("reads nothing out of a legacy sentence, which names ids only as prose", () => {
    const reading = useThemeSummaryReading(
      item({ detail: 'Applied theme "Nocturne" (nocturne), replacing "Moss" (moss).' }),
    );

    expect(reading.toTheme.value).toBeNull();
    expect(reading.has.value).toBe(false);
    expect(reading.toColors.value).toBeNull();
  });

  it("reads nothing out of a bare mode change or a missing record", () => {
    expect(useThemeSummaryReading(item({ detail: "Applied appearance mode in dark mode." })).has.value).toBe(
      false,
    );
    expect(useThemeSummaryReading(item({ detail: undefined })).has.value).toBe(false);
    expect(useThemeSummaryReading(null).has.value).toBe(false);
  });

  it("reads nothing for a tool that changes no appearance", () => {
    const reading = useThemeSummaryReading(
      item({ name: "app_get_theme_state", detail: record("nocturne", null) }),
    );

    expect(reading.has.value).toBe(false);
  });
});

describe("isRecordedAppearanceCall", () => {
  it("keeps a settled call that left a record", () => {
    expect(isRecordedAppearanceCall(item({ detail: record("nocturne", "moss") }))).toBe(true);
  });

  it("answers to the name a provider reports, raw", () => {
    expect(
      isRecordedAppearanceCall(
        item({ name: "kone_app_set_theme", detail: record("nocturne", null) }),
      ),
    ).toBe(true);
    expect(
      isRecordedAppearanceCall(
        item({ name: "mcp__kone__app_create_custom_theme", detail: record("brand-01", null) }),
      ),
    ).toBe(true);
  });

  it("drops calls with nothing to draw", () => {
    // A failed call changed nothing.
    expect(
      isRecordedAppearanceCall(item({ status: "failed", detail: record("nocturne", null) })),
    ).toBe(false);
    // A running call has no result yet.
    expect(
      isRecordedAppearanceCall(item({ status: "in-progress", detail: record("nocturne", null) })),
    ).toBe(false);
    // A bare mode change leaves a sentence, not a record.
    expect(
      isRecordedAppearanceCall(item({ detail: "Applied appearance mode in dark mode." })),
    ).toBe(false);
    // So does a cancel.
    expect(
      isRecordedAppearanceCall(
        item({
          name: "app_preview_theme_override",
          detail: "Cancelled live theme preview; restored saved theme.",
        }),
      ),
    ).toBe(false);
    // And a tool that changes no appearance never has one.
    expect(
      isRecordedAppearanceCall(item({ name: "app_get_theme_state", detail: "states" })),
    ).toBe(false);
  });
});

describe("isAppearanceToolName", () => {
  it("answers with the appearance tools, however a provider spells them", () => {
    expect(isAppearanceToolName("app_set_theme")).toBe(true);
    expect(isAppearanceToolName("app_create_custom_theme")).toBe(true);
    expect(isAppearanceToolName("app_preview_theme_override")).toBe(true);
    expect(isAppearanceToolName("kone_app_set_theme")).toBe(true);
    expect(isAppearanceToolName("app_get_theme_state")).toBe(false);
    expect(isAppearanceToolName("read_file")).toBe(false);
    expect(isAppearanceToolName(undefined)).toBe(false);
  });
});
