// Source server must be kone-dev-ref/apps/web on :3004. Pause existing CSS animations; never rewrite styles.
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const out = process.argv[2] || '/tmp/studio12-reference';
require('node:fs').mkdirSync(out, { recursive: true });
(async () => {
    const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    for (const theme of ['light', 'dark']) {
        const c = await b.newContext({ viewport: { width: 1280, height: 840 }, deviceScaleFactor: 2, colorScheme: theme });
        await c.addInitScript(() => localStorage.setItem('kone:recent-projects', JSON.stringify([{ name: 'kone', path: '/review/kone', lastOpenedAt: 1 }])));
        const p = await c.newPage();
        await p.goto('http://127.0.0.1:3004/');
        await p.locator('.folder-btn').first().click();
        await p.locator('.project-nav').waitFor();
        await p.keyboard.press('Control+b');
        await p.locator('.col__head').first().waitFor();
        await p.waitForTimeout(900);
        await p.evaluate(() => { let c = document.querySelector('.col').__vueParentComponent; while (c && c.type?.__name !== 'ThreadStrip')
            c = c.parent; const s = c.props.panes[0].session; s.title.value = 'Review thread'; s.blocks.value = [{ id: 'fixture', role: 'user', text: 'Hello from review', at: Date.now() }]; s.worktreePath.value = '/tmp/kone-review-worktree'; s.tokenUsage.value = { contextUsed: 40000, contextWindow: 200000, compactsAutomatically: true }; });
        await p.waitForTimeout(500);
        const tip = p.locator('.col__tool[data-tip="Hand off to another provider"]').first();
        for (const ms of [250, 310, 370, 450]) {
            await p.mouse.move(5, 830);
            await p.waitForTimeout(200);
            await p.locator('.col__head').first().hover();
            await p.waitForTimeout(400);
            await tip.hover();
            await p.evaluate(ms => { const el = document.querySelector('.col__tool[data-tip="Hand off to another provider"]'); getComputedStyle(el, '::after').opacity; for (const a of el.getAnimations({ subtree: true })) {
                a.pause();
                a.currentTime = ms;
            } }, ms);
            console.log(theme, ms, await tip.evaluate(el => ({ opacity: getComputedStyle(el, '::after').opacity, animations: el.getAnimations({ subtree: true }).map(a => ({ property: a.transitionProperty, time: a.currentTime })) })));
            await p.screenshot({ path: `${out}/e-${theme}-${ms}.png` });
            await tip.evaluate(el => el.getAnimations({ subtree: true }).forEach(a => a.finish()));
        }
        for (const ms of [50, 150]) {
            await tip.hover();
            await p.waitForTimeout(500);
            await p.mouse.move(5, 830);
            await p.evaluate(ms => { const el = document.querySelector('.col__tool[data-tip="Hand off to another provider"]'); getComputedStyle(el, '::after').opacity; for (const a of document.getAnimations()) {
                if (a.effect?.target === el || a.effect?.target === el.parentElement) {
                    a.pause();
                    a.currentTime = ms;
                }
            } }, ms);
            console.log(theme, 'out', ms, await tip.evaluate(el => getComputedStyle(el, '::after').opacity));
            await p.screenshot({ path: `${out}/e-${theme}-out${ms}.png` });
            await tip.evaluate(el => el.getAnimations({ subtree: true }).forEach(a => a.finish()));
        }
        await c.close();
    }
    await b.close();
})().catch(e => { console.error(e); process.exit(1); });
