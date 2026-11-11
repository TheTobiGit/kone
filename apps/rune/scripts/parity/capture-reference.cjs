#!/usr/bin/env node
// Install playwright-core in the checkout, or set PLAYWRIGHT_CORE to its module path.
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const [piece, sceneArg] = process.argv.slice(2);
const supported = ['empty-brand', 'empty-brand-hover', 'launcher-create', 'launcher-open', 'launcher-clone', 'launcher-more'];
if (!piece || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(piece) || !sceneArg || sceneArg.split(',').some(s => !supported.includes(s))) {
  console.error(`Usage: node capture-reference.cjs <piece> <scene,scene,...>\nSupported: ${supported.join(', ')}`);
  process.exit(2);
}
(async () => {
  const out = path.join('/workspace/rune-ref', piece);
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  try {
    for (const scene of sceneArg.split(',')) for (const theme of ['light', 'dark']) {
      console.log(`Capturing ${scene} ${theme}`);
      const target = path.join(out, `${scene}-${theme}.png`);
      fs.rmSync(target, { force: true });
      const context = await browser.newContext({ viewport: { width: 1292, height: 854 }, deviceScaleFactor: 1, colorScheme: theme });
      try {
        const page = await context.newPage();
        await page.goto('http://127.0.0.1:3004/', { waitUntil: 'load', timeout: 120000 });
        const labels = { create: 'Create a new project', open: 'Open from local folder', clone: 'Clone from GitHub' };
        await page.getByText(labels.create, { exact: true }).waitFor({ state: 'visible', timeout: 120000 });
        await page.waitForTimeout(3000);
        if (scene.startsWith('launcher-')) {
          const mode = scene === 'launcher-more' ? 'create' : scene.slice('launcher-'.length);
          await page.getByText(labels[mode], { exact: true }).click();
          await page.mouse.move(5, 840);
          await page.waitForTimeout(1900);
          if (scene === 'launcher-more') {
            await page.getByText('More', { exact: true }).click();
            await page.mouse.move(5, 840);
            await page.waitForTimeout(1200);
          }
        } else if (scene.endsWith('-hover')) {
          await page.mouse.move(420, 420);
          await page.mouse.move(600, 420, { steps: 12 });
          await page.waitForTimeout(700);
        }
        await page.screenshot({ path: target });
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
