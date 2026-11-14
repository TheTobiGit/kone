//! `Cx::selection_rects`: the line boxes of the [`El::selectable`](crate::El::selectable)
//! text selection, for a view that places something over it (a Quote button). It is a layout
//! read like `Cx::layout`, under a key no element can have, so it settles, replays from
//! `memo` and re-runs the view the same way; the boxes ride along with the rects the view is
//! given.
use super::*;

/// The layout-read key `Cx::selection_rects` reads under.
pub(crate) const SELECTION: &str = "\u{1}selection";

impl<S> Cx<S> {
    /// The line boxes of the text selection, `[x, y, w, h]` each in window points after
    /// scrolling, in reading order: one per line of each selected text, as its highlight draws
    /// them. Empty (and allocating nothing) when nothing is selected or only a caret is placed.
    /// Boxes aren't clipped to their scroll viewport, so a view can tell when the selection has
    /// scrolled out of sight. Only mounted texts have boxes: the rows of a virtual list that
    /// scrolled away have none. Like [`Cx::layout`], boxes are layout points: an ancestor's
    /// [`El::scale`](crate::El::scale) isn't applied.
    ///
    /// A view that reads it re-runs when a box appears, goes, or moves by more than half a
    /// point: in the same commit when layout moved it, the next frame when the selection
    /// changed or scrolling moved it. While a drag changes the selection that's every frame,
    /// so a toolbar that waits for the release
    /// ([`SelectionChange::dragging`](crate::SelectionChange::dragging)) should only read it
    /// once shown. A `memo` that reads it is rebuilt when the boxes move.
    pub fn selection_rects(&self) -> Vec<[f32; 4]> {
        layout_read::note_read(&mut self.layout_reads.borrow_mut(), SELECTION, None);
        crate::memo::read_selection(&self.layout.selection);
        self.layout.selection.to_vec()
    }
}

/// Bytes `a..b` of the text at a path.
pub(crate) type SelectedRange = (String, usize, usize);

/// Whether any box of `a` and `b` differs by more than half a point, or one has a box the
/// other lacks.
pub(crate) fn boxes_moved(a: &[[f32; 4]], b: &[[f32; 4]]) -> bool {
    a.len() != b.len() || a.iter().zip(b).any(|(x, y)| layout_read::moved(Some(*x), Some(*y)))
}

impl<S: 'static> Runtime<S> {
    /// The selection's line boxes laid out in the last commit's nodes.
    pub(super) fn selection_boxes(&self) -> Vec<[f32; 4]> {
        let mut out = Vec::new();
        for (i, a, b) in self.selection_ranges() { self.text_boxes(&self.nodes, i, a, b, &mut out); }
        for (i, n) in self.nodes.iter().enumerate() {
            if let Some(inp) = &n.input
                && inp.edit.focused && !inp.edit.is_secure()
            {
                let (a, b) = inp.edit.range();
                self.text_boxes(&self.nodes, i, a, b, &mut out);
            }
        }
        out
    }

    /// The selection's ranges by the path of each selected text. A measure reads them before it
    /// runs: reusing a `memo` moves its nodes out of the last commit's, leaving placeholders
    /// the selection can't be found in.
    pub(crate) fn selection_by_path(&self) -> Vec<SelectedRange> {
        let mut ranges: Vec<_> = self.selection_ranges().into_iter().map(|(i, a, b)| (self.nodes[i].path.clone(), a, b)).collect();
        for n in &self.nodes {
            if let Some(inp) = &n.input
                && inp.edit.focused && !inp.edit.is_secure()
            {
                let (a, b) = inp.edit.range();
                if a != b { ranges.push((n.path.clone(), a, b)); }
            }
        }
        ranges
    }

    /// The line boxes of `ranges` laid out in a measure's `nodes`, found there by path.
    pub(super) fn selection_boxes_in(&self, nodes: &[Node], ranges: &[SelectedRange]) -> Vec<[f32; 4]> {
        let mut out = Vec::new();
        for (path, a, b) in ranges {
            if let Some(j) = nodes.iter().position(|n| n.path == *path) { self.text_boxes(nodes, j, *a, *b, &mut out); }
        }
        out
    }

    /// Pushes the line boxes of bytes `a..b` of node `j`'s text onto `out`.
    fn text_boxes(&self, nodes: &[Node], j: usize, a: usize, b: usize, out: &mut Vec<[f32; 4]>) {
        let n = &nodes[j];
        let (Some(spec), Some(layout)) = (&n.text, &n.text_layout) else { return };
        let len = spec.content.len();
        let (a, b) = (a.min(len), b.min(len));
        if a >= b { return; }
        let (a, b) = n.elided.map_or((a, b), |e| e.range(a, b));
        let [x, y, w, h] = self.laid_out(nodes, j);
        let s = self.env.scale;
        let [ox, oy] = links::origin(n, spec, layout, [x, y, x + w, y + h], s, 1.0);
        for (bb, _) in crate::text::range_boxes(layout, a, b, true) {
            let (x0, y0) = (ox + bb.x0 as f32 / s + spec.selection_offset[0], oy + bb.y0 as f32 / s + spec.selection_offset[1]);
            let [px, py] = spec.selection_padding;
            let rect = [x0 - px, y0 - py, (bb.x1 - bb.x0) as f32 / s + px * 2.0, (bb.y1 - bb.y0) as f32 / s + py * 2.0];
            out.push(if spec.selection_pixel_snap {
                let [x, y, w, h] = rect;
                let (left, top) = ((x * s).round() / s, (y * s).round() / s);
                [left, top, ((x + w) * s).round() / s - left, ((y + h) * s).round() / s - top]
            } else { rect });
        }
    }

    /// Once a frame: the selection moved since the view last read it (a drag, a click, code,
    /// scrolling). That isn't layout feedback, so the view re-runs as for a state change.
    pub(super) fn selection_read_moved(&self) -> bool {
        let seen = &self.layout_seen.rects;
        seen.contains_key(SELECTION) && boxes_moved(&seen.selection, &self.selection_boxes())
    }
}
