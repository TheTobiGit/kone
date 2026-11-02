//! kone's native shell.

mod assets;
mod chrome;
mod clone;
mod clone_modal;
mod create_project;
mod folder_picker;
mod magnet;
mod path_complete;
mod projects;
mod shell;
mod strands;

use gpui_kit::*;
use kone_theme::{Scheme, Theme};

fn main() {
    gpui_kit::application().with_assets(assets::Assets).run(|cx: &mut App| {
        gpui_kit::init(cx);
        assets::load_fonts(cx).expect("bundled fonts load");
        chrome::init(cx);
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
                traffic_light_position: None,
            }),
            app_id: Some("dev.kone.native".into()),
            window_background: shell::frame_mode().background(),
            // No server title bar on Linux. Kit's window border then draws the
            // shadow and resize edges; our frame band drags, as on macOS.
            #[cfg(target_os = "linux")]
            window_decorations: Some(WindowDecorations::Client),
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
            chrome::hide_traffic_lights(window);
            cx.new(|cx| shell::Shell::new(window, cx))
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
    // Kit's root paints its theme background under every window; ours draws
    // its own surfaces, and the frame has to let the desktop through.
    component::Theme::global_mut(cx).tokens.background = transparent_black().into();
}
