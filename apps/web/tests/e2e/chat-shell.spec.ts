import { expect, test } from "@playwright/test";

test("landing composer remains page-native and keyboard accessible", async ({
  page,
}) => {
  await page.goto("/");

  const composer = page.getByLabel("What should we build?");
  await expect(composer).toBeVisible();
  await page.keyboard.type("Explain the current workspace");
  await expect(composer).toHaveValue("Explain the current workspace");

  const history = page.getByLabel("Toggle thread history");
  await history.focus();
  await expect(history).toBeFocused();
  await history.press("Enter");
  await expect(page.getByLabel("Thread history")).toBeVisible();
});

test("reduced motion disables effective animation durations", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  const duration = await page
    .getByLabel("What should we build?")
    .evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(["0s", "0.001s", "0.01ms"]).toContain(duration);
});

test("mobile viewport does not overflow horizontally", async ({ page }) => {
  await page.goto("/");
  const sizes = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(sizes.content).toBeLessThanOrEqual(sizes.viewport);
});
