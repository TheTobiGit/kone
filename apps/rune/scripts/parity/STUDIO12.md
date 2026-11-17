Studio 12 reference captures

Start the reference server from `/workspace/thetobi-developer/kone-dev-ref/apps/web` on `127.0.0.1:3004`. Do not use this repository's `apps/web` as the reference. Set `PLAYWRIGHT_CORE` to the installed Playwright Core module directory.

```sh
node apps/rune/scripts/parity/capture-studio12-reference.cjs studio-final /tmp/studio12-reference
node apps/rune/scripts/parity/capture-studio12-reference.cjs studio-final-multi /tmp/studio12-reference
node apps/rune/scripts/parity/capture-studio12-reference.cjs studio-final-composer /tmp/studio12-reference
node apps/rune/scripts/parity/capture-studio12-reference.cjs studio-final-multi-hover /tmp/studio12-reference
node apps/rune/scripts/parity/capture-studio12-tooltip.cjs /tmp/studio12-reference
```

Both scripts capture 1280×840 content at device scale 2 in light and dark. On Linux the Rune window is borderless: capture at `--size 1280x840 --scale 2`, with no subsequent frame crop or rescaling. Compose Electron left and Rune right at their original pixel sizes.

The reference script seeds recent projects in localStorage, session title/usage/provider refs, and pane entries through Studio's runtime state and persistence API. It does not clone DOM cards, replace DOM text, hide `Opening…`, or alter styles. The main row has three panes; the Nova row has two and seeds Claude in its first session. Without live backing sessions, the main row's additional panes remain dormant; the Rune fixture preserves those states too. This is a visual fixture, not evidence of live agent or restart persistence behavior.

The tooltip script pauses existing CSS animations through the Web Animations API. It samples the animation clock directly instead of waiting and then taking a screenshot while the transition continues. Show samples are 250, 310, 370 and 450 ms; leave samples are 50 and 150 ms. Keep the toolbar icon row in crops: the parent's 200 ms fade multiplies the tooltip's own 120 ms fade on leave. Native samples use `--fps 100` and input at 0.2 s (leave at 0.7 s).

Older Studio 12 sheets that cloned `.col` DOM nodes, rewrote title text nodes, or suppressed dormant labels are not parity evidence. The pass-4 paths and outstanding limits are recorded in `docs/rune-port/CHECKPOINT.md`.
