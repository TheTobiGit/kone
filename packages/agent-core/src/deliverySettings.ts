import fs from "node:fs";

import { z } from "zod";

import { userDataPath } from "./userDataDir.js";

// Which agent-mail delivery runs. `v2` turns on the ringer: the inbox rides the
// thread's turn slot, notes wait for the next turn, and only what rings wakes
// or restarts a session. Off by default, so today's routing stays the shipped
// behaviour until it is flipped. Read once at boot; a change applies on the
// next launch, since the two deliveries cannot hand rows between each other
// mid-run.

const DeliverySettingsWire = z.object({ v2: z.boolean().optional() });

export interface DeliverySettings {
  v2: boolean;
}

let cache: DeliverySettings | null = null;

/** The persisted delivery settings, read from disk once and cached. A missing
 *  or malformed file reads as every switch off. */
export function readDeliverySettings(): DeliverySettings {
  if (cache) return cache;
  try {
    const parsed = DeliverySettingsWire.safeParse(
      JSON.parse(fs.readFileSync(userDataPath("delivery-settings.json"), "utf8")),
    );
    cache = { v2: parsed.success ? (parsed.data.v2 ?? false) : false };
  } catch {
    cache = { v2: false };
  }
  return cache;
}

export function isDeliveryV2Enabled(): boolean {
  return readDeliverySettings().v2;
}
