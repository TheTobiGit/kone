use super::empty::StartPointer;
static FOLDER_META: Icon = Icon {
    name: "Folder01Icon",
    view: 24.0,
    body: r#"<path d="M8 7H16.75C18.8567 7 19.91 7 20.6667 7.50559C20.9943 7.72447 21.2755 8.00572 21.4944 8.33329C22 9.08996 22 10.1433 22 12.25C22 15.7612 22 17.5167 21.1573 18.7779C20.7926 19.3238 20.3238 19.7926 19.7779 20.1573C18.5167 21 16.7612 21 13.25 21H12C7.28595 21 4.92893 21 3.46447 19.5355C2 18.0711 2 15.714 2 11V7.94427C2 6.1278 2 5.21956 2.38032 4.53806C2.65142 4.05227 3.05227 3.65142 3.53806 3.38032C4.21956 3 5.1278 3 6.94427 3C8.10802 3 8.6899 3 9.19926 3.19101C10.3622 3.62712 10.8418 4.68358 11.3666 5.73313L12 7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static ROW_PIN: Icon = Icon {
    name: "row-pin",
    view: 24.0,
    body: r#"<path d="M3 21L8 16M13.2585 18.8714C9.51516 18.0215 5.97844 14.4848 5.12853 10.7415C4.99399 10.1489 4.92672 9.85266 5.12161 9.37197C5.3165 8.89129 5.55457 8.74255 6.03071 8.44509C7.10705 7.77265 8.27254 7.55888 9.48209 7.66586C11.1793 7.81598 12.0279 7.89104 12.4512 7.67048C12.8746 7.44991 13.1622 6.93417 13.7376 5.90269L14.4664 4.59604C14.9465 3.73528 15.1866 3.3049 15.7513 3.10202C16.316 2.89913 16.6558 3.02199 17.3355 3.26771C18.9249 3.84236 20.1576 5.07505 20.7323 6.66449C20.978 7.34417 21.1009 7.68401 20.898 8.2487C20.6951 8.8134 20.2647 9.05346 19.4039 9.53358L18.0672 10.2792C17.0376 10.8534 16.5229 11.1406 16.3024 11.568C16.0819 11.9955 16.162 12.8256 16.3221 14.4859C16.4399 15.7068 16.2369 16.88 15.5555 17.9697C15.2577 18.4458 15.1088 18.6839 14.6283 18.8786C14.1477 19.0733 13.8513 19.006 13.2585 18.8714Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static ROW_PIN_OFF: Icon = Icon {
    name: "row-pin-off",
    view: 24.0,
    body: r#"<path d="M7.5 8C6.95863 8.1281 6.49932 8.14239 5.99268 8.45891C5.07234 9.03388 4.85108 9.71674 5.08821 10.7612C5.94028 14.5139 9.48599 18.0596 13.2388 18.9117C14.2834 19.1489 14.9661 18.928 15.5416 18.0077C15.8411 17.5288 15.8716 17.0081 16 16.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 7.79915C12.1776 7.77794 12.3182 7.74034 12.4295 7.68235C13.3997 7.17686 13.9291 5.53361 14.4498 4.60009C14.9311 3.73715 15.1718 3.30567 15.7379 3.10227C16.3041 2.89888 16.6448 3.02205 17.3262 3.26839C18.9197 3.8445 20.1555 5.08032 20.7316 6.6738C20.9779 7.35521 21.1011 7.69591 20.8977 8.26204C20.6943 8.82817 20.2628 9.06884 19.3999 9.55018C18.4608 10.074 16.7954 10.6108 16.2905 11.5898C16.2345 11.6983 16.1978 11.8327 16.1769 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 21L8 16M3 3L21 21" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static ROW_ARCHIVE: Icon = Icon {
    name: "row-archive",
    view: 24.0,
    body: r#"<path d="M7 21H16.9999C19.3569 21 20.5354 21 21.2677 20.2678C21.9999 19.5355 21.9999 18.357 21.9999 16C21.9999 13.643 21.9999 12.4645 21.2677 11.7322C20.5354 11 19.3569 11 16.9999 11H7C4.64302 11 3.46453 11 2.7323 11.7322C2.00007 12.4644 2.00005 13.6429 2 15.9999C1.99995 18.357 1.99993 19.5355 2.73217 20.2677C3.4644 21 4.64294 21 7 21Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 11C4.00005 9.59977 4.00008 8.89966 4.27263 8.36485C4.5123 7.89455 4.89469 7.51218 5.365 7.27253C5.89981 7 6.59993 7 8.00015 7H16C17.4001 7 18.1002 7 18.635 7.27248C19.1054 7.51217 19.4878 7.89462 19.7275 8.36502C20 8.8998 20 9.59987 20 11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 7C6.00004 5.5998 6.00006 4.89969 6.27259 4.3649C6.51227 3.89457 6.89467 3.51218 7.36501 3.27252C7.89981 3 8.59991 3 10.0001 3H14C15.4001 3 16.1002 3 16.635 3.27248C17.1054 3.51217 17.4878 3.89462 17.7275 4.36502C18 4.8998 18 5.59987 18 7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 15L15.7 15.4C15.1111 16.1851 14.8167 16.5777 14.3944 16.7889C13.9721 17 13.4814 17 12.5 17H11.5C10.5186 17 10.0279 17 9.60557 16.7889C9.18328 16.5777 8.88885 16.1851 8.3 15.4L8 15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static DELETE: Icon = Icon {
    name: "Delete02Icon",
    view: 24.0,
    body: r#"<path d="M19.5 5.5L18.8803 15.5251C18.7219 18.0864 18.6428 19.3671 18.0008 20.2879C17.6833 20.7431 17.2747 21.1273 16.8007 21.416C15.8421 22 14.559 22 11.9927 22C9.42312 22 8.1383 22 7.17905 21.4149C6.7048 21.1257 6.296 20.7408 5.97868 20.2848C5.33688 19.3626 5.25945 18.0801 5.10461 15.5152L4.5 5.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 5.5H21M16.0557 5.5L15.3731 4.09173C14.9196 3.15626 14.6928 2.68852 14.3017 2.39681C14.215 2.3321 14.1231 2.27454 14.027 2.2247C13.5939 2 13.0741 2 12.0345 2C10.9688 2 10.436 2 9.99568 2.23412C9.8981 2.28601 9.80498 2.3459 9.71729 2.41317C9.32164 2.7167 9.10063 3.20155 8.65861 4.17126L8.05292 5.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.5 16.5L9.5 10.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M14.5 16.5L14.5 10.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
use super::empty::{COLORS_EASE, EASE, SEARCH, actions, rotating_wordmark, settings_button};
use crate::{
    project_state::{ProjectSession, ProjectSort},
    state::AppState,
    theme::{Palette, mix_srgb},
};
use rune::{
    AnimExt, Cursor, Curve, Cx, Easing, El, Family, Icon, ScrollSpec, Spring, TextStyle, col, el,
    icon, row, text, text_input,
};

static CLOCK: Icon = Icon {
    name: "session-clock",
    view: 24.0,
    body: r#"<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>"#,
};
static ARROW_DOWN: Icon = Icon {
    name: "arrow-down-01",
    view: 24.0,
    body: r#"<path d="M18 9C18 9 13.5811 15 12 15C10.4188 15 6 9 6 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static PROJECT_PIN: Icon = Icon {
    name: "project-pin",
    view: 24.0,
    body: r#"<path d="M3 21L8 16M13.2585 18.8714C9.51516 18.0215 5.97844 14.4848 5.12853 10.7415C4.99399 10.1489 4.92672 9.85266 5.12161 9.37197C5.3165 8.89129 5.55457 8.74255 6.03071 8.44509C7.10705 7.77265 8.27254 7.55888 9.48209 7.66586C11.1793 7.81598 12.0279 7.89104 12.4512 7.67048C12.8746 7.44991 13.1622 6.93417 13.7376 5.90269L14.4664 4.59604C14.9465 3.73528 15.1866 3.3049 15.7513 3.10202C16.316 2.89913 16.6558 3.02199 17.3355 3.26771C18.9249 3.84236 20.1576 5.07505 20.7323 6.66449C20.978 7.34417 21.1009 7.68401 20.898 8.2487C20.6951 8.8134 20.2647 9.05346 19.4039 9.53358L18.0672 10.2792C17.0376 10.8534 16.5229 11.1406 16.3024 11.568C16.0819 11.9955 16.162 12.8256 16.3221 14.4859C16.4399 15.7068 16.2369 16.88 15.5555 17.9697C15.2577 18.4458 15.1088 18.6839 14.6283 18.8786C14.1477 19.0733 13.8513 19.006 13.2585 18.8714Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static PROJECT_PINNED: Icon = Icon {
    name: "project-pinned",
    view: 24.0,
    body: r#"<path d="M3 21L8 16M13.2585 18.8714C9.51516 18.0215 5.97844 14.4848 5.12853 10.7415C4.99399 10.1489 4.92672 9.85266 5.12161 9.37197C5.3165 8.89129 5.55457 8.74255 6.03071 8.44509C7.10705 7.77265 8.27254 7.55888 9.48209 7.66586C11.1793 7.81598 12.0279 7.89104 12.4512 7.67048C12.8746 7.44991 13.1622 6.93417 13.7376 5.90269L14.4664 4.59604C14.9465 3.73528 15.1866 3.3049 15.7513 3.10202C16.316 2.89913 16.6558 3.02199 17.3355 3.26771C18.9249 3.84236 20.1576 5.07505 20.7323 6.66449C20.978 7.34417 21.1009 7.68401 20.898 8.2487C20.6951 8.8134 20.2647 9.05346 19.4039 9.53358L18.0672 10.2792C17.0376 10.8534 16.5229 11.1406 16.3024 11.568C16.0819 11.9955 16.162 12.8256 16.3221 14.4859C16.4399 15.7068 16.2369 16.88 15.5555 17.9697C15.2577 18.4458 15.1088 18.6839 14.6283 18.8786C14.1477 19.0733 13.8513 19.006 13.2585 18.8714Z" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static FINDER: Icon = Icon {
    name: "finder",
    view: 24.0,
    body: r#"<path d="M2.5 12C2.5 7.52166 2.5 5.28249 3.89124 3.89124C5.28249 2.5 7.52166 2.5 12 2.5C16.4783 2.5 18.7175 2.5 20.1088 3.89124C21.5 5.28249 21.5 7.52166 21.5 12C21.5 16.4783 21.5 18.7175 20.1088 20.1088C18.7175 21.5 16.4783 21.5 12 21.5C7.52166 21.5 5.28249 21.5 3.89124 20.1088C2.5 18.7175 2.5 16.4783 2.5 12Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 8V10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M17 8V10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 16.5C10.5 18.5 13.5 18.5 17 16.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M12.9896 2.5C12.1238 3.78525 10.5163 7.71349 10.0737 11.5798C9.98097 12.3899 9.9346 12.795 10.1905 13.1176C10.2151 13.1486 10.2474 13.1843 10.2757 13.212C10.5708 13.5 11.0149 13.5 11.9031 13.5C12.3889 13.5 12.6317 13.5 12.7766 13.6314C12.7923 13.6457 12.8051 13.6588 12.819 13.6748C12.9468 13.8225 12.9383 14.072 12.9212 14.5709C12.8685 16.1156 12.9401 19.0524 14 21.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static CANCEL: Icon = Icon {
    name: "cancel-01",
    view: 24.0,
    body: r#"<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>"#,
};
static BRANCH: Icon = Icon {
    name: "git-branch",
    view: 24.0,
    body: r#"<circle cx="6" cy="18" r="3" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="18" cy="6" r="3" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M6 15V3m12 6a9 9 0 0 1-9 9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>"#,
};
static REPO_MARK: Icon = Icon {
    name: "project-repo-mark",
    view: 16.0,
    body: r#"<path fill="currentColor" fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8C0 11.54 2.29 14.53 5.47 15.59C5.87 15.66 6.02 15.42 6.02 15.21C6.02 15.02 6.01 14.39 6.01 13.72C4 14.09 3.48 13.23 3.32 12.78C3.23 12.55 2.84 11.84 2.5 11.65C2.22 11.5 1.82 11.13 2.49 11.12C3.12 11.11 3.57 11.7 3.72 11.94C4.44 13.15 5.59 12.81 6.05 12.6C6.12 12.08 6.33 11.73 6.56 11.53C4.78 11.33 2.92 10.64 2.92 7.58C2.92 6.71 3.23 5.99 3.74 5.43C3.66 5.23 3.38 4.41 3.82 3.31C3.82 3.31 4.49 3.1 6.02 4.13C6.66 3.95 7.34 3.86 8.02 3.86C8.7 3.86 9.38 3.95 10.02 4.13C11.55 3.09 12.22 3.31 12.22 3.31C12.66 4.41 12.38 5.23 12.26 5.43C12.81 5.99 13.12 6.7 13.12 7.58C13.12 10.65 11.25 11.33 9.47 11.53C9.76 11.78 10.01 12.26 10.01 13.01C10.01 14.08 10 14.94 10 15.21C10 15.42 10.15 15.67 10.55 15.59C13.71 14.53 16 11.53 16 8C16 3.58 12.42 0 8 0Z"/>"#,
};

pub(super) fn folder_with_git(name: &str, t: Palette, tree: &serde_json::Value) -> El {
    folder_with_git_hover(name, t, tree, false)
}

fn folder_with_git_hover(name: &str, t: Palette, tree: &serde_json::Value, active: bool) -> El {
    let (sheet_top, sheet_bottom, pocket_top, pocket_middle, pocket_bottom, shadow) = if t.dark {
        (
            mix_srgb(t.ground, t.ink, 0.068),
            mix_srgb(t.ground, t.ink, 0.04),
            mix_srgb(t.ground, t.ink, 0.094),
            mix_srgb(t.ground, t.ink, 0.057),
            mix_srgb(t.ground, t.ink, 0.035),
            t.ground.alpha(0.3),
        )
    } else {
        (
            mix_srgb(t.raised, t.ink, 0.052),
            mix_srgb(t.raised, t.ink, 0.123),
            mix_srgb(t.raised, t.ink, 0.013),
            mix_srgb(t.raised, t.ink, 0.077),
            mix_srgb(t.raised, t.ink, 0.12),
            t.ink.alpha(0.06),
        )
    };
    let sheet = el()
        .size(168.0, 44.0)
        .radius(16.0)
        .fill(sheet_bottom)
        .linear_gradient(
            160_f32.to_radians(),
            [(0.0, sheet_top), (1.0, sheet_bottom)],
        )
        .absolute(16.0, 6.0);
    let changes = tree["changes"].as_array();
    let branch = tree["branch"].as_str();
    let added: i64 = changes
        .into_iter()
        .flatten()
        .map(|c| c["added"].as_i64().unwrap_or(0))
        .sum();
    let removed: i64 = changes
        .into_iter()
        .flatten()
        .map(|c| c["removed"].as_i64().unwrap_or(0))
        .sum();
    let mut pocket = col()
        .size(200.0, 92.0)
        .radius(22.0)
        .focus_ring(2.0, 3.0, t.ink.alpha(0.26))
        .justify_end()
        .px(18.0)
        .pb(15.0)
        .fill(pocket_bottom)
        .linear_gradient(
            168_f32.to_radians(),
            [
                (0.0, pocket_top),
                (0.55, pocket_middle),
                (1.0, pocket_bottom),
            ],
        )
        .shadow(4.0, 10.0, shadow)
        .absolute(0.0, 24.0)
        .child({
            let mut name_row = row().w_full().items_end().gap(9.0);
            if tree.is_object() {
                let mark = if t.dark {
                    mix_srgb(t.ground, t.ink, 0.937)
                } else {
                    mix_srgb(t.ink, t.ink_soft, 0.565)
                };
                name_row = name_row.child(icon(&REPO_MARK, 16.0).color(mark));
            }
            name_row.child(
                text(name.to_owned())
                    .font(TextStyle::new(17.0, 400.0).lh(17.0).tracking(-0.408))
                    .color(t.ink)
                    .help(name.to_owned())
                    .shrink()
                    .min_w(0.0)
                    .truncate(),
            )
        });
    if let Some(branch) = branch {
        let mut meta = row().w_full().center_y().justify_between().gap(6.0).child(
            row()
                .center_y()
                .gap(6.0)
                .shrink()
                .min_w(0.0)
                .child(icon(&BRANCH, 12.0).color(t.muted))
                .child(
                    text(branch.to_owned())
                        .font(
                            TextStyle::new(11.0, 400.0)
                                .lh(11.0)
                                .tracking(0.2)
                                .family(Family::Mono),
                        )
                        .color(t.muted)
                        .shrink()
                        .min_w(0.0)
                        .truncate(),
                ),
        );
        if added > 0 || removed > 0 {
            let mut diff = row().center_y().gap(12.0);
            if added > 0 {
                diff = diff.child(
                    text(format!("+{added}"))
                        .font(TextStyle::new(12.5, 400.0).lh(12.5).family(Family::Mono))
                        .color(
                            rune::color::hex(if t.dark { "#10b981" } else { "#059669" }).unwrap(),
                        ),
                );
            }
            if removed > 0 {
                diff = diff.child(
                    text(format!("−{removed}"))
                        .font(TextStyle::new(12.5, 400.0).lh(12.5).family(Family::Mono))
                        .color(rune::color::hex("#e11d48").unwrap()),
                );
            }
            meta = meta.child(diff);
        }
        pocket = pocket.gap(7.0).child(meta);
    }
    let mut stage = el().size(200.0, 116.0).child(sheet);
    for (i, change) in changes.into_iter().flatten().take(3).enumerate() {
        let add = change["added"].as_i64().unwrap_or(0);
        let del = change["removed"].as_i64().unwrap_or(0);
        let path = change["path"].as_str().unwrap_or("");
        let seed: usize = path.chars().map(|c| c as usize).sum();
        let jitter = |base: i32, i: usize| (base + ((seed + i * 7) % 5) as i32 - 2).max(6) as f32;
        let status = change["status"].as_str().unwrap_or("");
        let is_new = matches!(status, "added" | "untracked");
        let context = if t.dark {
            mix_srgb(t.ground, t.ink, 0.446)
        } else {
            mix_srgb(t.raised_high, t.faint, 0.5)
        };
        let green = rune::color::hex(if t.dark { "#12b981" } else { "#059669" }).unwrap();
        let red = rune::color::hex("#e11d48").unwrap();
        let marks = if add > 0 && del > 0 {
            vec![
                (jitter(16, 0), context),
                (jitter(10, 1), red),
                (jitter(13, 2), green),
            ]
        } else if add > 0 || is_new {
            vec![
                (jitter(15, 0), green),
                (jitter(10, 1), green),
                (jitter(8, 2), context),
            ]
        } else if del > 0 {
            vec![
                (jitter(15, 0), red),
                (jitter(9, 1), red),
                (jitter(7, 2), context),
            ]
        } else {
            vec![(15.0, context), (10.0, context)]
        };
        let mut mark_col = col().gap(3.0);
        if status != "deleted" {
            for (width, color) in marks {
                mark_col = mark_col.child(el().size(width, 3.0).radius(2.0).fill(color));
            }
        }
        let mut paper = col()
            .key(format!("project-paper-{i}"))
            .size(50.0, 62.0)
            .px(8.0)
            .pt(8.0)
            .gap(2.0)
            .radius(6.0)
            .fill(if t.dark {
                mix_srgb(t.raised_high, t.ink, 0.057)
            } else {
                t.raised_high
            })
            .shadow(0.0, 4.0, t.line)
            .child(icon(super::file_icons::for_path(path), 10.0).color(t.ink))
            .child(mark_col);
        if status == "deleted" {
            paper = paper.opacity(0.9).border(1.5, red).border_dash(3.0, 2.0);
        }
        let spring = Spring::from_stiffness_damping(340.0, 15.0, 0.7);
        let angle = [-10.0_f32, 1.0, 11.0][i] + if active { [-6.0, 0.0, 6.0][i] } else { 0.0 };
        stage = stage.child(
            paper
                .absolute([44.0, 78.0, 112.0][i], [0.0, -6.0, 0.0][i])
                .origin(0.0, 0.0)
                .rotate(angle.to_radians())
                .rotate_motion(spring.delay(if active { i as f32 * 0.04 } else { 0.0 }))
                .offset(
                    if active { [-14.0, 0.0, 14.0][i] } else { 0.0 },
                    if active { [-4.0, -5.0, -4.0][i] } else { 0.0 },
                )
                .offset_motion(spring.delay(if active { i as f32 * 0.04 } else { 0.0 })),
        );
    }
    stage.child(pocket)
}

/// `HomeRecent`'s corner chip: the signed-in user's initial in a 30 pt ink disc,
/// shown once a machine name resolves and easing up 5% on hover.
fn profile_chip(s: &AppState, t: Palette) -> Option<El> {
    let name = s.profile.name.clone()?;
    Some(
        el().key("profile-chip")
            .ml(2.0)
            .size(30.0, 30.0)
            .radius(15.0)
            .center()
            .fill(t.ink)
            .scale(if s.profile_hover { 1.05 } else { 1.0 })
            .scale_motion(Curve::tween(0.3, Easing::cubic(0.0, 0.0, 0.2, 1.0)))
            .role("button")
            .label(format!("Open profile — {name}"))
            .focusable(true)
            .cursor(Cursor::Pointer)
            .help(name)
            .on_hover_change(|s: &mut AppState, over, _| s.profile_hover = over)
            .child(
                text(s.profile.initial.clone())
                    .font(TextStyle::new(13.0, 400.0).lh(13.0))
                    .color(t.ground),
            ),
    )
}

pub fn view(s: &AppState, cx: &mut Cx<AppState>) -> El {
    let t = Palette::new(cx.system_dark());
    let mut trailing = row()
        .center_y()
        .gap(12.0)
        .child(settings_button(t))
        .child(
            row()
                .h(36.0)
                .px(12.0)
                .gap(10.0)
                .center_y()
                .radius(11.0)
                .fill(t.hover)
                .child(icon(&SEARCH, 15.0).color(t.muted))
                .child(
                    text_input(&s.search, TextStyle::new(14.0, 400.0))
                        .key("project-search")
                        .w(176.0)
                        .single_line()
                        .placeholder("Search projects", t.muted)
                        .color(t.ink)
                        .on_edit(|s: &mut AppState| &mut s.search),
                )
                .child(
                    el().px(6.0)
                        .py(2.0)
                        .radius(5.0)
                        .border(1.0, t.muted.alpha(0.25))
                        .child(
                            text("⌘K")
                                .font(TextStyle::new(10.0, 400.0).family(Family::Mono).lh(10.0))
                                .color(t.muted),
                        ),
                ),
        )
        .child(
            row()
                .h(36.0)
                .px(12.0)
                .center_y()
                .gap(6.0)
                .radius(11.0)
                .hover(t.hover)
                .focus_highlight(t.hover)
                .role("button")
                .label("Change project sort order")
                .focusable(true)
                .cursor(rune::Cursor::Pointer)
                .child(
                    text(match s.project_data.sort {
                        ProjectSort::Recent => "Recent",
                        ProjectSort::Name => "Name",
                    })
                    .font(TextStyle::new(14.0, 400.0))
                    .color(t.ink_soft),
                )
                .child(icon(&ARROW_DOWN, 12.0).color(t.muted))
                .on_press(|s: &mut AppState| {
                    s.project_data.sort = match s.project_data.sort {
                        ProjectSort::Recent => ProjectSort::Name,
                        ProjectSort::Name => ProjectSort::Recent,
                    };
                }),
        );
    if let Some(chip) = profile_chip(s, t) {
        trailing = trailing.child(chip);
    }
    let header = row()
        .w_full()
        .center_y()
        .justify_between()
        .child(rotating_wordmark(t, &s.start_actions))
        .child(trailing);
    // Electron shows the repository mark while the first status read is pending.
    let loading_summary = serde_json::json!({});
    let mut cells: Vec<El> = s
        .sorted_projects()
        .into_iter()
        .filter(|(_, p)| {
            p.name
                .to_lowercase()
                .contains(&s.search.text.trim().to_lowercase())
        })
        .map(|(i, p)| {
            let path = p.path.clone();
            let hover_path = path.clone();
            let press_path = path.clone();
            let pin_path = path.clone();
            let reveal_path = path.clone();
            let forget_path = path.clone();
            let pinned = s.project_data.metadata.get(&path).is_some_and(|m| m.pinned);
            let active = s.project_data.hovered_project.as_deref() == Some(path.as_str())
                && s.launcher.mode.is_none();
            let pressed =
                active && s.project_data.pressed_project.as_deref() == Some(path.as_str());
            let spring = Spring::from_stiffness_damping(420.0, 38.0, 0.85);
            let action = |label: &'static str,
                          title: &'static str,
                          glyph: &'static Icon,
                          size: f32,
                          ink: rune::Color| {
                el().size(24.0, 24.0)
                    .center()
                    .radius(12.0)
                    .focus_ring(2.0, 2.0, t.ink.alpha(0.34))
                    .role("button")
                    .label(label)
                    .help(title)
                    .focusable(s.launcher.mode.is_none())
                    .cursor(rune::Cursor::Pointer)
                    .hover_group()
                    .child(icon(glyph, size).color(ink).group_color(t.ink))
            };
            let controls = col()
                .gap(6.0)
                .self_center()
                .group_opacity(0.0, 1.0)
                .offset(
                    if active { 0.0 } else { 4.0 },
                    if active { -6.0 } else { 0.0 },
                )
                .offset_motion(Spring::from_stiffness_damping(500.0, 30.0, 1.0))
                .child(
                    action(
                        if pinned {
                            "Unpin project"
                        } else {
                            "Pin to top"
                        },
                        if pinned { "Unpin" } else { "Pin to top" },
                        if pinned {
                            &PROJECT_PINNED
                        } else {
                            &PROJECT_PIN
                        },
                        14.0,
                        if pinned { t.ink } else { t.muted },
                    )
                    .on_press(move |s: &mut AppState| s.pin_project(pin_path.clone())),
                )
                .child(
                    action(
                        "Reveal in Finder",
                        "Reveal in Finder",
                        &FINDER,
                        15.0,
                        t.muted,
                    )
                    .on_press(move |s: &mut AppState| s.reveal_project(reveal_path.clone())),
                )
                .child(
                    action("Remove from recents", "Remove", &CANCEL, 14.0, t.muted)
                        .on_press(move |s: &mut AppState| s.forget_project(forget_path.clone())),
                );
            let tile = row()
                .h(123.8)
                .items_start()
                .gap(12.0)
                .hover_group_focus()
                .on_hover_focus_change(move |s: &mut AppState, over, _| {
                    if over {
                        s.project_data.hovered_project = Some(hover_path.clone());
                    } else if s.project_data.hovered_project.as_deref() == Some(hover_path.as_str())
                    {
                        s.project_data.hovered_project = None;
                    }
                })
                .child(
                    folder_with_git_hover(
                        &p.name,
                        t,
                        s.project_data
                            .summaries
                            .get(&p.path)
                            .unwrap_or(&loading_summary),
                        active,
                    )
                    .key(format!("project-{i}"))
                    .role("button")
                    .label(format!("Open {}", p.name))
                    .focusable(s.launcher.mode.is_none())
                    .cursor(rune::Cursor::Pointer)
                    .press_scale(0.985)
                    .offset(
                        0.0,
                        if pressed {
                            -3.0
                        } else if active {
                            -6.0
                        } else {
                            0.0
                        },
                    )
                    .offset_motion(spring)
                    .on_drag(move |s: &mut AppState, drag, _| match drag.phase {
                        rune::Phase::Down => {
                            s.project_data.pressed_project = Some(press_path.clone())
                        }
                        rune::Phase::Up => s.project_data.pressed_project = None,
                        rune::Phase::Move => {}
                    })
                    .on_press(move |s: &mut AppState| {
                        if s.launcher.mode.is_none() {
                            s.open_project(path.clone());
                        }
                    }),
                )
                .child(controls);
            // The source button's inline folder leaves a line-box descender below its
            // 116 pt artwork; it contributes eight points to an all-card grid row.
            el().w(236.0).h(124.0).child(tile)
        })
        .collect();
    let no_matches = cells.is_empty();
    cells.push(
        el().w(236.0)
            .self_center()
            .child(actions(t, s, cx.is_reduced_motion()).offset(-6.0, 0.0)),
    );
    let mut grid = col().gap(24.0);
    let mut iter = cells.into_iter();
    loop {
        let Some(first) = iter.next() else { break };
        let mut line = row().w_full().gap(56.0).items_start().child(first);
        for _ in 0..2 {
            if let Some(cell) = iter.next() {
                line = line.child(cell);
            }
        }
        grid = grid.child(line);
    }
    if no_matches {
        grid = grid.child(
            el().pb(24.0).child(
                text(format!("No projects match “{}”", s.search.text))
                    .font(
                        TextStyle::new(12.0, 400.0)
                            .family(Family::Mono)
                            .tracking(0.3),
                    )
                    .color(t.muted),
            ),
        );
    }
    col()
        .apply_start_pointer(cx.is_reduced_motion())
        .w_full()
        .h_full()
        .fill(t.ground)
        .px(64.0)
        .pt(20.0)
        .pb(64.0)
        .child(header)
        .child(
            row()
                .w_full()
                .justify_center()
                .pt(96.0)
                .child(col().w(820.0).child(grid)),
        )
        .child(
            row()
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                .justify_center()
                .pt(96.0)
                .child(
                    col()
                        .key("home-sessions")
                        .w(820.0)
                        .h_full()
                        .scroll(ScrollSpec {
                            stick_bottom: false,
                        })
                        .clip_fade_linear(0.0, 0.0, 0.0, 44.0)
                        .child(sessions(s, &s.project_data.home_sessions, t, true).pb(24.0)),
                ),
        )
}

fn time_ago(timestamp: i64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    time_ago_at(timestamp, now)
}

fn time_ago_at(timestamp: i64, now: i64) -> String {
    let seconds = (now - timestamp).max(0) / 1000;
    if seconds < 45 {
        return "just now".into();
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return format!("{minutes}m ago");
    }
    let hours = minutes / 60;
    if hours < 24 {
        return format!("{hours}h ago");
    }
    let days = hours / 24;
    if days < 7 {
        return format!("{days}d ago");
    }
    let weeks = days / 7;
    if weeks < 5 {
        return format!("{weeks}w ago");
    }
    let months = days / 30;
    if months < 12 {
        format!("{months}mo ago")
    } else {
        format!("{}y ago", days / 365)
    }
}

fn token_count(tokens: i64) -> String {
    if tokens >= 1_000_000 {
        let value = format!("{:.2}", tokens as f64 / 1_000_000.0);
        format!("{}M", value.trim_end_matches('0').trim_end_matches('.'))
    } else if tokens >= 1000 {
        let value = tokens as f64 / 1000.0;
        if value >= 100.0 {
            format!("{value:.0}K")
        } else {
            let value = format!("{value:.1}");
            format!("{}K", value.strip_suffix(".0").unwrap_or(&value))
        }
    } else {
        tokens.to_string()
    }
}

fn session_cost(session: &ProjectSession) -> f64 {
    if let Some(cost) = session.cost {
        return cost;
    }
    let model = session.model.to_lowercase();
    let rate = if model.contains("opus") {
        24.0
    } else if model.contains("haiku") {
        1.4
    } else if model.contains("sonnet") {
        4.8
    } else if model.contains("flash") {
        0.2
    } else if model.contains("pro")
        && (model.contains("gemini") || session.provider == "antigravity")
    {
        1.5
    } else if (model.contains("mini") && !model.contains("gemini"))
        || model.contains("deepseek")
        || model.contains("r1")
    {
        0.45
    } else if model.contains("o1") || model.contains("o3") {
        6.0
    } else if session.provider == "claudeAgent" {
        4.8
    } else if session.provider == "antigravity" {
        1.5
    } else {
        3.5
    };
    session.tokens.max(0) as f64 / 1_000_000.0 * rate
}

pub(super) fn sessions(s: &AppState, sessions: &[ProjectSession], t: Palette, home: bool) -> El {
    let mut list = col().w_full().gap(40.0);
    let mut first = true;
    for (pinned, label) in [(true, "PINNED"), (false, "RECENT")] {
        let group: Vec<_> = sessions
            .iter()
            .filter(|session| session.pinned == pinned)
            .collect();
        if group.is_empty() {
            continue;
        }
        let tint = if pinned { t.warn } else { t.faint };
        let mut head = row().w_full().center_y().justify_between().child(
            row()
                .center_y()
                .gap(7.0)
                .child(icon(if pinned { &PROJECT_PIN } else { &CLOCK }, 11.0).color(tint))
                .child(
                    text(label)
                        .font(
                            TextStyle::new(10.0, 400.0)
                                .family(Family::Mono)
                                .tracking(1.4),
                        )
                        .color(tint),
                ),
        );
        if first {
            let mut toggle = row()
                .center_y()
                .gap(2.0)
                .padding(2.0)
                .radius(8.0)
                .fill(t.hover);
            for (label, cost) in [("Tokens", false), ("Cost", true)] {
                let selected = s.project_data.metric_cost == cost;
                let mut button = el().px(7.0).py(2.0).radius(6.0);
                if selected {
                    button = button.fill(t.ground).shadow(1.0, 2.0, t.ink.alpha(0.08));
                }
                toggle = toggle.child(
                    button
                        .child(
                            text(label)
                                .font(
                                    TextStyle::new(10.0, 400.0)
                                        .family(Family::Mono)
                                        .lh(14.0)
                                        .tracking(0.4),
                                )
                                .color(if selected { t.ink } else { t.muted }),
                        )
                        .on_press(move |s: &mut AppState| s.project_data.metric_cost = cost),
                );
            }
            head = head.child(toggle);
            first = false;
        }
        let mut rows = col().w_full().gap(22.0);
        for session in group {
            let id = session.id.clone();
            let path = session.project_path.clone();
            let hovered = s.project_data.hovered_session.as_deref() == Some(id.as_str());
            let mut metadata = row().gap(10.0).center_y();
            let mono = TextStyle::new(11.0, 400.0).family(Family::Mono);
            metadata = metadata.child(
                text(session.agent_name.clone())
                    .font(mono)
                    .color(t.ink_soft),
            );
            if home
                && let Some(project) = std::path::Path::new(&path)
                    .file_name()
                    .and_then(|p| p.to_str())
            {
                metadata = metadata.child(
                    row()
                        .center_y()
                        .gap(5.0)
                        .child(icon(&FOLDER_META, 12.0).color(t.ink_soft))
                        .child(text(project.to_owned()).font(mono).color(t.ink_soft)),
                );
            }
            if let Some(branch) = &session.branch {
                metadata = metadata.child(
                    row()
                        .center_y()
                        .gap(5.0)
                        .child(icon(&BRANCH, 12.0).color(t.muted))
                        .child(text(branch.clone()).font(mono).color(t.muted)),
                );
            }
            if session.added > 0 {
                metadata = metadata.child(
                    text(format!("+{}", session.added))
                        .font(mono)
                        .color(rune::color::hex("#059669").unwrap()),
                );
            }
            if session.removed > 0 {
                metadata = metadata.child(
                    text(format!("−{}", session.removed))
                        .font(mono)
                        .color(rune::color::hex("#e11d48").unwrap()),
                );
            }
            if session.added == 0 && session.removed == 0 && !session.model.is_empty() {
                metadata = metadata.child(text(session.model.clone()).font(mono).color(t.muted));
            }
            metadata = metadata.child(text(time_ago(session.updated_at)).font(mono).color(t.muted));
            let mut trail = row().w(86.0).h(40.0).center_y().justify_end();
            if hovered {
                let action_font = TextStyle::new(11.0, 400.0).lh(11.0).tracking(-0.11);
                let mut actions = row().center_y().gap(4.0);
                for (label, aria, action, glyph) in [
                    (
                        if session.pinned { "Unpin" } else { "Pin" },
                        if session.pinned {
                            "Unpin conversation"
                        } else {
                            "Pin conversation"
                        },
                        "pin",
                        if session.pinned {
                            &ROW_PIN_OFF
                        } else {
                            &ROW_PIN
                        },
                    ),
                    ("Archive", "Archive conversation", "archive", &ROW_ARCHIVE),
                ] {
                    let action_id = id.clone();
                    let action_path = path.clone();
                    let pinned = session.pinned;
                    let ink = if pinned && action == "pin" {
                        t.warn
                    } else {
                        t.muted
                    };
                    actions = actions.child(
                        el().px(6.0)
                            .py(3.0)
                            .radius(7.0)
                            .role("button")
                            .label(aria)
                            .focusable(true)
                            .focus_ring(2.0, 2.0, t.ink.alpha(0.3))
                            .hover_group()
                            .cursor(Cursor::Pointer)
                            .child(
                                row()
                                    .center_y()
                                    .gap(5.0)
                                    .child(icon(glyph, 12.0).color(ink).group_color(t.ink))
                                    .child(
                                        text(label).font(action_font).color(ink).group_color(t.ink),
                                    ),
                            )
                            .on_press(move |s: &mut AppState| {
                                s.session_action(
                                    action_path.clone(),
                                    action_id.clone(),
                                    action,
                                    pinned,
                                )
                            }),
                    );
                }
                let delete_id = id.clone();
                let delete_path = path.clone();
                actions = actions.child(
                    el().px(6.0)
                        .py(3.0)
                        .radius(7.0)
                        .role("button")
                        .label("Hold to delete conversation")
                        .hover_group()
                        .cursor(Cursor::Pointer)
                        .child(
                            row()
                                .center_y()
                                .gap(5.0)
                                .child(icon(&DELETE, 12.0).color(t.muted).group_color(t.ink))
                                .child(
                                    text("Delete")
                                        .font(action_font)
                                        .color(t.muted)
                                        .group_color(t.ink),
                                ),
                        )
                        .on_drag(move |s: &mut AppState, drag, _| match drag.phase {
                            rune::Phase::Down => {
                                s.project_data.delete_hold = Some(std::time::Instant::now())
                            }
                            rune::Phase::Up => {
                                let held = s.project_data.delete_hold.take().is_some_and(|start| {
                                    start.elapsed() >= std::time::Duration::from_millis(850)
                                });
                                if held
                                    && !drag.cancelled()
                                    && drag.x >= 0.0
                                    && drag.y >= 0.0
                                    && drag.x <= drag.w
                                    && drag.y <= drag.h
                                {
                                    s.session_action(
                                        delete_path.clone(),
                                        delete_id.clone(),
                                        "delete",
                                        false,
                                    );
                                }
                            }
                            rune::Phase::Move => {}
                        }),
                );
                trail = trail.child(actions);
            } else {
                let cost = session_cost(session);
                let value = if s.project_data.metric_cost && cost > 0.0 {
                    Some(if cost < 0.01 {
                        "<$0.01".to_owned()
                    } else {
                        format!("${cost:.2}")
                    })
                } else if !s.project_data.metric_cost && session.tokens > 0 {
                    Some(token_count(session.tokens))
                } else {
                    None
                };
                if let Some(value) = value {
                    trail = trail.child(
                        col()
                            .items_end()
                            .child(
                                text(value)
                                    .font(
                                        TextStyle::new(22.0, 400.0)
                                            .family(Family::Mono)
                                            .lh(28.0)
                                            .tracking(-0.44),
                                    )
                                    .color(t.ink),
                            )
                            .child(
                                text(if s.project_data.metric_cost {
                                    "USD"
                                } else {
                                    "TOKENS"
                                })
                                .font(
                                    TextStyle::new(9.0, 400.0)
                                        .family(Family::Mono)
                                        .lh(12.0)
                                        .tracking(0.9),
                                )
                                .color(t.faint),
                            ),
                    );
                }
            }
            let hover_id = id.clone();
            rows = rows.child(
                row()
                    .w_full()
                    .pr(14.0)
                    .gap(14.0)
                    .center_y()
                    .radius(10.0)
                    .hover_group_focus()
                    .hover_motion(
                        Curve::tween(0.16, COLORS_EASE),
                        Curve::tween(0.16, COLORS_EASE),
                    )
                    .focus_ring(2.0, 2.0, t.ink.alpha(0.3))
                    .focusable(true)
                    .cursor(Cursor::Pointer)
                    .scale(if hovered { 1.009 } else { 1.0 })
                    .origin(0.0, 0.5)
                    .scale_motion(Curve::tween(0.34, EASE))
                    .child(identity_lead(
                        &session.avatar_svg,
                        session.avatar.as_deref(),
                        &session.provider,
                        t,
                        hovered,
                    ))
                    .child(
                        col()
                            .grow(1.0)
                            .gap(6.0)
                            .child(
                                text(session.title.clone())
                                    .font(TextStyle::new(16.0, 400.0).tracking(-0.16))
                                    .color(if hovered {
                                        t.ink
                                    } else if t.dark {
                                        t.muted
                                    } else {
                                        t.ink_soft
                                    })
                                    .truncate(),
                            )
                            .child(metadata),
                    )
                    .child(trail)
                    .on_hover_focus_change(move |s: &mut AppState, over, _| {
                        if over {
                            s.project_data.hovered_session = Some(hover_id.clone());
                        } else if s.project_data.hovered_session.as_deref()
                            == Some(hover_id.as_str())
                        {
                            s.project_data.hovered_session = None;
                        }
                    })
                    .on_press(move |s: &mut AppState| {
                        if home {
                            s.open_home_session(path.clone(), id.clone())
                        } else {
                            s.open_recent_session(id.clone())
                        }
                    }),
            );
        }
        list = list.child(col().w_full().gap(14.0).child(head).child(rows));
    }
    list
}

static PROVIDER_CLAUDE: Icon = Icon {
    name: "provider-claude",
    view: 256.0,
    body: r#"<path d="m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z" fill="currentColor" fill-rule="evenodd"/>"#,
};

static PROVIDER_GPT: Icon = Icon {
    name: "provider-gpt",
    view: 24.0,
    body: r#"<path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.911 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.182a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.998-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.142-.08 4.778-2.758a.795.795 0 0 0 .393-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.495 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.677l5.815 3.354-2.02 1.169a.076.076 0 0 1-.071 0l-4.83-2.787A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.856-5.833-3.388L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.666zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.062l4.83-2.786a4.5 4.5 0 0 1 6.68 4.66zM8.307 12.863l-2.02-1.164a.08.08 0 0 1-.038-.057V6.074a4.5 4.5 0 0 1 7.376-3.454l-.142.08L8.704 5.46a.795.795 0 0 0-.393.68zm1.098-2.366 2.602-1.5 2.607 1.5v3l-2.597 1.5-2.607-1.5z" fill="currentColor" fill-rule="evenodd"/>"#,
};

static PROVIDER_CURSOR: Icon = Icon {
    name: "provider-cursor",
    view: 24.0,
    body: r#"<path d="M22.07 5.7L12.5 0.18C12.19 0 11.81 0 11.5 0.18L1.93 5.7C1.67 5.85 1.51 6.13 1.51 6.43V17.57C1.51 17.87 1.67 18.15 1.93 18.3L11.5 23.82C11.81 24 12.19 24 12.5 23.82L22.07 18.3C22.33 18.15 22.49 17.87 22.49 17.57V6.43C22.49 6.13 22.33 5.85 22.07 5.7H22.07ZM21.47 6.87L12.23 22.88C12.16 22.99 12 22.94 12 22.82V12.34C12 12.13 11.89 11.94 11.71 11.83L2.63 6.59C2.52 6.53 2.57 6.36 2.69 6.36H21.17C21.44 6.36 21.6 6.65 21.47 6.88H21.47Z" fill="currentColor" fill-rule="evenodd"/>"#,
};

static PROVIDER_OPENCODE: Icon = Icon {
    name: "provider-opencode",
    view: 24.0,
    body: r#"<path d="M22 24H2V0h20zM17 4.8H7v14.4h10z" fill="currentColor" fill-rule="evenodd"/>"#,
};

pub(super) fn identity_lead(
    svg: &str,
    avatar: Option<&str>,
    brand: &str,
    t: Palette,
    hovered: bool,
) -> El {
    use std::sync::{Arc, OnceLock};
    static IMAGES: OnceLock<rune::ImageCache> = OnceLock::new();
    let cache = IMAGES.get_or_init(|| rune::ImageCache::new(Arc::new(|| {})));
    let avatar_image = avatar.and_then(|src| {
        use base64::Engine;
        if src == "/agents/kone.jpg" {
            Some(cache.load(include_bytes!("../../../web/public/agents/kone.jpg").as_slice()))
        } else {
            let (header, data) = src.strip_prefix("data:")?.split_once(',')?;
            let mime = header.strip_suffix(";base64")?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data)
                .ok()?;
            Some(cache.load_mime(bytes, mime, 36.0, 2.0))
        }
    });
    let image = avatar_image
        .filter(|image| image.wait().is_ok())
        .unwrap_or_else(|| {
            let fallback = cache.svg(Arc::<[u8]>::from(svg.as_bytes()), 36.0, 2.0);
            let _ = fallback.wait();
            fallback
        });
    let (mark, color) = match brand {
        "claude" | "claudeAgent" => (&PROVIDER_CLAUDE, rune::color::hex("#d97757").unwrap()),
        "codex" => (&PROVIDER_GPT, t.ink),
        "gpt" | "openai" => (&PROVIDER_GPT, t.ink),
        "cursor" => (&PROVIDER_CURSOR, t.ink),
        "opencode" => (&PROVIDER_OPENCODE, t.ink),
        _ => (&PROVIDER_DOT, t.ink),
    };
    let (width, badge_size, badge_x, badge_y, icon_size, badge_color) = if hovered {
        (78.0, 36.0, 42.0, 0.0, 20.0, mix_srgb(t.ground, t.ink, 0.06))
    } else {
        (36.0, 21.8, 20.1, 20.1, 12.7, t.ground)
    };
    el().size(width, 36.0)
        .child(
            el().size(36.0, 36.0)
                .radius(18.0)
                .pixels_fit(image.pixels(), rune::SurfaceFit::Fill)
                .absolute(0.0, 0.0),
        )
        .child(
            el().size(badge_size, badge_size)
                .radius(badge_size / 2.0)
                .fill(badge_color)
                .center()
                .absolute(badge_x, badge_y)
                .child(icon(mark, icon_size).color(color)),
        )
}

static PROVIDER_DOT: Icon = Icon {
    name: "provider-dot",
    view: 24.0,
    body: r#"<circle cx="12" cy="12" r="4.5" fill="currentColor"/>"#,
};

#[cfg(test)]
mod session_tests {
    #[test]
    fn clicking_a_pressed_card_opens_its_project() {
        use rune::{Env, Runtime};
        let mut state = AppState::default();
        crate::review::populate(&mut state, crate::state::Page::Projects);
        let mut rt = Runtime::new(state, view, (1280.0, 840.0), Env::default());
        rt.frame(0.0);
        let (x, y) = rt.find("project-0").expect("project card");
        rt.pointer_move(x, y);
        rt.pointer_down(x, y);
        rt.frame(1.0 / 60.0);
        rt.pointer_up(x, y);
        rt.frame(2.0 / 60.0);
        rt.update(|s, _| {
            assert_eq!(s.page, crate::state::Page::Overview);
            assert!(s.project_data.pressed_project.is_none());
        });
    }
    #[test]
    fn focus_aware_hover_notifies_once_per_group_transition() {
        use rune::{Cx, El, Env, Key, KeyEvent, Mods, Runtime, col, el};
        use std::{cell::RefCell, rc::Rc};
        type Events = Rc<RefCell<Vec<bool>>>;
        fn view(_: &Events, _: &mut Cx<Events>) -> El {
            col()
                .child(
                    col()
                        .size(100.0, 40.0)
                        .hover_group_focus()
                        .on_hover_focus_change(|events: &mut Events, over, _| {
                            events.borrow_mut().push(over)
                        })
                        .child(el().size(30.0, 20.0).focusable(true))
                        .child(el().size(30.0, 20.0).focusable(true)),
                )
                .child(el().size(30.0, 30.0).focusable(true))
        }
        let events = Rc::new(RefCell::new(Vec::new()));
        let mut rt = Runtime::new(events.clone(), view, (200.0, 100.0), Env::default());
        rt.frame(0.0);
        for expected in [&[true][..], &[true][..], &[true, false][..]] {
            rt.key(KeyEvent {
                key: Key::Tab,
                mods: Mods::default(),
            });
            rt.frame(0.0);
            rt.frame(1.0 / 60.0);
            assert_eq!(&*events.borrow(), expected);
        }
    }

    #[test]
    fn pointer_only_hover_does_not_fire_for_keyboard_focus() {
        use rune::{Cx, El, Env, Key, KeyEvent, Mods, Runtime, col, el};
        use std::{cell::RefCell, rc::Rc};
        type Events = Rc<RefCell<Vec<bool>>>;
        fn view(_: &Events, _: &mut Cx<Events>) -> El {
            col()
                .size(100.0, 40.0)
                .hover_group_focus()
                .on_hover_change(|events: &mut Events, over, _| events.borrow_mut().push(over))
                .child(el().size(30.0, 30.0).focusable(true))
        }
        let events = Rc::new(RefCell::new(Vec::new()));
        let mut rt = Runtime::new(events.clone(), view, (200.0, 100.0), Env::default());
        rt.frame(0.0);
        rt.key(KeyEvent {
            key: Key::Tab,
            mods: Mods::default(),
        });
        rt.frame(0.0);
        rt.frame(1.0 / 60.0);
        assert!(events.borrow().is_empty());
    }
    use super::*;
    #[test]
    fn formats_source_time_and_tokens() {
        assert_eq!(time_ago_at(0, 44_000), "just now");
        assert_eq!(time_ago_at(0, 45_000), "0m ago");
        assert_eq!(time_ago_at(0, 8 * 86_400_000), "1w ago");
        assert_eq!(token_count(12_400), "12.4K");
        assert_eq!(token_count(1_240_000), "1.24M");
    }
}
