//! Window chrome: no traffic lights, a draggable top band, and the standard
//! window keys served by the menu bar instead.

use gpui_kit::*;

actions!(kone, [Quit, CloseWindow, Minimize]);

pub fn init(cx: &mut App) {
    cx.on_action(|_: &Quit, cx| cx.quit());
    cx.on_action(|_: &CloseWindow, cx| {
        if let Some(w) = cx.active_window() {
            let _ = w.update(cx, |_, window, _| window.remove_window());
        }
    });
    cx.on_action(|_: &Minimize, cx| {
        if let Some(w) = cx.active_window() {
            let _ = w.update(cx, |_, window, _| window.minimize_window());
        }
    });
    cx.bind_keys([
        KeyBinding::new("cmd-q", Quit, None),
        KeyBinding::new("cmd-w", CloseWindow, None),
        KeyBinding::new("cmd-m", Minimize, None),
    ]);
    #[cfg(target_os = "linux")]
    cx.bind_keys([
        KeyBinding::new("ctrl-q", Quit, None),
        KeyBinding::new("ctrl-w", CloseWindow, None),
        KeyBinding::new("ctrl-m", Minimize, None),
    ]);
    cx.set_menus([
        Menu { name: "kone".into(), items: vec![MenuItem::action("Quit kone", Quit)], disabled: false },
        Menu {
            name: "Window".into(),
            items: vec![MenuItem::action("Minimize", Minimize), MenuItem::action("Close Window", CloseWindow)],
            disabled: false,
        },
    ]);
}

/// Hide AppKit's close, minimise and zoom buttons. The window keeps its
/// titled style, so it still resizes, rounds its corners and minimises.
#[cfg(target_os = "macos")]
pub fn hide_traffic_lights(window: &Window) {
    use objc2_app_kit::{NSView, NSWindowButton};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    let Ok(handle) = HasWindowHandle::window_handle(window) else { return };
    let RawWindowHandle::AppKit(h) = handle.as_raw() else { return };
    // SAFETY: an AppKit window handle's `ns_view` is a live NSView owned by
    // this window for as long as the window exists, and we are on the main thread.
    let view: &NSView = unsafe { h.ns_view.cast::<NSView>().as_ref() };
    let Some(ns_window) = view.window() else { return };
    for kind in [NSWindowButton::CloseButton, NSWindowButton::MiniaturizeButton, NSWindowButton::ZoomButton] {
        if let Some(button) = ns_window.standardWindowButton(kind) {
            button.setHidden(true);
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn hide_traffic_lights(_: &Window) {}
