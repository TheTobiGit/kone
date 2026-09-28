import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setUserDataDir } from "../../userDataDir.js";
import { resolveModelRates } from "./resolver.js";

/** The store keeps its snapshot in module state, loaded once — each test takes
 *  a fresh instance so the cache it seeds is the one read. */
async function freshStore(tag: string): Promise<typeof import("./store.js")> {
  // SAFETY: the query only busts the module cache; the module is store.ts.
  return (await import(`./store.ts?${tag}`)) as typeof import("./store.js");
}

function seedDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "kone-pricing-"));
  mkdirSync(path.join(dir, "pricing"));
  // Both sources fresh, so no test here reaches for the network.
  const fresh = { fetchedAtMs: Date.now() };
  writeFileSync(path.join(dir, "pricing", "state.json"), JSON.stringify({ litellm: fresh, modelsDev: fresh }));
  setUserDataDir(dir);
  return dir;
}

const offline = { fetch: () => Promise.reject(new Error("offline")) };

describe("pricing cache", () => {
  test("a cache written stringified twice still loads", async () => {
    const dir = seedDir();
    const compact = { retrievedAt: "2026-09-27", source: "test", models: { "kone-test-model": { i: 4, o: 20, cw: 5, cr: 0.2 } } };
    writeFileSync(path.join(dir, "pricing", "litellm-cache.json"), JSON.stringify(JSON.stringify(compact)));

    const store = await freshStore("double");
    const rates = resolveModelRates(store.currentPricingSnapshot(offline), "kone-test-model");
    expect(rates?.inputPerMillion).toBe(4);
    expect(rates?.cacheReadPerMillion).toBe(0.2);
  });

  test("a refreshed feed is cached as plain JSON", async () => {
    const dir = seedDir();
    const feed = {
      "kone-test-model": { input_cost_per_token: 4e-6, output_cost_per_token: 2e-5, litellm_provider: "anthropic", mode: "chat" },
    };
    const store = await freshStore("write");
    await store.refreshPricingNow({
      fetch: async (url) =>
        String(url).includes("litellm") ? new Response(JSON.stringify(feed)) : new Response("{}", { status: 500 }),
    });

    const written: unknown = JSON.parse(readFileSync(path.join(dir, "pricing", "litellm-cache.json"), "utf8"));
    expect(written).toHaveProperty("models.kone-test-model");
  });
});
