//! kone's native shell.

mod assets;
mod plasma;
mod shell;

use gpui_kit::*;
use kone_theme::{Scheme, Theme};

/// Where AppKit puts the traffic lights, matching the Electron window's inset.
const TRAFFIC_LIGHTS: Point<Pixels> = Point { x: px(16.), y: px(6.) };

fn main() {
    gpui_kit::application().with_assets(assets::Assets).run(|cx: &mut App| {
        gpui_kit::init(cx);
        assets::load_fonts(cx).expect("bundled fonts load");
        Theme::init(cx);
        // A fixed scheme stops the window from following the system.
        let pinned = std::env::var("KONE_SCHEME").ok().map(|s| if s == "dark" { Scheme::Dark } else { Scheme::Light });
        if let Some(scheme) = pinned {
            Theme::set_scheme(scheme, cx);
        }
        sync_kit_mode(cx);

        let bounds = Bounds::centered(None, size(px(1280.), px(820.)), cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            window_min_size: Some(size(px(900.), px(600.))),
            titlebar: Some(TitlebarOptions {
                title: Some("kone".into()),
                appears_transparent: true,
                traffic_light_position: Some(TRAFFIC_LIGHTS),
            }),
            app_id: Some("dev.kone.native".into()),
            ..Default::default()
        };
        gpui_kit::open_window(options, cx, |window, cx| {
            // Follow the system appearance the way the web app's kone theme does.
            if pinned.is_none() {
                window
                    .observe_window_appearance(|window, cx| {
                        Theme::set_scheme(Scheme::from(window.appearance()), cx);
                        sync_kit_mode(cx);
                    })
                    .detach();
            }
            cx.new(shell::Shell::new)
        })
        .expect("main window opens");
        cx.activate(true);
    });
}

/// Kit's own widgets read Kit's theme; keep its light/dark in step with ours.
fn sync_kit_mode(cx: &mut App) {
    let mode = if Theme::get(cx).is_dark() {
        component::ThemeMode::Dark
    } else {
        component::ThemeMode::Light
    };
    component::Theme::change(mode, None, cx);
}
