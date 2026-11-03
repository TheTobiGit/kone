//! State and tile rendering for the recent-projects home component.
use gpui_kit::base::input::InputState;
use kone_theme::hsla;

pub(crate) struct Home {
    /// The recent projects, in launcher order; `None` until the first read lands.
    pub(crate) recents: Option<Vec<crate::projects::RecentProject>>,
    pub(crate) tiles: std::collections::HashMap<String, crate::recents::Tile>,
    pub(crate) hovered: Option<String>,
    /// Addition and removal tweens, by path.
    /// Set while rendering a tile that is outside the scroll view.
    pub(crate) count_hold: bool,
    pub(crate) tile_counts: std::collections::HashMap<String, [crate::recents::CountMotion; 2]>,
    /// Each tile's hover springs, by path.
    pub(crate) tile_motion: std::collections::HashMap<String, crate::recents::TileMotion>,
    pub(crate) entry_motion: Option<std::collections::HashMap<String, crate::recents::EntryMotion>>,
    pub(crate) start_entry: Option<crate::recents::EntryMotion>,
    /// Keyboard focus in the grid: (cell, stop). Cells are the shown tiles
    /// then the start actions; see `recents::slots` for the stops.
    pub(crate) kb: Option<(usize, usize)>,
    /// A tile the keyboard focus follows across a reorder (a pin from the keys).
    pub(crate) kb_follow: Option<(String, usize)>,
    /// The grid's scroller, so keyboard focus can bring its row into view.
    pub(crate) grid_scroll: ScrollHandle,
    /// The row last brought into view for the keyboard.
    pub(crate) kb_row: Option<usize>,
    pub(crate) query: Entity<InputState>,
    pub(crate) sort: crate::recents::Sort,
    pub(crate) _query_sub: Subscription,
    pub(crate) _recents_task: Option<Task<()>>,
}

impl Home {
    pub(crate) fn new(query: Entity<InputState>, query_sub: Subscription) -> Self {
        Self {
            recents: None,
            tiles: Default::default(),
            hovered: None,
            count_hold: false,
            tile_counts: Default::default(),
            tile_motion: Default::default(),
            entry_motion: None,
            start_entry: None,
            kb: None,
            kb_follow: None,
            grid_scroll: ScrollHandle::new(),
            kb_row: None,
            query,
            sort: crate::recents::Sort::Recent,
            _query_sub: query_sub,
            _recents_task: None,
        }
    }
}

use super::*;

impl Home {
    /// One tile, and whether its hover springs still need frames.
    /// `focus` is the keyboard stop inside this tile, if it has one.
    pub(crate) fn tile(
        &mut self,
        project: &RecentProject,
        busy: bool,
        focus: Option<usize>,
        now: Duration,
        c: &Palette,
        cx: &mut Context<Shell>,
    ) -> (AnyElement, bool) {
        let key = project.path.clone();
        // Electron's isActive: pointer over it or keyboard focus inside it.
        let active = !busy && (self.hovered.as_deref() == Some(key.as_str()) || focus.is_some());
        let motion = self.tile_motion.entry(key.clone()).or_default();
        let (lift_t, side_t, moving) = motion.sample(active, now);
        let (paper_t, paper_moving) = motion.papers(now);
        let (entry, entering) = self.entry_motion.as_mut()
            .and_then(|motions| motions.get_mut(&key)).map(|m| m.sample(now)).unwrap_or((1., false));
        let scale = entry_scale(entry);
        let inset_x = TILE_W * (1. - scale) / 2.;
        let inset_y = TILE_H * (1. - scale) / 2.;
        let mut moving = moving || paper_moving || entering;
        let pinned = project.pinned == Some(true);
        let tile = self.tiles.get(&key);
        let missing = matches!(tile, Some(Tile::Missing));
        let lift = -6. * lift_t;
        // Position rides the spring's overshoot as Electron's x/y do; only
        // the opacity is held to 0..1.
        let fade = side_t.clamp(0., 1.);

        let mut meta = div().flex().items_center().gap(px(10.)).h(px(13.)).font_family(crate::folder_picker::MONO).text_size(px(11.5));
        match tile {
            Some(Tile::Missing) => {
                meta = meta.child(div().text_color(hsla(c.muted)).child("Folder not found"));
            }
            Some(Tile::Repo(s, partial)) => {
                // As Electron's CountUp: nothing counts until the tile is first
                // in view, so an offscreen row still counts up when scrolled to.
                let (added, removed) = if self.count_hold && !self.tile_counts.contains_key(&key) {
                    (0, 0)
                } else {
                    let counts = self.tile_counts.entry(key.clone()).or_default();
                    let (added, adding) = counts[0].sample(s.added, now);
                    let (removed, removing) = counts[1].sample(s.removed, now);
                    moving |= adding || removing;
                    (added, removed)
                };
                let branch = match &s.branch {
                    Branch::Named(n) => Some(n.clone()),
                    Branch::Detached(sha) => Some(sha.clone()),
                    Branch::Unknown => None,
                };
                if let Some(b) = branch {
                    meta = meta.child(
                        div().flex().items_center().gap(px(5.)).min_w(px(0.)).text_color(hsla(c.muted))
                            .child(svg().path("icons/git-branch.svg").size(px(12.)).flex_shrink_0().text_color(hsla(c.muted)))
                            .child(div().min_w(px(0.)).max_w(px(100.)).truncate().child(b)),
                    );
                }
                if s.added > 0 || s.removed > 0 || added > 0 || removed > 0 || *partial {
                    let mut diff = div().flex().gap(px(5.)).flex_shrink_0();
                    if s.added > 0 || added > 0 || *partial {
                        diff = diff.child(div().flex().text_color(hsla(if kone_theme::Theme::get(cx).is_dark() { kone_theme::Rgba::hex(0x10b981) } else { c.diff_add }))
                            .child(format!("+{}", group(added)))
                            .when(*partial, |d| d.child(div().id(SharedString::from(format!("partial:{key}")))
                                .text_color(hsla(c.muted)).child("+").tooltip(tip("Partial: very large change set")))));
                    }
                    if s.removed > 0 || removed > 0 {
                        diff = diff.child(div().text_color(hsla(c.diff_del)).child(format!("−{}", group(removed))));
                    }
                    meta = meta.child(diff);
                }
            }
            _ => {}
        }

        let papers = match tile { Some(Tile::Repo(s, _)) => s.files.iter().take(3).cloned().collect(), _ => Vec::new() };
        let paper_colors = PaperColors::new(c, kone_theme::Theme::get(cx).is_dark());
        let pocket_bg = c.raised;
        let sheet_bg = c.raised_high;
        let folder = div()
            .id(SharedString::from(format!("tile:{key}")))
            .relative()
            .w(px(TILE_W * scale))
            .h(px(TILE_H * scale))
            .left(px(inset_x))
            .top(px(lift + inset_y))
            .when(missing, |d| d.opacity(0.55))
            .when(!busy, |d| {
                let path = key.clone();
                d.cursor_pointer().on_click(cx.listener(move |this, _, window, cx| {
                    this.open_project(std::path::PathBuf::from(&path), window, cx)
                }))
            })
            // The back sheet peeking above the pocket.
            .child(div().absolute().left(px(16. * scale)).top(px(6. * scale)).w(px(168. * scale)).h(px(44. * scale)).rounded(px(15.)).bg(hsla(sheet_bg)).border_1().border_color(hsla(c.line_soft)))
            .child(canvas(move |_, _, _| (), move |bounds, _, window, cx| {
                paint_papers(bounds, &papers, paper_t, &paper_colors, window, cx);
            }).absolute().size_full())
            .child(
                div()
                    .absolute()
                    .left_0()
                    .bottom_0()
                    .w(px(TILE_W * scale))
                    .h(px(POCKET_H * scale))
                    .rounded(px(22.))
                    .bg(hsla(pocket_bg))
                    .border_1()
                    .border_color(hsla(if active { c.line } else { c.line_soft }))
                    .shadow(vec![BoxShadow {
                        color: black().opacity(0.06 + 0.06 * lift_t.clamp(0., 1.)),
                        offset: point(px(0.), px(4.)),
                        blur_radius: px(10.),
                        spread_radius: px(0.),
                        inset: false,
                    }])
                    .flex()
                    .flex_col()
                    .justify_end()
                    .gap(px(7. * scale))
                    .px(px(18. * scale))
                    .pb(px(15. * scale))
                    .child(
                        div()
                            .flex()
                            .items_end()
                            .gap(px(9. * scale))
                            .min_w(px(0.))
                            .when(tile.is_none() || matches!(tile, Some(Tile::Repo(_, _))), |d| {
                                d.child(svg().path("icons/gh-mark.svg").size(px(15. * scale)).flex_shrink_0().text_color(hsla(c.ink_soft)))
                            })
                            .child(
                                div()
                                    .id(SharedString::from(format!("name:{key}")))
                                    .when(!busy, |d| d.tooltip(tip(project.name.clone())).tooltip_show_delay(Duration::from_millis(500)))
                                    .min_w(px(0.))
                                    .truncate()
                                    .text_size(px(17. * scale))
                                    .line_height(px(17. * scale))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(hsla(c.ink))
                                    .child(project.name.clone()),
                            ),
                    )
                    .child(meta),
            )
            // Electron rings the pocket, not the whole button, on keyboard focus.
            .when(focus == Some(0), |d| {
                d.child(ring(22., 3., c.ink.alpha(0.26)).left(px(-5.)).top(px(TILE_H - POCKET_H - 5.)))
            });

        let side = |id: &str, icon: &'static str, label: &'static str, on: bool, ringed: bool, cx: &mut Context<Shell>, act: fn(&mut Shell, String, &mut Window, &mut Context<Shell>)| {
            let path = key.clone();
            div()
                .id(SharedString::from(format!("{id}:{key}")))
                .relative()
                .size(px(24.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(7.))
                // Like Electron's pointer-events: none, a column on its way out
                // takes no pointer at all: no hand, no wash, no clicks, no tips.
                .when(active, |d| {
                    d.cursor_pointer()
                        .hover(|s| s.bg(hsla(c.hover)))
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .on_click(cx.listener(move |this, _, window, cx| {
                            cx.stop_propagation();
                            // As Electron's onSideAction: drop hover and focus so the
                            // tile doesn't stay lifted after a reorder, a file
                            // manager window, or its own removal.
                            this.home.hovered = None;
                            this.clear_kb();
                            act(this, path.clone(), window, cx)
                        }))
                        .tooltip(tip(label)).tooltip_show_delay(Duration::from_millis(500))
                })
                .when(ringed, |d| d.child(ring(7., 2., c.ink.alpha(0.34))))
                .child(svg().path(icon).size(px(14.)).text_color(hsla(if on { c.ink } else { c.muted })))
        };
        let actions = div()
            .absolute()
            .top(px(-6. * side_t))
            .bottom(px(6. * side_t))
            // Slides in 4px from the right as it fades up.
            .left(px(TILE_W + 12. + 4. * (1. - side_t)))
            .flex()
            .flex_col()
            .justify_center()
            .gap(px(6.))
            .opacity(fade)
            .when(fade < 0.01, |d| d.invisible())
            .child(side("pin", "icons/pin.svg", if pinned { "Unpin" } else { "Pin to top" }, pinned, focus == Some(1), cx, |this, p, _, cx| this.toggle_pin(p, cx)))
            .child(side("reveal", "icons/finder.svg", REVEAL_TIP, false, focus == Some(2), cx, |this, p, _, cx| this.reveal(p, cx)))
            .child(side("forget", "icons/cancel.svg", "Remove", false, focus == Some(3), cx, |this, p, _, cx| this.forget(p, cx)));

        let hover_key = key.clone();
        let el = div()
            .id(SharedString::from(format!("cell:{key}")))
            .relative()
            .w(px(CELL_W))
            .h(px(TILE_H))
            .top(px(12. * (1. - entry)))
            .opacity(entry.clamp(0., 1.))
            .pr(px(ACTIONS_W))
            .when(!busy, |d| d.on_hover(cx.listener(move |this, over: &bool, _, cx| {
                let next = if *over { Some(hover_key.clone()) } else if this.home.hovered.as_deref() == Some(hover_key.as_str()) { None } else { return };
                if this.home.hovered != next {
                    this.home.hovered = next;
                    cx.notify();
                }
            })))
            .child(folder)
            .child(actions)
            .into_any_element();
        (el, moving)
    }
}
