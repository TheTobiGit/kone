import {
  Book02Icon,
  CheckmarkCircle02Icon,
  RoboticIcon,
  Search01Icon,
  Shield01Icon,
  Wrench01Icon,
} from "@hugeicons/core-free-icons";

import type { DetailIcon } from "~/utils/detailFormat";

// The glyph for a built-in sub-agent, by preset id. One map, so the roster
// cards and the detail page can't drift apart; anything unrecognised (custom
// presets, future built-ins) reads as the generic worker.
const NATIVE_SUBAGENT_ICONS: Record<string, DetailIcon> = {
  "builtin-scout": Search01Icon,
  "builtin-reviewer": CheckmarkCircle02Icon,
  "builtin-security-reviewer": Shield01Icon,
  "builtin-librarian": Book02Icon,
  "builtin-worker": Wrench01Icon,
};

export function nativeSubagentIcon(presetId: string): DetailIcon {
  return NATIVE_SUBAGENT_ICONS[presetId] ?? RoboticIcon;
}
