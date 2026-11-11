#!/usr/bin/env node
// Install playwright-core in the checkout, or set PLAYWRIGHT_CORE to its module path.
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const [piece, sceneArg] = process.argv.slice(2);
const startScenes = ['empty-brand', 'empty-brand-hover', 'launcher-create', 'launcher-open', 'launcher-clone', 'launcher-more'];
const studioHeadScenes = [
  'studio-column-head',
  'studio-column-head-hover',
  'studio-column-head-tooltip',
  'studio-column-head-meter-calm',
  'studio-column-head-meter-warm',
  'studio-column-head-meter-full',
  'studio-column-head-meter-open',
  'studio-column-head-handoff',
  'studio-column-head-dormant',
  'studio-column-head-terminal-live',
];
const supported = [...startScenes, ...studioHeadScenes];
if (!piece || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(piece) || !sceneArg || sceneArg.split(',').some((s) => !supported.includes(s))) {
  console.error(`Usage: node capture-reference.cjs <piece> <scene,scene,...>\nSupported: ${supported.join(', ')}`);
  process.exit(2);
}

const RECENTS = JSON.stringify([{ name: 'kone', path: '/review/kone', lastOpenedAt: Date.now() }]);

async function openStart(page) {
  const labels = { create: 'Create a new project', open: 'Open from local folder', clone: 'Clone from GitHub' };
  await page.getByText(labels.create, { exact: true }).waitFor({ state: 'visible', timeout: 120000 });
  await page.waitForTimeout(3000);
  return labels;
}

async function openStudio(page) {
  await page.locator('.folder-btn').first().waitFor({ timeout: 120000 });
  await page.waitForTimeout(1500);
  await page.locator('.folder-btn').first().click();
  await page.locator('.project-nav').waitFor({ timeout: 20000 });
  await page.waitForTimeout(800);
  await page.keyboard.press('Control+b');
  await page.locator('.col__head').first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(800);
}

async function withThread(page, opts = {}) {
  await page.evaluate((opts) => {
    const col = document.querySelector('.col');
    let strip = col && col.__vueParentComponent;
    while (strip && strip.type?.__name !== 'ThreadStrip') strip = strip.parent;
    if (!strip) throw new Error('ThreadStrip not found');
    const pane = strip.props.panes[0];
    if (!pane?.session) throw new Error('no thread session');
    const s = pane.session;
    s.title.value = opts.title || 'Review thread';
    if ((s.blocks.value || []).length === 0) {
      s.blocks.value = [{ id: 'review-block', kind: 'user', text: 'Hello from review', at: Date.now() }];
    }
    if (opts.used != null) {
      s.tokenUsage.value = {
        contextUsed: opts.used,
        contextWindow: opts.window || 200000,
        compactsAutomatically: true,
      };
    } else if (opts.used === null) {
      s.tokenUsage.value = null;
    }
    if (opts.worktree) s.worktreePath.value = opts.worktree;
    if (opts.handoff) {
      s.forkContext.value = { forkKind: 'handoff', sourceProvider: 'claudeAgent' };
    }
  }, opts);
  await page.waitForTimeout(opts.used != null ? 1200 : 400);
}

async function parkPointer(page) {
  await page.mouse.move(5, 840);
  await page.waitForTimeout(400);
}

async function hoverHead(page) {
  const box = await page.locator('.col__head').first().boundingBox();
  if (!box) throw new Error('column head not found');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(500);
}

async function hoverTool(page, tip) {
  const tool = page.locator(`.col__tool[data-tip="${tip}"]`).first();
  await tool.waitFor({ state: 'visible', timeout: 5000 });
  await tool.hover();
  await page.waitForTimeout(500);
}

async function injectDormant(page) {
  await page.evaluate(() => {
    const col = document.querySelector('.col');
    let row = col && col.__vueParentComponent;
    while (row && row.type?.__name !== 'StudioRow') row = row.parent;
    if (!row) throw new Error('StudioRow not found');
    const entries = row.setupState.studio.entries;
    const first = entries.value[0];
    entries.value = [
      first,
      {
        ...first,
        id: 'review-dormant',
        kind: 'thread',
        session: undefined,
        anchor: { kind: 'thread', threadId: 'review-dormant' },
      },
    ];
  });
  await page.waitForTimeout(800);
}

async function injectTerminalLive(page) {
  const opened = await page.evaluate(async () => {
    const col = document.querySelector('.col');
    let row = col && col.__vueParentComponent;
    while (row && row.type?.__name !== 'StudioRow') row = row.parent;
    if (!row) throw new Error('StudioRow not found');
    await row.setupState.studio.open('terminal', { focus: true });
    return true;
  });
  await page.waitForTimeout(900);
  const ready = await page.evaluate(() => {
    const col = document.querySelector('.col');
    let row = col && col.__vueParentComponent;
    while (row && row.type?.__name !== 'StudioRow') row = row.parent;
    const sessions = row.setupState.terminal?.sessions;
    if (!sessions || !Array.isArray(sessions.value) || sessions.value.length === 0) return false;
    const s = sessions.value[0];
    s.hasRunningSubprocess = true;
    s.childCommandLabel = 'npm run dev';
    sessions.value = [...sessions.value];
    return true;
  });
  await page.waitForTimeout(400);
  const visible = await page.locator('.col__busy').count();
  if (!opened || !ready || visible === 0) {
    throw new Error(`terminal live-process pill not visible (opened=${opened} ready=${ready} busy=${visible})`);
  }
}

async function captureStart(page, scene) {
  const labels = await openStart(page);
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
}

async function captureStudioHead(page, scene) {
  await openStudio(page);
  const meter = {
    'studio-column-head': 40000,
    'studio-column-head-hover': 40000,
    'studio-column-head-tooltip': 40000,
    'studio-column-head-meter-calm': 40000,
    'studio-column-head-meter-warm': 150000,
    'studio-column-head-meter-full': 190000,
    'studio-column-head-meter-open': 40000,
    'studio-column-head-handoff': 40000,
    'studio-column-head-dormant': 40000,
    'studio-column-head-terminal-live': null,
  }[scene];
  await withThread(page, {
    title: 'Review thread',
    used: meter,
    window: 200000,
    worktree: scene === 'studio-column-head-handoff' || scene === 'studio-column-head-dormant' || scene.startsWith('studio-column-head-meter') || scene === 'studio-column-head' || scene === 'studio-column-head-hover' || scene === 'studio-column-head-tooltip'
      ? '/tmp/kone-review-worktree'
      : undefined,
    handoff: scene === 'studio-column-head-handoff',
  });
  if (scene === 'studio-column-head-dormant') {
    await injectDormant(page);
    await parkPointer(page);
    return;
  }
  if (scene === 'studio-column-head-terminal-live') {
    await injectTerminalLive(page);
    await parkPointer(page);
    return;
  }
  if (scene === 'studio-column-head-meter-open') {
    await parkPointer(page);
    await page.locator('.context-meter').first().click();
    await page.waitForTimeout(500);
    return;
  }
  if (scene === 'studio-column-head-hover') {
    await hoverHead(page);
    return;
  }
  if (scene === 'studio-column-head-tooltip') {
    await hoverHead(page);
    await hoverTool(page, 'Hand off to another provider');
    return;
  }
  await parkPointer(page);
}

(async () => {
  const out = path.join('/workspace/rune-ref', piece);
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  try {
    for (const scene of sceneArg.split(',')) {
      for (const theme of ['light', 'dark']) {
        console.log(`Capturing ${scene} ${theme}`);
        const target = path.join(out, `${scene}-${theme}.png`);
        fs.rmSync(target, { force: true });
        const isStudio = studioHeadScenes.includes(scene);
        const context = await browser.newContext({
          viewport: { width: 1292, height: 854 },
          deviceScaleFactor: 1,
          colorScheme: theme,
        });
        try {
          if (isStudio) {
            await context.addInitScript((recents) => {
              localStorage.setItem('kone:recent-projects', recents);
            }, RECENTS);
          }
          const page = await context.newPage();
          await page.goto('http://127.0.0.1:3004/', { waitUntil: 'load', timeout: 120000 });
          if (isStudio) await captureStudioHead(page, scene);
          else await captureStart(page, scene);
          await page.screenshot({ path: target });
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
