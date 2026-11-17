// Run the server from kone-dev-ref/apps/web at 127.0.0.1:3004.
// Seed application data only. Never clone or rewrite rendered reference nodes.
// Usage: PLAYWRIGHT_CORE=/absolute/path/to/playwright-core node THIS_FILE SCENE OUTDIR
// Scenes: studio-final, studio-final-composer, studio-final-multi, studio-final-multi-hover.
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const fs = require('node:fs');
const [scene = 'studio-final', out = '/tmp/studio12-reference'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
(async () => {
    const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    for (const theme of ['light', 'dark']) {
        const c = await b.newContext({ viewport: { width: 1280, height: 840 }, deviceScaleFactor: 2, colorScheme: theme });
        await c.addInitScript(multi => localStorage.setItem('kone:recent-projects', JSON.stringify([{ name: 'kone', path: '/review/kone', lastOpenedAt: 1 }, ...(multi ? [{ name: 'nova', path: '/review/nova', lastOpenedAt: 0 }] : [])])), scene.includes('multi'));
        const p = await c.newPage();
        p.on('pageerror', e => console.error(e.message));
        await p.goto('http://127.0.0.1:3004/');
        await p.locator('.folder-btn').first().waitFor();
        await p.locator('.folder-btn').first().click();
        await p.locator('.project-nav').waitFor();
        await p.keyboard.press('Control+b');
        await p.locator('.col__head').first().waitFor();
        await p.waitForTimeout(800);
        await p.evaluate(({ multi, usage }) => {
            let ts = document.querySelector('.col').__vueParentComponent;
            while (ts && ts.type?.__name !== 'ThreadStrip') ts = ts.parent;
            const s = ts.props.panes[0].session;
            s.title.value = 'Studio overview review';
            if (usage) {
                s.tokenUsage.value = { contextUsed: 4200, contextWindow: 10000, compactsAutomatically: true };
            }
            if (multi) {
            let row = ts;
            while (row && row.type?.__name !== 'StudioRow')
                row = row.parent;
            const st = row.setupState, base = st.studio.entries.value[0];
            st.studio.entries.value = [base, ...['review-two', 'review-three'].map(id => ({ ...base, id, anchor: { kind: 'thread', threadId: null } }))];
            st.persistRow();
            st.studioStore.saveRow({ projectPath: '/review/nova', focusedId: 'nova-one', panes: ['nova-one', 'nova-two'].map(id => ({ id, kind: 'thread', width: 0, anchor: { kind: 'thread', threadId: id } })) });
            }
        }, { multi: scene.includes('multi'), usage: scene !== 'studio-final' });
        await p.waitForTimeout(5500);
        if (scene.includes('multi')) {
            await p.keyboard.press('Control+Shift+O');
            await p.waitForTimeout(1500);
            await p.evaluate(() => {
                const slot = document.querySelectorAll('.plane__slot')[1];
                let ts = slot.querySelector('.col').__vueParentComponent;
                while (ts && ts.type?.__name !== 'ThreadStrip') ts = ts.parent;
                ts.props.panes[0].session.provider.value = 'claudeAgent';
            });
        }
        if (scene.includes('composer'))
            await p.getByRole('button', { name: 'Wake the agent' }).first().click();
        await p.mouse.move(1, 839);
        await p.waitForTimeout(1200);
        if (scene.includes('hover')) {
            await p.mouse.move(300, 200);
            await p.waitForTimeout(500);
        }
        console.log(scene, theme, await p.evaluate(() => ({ cards: document.querySelectorAll('.col').length, slots: document.querySelectorAll('.plane__slot').length, opening: document.querySelectorAll('.col__dormant').length, attach: document.querySelector('.attach')?.outerHTML, selected: [...document.querySelectorAll('.col.is-focused')].map(e => ({ background: getComputedStyle(e).backgroundColor, shadow: getComputedStyle(e).boxShadow })), nova: document.querySelectorAll('.plane__slot')[1]?.querySelector('.col__map-label path')?.getAttribute('fill') })));
        await p.screenshot({ path: `${out}/e-${scene}-${theme}.png` });
        await c.close();
    }
    await b.close();
})().catch(e => { console.error(e); process.exit(1); });
