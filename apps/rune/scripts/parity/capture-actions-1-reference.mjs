import { chromium } from 'playwright-core';

const [flow, theme, output] = process.argv.slice(2);
const flows = new Set([
  'row-open-click', 'row-open-enter', 'switcher-pick', 'back-list',
  'cycle-hud', 'cycle-pick', 'studio-summon', 'studio-close',
  'recent-session-pane', 'round-trip',
]);
if (!flows.has(flow) || !['light', 'dark'].includes(theme) || !output) {
  throw new Error('Usage: capture-actions-1-reference.mjs <flow> <light|dark> <output.png>');
}

const recents = [
  { name: 'kone', path: '/review/kone', lastOpenedAt: Date.now() },
  { name: 'nova', path: '/review/nova', lastOpenedAt: Date.now() - 86_400_000 },
  { name: 'atlas', path: '/review/atlas', lastOpenedAt: Date.now() - 172_800_000 },
];
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const context = await browser.newContext({
  viewport: { width: 1280, height: 840 },
  deviceScaleFactor: 2,
  colorScheme: theme,
});
await context.addInitScript((data) => {
  localStorage.setItem('kone:recent-projects', JSON.stringify(data.recents));
  localStorage.setItem('kone:appearance', data.theme);
}, { recents, theme });
const page = await context.newPage();
await page.goto('http://127.0.0.1:3004/', { waitUntil: 'load', timeout: 120_000 });
await page.locator('.folder-btn').first().waitFor({ timeout: 120_000 });
await page.waitForTimeout(2400);

async function openProject() {
  await page.locator('.folder-btn').first().click();
  await page.locator('.greet').waitFor({ timeout: 30_000 });
  await page.waitForTimeout(900);
}
async function openStudio() {
  await openProject();
  await page.keyboard.press('Control+b');
  await page.locator('.plane').waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1200);
}
async function setCycleHud() {
  await page.locator('.project-main').evaluate((el) => {
    let component = el.__vueParentComponent;
    while (component && component.type?.__name !== 'ProjectView') component = component.parent;
    if (!component) throw new Error('ProjectView instance not found');
    const state = component.setupState;
    const current = state.props.project;
    const next = state.cycleProjects[0];
    if (!next) throw new Error('No other recent project to cycle to');
    state.cycleEntries = [
      { path: current.path, name: current.name, isSelf: true },
      { path: next.path, name: next.name, isSelf: false },
    ];
    state.cycleIndex = 1;
    state.cycling = true;
  });
}

switch (flow) {
  case 'row-open-click':
    await page.locator('.folder-btn').first().click();
    await page.locator('.greet').waitFor({ timeout: 30_000 });
    break;
  case 'row-open-enter':
    await page.locator('.folder-btn').first().focus();
    await page.keyboard.press('Enter');
    await page.locator('.greet').waitFor({ timeout: 30_000 });
    break;
  case 'switcher-pick':
    await openProject();
    await page.locator('.proj').click();
    await page.locator('.project-row').first().waitFor({ timeout: 10_000 });
    await page.locator('.project-row').first().click();
    await page.waitForTimeout(1000);
    break;
  case 'cycle-hud':
    await openProject();
    await setCycleHud();
    await page.waitForTimeout(500);
    break;
  case 'cycle-pick':
    await openProject();
    await setCycleHud();
    await page.locator('.project-main').evaluate((el) => {
      let component = el.__vueParentComponent;
      while (component && component.type?.__name !== 'ProjectView') component = component.parent;
      if (!component) throw new Error('ProjectView instance not found');
      const state = component.setupState;
      const entry = state.cycleEntries[state.cycleIndex];
      const target = state.cycleProjects.find((project) => project.path === entry?.path);
      state.cycling = false;
      state.cycleEntries = [];
      if (target) state.switchTo(target);
    });
    await page.waitForTimeout(900);
    break;
  case 'back-list':
    await openProject();
    await page.getByRole('button', { name: 'Back to projects' }).focus();
    await page.keyboard.press('Enter');
    await page.locator('.folder-btn').first().waitFor({ timeout: 20_000 });
    break;
  case 'studio-summon':
    await openStudio();
    break;
  case 'studio-close':
    await openStudio();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('.plane')?.classList.contains('portal-fade--hidden'), null, { timeout: 20_000 });
    break;
  case 'recent-session-pane':
    await page.locator('.rs__row[data-intent-session="demo-1:/review/kone"]').waitFor({ timeout: 30_000 });
    await page.locator('.rs__row[data-intent-session="demo-1:/review/kone"]').click();
    await page.locator('.col__head').first().waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1200);
    break;
  case 'round-trip':
    await openProject();
    await page.keyboard.press('Control+b');
    await page.waitForTimeout(800);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('.plane')?.classList.contains('portal-fade--hidden'), null, { timeout: 20_000 });
    break;
}

await page.waitForTimeout(500);
await page.screenshot({ path: output });
const state = await page.evaluate(() => ({
  path: document.querySelector('.greet')?.textContent?.trim() ?? null,
  planeHidden: document.querySelector('.plane')?.classList.contains('portal-fade--hidden') ?? null,
  columns: document.querySelectorAll('.col__head').length,
  cycleHud: Boolean(document.querySelector('.cycle-dock')),
  focused: document.activeElement?.getAttribute('aria-label') || document.activeElement?.className || document.activeElement?.tagName,
}));
console.log(JSON.stringify({ flow, theme, state }));
await browser.close();
