use rune::{Cx, El, Icon, ScrollSpec, TextStyle, col, el, icon, row, text, text_input};

use crate::{
    state::{AppState, StudioState},
    theme::Palette,
};

pub(super) static FOOTER_COPY01: Icon = Icon {
    name: "footer-Copy01",
    view: 24.0,
    body: r#"<path d="M9 15C9 12.1716 9 10.7574 9.87868 9.87868C10.7574 9 12.1716 9 15 9L16 9C18.8284 9 20.2426 9 21.1213 9.87868C22 10.7574 22 12.1716 22 15V16C22 18.8284 22 20.2426 21.1213 21.1213C20.2426 22 18.8284 22 16 22H15C12.1716 22 10.7574 22 9.87868 21.1213C9 20.2426 9 18.8284 9 16L9 15Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M16.9999 9C16.9975 6.04291 16.9528 4.51121 16.092 3.46243C15.9258 3.25989 15.7401 3.07418 15.5376 2.90796C14.4312 2 12.7875 2 9.5 2C6.21252 2 4.56878 2 3.46243 2.90796C3.25989 3.07417 3.07418 3.25989 2.90796 3.46243C2 4.56878 2 6.21252 2 9.5C2 12.7875 2 14.4312 2.90796 15.5376C3.07417 15.7401 3.25989 15.9258 3.46243 16.092C4.51121 16.9528 6.04291 16.9975 9 16.9999" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static FOOTER_FOOTPRINTS: Icon = Icon {
    name: "footer-Footprints",
    view: 24.0,
    body: r#"<path d="M15.5 17H20M17.0192 6C19.5072 6 21 8 21 11C21 12.5022 20.7401 13.9522 20.4642 15.0312C20.2122 16.017 20.0362 17.0241 19.965 18.0394C19.8371 19.8655 19.2971 22 17.0192 22C14.6308 22 14.5312 19 15.5264 16.5C16.1931 14 14.0336 12.4 14.0336 10C13.8678 8.66667 14.2327 6 17.0192 6Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.5 13H4M6.98077 2C4.49279 2 3 4 3 7C3 8.50224 3.25994 9.95224 3.53576 11.0312C3.78776 12.017 3.9638 13.0241 4.03495 14.0394C4.16293 15.8655 4.70287 18 6.98077 18C9.36923 18 9.46875 15 8.47355 12.5C7.8069 10 9.96637 8.4 9.96637 6C10.1322 4.66667 9.76728 2 6.98077 2Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

static CONNECTOR_CORNER: Icon = Icon {
    name: "conversation-connector-corner",
    view: 12.0,
    body: r#"<path d="M12 0 Q0 0 0 12" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>"#,
};

static SETTING_ARROW: Icon = Icon {
    name: "studio-setting-arrow",
    view: 24.0,
    body: r#"<path d="M9.00005 6C9.00005 6 15 10.4189 15 12C15 13.5812 9 18 9 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
/// Live replies only: the Electron fixture footers carry no fork affordance.
static FOOTER_GITFORK: Icon = Icon {
    name: "footer-GitFork",
    view: 24.0,
    body: r#"<path d="M6 8C7.10457 8 8 7.10457 8 6C8 4.89543 7.10457 4 6 4C4.89543 4 4 4.89543 4 6C4 7.10457 4.89543 8 6 8Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 20C13.1046 20 14 19.1046 14 18C14 16.8954 13.1046 16 12 16C10.8954 16 10 16.8954 10 18C10 19.1046 10.8954 20 12 20Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 8C19.1046 8 20 7.10457 20 6C20 4.89543 19.1046 4 18 4C16.8954 4 16 4.89543 16 6C16 7.10457 16.8954 8 18 8Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.01734 8.74067C6.01734 10.4142 5.77537 12.1995 9.22051 11.9855H12.0053M17.9929 8.57617C18.1259 11.9855 16.9199 11.7648 15.7861 11.9855H12.0053M12.0053 15.7001V11.9855" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

static EXPAND: Icon = Icon {
    name: "studio-expand",
    view: 24.0,
    body: r#"<path d="M16.4999 3.26621C17.3443 3.25421 20.1408 2.67328 20.7337 3.26621C21.3266 3.85913 20.7457 6.65559 20.7337 7.5M20.5059 3.49097L13.5021 10.4961M3.26636 16.5001C3.25436 17.3445 2.67343 20.141 3.26636 20.7339C3.85928 21.3268 6.65574 20.7459 7.50015 20.7339M10.502 13.4976L3.49824 20.5027" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static SHRINK: Icon = Icon {
    name: "studio-shrink",
    view: 24.0,
    body: r#"<path d="M6.5023 10.7365C7.34671 10.7485 10.1432 11.3294 10.7361 10.7365C11.329 10.1436 10.7481 7.34708 10.7361 6.50267M13.2685 17.5027C13.2565 16.6583 12.6756 13.8618 13.2685 13.2689C13.8614 12.676 16.6579 13.2569 17.5023 13.2689M20.9991 21.001L13.6102 13.6188M10.3691 10.3763L2.99998 2.99902" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static CLOSE: Icon = Icon {
    name: "studio-close",
    view: 24.0,
    body: r#"<path d="M18 6L6.00081 17.9992M17.9992 18L6 6.00085" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>"#,
};

static SIDE_CHAT: Icon = Icon {
    name: "studio-side-chat",
    view: 24.0,
    body: r#"<path d="M8 10.5h8M8 14h5.5M17 3.338A9.95 9.95 0 0 0 12 2C6.477 2 2 6.477 2 12c0 1.6.376 3.112 1.043 4.453c.178.356.237.763.134 1.148l-.595 2.226a1.3 1.3 0 0 0 1.591 1.592l2.226-.596a1.63 1.63 0 0 1 1.149.133A9.96 9.96 0 0 0 12 22c5.523 0 10-4.477 10-10c0-1.821-.487-3.53-1.338-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static HANDOFF: Icon = Icon {
    name: "studio-handoff",
    view: 24.0,
    body: r#"<path d="M16.9767 19.5C19.4017 17.8876 21 15.1305 21 12C21 7.02944 16.9706 3 12 3C11.3126 3 10.6432 3.07706 10 3.22302M16.9767 19.5V16M16.9767 19.5H20.5M7 4.51555C4.58803 6.13007 3 8.87958 3 12C3 16.9706 7.02944 21 12 21C12.6874 21 13.3568 20.9229 14 20.777M7 4.51555V8M7 4.51555H3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static ARCHIVE: Icon = Icon {
    name: "studio-archive",
    view: 24.0,
    body: r#"<path d="M7 21H17C19.357 21 20.535 21 21.268 20.268C22 19.535 22 18.357 22 16S22 12.465 21.268 11.732C20.535 11 19.357 11 17 11H7C4.643 11 3.465 11 2.732 11.732C2 12.465 2 13.643 2 16S2 19.535 2.732 20.268C3.465 21 4.643 21 7 21ZM4 11C4 9.6 4 8.9 4.273 8.365C4.512 7.895 4.895 7.512 5.365 7.273C5.9 7 6.6 7 8 7H16C17.4 7 18.1 7 18.635 7.273C19.105 7.512 19.488 7.895 19.727 8.365C20 8.9 20 9.6 20 11M6 7C6 5.6 6 4.9 6.273 4.365C6.512 3.895 6.895 3.512 7.365 3.273C7.9 3 8.6 3 10 3H14C15.4 3 16.1 3 16.635 3.273C17.105 3.512 17.488 3.895 17.727 4.365C18 4.9 18 5.6 18 7M16 15L15.7 15.4C15.111 16.185 14.817 16.578 14.394 16.789C13.972 17 13.481 17 12.5 17H11.5C10.519 17 10.028 17 9.606 16.789C9.183 16.578 8.889 16.185 8.3 15.4L8 15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

static TERMINAL: Icon = Icon {
    name: "studio-terminal",
    view: 24.0,
    body: r#"<path d="M7.5 7.5L8.72654 8.55719C9.24218 9.00163 9.5 9.22386 9.5 9.5C9.5 9.77614 9.24218 9.99836 8.72654 10.4428L7.5 11.5M11.5 12.5H15.5M12 21C15.7497 21 17.6246 21 18.9389 20.0451C19.3634 19.7367 19.7367 19.3634 20.0451 18.9389C21 17.6246 21 15.7497 21 12C21 8.25027 21 6.3754 20.0451 5.06107C19.7367 4.6366 19.3634 4.26331 18.9389 3.95491C17.6246 3 15.7497 3 12 3C8.25027 3 6.3754 3 5.06107 3.95491C4.6366 4.26331 4.26331 4.6366 3.95491 5.06107C3 6.3754 3 8.25027 3 12C3 15.7497 3 17.6246 3.95491 18.9389C4.26331 19.3634 4.6366 19.7367 5.06107 20.0451C6.3754 21 8.25027 21 12 21Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

static REFRESH: Icon = Icon {
    name: "studio-refresh",
    view: 24.0,
    body: r#"<path d="M20.0092 2V5.13219C20.0092 5.42605 19.6418 5.55908 19.4537 5.33333C17.6226 3.2875 14.9617 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22C17.5228 22 22 17.5228 22 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

static ACTIVITY_FILE: Icon = Icon {
    name: "activity-file",
    view: 24.0,
    body: r#"<path d="M8 7L16 7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 11L12 11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 21.5V21C13 18.1716 13 16.7574 13.8787 15.8787C14.7574 15 16.1716 15 19 15H19.5M20 13.3431V10C20 6.22876 20 4.34315 18.8284 3.17157C17.6569 2 15.7712 2 12 2C8.22877 2 6.34315 2 5.17157 3.17157C4 4.34314 4 6.22876 4 10L4 14.5442C4 17.7892 4 19.4117 4.88607 20.5107C5.06508 20.7327 5.26731 20.9349 5.48933 21.1139C6.58831 22 8.21082 22 11.4558 22C12.1614 22 12.5141 22 12.8372 21.886C12.9044 21.8623 12.9702 21.835 13.0345 21.8043C13.3436 21.6564 13.593 21.407 14.0919 20.9081L18.8284 16.1716C19.4065 15.5935 19.6955 15.3045 19.8478 14.9369C20 14.5694 20 14.1606 20 13.3431Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static ACTIVITY_COMMAND: Icon = Icon {
    name: "activity-command",
    view: 24.0,
    body: r#"<path d="M14 4H10C6.22876 4 4.34315 4 3.17157 5.17157C2 6.34315 2 8.22876 2 12C2 15.7712 2 17.6569 3.17157 18.8284C4.34315 20 6.22876 20 10 20H14C17.7712 20 19.6569 20 20.8284 18.8284C22 17.6569 22 15.7712 22 12C22 8.22876 22 6.34315 20.8284 5.17157C19.6569 4 17.7712 4 14 4Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 9L8.83981 10.5858C9.61327 11.2525 10 11.5858 10 12C10 12.4142 9.61327 12.7475 8.83981 13.4142L7 15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 16H17" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static ACTIVITY_EDIT: Icon = Icon {
    name: "activity-edit",
    view: 24.0,
    body: r#"<path d="M13 20.8268V22H14.1734C14.5827 22 14.7874 22 14.9715 21.9238C15.1555 21.8475 15.3003 21.7028 15.5897 21.4134L20.4133 16.5894C20.6864 16.3164 20.8229 16.1799 20.8959 16.0327C21.0347 15.7525 21.0347 15.4236 20.8959 15.1434C20.8229 14.9961 20.6864 14.8596 20.4133 14.5866C20.1403 14.3136 20.0038 14.1771 19.8565 14.1041C19.5763 13.9653 19.2473 13.9653 18.9671 14.1041C18.8198 14.1771 18.6833 14.3136 18.4103 14.5866L18.4103 14.5866L13.5867 19.4106C13.2972 19.7 13.1525 19.8447 13.0762 20.0287C13 20.2128 13 20.4174 13 20.8268Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M19 11C19 11 19 9.4306 18.8478 9.06306C18.6955 8.69552 18.4065 8.40649 17.8284 7.82843L13.0919 3.09188C12.593 2.593 12.3436 2.34355 12.0345 2.19575C11.9702 2.165 11.9044 2.13772 11.8372 2.11401C11.5141 2 11.1614 2 10.4558 2C7.21082 2 5.58815 2 4.4894 2.88607C4.26732 3.06508 4.06508 3.26731 3.88607 3.48933C3 4.58831 3 6.21082 3 9.45584V14C3 17.7712 3 19.6569 4.17157 20.8284C5.23467 21.8915 6.8857 21.99 10 21.9991M12 2.5V3C12 5.82843 12 7.24264 12.8787 8.12132C13.7574 9 15.1716 9 18 9H18.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static ACTIVITY_THINKING: Icon = Icon {
    name: "activity-thinking",
    view: 24.0,
    body: r#"<path d="M7 4.5C5.34315 4.5 4 5.84315 4 7.5C4 8.06866 4.15822 8.60037 4.43304 9.0535C3.04727 9.31855 2 10.537 2 12C2 13.463 3.04727 14.6814 4.43304 14.9465M7 4.5C7 3.11929 8.11929 2 9.5 2C10.8807 2 12 3.11929 12 4.5V19.5C12 20.8807 10.8807 22 9.5 22C8.11929 22 7 20.8807 7 19.5C5.34315 19.5 4 18.1569 4 16.5C4 15.9313 4.15822 15.3996 4.43304 14.9465M7 4.5C7 5.31791 7.39278 6.04408 8 6.50018M4.43304 14.9465C4.78948 14.3588 5.34207 13.9032 6 13.6707" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M17 19.4999C18.6569 19.4999 20 18.1567 20 16.4999C20 15.9312 19.8418 15.3995 19.567 14.9464C20.9527 14.6813 22 13.4629 22 11.9999C22 10.5369 20.9527 9.31843 19.567 9.05338M17 19.4999C17 20.8806 15.8807 21.9999 14.5 21.9999C13.1193 21.9999 12 20.8806 12 19.4999L12 4.49988C12 3.11917 13.1193 1.99988 14.5 1.99988C15.8807 1.99988 17 3.11917 17 4.49988C18.6569 4.49988 20 5.84302 20 7.49988C20 8.06854 19.8418 8.60024 19.567 9.05338M17 19.4999C17 18.682 16.6072 17.9558 16 17.4997M19.567 9.05338C19.2105 9.64109 18.6579 10.0966 18 10.3292" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static ACTIVITY_CHEVRON: Icon = Icon {
    name: "activity-chevron",
    view: 24.0,
    body: r#"<path d="m9 18 6-6-6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

static WORKTREE: Icon = Icon {
    name: "studio-worktree",
    view: 10.0,
    body: r#"<path d="M8.854 7.146a.5.5 0 0 0-.707.707l.146.146H5.75a.75.75 0 0 1-.75-.75v-3.5a.75.75 0 0 1 .75-.75h2.543l-.146.146a.5.5 0 0 0 .708.707l1-1a.5.5 0 0 0 0-.707l-1-1a.5.5 0 0 0-.707.707l.146.146H5.751c-.965 0-1.75.785-1.75 1.75v1.25H.5a.5.5 0 0 0 0 1H4v1.25c0 .965.785 1.75 1.75 1.75h2.543l-.146.146a.5.5 0 0 0 .708.707l1-1a.5.5 0 0 0 0-.707l-1-1z" fill="currentColor"/>"#,
};

static STUDIO_PROVIDER_CODEX: Icon = Icon {
    name: "studio-provider-codex",
    view: 24.0,
    body: r#"<path d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z" fill="currentColor" fill-rule="evenodd"/>"#,
};
static STUDIO_PROVIDER_GPT: Icon = Icon {
    name: "studio-provider-gpt",
    view: 24.0,
    body: r#"<path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.911 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.182a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.998-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.142-.08 4.778-2.758a.795.795 0 0 0 .393-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.495 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.677l5.815 3.354-2.02 1.169a.076.076 0 0 1-.071 0l-4.83-2.787A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.856-5.833-3.388L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.666zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.062l4.83-2.786a4.5 4.5 0 0 1 6.68 4.66zM8.307 12.863l-2.02-1.164a.08.08 0 0 1-.038-.057V6.074a4.5 4.5 0 0 1 7.376-3.454l-.142.08L8.704 5.46a.795.795 0 0 0-.393.68zm1.098-2.366 2.602-1.5 2.607 1.5v3l-2.597 1.5-2.607-1.5z" fill="currentColor" fill-rule="evenodd"/>"#,
};
static STUDIO_PROVIDER_CURSOR: Icon = Icon {
    name: "studio-provider-cursor",
    view: 24.0,
    body: r#"<path d="M22.07 5.7L12.5 0.18C12.19 0 11.81 0 11.5 0.18L1.93 5.7C1.67 5.85 1.51 6.13 1.51 6.43V17.57C1.51 17.87 1.67 18.15 1.93 18.3L11.5 23.82C11.81 24 12.19 24 12.5 23.82L22.07 18.3C22.33 18.15 22.49 17.87 22.49 17.57V6.43C22.49 6.13 22.33 5.85 22.07 5.7H22.07ZM21.47 6.87L12.23 22.88C12.16 22.99 12 22.94 12 22.82V12.34C12 12.13 11.89 11.94 11.71 11.83L2.63 6.59C2.52 6.53 2.57 6.36 2.69 6.36H21.17C21.44 6.36 21.6 6.65 21.47 6.88H21.47Z" fill="currentColor" fill-rule="evenodd"/>"#,
};
static STUDIO_PROVIDER_OPENCODE: Icon = Icon {
    name: "studio-provider-opencode",
    view: 24.0,
    body: r#"<path d="M22 24H2V0h20zM17 4.8H7v14.4h10z" fill="currentColor" fill-rule="evenodd"/>"#,
};
static STUDIO_PROVIDER_CLAUDE: Icon = Icon {
    name: "studio-provider-claude",
    view: 256.0,
    body: r#"<path d="m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z" fill="currentColor" fill-rule="evenodd"/>"#,
};

static PICKER_BRAIN: Icon = Icon {
    name: "studio-picker-brain",
    view: 24.0,
    body: r#"<path d="M7 4.5C5.34315 4.5 4 5.84315 4 7.5C4 8.06866 4.15822 8.60037 4.43304 9.0535C3.04727 9.31855 2 10.537 2 12C2 13.463 3.04727 14.6814 4.43304 14.9465M7 4.5C7 3.11929 8.11929 2 9.5 2C10.8807 2 12 3.11929 12 4.5V19.5C12 20.8807 10.8807 22 9.5 22C8.11929 22 7 20.8807 7 19.5C5.34315 19.5 4 18.1569 4 16.5C4 15.9313 4.15822 15.3996 4.43304 14.9465M7 4.5C7 5.31791 7.39278 6.04408 8 6.50018M4.43304 14.9465C4.78948 14.3588 5.34207 13.9032 6 13.6707" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M17 19.4999C18.6569 19.4999 20 18.1567 20 16.4999C20 15.9312 19.8418 15.3995 19.567 14.9464C20.9527 14.6813 22 13.4629 22 11.9999C22 10.5369 20.9527 9.31843 19.567 9.05338M17 19.4999C17 20.8806 15.8807 21.9999 14.5 21.9999C13.1193 21.9999 12 20.8806 12 19.4999L12 4.49988C12 3.11917 13.1193 1.99988 14.5 1.99988C15.8807 1.99988 17 3.11917 17 4.49988C18.6569 4.49988 20 5.84302 20 7.49988C20 8.06854 19.8418 8.60024 19.567 9.05338M17 19.4999C17 18.682 16.6072 17.9558 16 17.4997M19.567 9.05338C19.2105 9.64109 18.6579 10.0966 18 10.3292" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static PICKER_SEARCH: Icon = Icon {
    name: "studio-picker-search",
    view: 24.0,
    body: r#"<circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m15.5 15.5 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>"#,
};

fn brand_mark(provider: &str, t: Palette) -> El {
    brand_mark_size(provider, 15.0, t)
}
fn brand_mark_size(provider: &str, size: f32, t: Palette) -> El {
    let mark = match provider {
        "claudeAgent" => &STUDIO_PROVIDER_CLAUDE,
        "cursor" => &STUDIO_PROVIDER_CURSOR,
        "opencode" => &STUDIO_PROVIDER_OPENCODE,
        "gpt" | "openai" => &STUDIO_PROVIDER_GPT,
        _ => &STUDIO_PROVIDER_CODEX,
    };
    icon(mark, size).color(if provider == "claudeAgent" {
        t.accent
    } else {
        t.ink_soft
    })
}

pub(super) fn provider_mark(state: Option<&StudioState>, t: Palette) -> El {
    let provider = state
        .and_then(|s| s.providers.get(s.provider_index))
        .map(|p| p.id.as_str())
        .unwrap_or("codex");
    let mut marks = row().center_y().gap(4.0);
    if let Some(state) = state {
        if let Some(source) = &state.handoff_source {
            marks = marks
                .child(brand_mark(if source == "codex" { "gpt" } else { source }, t).opacity(0.55))
                .child(label("→", 10.0, 400.0, t.muted).opacity(0.8));
        } else {
            for past in &state.past_providers {
                marks = marks.child(brand_mark(past, t).opacity(0.45));
            }
        }
    }
    marks = marks.child(brand_mark(provider, t));
    if state.is_some_and(|s| s.side_chat) {
        marks = marks.child(
            icon(&SIDE_CHAT, 11.0).color(crate::theme::mix_srgb(t.ink_soft, t.accent, 0.72)),
        );
    }
    marks
}

fn connected_avatar(identity: &crate::state::StudioIdentity, t: Palette) -> El {
    avatar_at(identity, 16.0, t)
}

fn avatar_at(identity: &crate::state::StudioIdentity, size: f32, t: Palette) -> El {
    use std::sync::{Arc, OnceLock};
    static IMAGES: OnceLock<rune::ImageCache> = OnceLock::new();
    let cache = IMAGES.get_or_init(|| rune::ImageCache::new(Arc::new(|| {})));
    let avatar = identity.avatar.as_deref().and_then(|src| {
        use base64::Engine;
        if src == "/agents/kone.jpg" {
            Some(cache.load(include_bytes!("../../../web/public/agents/kone.jpg").as_slice()))
        } else {
            let (header, data) = src.strip_prefix("data:")?.split_once(',')?;
            let mime = header.strip_suffix(";base64")?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data)
                .ok()?;
            Some(cache.load_mime(bytes, mime, size, 2.0))
        }
    });
    let image = avatar
        .filter(|image| image.wait().is_ok())
        .unwrap_or_else(|| {
            let image = cache.svg(Arc::<[u8]>::from(identity.svg.as_bytes()), size, 2.0);
            let _ = image.wait();
            image
        });
    el().w(size)
        .h(size)
        .radius(size / 2.0)
        .fill(t.ground)
        .shadow(1.0, 2.0, rune::color::hex("#000000").unwrap().alpha(0.16))
        .pixels_fit(image.pixels(), rune::SurfaceFit::Fill)
}

fn conversation_fixture_speaker(scene: &str, dark: bool, turn: usize) -> Option<&'static str> {
    let speaker = match (scene, dark, turn) {
        ("mid", false, _) => "Linen",
        ("mid", true, _) => "Cairn",
        ("scrolled", false, _) => "Rowan",
        ("scrolled", true, _) => "Granite",
        ("compaction", false, _) => "Clay",
        ("compaction", true, _) => "Ash",
        ("marks", false, _) => "Arbor",
        ("marks", true, _) => "Linen",
        ("code", false, _) => "Verge",
        ("code", true, _) => "Indigo",
        _ => return None,
    };
    Some(speaker)
}

fn fixture_dark_theme(fallback: bool) -> bool {
    use std::sync::OnceLock;
    static THEME: OnceLock<Option<bool>> = OnceLock::new();
    THEME
        .get_or_init(|| {
            let mut args = std::env::args().skip(1);
            while let Some(arg) = args.next() {
                if arg == "--theme" {
                    return args.next().map(|theme| theme == "dark");
                }
            }
            None
        })
        .unwrap_or(fallback)
}

fn fork_tool(
    glyph: &'static Icon,
    tip: &'static str,
    state: Option<&StudioState>,
    t: Palette,
) -> El {
    let shown = state.and_then(|s| s.head_tooltip.as_deref()) == Some(tip);
    let mut button = el()
        .key(format!("studio-tool-{tip}"))
        .role("button")
        .label(tip)
        .focusable(true)
        .hover_group_focus()
        .w(20.0)
        .h(20.0)
        .center()
        .radius(6.0)
        .hover(t.hover)
        .child(icon(glyph, 13.0).color(t.muted))
        .on_hover_focus_change(move |s: &mut AppState, over, tx| {
            s.studio.head_tooltip = None;
            s.studio.head_tooltip_pending = if over {
                tx.wake_after(std::time::Duration::from_millis(300));
                Some((tip.into(), std::time::Instant::now()))
            } else {
                None
            };
        });
    if shown {
        let width = (tip.chars().count() as f32 * 5.8 + 14.0).max(40.0);
        button = button.child(
            el().key(format!("studio-tooltip-{tip}"))
                .absolute(
                    if tip == "Open a side chat" {
                        0.0
                    } else {
                        (20.0 - width) / 2.0
                    },
                    -26.0,
                )
                .transition(tooltip_transition())
                .w(width)
                .px(7.0)
                .h(20.0)
                .center()
                .radius(6.0)
                .fill(t.ink)
                .child(label(tip, 11.0, 500.0, t.ground)),
        );
    }
    button
}

fn head_tip(
    mut control: El,
    tip: String,
    state: Option<&StudioState>,
    right: bool,
    t: Palette,
) -> El {
    let shown = state.and_then(|s| s.head_tooltip.as_deref()) == Some(tip.as_str());
    let width = (tip.chars().count() as f32 * 5.8 + 14.0).max(40.0);
    if shown {
        control = control.child(
            el().key(format!("studio-tooltip-{tip}"))
                .transition(tooltip_transition())
                .absolute(
                    if right {
                        20.0 - width
                    } else {
                        (20.0 - width) / 2.0
                    },
                    -26.0,
                )
                .w(width)
                .h(20.0)
                .center()
                .radius(6.0)
                .fill(t.ink)
                .child(label(tip.clone(), 11.0, 500.0, t.ground)),
        );
    }
    control
        .hover_group_focus()
        .on_hover_focus_change(move |s: &mut AppState, over, tx| {
            s.studio.head_tooltip = None;
            s.studio.head_tooltip_pending = if over {
                tx.wake_after(std::time::Duration::from_millis(300));
                Some((tip.clone(), std::time::Instant::now()))
            } else {
                None
            };
        })
}

fn tooltip_transition() -> rune::Transition {
    let spring = rune::Spring::from_stiffness_damping(900.0, 60.0, 1.0);
    rune::Transition::offset(0.0, 2.0)
        .combined(rune::Transition::opacity())
        .springs(rune::SpringPair::new(spring, spring))
}

static METER_TRACK: Icon = Icon {
    name: "studio-meter-track",
    view: 20.0,
    body: r#"<circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="2.25"/>"#,
};

fn meter_arc(percent: usize) -> &'static Icon {
    static ARCS: std::sync::OnceLock<Vec<Icon>> = std::sync::OnceLock::new();
    &ARCS.get_or_init(|| {
        (0..=100).map(|p| {
            if p == 100 {
                return Icon {
                    name: "studio-meter-100",
                    view: 20.0,
                    body: r#"<circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="2.25"/>"#,
                };
            }
            let angle = std::f32::consts::TAU * (p.min(99) as f32 / 100.0);
            let x = 10.0 + 7.0 * angle.sin();
            let y = 10.0 - 7.0 * angle.cos();
            Icon {
                name: Box::leak(format!("studio-meter-{p}").into_boxed_str()),
                view: 20.0,
                body: Box::leak(format!(r#"<path d="M10 3 A7 7 0 {} 1 {x:.4} {y:.4}" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round"/>"#, if p > 50 { 1 } else { 0 }).into_boxed_str()),
            }
        }).collect()
    })[percent.min(100)]
}

fn context_meter(state: &StudioState, t: Palette) -> El {
    let Some((used, window)) = state.context_usage.filter(|(_, window)| *window > 0) else {
        return el().w(0.0);
    };
    let fraction = (used as f64 / window as f64 * 100.0).min(100.0);
    let percent = fraction.round() as usize;
    let color = if fraction >= 90.0 {
        rune::Color::from_oklab([0.6, 0.16, 0.08, 1.0])
    } else if fraction >= 70.0 {
        t.accent
    } else {
        crate::theme::mix_srgb(t.muted, t.accent, 0.52)
    };
    let mut meter = el()
        .key("studio-context-meter")
        .role("button")
        .label("Context window")
        .expanded(state.context_open)
        .focusable(true)
        .on_key(|s: &mut AppState, event, _| {
            if event.key == rune::Key::Enter {
                s.studio.context_open = !s.studio.context_open;
                true
            } else {
                false
            }
        })
        .w(15.0)
        .h(15.0)
        .center()
        .child(icon(&METER_TRACK, 15.0).color(t.muted.alpha(0.22)))
        .child(
            icon(meter_arc(percent), 15.0)
                .opacity(if percent == 0 { 0.0 } else { 1.0 })
                .color(color)
                .absolute(0.0, 0.0),
        )
        .on_press(|s: &mut AppState| s.studio.context_open = !s.studio.context_open);
    if state.context_open {
        // A transparent backdrop catches presses outside the card. It is added
        // before the card so the card and its actions remain interactive.
        meter = meter.child(
            el().key("studio-context-backdrop")
                .size(8192.0, 8192.0)
                .absolute(-4096.0, -4096.0)
                .on_press(|s: &mut AppState| s.studio.context_open = false),
        );
        let data_row = |name: &str, value: String| {
            row()
                .w_full()
                .justify_between()
                .child(label(name, 11.0, 400.0, t.muted).font(TextStyle::new(11.0, 400.0).mono()))
                .child(label(value, 11.0, 400.0, t.ink).font(TextStyle::new(11.0, 400.0).mono()))
        };
        let mut data = col()
            .w_full()
            .padding(12.0)
            .gap(3.0)
            .radius(18.0)
            .fill(t.raised)
            .child(data_row(
                "Used",
                format!("{} · {}", format_percent(fraction), format_tokens(used)),
            ));
        if used < window {
            data = data.child(data_row("Remaining", format_tokens(window - used)));
        }
        for (name, value) in [
            ("Input", state.context_input),
            ("Output", state.context_output),
            ("Total", state.context_total),
        ] {
            if let Some(value) = value {
                data = data.child(data_row(name, format_tokens(value)));
            }
        }
        data = data.child(data_row("Window", format_tokens(window)));
        if state.context_auto_compact {
            data = data.child(el().w_full().h(1.0).fill(t.line).my(5.0)).child(
                label(
                    format!("Auto-compacts at ~{}.", format_tokens(window)),
                    11.0,
                    400.0,
                    t.muted,
                )
                .font(TextStyle::new(11.0, 400.0).mono()),
            );
        }
        let mut card = col()
            .on_press(|_: &mut AppState| {})
            .w(260.0)
            .radius(20.0)
            .border(1.0, t.line)
            .fill(t.ground)
            .shadow(6.0, 18.0, rune::Color::BLACK.alpha(0.10))
            .child(
                row()
                    .w_full()
                    .h(36.0)
                    .px(13.0)
                    .center_y()
                    .justify_between()
                    .child(label("Context window", 12.5, 600.0, t.ink_soft))
                    .child(
                        el().key("studio-context-cancel")
                            .role("button")
                            .label("Cancel")
                            .focusable(true)
                            .child(label("Cancel", 13.0, 600.0, t.muted))
                            .on_press(|s: &mut AppState| s.studio.context_open = false),
                    ),
            )
            .child(data);
        if state
            .providers
            .get(state.provider_index)
            .is_some_and(|p| p.supports_compaction)
        {
            let ready = state.started
                && !state.busy
                && state.compact_request.is_none()
                && state.items.iter().any(|item| item.kind == "user");
            let mut action = el()
                .key("studio-context-compact")
                .role("button")
                .label("Compact context")
                .focusable(ready)
                .w_full()
                .h(34.0)
                .px(12.0)
                .center_y()
                .radius(12.0)
                .child(label(
                    if state.compact_request.is_some() {
                        "Compacting…"
                    } else {
                        "Compact context"
                    },
                    12.0,
                    400.0,
                    t.ink_soft,
                ))
                .opacity(if ready { 1.0 } else { 0.45 });
            if ready {
                action = action.hover(t.hover).on_press(|s: &mut AppState| {
                    s.studio.compact_error = None;
                    s.studio.compact_request = s.request(
                        "agent.compact",
                        serde_json::json!({"threadId": s.studio.thread_id}),
                    );
                });
            }
            let mut actions = col()
                .w_full()
                .padding(6.0)
                .radius(18.0)
                .fill(t.raised)
                .child(action);
            if let Some(error) = &state.compact_error {
                actions = actions.child(label(error.clone(), 11.0, 400.0, t.muted));
            }
            card = card.child(actions);
        }
        let spring = rune::Spring::from_stiffness_damping(300.0, 22.0, 0.9);
        meter = meter.child(
            card.key("studio-context-card")
                .transition(
                    rune::Transition::offset(0.0, -6.0)
                        .combined(rune::Transition::scale(0.97))
                        .springs(rune::SpringPair::new(spring, spring)),
                )
                .absolute(-245.0, 23.0)
                .raise(),
        );
    }
    let mut tip = format!(
        "{} used · {} of {} tokens",
        format_percent(fraction),
        format_tokens(used),
        format_tokens(window)
    );
    if state.context_auto_compact {
        tip.push_str(&format!(". Auto-compacts at ~{}.", format_tokens(window)));
    }
    if state.context_open {
        meter
    } else {
        head_tip(meter, tip, Some(state), false, t)
    }
}

fn format_tokens(value: u64) -> String {
    if value < 1_000 {
        return value.to_string();
    }
    if value < 10_000 {
        return format_decimal(value as f64 / 1_000.0, "k");
    }
    if value < 1_000_000 {
        return format!("{:.0}k", value as f64 / 1_000.0);
    }
    format_decimal(value as f64 / 1_000_000.0, "m")
}

fn format_decimal(value: f64, suffix: &str) -> String {
    let number = format!("{value:.1}");
    format!("{}{suffix}", number.strip_suffix(".0").unwrap_or(&number))
}

fn format_percent(value: f64) -> String {
    if value < 10.0 {
        format_decimal(value, "%")
    } else {
        format!("{value:.0}%")
    }
}

fn title_of(state: &StudioState) -> String {
    if !state.title.is_empty() {
        return state.title.clone();
    }
    state
        .items
        .iter()
        .find(|item| item.kind == "user" && !item.text.is_empty())
        .map(|item| item.text.lines().next().unwrap_or("New thread").into())
        .unwrap_or_else(|| "New thread".into())
}

fn column_title(state: Option<&StudioState>, focused: bool, t: Palette) -> El {
    let (label, side_chat) = state
        .map(|state| (title_of(state), state.side_chat))
        .unwrap_or_else(|| ("New thread".into(), false));
    let base = if focused {
        t.ink
    } else if side_chat {
        crate::theme::mix_srgb(t.accent, t.muted, 0.58)
    } else {
        t.muted
    };
    let hover = if side_chat {
        crate::theme::mix_srgb(t.accent, t.ink, 0.66)
    } else {
        t.ink
    };
    let mut style = TextStyle::new(13.5, 620.0).lh(16.2).tracking(-0.2025);
    if side_chat {
        style = style.italic();
    }
    let mut title = el().hover_group().min_w(0.0).child(
        text(label)
            .font(style)
            .color(base)
            .group_color(hover)
            .truncate(),
    );
    if focused {
        title = title
            .key("studio-title-info-trigger")
            .role("button")
            .label("Thread info")
            .expanded(state.is_some_and(|state| state.title_info_open))
            .focusable(true)
            .on_key(|s: &mut AppState, event, _| {
                if event.key == rune::Key::Enter {
                    s.studio.title_info_open = !s.studio.title_info_open;
                    s.studio.context_open = false;
                    true
                } else {
                    false
                }
            })
            .on_press(|s: &mut AppState| {
                s.studio.title_info_open = !s.studio.title_info_open;
                s.studio.context_open = false;
            });
        if let Some(state) = state.filter(|state| state.title_info_open) {
            title = title.child(
                el().size(8192.0, 8192.0)
                    .absolute(-4096.0, -4096.0)
                    .on_press(|s: &mut AppState| s.studio.title_info_open = false),
            );
            title = title.child(thread_info_panel(state, t).absolute(-120.0, 25.0).raise());
        }
    }
    title
}

fn thread_info_panel(state: &StudioState, t: Palette) -> El {
    let info_row = |name: &str, value: String| {
        row()
            .w_full()
            .h(28.0)
            .center_y()
            .justify_between()
            .gap(16.0)
            .child(label(name, 11.5, 400.0, t.muted))
            .child(label(value, 12.5, 500.0, t.ink).truncate())
    };
    let provider = state
        .providers
        .get(state.provider_index)
        .map(|p| p.label.clone())
        .unwrap_or_default();
    let model = state
        .models
        .get(state.model_index)
        .map(|m| m.label.clone())
        .unwrap_or_else(|| "Default".into());
    let name_row = if state.title_editing {
        row()
            .w_full()
            .h(28.0)
            .center_y()
            .justify_between()
            .child(label("Name", 11.5, 400.0, t.muted))
            .child(
                text_input(&state.title_draft, TextStyle::new(12.5, 500.0))
                    .key("studio-title-draft")
                    .w(180.0)
                    .h(24.0)
                    .color(t.ink)
                    .on_edit(|s: &mut AppState| &mut s.studio.title_draft)
                    .on_submit(|s: &mut AppState, _: &mut rune::Tx| {
                        s.commit_studio_title();
                    }),
            )
    } else {
        info_row("Name", title_of(state))
            .key("studio-title-edit")
            .role("button")
            .label("Rename thread")
            .focusable(true)
            .on_press(|s: &mut AppState| {
                s.studio.title_draft = rune::TextEdit::new(s.studio.title.clone());
                s.studio.title_draft.anchor = 0;
                s.studio.title_editing = true;
                s.studio.title_draft.focused = true;
            })
    };
    let mut rows = col()
        .w_full()
        .px(15.0)
        .py(8.0)
        .child(name_row)
        .child(info_row("Provider", provider))
        .child(info_row("Model", model))
        .child(info_row("Reasoning", state.effort.clone()));
    if let Some(path) = &state.worktree_path {
        rows = rows.child(info_row("Worktree", path.clone()));
    }
    if let Some(source) = &state.handoff_source {
        rows = rows.child(info_row("Handed off", format!("From {source}")));
    }
    rows = rows.child(label("USAGE", 10.0, 600.0, t.muted).mt(10.0));
    if let Some((used, window)) = state.context_usage {
        rows = rows.child(info_row(
            "In context",
            format!("{} / {}", format_tokens(used), format_tokens(window)),
        ));
    } else {
        rows = rows.child(info_row("Tokens", "Not reported yet".into()));
    }
    for (name, value) in [
        ("Input", state.context_input),
        ("Output", state.context_output),
        ("Total", state.context_total),
    ] {
        if let Some(value) = value {
            rows = rows.child(info_row(name, format_tokens(value)));
        }
    }
    rows = rows
        .child(label("IDENTITY", 10.0, 600.0, t.muted).mt(10.0))
        .child(info_row(
            "Thread ID",
            if state.thread_id.is_empty() {
                "Not started".into()
            } else {
                short_thread_id(&state.thread_id)
            },
        ));
    rows = rows.child(label("EXPORT", 10.0, 600.0, t.muted).mt(10.0))
        .child(row().w_full().h(32.0).center_y().justify_between()
            .child(label("Format", 11.5, 400.0, t.muted))
            .child(row().gap(12.0)
                .child(el().key("studio-export-markdown").focusable(true).role("radio")
                    .child(label("Markdown", 12.5, 500.0, if state.export_json { t.muted } else { t.ink }))
                    .on_press(|s: &mut AppState| s.studio.export_json = false))
                .child(el().key("studio-export-json").focusable(true).role("radio")
                    .child(label("JSON", 12.5, 500.0, if state.export_json { t.ink } else { t.muted }))
                    .on_press(|s: &mut AppState| s.studio.export_json = true))))
        .child(row().w_full().justify_end().child(
            el().key("studio-export").role("button").focusable(true).px(12.0).h(30.0).center()
                .radius(8.0).border(1.0, t.line)
                .child(label("↓  Export thread", 12.5, 550.0, t.ink))
                .on_press_tx(|s: &mut AppState, tx: &mut rune::Tx| {
                    if s.studio.busy || s.studio.export_request.is_some() { return; }
                    let format = if s.studio.export_json { "json" } else { "markdown" };
                    let ext = if s.studio.export_json { "json" } else { "md" };
                    let options = rune::FileDialogOptions { title: "Export thread".into(), file_name: Some(format!("thread.{ext}")), ..Default::default() };
                    let thread = s.studio.thread_id.clone();
                    tx.save_file(options, move |s: &mut AppState, result, _| {
                        match result {
                            Ok(Some(path)) => {
                                s.studio.export_request = s.request("history.export", serde_json::json!({"threadId": thread, "format": format, "path": path}));
                            }
                            Ok(None) => s.studio.export_status = Some("Cancelled.".into()),
                            Err(error) => s.studio.export_status = Some(error.to_string()),
                        }
                    });
                })));
    if let Some(status) = &state.export_status {
        rows = rows.child(label(status.clone(), 11.5, 400.0, t.muted).mt(4.0));
    }
    col()
        .on_press(|_: &mut AppState| {})
        .w(320.0)
        .radius(18.0)
        .border(1.0, t.line)
        .fill(t.ground)
        .shadow(10.0, 28.0, rune::Color::BLACK.alpha(0.16))
        .child(
            row()
                .w_full()
                .h(42.0)
                .px(15.0)
                .center_y()
                .fill(t.raised)
                .child(label("Details", 13.0, 600.0, t.ink_soft)),
        )
        .child(rows)
}

fn short_thread_id(id: &str) -> String {
    let chars: Vec<char> = id.chars().collect();
    if chars.len() <= 16 {
        id.into()
    } else {
        format!(
            "{}…{}",
            chars[..8].iter().collect::<String>(),
            chars[chars.len() - 6..].iter().collect::<String>()
        )
    }
}

fn label(value: impl Into<String>, size: f32, weight: f32, color: rune::Color) -> El {
    text(value).font(TextStyle::new(size, weight)).color(color)
}

fn project_nav(s: &AppState, t: Palette) -> El {
    let mut nav = row().center_y().gap(4.0).offset(0.0, 10.0);
    for (index, project) in s.projects.iter().enumerate() {
        let has_row = s.studio_layout["rows"]
            .as_array()
            .is_some_and(|rows| rows.iter().any(|r| r["projectPath"] == project.path));
        if !has_row && Some(index) != s.selected_project {
            continue;
        }
        let path = project.path.clone();
        nav = nav.child(
            el().key(format!("studio-row-{index}"))
                .px(8.0)
                .h(26.0)
                .center()
                .radius(8.0)
                .hover(t.hover)
                .child(label(project.name.clone(), 12.0, 400.0, t.muted))
                .on_press_tx(move |s: &mut AppState, tx| {
                    s.select_studio_project(index);
                    tx.scroll_into_view(format!("studio-row-slot-{path}"));
                }),
        );
    }
    nav
}

pub fn view(s: &AppState, cx: &mut Cx<AppState>) -> El {
    let t = Palette::new(cx.system_dark());
    if s.selected_project.is_none() {
        let mut choices = col().w(300.0).gap(4.0);
        for (index, project) in s.projects.iter().enumerate() {
            choices = choices.child(
                row()
                    .key(format!("studio-project-{index}"))
                    .w_full()
                    .h(44.0)
                    .px(12.0)
                    .center_y()
                    .radius(10.0)
                    .hover(t.hover)
                    .child(label(project.name.clone(), 14.0, 600.0, t.ink).grow(1.0))
                    .child(label("→", 15.0, 400.0, t.muted))
                    .on_press(move |s: &mut AppState| s.select_studio_project(index)),
            );
        }
        return col().w_full().h_full().fill(t.ground).center().child(
            col()
                .items_center()
                .gap(18.0)
                .child(label("Choose a project", 16.0, 600.0, t.ink))
                .child(choices),
        );
    }
    let (viewport_w, viewport_h) = if s.studio_viewport.0 > 0.0 {
        s.studio_viewport
    } else {
        (1292.0, 854.0)
    };
    let mut plane = col().w_full();
    let rows = s.studio_layout["rows"].as_array();
    let mut selected_present = false;
    if let Some(rows) = rows {
        for saved in rows {
            let Some(path) = saved["projectPath"].as_str() else {
                continue;
            };
            let Some(index) = s.projects.iter().position(|p| p.path == path) else {
                continue;
            };
            let selected = Some(index) == s.selected_project;
            selected_present |= selected;
            plane = plane.child(studio_row(
                s,
                saved,
                index,
                selected,
                (viewport_w, viewport_h),
                t,
                cx,
            ));
        }
    }
    if !selected_present && let Some(index) = s.selected_project {
        let empty = serde_json::json!({"projectPath":s.projects[index].path,"panes":[]});
        plane = plane.child(studio_row(
            s,
            &empty,
            index,
            true,
            (viewport_w, viewport_h),
            t,
            cx,
        ));
    }
    let plane = col()
        .key("studio-plane")
        .w_full()
        .h_full()
        .fill(t.ground)
        .scroll(ScrollSpec {
            stick_bottom: false,
        })
        .on_layout_tx(|s: &mut AppState, [_, _, w, h], tx| {
            s.studio_viewport = (w, h);
            if let Some(path) = s.studio_scroll_row.take() {
                tx.scroll_into_view(format!("studio-row-slot-{path}"));
                if !s.studio.thread_id.is_empty() {
                    s.center_studio_column(tx);
                }
            }
        })
        .child(plane);
    let plane = if s.studio_refusal.is_some() {
        plane.child(el().pin(None, Some(0.0), Some(34.0), Some(0.0)).center().child(
            label("A column can’t cross the vertical axis — a row is a project, and a thread is bound to its repo.", 12.5, 400.0, t.muted)
        ))
    } else {
        plane
    };
    if s.studio.handoff_picker {
        plane.child(handoff_picker(s, t))
    } else {
        plane
    }
}

fn handoff_picker(s: &AppState, t: Palette) -> El {
    let source = s.studio.handoff_selection.as_ref();
    let source_provider = source.and_then(|(index, _, _, _)| s.studio.providers.get(*index));
    let source_model = source.and_then(|(_, models, index, _)| models.get(*index));
    let mut rail = col().w(44.0).h(294.0).items_center().pt(4.0).gap(10.0);
    for (index, provider) in s.studio.providers.iter().enumerate() {
        rail = rail.child(
            el().key(format!("handoff-provider-{index}"))
                .role("button")
                .label(provider.label.clone())
                .focusable(true)
                .on_key(move |s: &mut AppState, event, _| {
                    if event.key != rune::Key::Enter {
                        return false;
                    }
                    s.studio.handoff_staged = false;
                    if index != s.studio.provider_index {
                        s.select_provider(index);
                    }
                    true
                })
                .w(44.0)
                .h(44.0)
                .center()
                .hover(t.hover)
                .opacity(if index == s.studio.provider_index {
                    1.0
                } else {
                    0.48
                })
                .child(brand_mark_size(&provider.id, 20.0, t))
                .on_press(move |s: &mut AppState| {
                    s.studio.handoff_staged = false;
                    if index != s.studio.provider_index {
                        s.select_provider(index);
                    }
                }),
        );
    }
    let mut models = col().w_full().grow(1.0).padding(14.0);
    if s.studio.models.is_empty() {
        models = models
            .center()
            .child(label("No models available.", 13.0, 400.0, t.muted));
    }
    for (index, model) in s.studio.models.iter().enumerate() {
        let query = s.studio.handoff_query.text.trim().to_lowercase();
        if !query.is_empty()
            && !format!("{} {}", model.label, model.id)
                .to_lowercase()
                .contains(&query)
        {
            continue;
        }
        let selected = (s.studio.handoff_staged && index == s.studio.model_index)
            || source.is_some_and(|(provider, models, source_index, _)| {
                *provider == s.studio.provider_index
                    && models
                        .get(*source_index)
                        .is_some_and(|source| source.id == model.id)
            });
        let provider = s
            .studio
            .providers
            .get(s.studio.provider_index)
            .map(|p| p.id.as_str())
            .unwrap_or("codex");
        models = models.child(
            row()
                .key(format!("handoff-model-{index}"))
                .role("button")
                .label(model.label.clone())
                .focusable(true)
                .on_key(move |s: &mut AppState, event, _| {
                    if event.key != rune::Key::Enter {
                        return false;
                    }
                    s.studio.model_index = index;
                    s.studio.effort = s.studio.models[index]
                        .default_effort
                        .clone()
                        .unwrap_or_default();
                    s.studio.handoff_staged = true;
                    true
                })
                .w_full()
                .h(40.0)
                .px(10.0)
                .gap(13.0)
                .center_y()
                .radius(11.0)
                .fill(if selected {
                    t.hover
                } else {
                    t.ground.alpha(0.0)
                })
                .hover(t.hover)
                .child(
                    brand_mark_size(if provider == "codex" { "gpt" } else { provider }, 17.0, t)
                        .opacity(0.72),
                )
                .child(label(model.label.clone(), 15.0, 400.0, t.ink).opacity(0.72))
                .child(if model.efforts.is_empty() {
                    el()
                } else {
                    let color = rune::color::hex(if model.label.contains("Mini") {
                        "#50b9ed"
                    } else {
                        "#59cba8"
                    })
                    .unwrap();
                    let count = if model.label.contains("Mini") { 1 } else { 2 };
                    let mut brains = row();
                    for _ in 0..count {
                        brains = brains.child(icon(&PICKER_BRAIN, 13.0).color(color));
                    }
                    brains
                })
                .on_press(move |s: &mut AppState| {
                    s.studio.model_index = index;
                    s.studio.effort = s.studio.models[index]
                        .default_effort
                        .clone()
                        .unwrap_or_default();
                    s.studio.handoff_staged = true;
                }),
        );
    }
    let content = col()
        .w(340.0)
        .h(294.0)
        .radius(18.0)
        .border(1.0, t.line)
        .fill(t.raised)
        .child(
            row()
                .h(32.0)
                .mx(10.0)
                .mt(10.0)
                .px(10.0)
                .gap(8.0)
                .center_y()
                .radius(12.0)
                .fill(t.hover)
                .child(icon(&PICKER_SEARCH, 14.0).color(t.muted))
                .child(
                    text_input(&s.studio.handoff_query, TextStyle::new(12.5, 400.0))
                        .key("handoff-search")
                        .grow(1.0)
                        .single_line()
                        .placeholder("Search models…", t.placeholder)
                        .color(t.ink)
                        .on_edit(|s: &mut AppState| &mut s.studio.handoff_query),
                ),
        )
        .child(models);
    let mut route = row().center_y().gap(5.0).grow(1.0);
    if let Some(provider) = source_provider {
        route = route.child(brand_mark(&provider.id, t));
    }
    route = route
        .child(label(
            source_model.map(|m| m.label.as_str()).unwrap_or("Model"),
            12.5,
            400.0,
            t.ink,
        ))
        .child(label("→", 12.0, 400.0, t.muted));
    if s.studio.handoff_staged {
        if let Some(provider) = s.studio.providers.get(s.studio.provider_index) {
            route = route.child(brand_mark(&provider.id, t));
        }
        if let Some(model) = s.studio.models.get(s.studio.model_index) {
            route = route.child(label(model.label.clone(), 12.5, 400.0, t.ink));
        }
    }
    let different = source.is_some_and(|(provider, models, model, effort)| {
        *provider != s.studio.provider_index
            || models.get(*model).map(|m| &m.id)
                != s.studio.models.get(s.studio.model_index).map(|m| &m.id)
            || *effort != s.studio.effort
    });
    let mut confirm = row()
        .role("button")
        .label("Hand off")
        .focusable(s.studio.handoff_staged && different)
        .center_y()
        .gap(6.0)
        .opacity(if s.studio.handoff_staged && different {
            1.0
        } else {
            0.4
        })
        .child(label("Hand off", 14.0, 600.0, t.ink))
        .child(label("→", 14.0, 400.0, t.accent));
    if s.studio.handoff_staged && different {
        confirm = confirm
            .on_key(|s: &mut AppState, event, _| {
                if event.key != rune::Key::Enter {
                    return false;
                }
                s.create_continuation(true);
                true
            })
            .on_press(|s: &mut AppState| s.create_continuation(true));
    }
    let mut card = col()
        .w(384.0)
        .radius(22.0)
        .fill(if t.dark { t.ground } else { t.sunken })
        .border(1.0, t.line_soft)
        .child(row().child(rail).child(content))
        .child(
            row()
                .w_full()
                .h(34.0)
                .px(14.0)
                .center_y()
                .gap(10.0)
                .child(route)
                .child(confirm),
        );
    if s.studio.handoff_staged && !different {
        card = card.child(
            label(
                "Already here — pick another provider or model to hand off to.",
                11.5,
                400.0,
                t.muted,
            )
            .px(14.0)
            .pb(4.0),
        );
    }
    el().pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
        .child(
            el().pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                .fill(t.ground.alpha(0.62))
                .on_press(|s: &mut AppState| s.cancel_handoff_picker()),
        )
        .child(card.pin(None, None, Some(24.0), Some(24.0)))
}

fn studio_row(
    s: &AppState,
    saved: &serde_json::Value,
    project_index: usize,
    selected_row: bool,
    viewport: (f32, f32),
    t: Palette,
    cx: &Cx<AppState>,
) -> El {
    let (viewport_w, viewport_h) = viewport;
    let project = &s.projects[project_index];
    let path = project.path.clone();
    let panes = saved["panes"].as_array();
    let mut rail = row().h_full();
    let count = panes.map_or(0, Vec::len);
    if count >= 1 {
        let pane = &panes.unwrap()[0];
        let width = [840.0_f32, 960.0, 1120.0, 1240.0]
            [(pane["width"].as_u64().unwrap_or(0) as usize).min(3)]
        .min(viewport_w);
        let width = if pane["zen"].as_bool().unwrap_or(false) {
            viewport_w
        } else {
            width
        };
        rail = rail.child(
            el().w(((viewport_w - width) / 2.0 - 14.0).max(0.0))
                .h_full(),
        );
    }
    if let Some(panes) = panes {
        for (i, pane) in panes.iter().enumerate() {
            let Some(thread) = pane["anchor"]["threadId"].as_str() else {
                continue;
            };
            let focused = selected_row && thread == s.studio.thread_id;
            let state = if focused {
                Some(&s.studio)
            } else {
                s.studio_threads.get(thread)
            };
            let width = [840.0_f32, 960.0, 1120.0, 1240.0]
                [(pane["width"].as_u64().unwrap_or(0) as usize).min(3)]
            .min(viewport_w);
            let zen = focused && pane["zen"].as_bool().unwrap_or(false);
            let width = if zen { viewport_w } else { width };
            let id = thread.to_owned();
            let focus_id = id.clone();
            let width_id = id.clone();
            let zen_id = id.clone();
            let close_id = id.clone();
            let project_path = path.clone();
            let hover_id = id.clone();
            let show_tools = s.studio_column_hover.as_deref() == Some(id.as_str());
            let has_thread = state.is_some_and(|s| {
                !s.dormant && s.terminal_command.is_none() && (!s.items.is_empty() || s.busy)
            });
            let side_chat = state.is_some_and(|s| s.side_chat);
            // `.col__head`: 33.59 tall with its 20pt controls at the top and a
            // 13.59pt run below (the body starts at +56 in the page).
            let activity_fixture = state.is_some_and(|state| {
                state
                    .conversation_fixture
                    .as_deref()
                    .is_some_and(|x| x.starts_with("activity-"))
            });
            let activity_hover = s.studio.conversation_fixture.as_deref() == Some("activity-hover");
            let head = row()
                .w_full()
                .px(6.4)
                .h(33.59)
                .justify_between()
                .child(
                    row()
                        .w(100.0)
                        .gap(2.0)
                        .opacity(if show_tools && (!activity_fixture || activity_hover) {
                            1.0
                        } else {
                            0.0
                        })
                        .child(if has_thread && !side_chat {
                            fork_tool(&SIDE_CHAT, "Open a side chat", state, t)
                                .on_press(|s: &mut AppState| s.create_continuation(false))
                        } else {
                            el().w(0.0)
                        })
                        .child(if has_thread && !side_chat {
                            fork_tool(&HANDOFF, "Hand off to another provider", state, t)
                                .on_press(|s: &mut AppState| s.open_handoff_picker())
                        } else {
                            el().w(0.0)
                        })
                        .child(if has_thread {
                            fork_tool(&ARCHIVE, "Archive conversation", state, t).on_press({
                                let id = id.clone();
                                let path = path.clone();
                                move |s: &mut AppState| {
                                    s.archive_studio_thread(path.clone(), id.clone());
                                }
                            })
                        } else {
                            el().w(0.0)
                        }),
                )
                .child(
                    row()
                        .gap(8.0)
                        .h(20.0)
                        .center_y()
                        .child(if activity_fixture {
                            brand_mark_size("gpt", 14.0, t)
                        } else if state.is_some_and(|s| s.terminal_command.is_some()) {
                            icon(&TERMINAL, 15.0).color(t.muted)
                        } else if state.is_some_and(|s| s.dormant) {
                            icon(&SIDE_CHAT, 15.0).color(t.muted)
                        } else {
                            provider_mark(state, t)
                        })
                        .child(
                            if state.is_some_and(|state| {
                                state.worktree_path.is_some()
                                    && !state.dormant
                                    && state.terminal_command.is_none()
                            }) {
                                head_tip(
                                    el().w(8.0).child(icon(&WORKTREE, 12.0).color(t.muted)),
                                    state
                                        .and_then(|s| s.worktree_path.clone())
                                        .unwrap_or_default(),
                                    state,
                                    false,
                                    t,
                                )
                            } else {
                                el().w(0.0)
                            },
                        )
                        .child(if state.is_some_and(|s| s.dormant) {
                            label("New thread", 13.5, 400.0, t.ink)
                        } else if state.is_some_and(|s| s.terminal_command.is_some()) {
                            label("Terminal", 13.5, 400.0, t.ink)
                        } else {
                            column_title(state, focused, t)
                        })
                        .child(
                            if let Some(command) = state.and_then(|s| s.terminal_command.as_ref()) {
                                row()
                                    .center_y()
                                    .gap(5.0)
                                    .px(8.0)
                                    .h(18.0)
                                    .radius(999.0)
                                    .fill(t.ink.alpha(0.05))
                                    .child(el().w(5.0).h(5.0).radius(3.0).fill(t.muted))
                                    .child(label(command.clone(), 10.0, 620.0, t.muted))
                            } else if let Some(state) = state.filter(|_| !activity_fixture) {
                                context_meter(state, t)
                            } else {
                                el().w(0.0)
                            },
                        ),
                )
                .child(
                    row()
                        .opacity(if show_tools && (!activity_fixture || activity_hover) {
                            1.0
                        } else {
                            0.0
                        })
                        .w(100.0)
                        .justify_end()
                        .gap(2.0)
                        .child(head_tip(
                            el().key(format!("studio-width-{id}"))
                                .px(4.0)
                                .h(20.0)
                                .min_w(20.0)
                                .opacity(if zen { 0.4 } else { 1.0 })
                                .center()
                                .radius(6.0)
                                .hover(t.hover)
                                .child(label(
                                    if zen {
                                        "max".into()
                                    } else {
                                        format!("{width:.0}")
                                    },
                                    10.0,
                                    650.0,
                                    t.muted,
                                ))
                                .on_press_tx(move |s: &mut AppState, tx| {
                                    if zen {
                                        return;
                                    }
                                    s.select_studio_project(project_index);
                                    s.open_studio_thread(width_id.clone());
                                    s.cycle_studio_width(&width_id);
                                    s.center_studio_column(tx);
                                }),
                            if zen {
                                "Maximized".into()
                            } else {
                                format!("Width: {width:.0}px")
                            },
                            state,
                            false,
                            t,
                        ))
                        .child(if state.is_some_and(|s| s.terminal_command.is_some()) {
                            el().w(20.0)
                                .h(20.0)
                                .center()
                                .radius(6.0)
                                .hover(t.hover)
                                .child(icon(&REFRESH, 13.0).color(t.muted))
                        } else {
                            el().w(0.0)
                        })
                        .child(head_tip(
                            el().key(format!("studio-zen-{id}"))
                                .w(20.0)
                                .h(20.0)
                                .center()
                                .radius(6.0)
                                .hover(t.hover)
                                .child(
                                    icon(if zen { &SHRINK } else { &EXPAND }, 13.0).color(t.muted),
                                )
                                .on_press_tx(move |s: &mut AppState, tx| {
                                    s.select_studio_project(project_index);
                                    s.open_studio_thread(zen_id.clone());
                                    s.toggle_studio_zen(&zen_id);
                                    s.center_studio_column(tx);
                                }),
                            if zen {
                                "Restore column".into()
                            } else {
                                "Maximize column".into()
                            },
                            state,
                            false,
                            t,
                        ))
                        .child(head_tip(
                            el().key(format!("studio-close-{id}"))
                                .w(20.0)
                                .h(20.0)
                                .center()
                                .radius(6.0)
                                .hover(t.hover)
                                .child(icon(&CLOSE, 13.0).color(t.muted))
                                .on_press(move |s: &mut AppState| {
                                    s.select_studio_project(project_index);
                                    s.close_studio_thread(&close_id);
                                }),
                            "Close column".into(),
                            state,
                            true,
                            t,
                        )),
                );
            let body = if state.is_some_and(|s| s.dormant) {
                col()
                    .w_full()
                    .grow(1.0)
                    .items_center()
                    .pt(40.0)
                    .child(label("Opening…", 12.5, 400.0, t.muted).opacity(0.7))
            } else if state.is_some_and(|s| s.terminal_command.is_some()) {
                col().w_full().grow(1.0)
            } else if focused {
                focused_body(
                    s,
                    &project.name,
                    t,
                    crate::codegolf::MARK_BASE + (project_index * 256 + i) as u32,
                )
            } else if let Some(state) = state {
                parked_body(
                    state,
                    &id,
                    t,
                    crate::codegolf::MARK_BASE + (project_index * 256 + i) as u32,
                )
            } else {
                col().w_full().grow(1.0)
            };
            if i == 0 {
                let seam_key = format!("{path}-0");
                let hovered = s.studio_seam_hover.as_deref() == Some(seam_key.as_str());
                let layout_key = seam_key.clone();
                let press_key = seam_key.clone();
                let menu_path = path.clone();
                rail = rail.child(
                    el().key(format!("studio-seam-{path}-0"))
                        .w(14.0)
                        .h(28.0)
                        .self_center()
                        .center()
                        .on_layout(move |s: &mut AppState, bounds| {
                            s.studio_seam_bounds.insert(layout_key.clone(), bounds);
                        })
                        .on_hover_change(move |s: &mut AppState, over, _| {
                            if over {
                                s.studio_seam_hover = Some(seam_key.clone());
                            } else if s.studio_seam_hover.as_deref() == Some(seam_key.as_str()) {
                                s.studio_seam_hover = None;
                            }
                        })
                        .child(
                            el().w(5.0)
                                .offset(0.0, -12.0)
                                .h(if hovered { 19.44 } else { 18.0 })
                                .radius(3.0)
                                .fill(t.ink.alpha(if hovered { 0.48 } else { 0.32 })),
                        )
                        .on_press(move |s: &mut AppState| {
                            s.studio_insert_menu = s
                                .studio_seam_bounds
                                .get(&press_key)
                                .copied()
                                .map(|b| (menu_path.clone(), 0, b));
                        }),
                );
            }
            rail = rail.child(
                col()
                    .key(format!("studio-pane-{id}"))
                    .w(width)
                    .h_full()
                    .opacity(if focused {
                        1.0
                    } else if show_tools {
                        0.52
                    } else {
                        0.34
                    })
                    .scale(if focused { 1.0 } else { 0.985 })
                    .pt(24.0)
                    .on_hover_focus_change(move |s: &mut AppState, over, _| {
                        if over {
                            s.studio_column_hover = Some(hover_id.clone());
                        } else if s.studio_column_hover.as_deref() == Some(hover_id.as_str()) {
                            s.studio_column_hover = None;
                        }
                    })
                    .on_press_tx(move |s: &mut AppState, tx| {
                        s.select_studio_project(project_index);
                        s.open_studio_thread(focus_id.clone());
                        tx.scroll_into_view(format!("studio-row-slot-{project_path}"));
                        s.center_studio_column(tx);
                    })
                    .child(head)
                    .child(body),
            );
            let seam_key = format!("{path}-{}", i + 1);
            let hovered = s.studio_seam_hover.as_deref() == Some(seam_key.as_str());
            let layout_key = seam_key.clone();
            let press_key = seam_key.clone();
            let menu_path = path.clone();
            rail = rail.child(
                el().key(format!("studio-seam-{path}-{}", i + 1))
                    .w(14.0)
                    .h(28.0)
                    .self_center()
                    .center()
                    .on_layout(move |s: &mut AppState, bounds| {
                        s.studio_seam_bounds.insert(layout_key.clone(), bounds);
                    })
                    .on_hover_change(move |s: &mut AppState, over, _| {
                        if over {
                            s.studio_seam_hover = Some(seam_key.clone());
                        } else if s.studio_seam_hover.as_deref() == Some(seam_key.as_str()) {
                            s.studio_seam_hover = None;
                        }
                    })
                    .child(
                        el().w(5.0)
                            .offset(0.0, -12.0)
                            .h(if hovered { 19.44 } else { 18.0 })
                            .radius(3.0)
                            .fill(t.ink.alpha(if hovered { 0.48 } else { 0.32 })),
                    )
                    .on_press(move |s: &mut AppState| {
                        s.studio_insert_menu = s
                            .studio_seam_bounds
                            .get(&press_key)
                            .copied()
                            .map(|b| (menu_path.clone(), i + 1, b));
                    }),
            );
        }
        if count > 1 {
            rail = rail.child(el().w(viewport_w / 2.0).h_full());
        }
    }
    let mut bar = row().w_full().h(32.0).px(32.0).justify_between().center_y();
    if count > 1 {
        let mut dashes = row().gap(6.0).center_y();
        for pane in panes.into_iter().flatten() {
            if let Some(thread) = pane["anchor"]["threadId"].as_str() {
                let id = thread.to_owned();
                let project_path = path.clone();
                dashes = dashes.child(
                    el().key(format!("studio-index-{id}"))
                        .w(if selected_row && id == s.studio.thread_id {
                            24.0
                        } else {
                            13.0
                        })
                        .h(20.0)
                        .center()
                        .child(el().w_full().h(2.0).radius(1.0).fill(
                            if selected_row && id == s.studio.thread_id {
                                t.ink
                            } else {
                                t.ink.alpha(0.16)
                            },
                        ))
                        .on_press_tx(move |s: &mut AppState, tx| {
                            s.select_studio_project(project_index);
                            s.open_studio_thread(id.clone());
                            tx.scroll_into_view(format!("studio-row-slot-{project_path}"));
                            s.center_studio_column(tx);
                        }),
                );
            }
        }
        bar = bar.child(el().w(24.0)).child(
            el().absolute((viewport_w - 100.0) / 2.0 - 32.0, 7.0)
                .w(100.0)
                .h(20.0)
                .center()
                .child(dashes),
        );
    } else {
        bar = bar.child(el().w(24.0));
    }
    if count > 0 {
        bar = bar.child(project_nav(s, t));
    }
    let content = if count == 0 {
        let parent = project.path.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
        let summary = s
            .project_data
            .summaries
            .get(&project.path)
            .cloned()
            .unwrap_or_default();
        let mut actions = col().w_full().gap(2.0);
        for (index, (symbol, title, keys)) in [
            ("◯", "New thread", "Ctrl N"),
            ("›_", "Terminal", "Ctrl Shift T"),
            ("▤", "Scratchpad", "Ctrl Shift N"),
        ]
        .into_iter()
        .enumerate()
        {
            let mut chips = row().gap(3.0).center_y();
            for key in keys.split_whitespace() {
                chips = chips.child(
                    el().px(4.0)
                        .min_w(17.0)
                        .h(17.0)
                        .center()
                        .radius(5.0)
                        .fill(t.ink.alpha(0.07))
                        .child(label(key, 11.0, 400.0, t.muted)),
                );
            }
            let mut action = row()
                .key(format!("studio-chooser-{index}"))
                .w_full()
                .h(38.0)
                .px(11.0)
                .gap(10.0)
                .center_y()
                .radius(10.0)
                .hover(t.hover)
                .child(label(symbol, 16.0, 400.0, t.muted))
                .child(label(title, 13.5, 400.0, t.ink_soft).grow(1.0))
                .child(chips);
            if index == 0 {
                action = action.on_press_tx(move |s: &mut AppState, tx| {
                    s.select_studio_project(project_index);
                    s.new_studio_thread();
                    s.center_studio_column(tx);
                });
            }
            let offset = s.chooser_magnet.offsets[index];
            let active = s.chooser_magnet.active[index];
            actions =
                actions.child(
                    el().w_full()
                        .on_layout(move |s: &mut AppState, bounds| {
                            s.chooser_magnet.bounds[index] = bounds
                        })
                        .child(action.offset(offset[0], offset[1]).offset_motion(
                            rune::Curve::tween(if active { 0.35 } else { 0.6 }, super::empty::EASE),
                        )),
                );
        }
        el().w_full()
            .grow(1.0)
            .on_pointer_move_local(|s: &mut AppState, p, tx| {
                if !s.chooser_magnet.pointer_move(p.window_x, p.window_y, false) {
                    tx.live_only();
                }
            })
            .child(crate::plasma::slot(s, cx, 1.0))
            .child(
                col().w_full().h_full().center().child(
                    col()
                        .w(256.0)
                        .items_center()
                        .child(
                            super::projects::folder_with_git(&project.name, t, &summary).scale(0.9),
                        )
                        .child(el().h(9.6))
                        .child(label(parent.to_owned(), 12.0, 400.0, t.muted))
                        .child(el().h(20.0))
                        .child(actions),
                ),
            )
    } else {
        col()
            .key(format!("studio-rail-{path}"))
            .w_full()
            .grow(1.0)
            .shrink()
            .scroll_x()
            .child(rail)
    };
    let mut result = col()
        .key(format!("studio-row-slot-{path}"))
        .w_full()
        .h(viewport_h)
        .fill(t.ground)
        .child(bar)
        .child(content);
    if let Some((menu_path, index, bounds)) = &s.studio_insert_menu
        && *menu_path == path
    {
        let index = *index;
        let x = if index == 0 {
            bounds[0] + bounds[2] + 8.0
        } else {
            bounds[0] - 192.0
        };
        let y = bounds[1] + bounds[3] / 2.0 - 75.0;
        let mut menu = col().w(184.0).radius(18.0).fill(t.raised).child(
            el().w_full()
                .h(38.0)
                .px(16.0)
                .center_y()
                .fill(t.sunken)
                .child(label("Insert", 13.0, 400.0, t.ink_soft)),
        );
        for (row_index, (symbol, title)) in
            [("◯", "New thread"), ("›_", "Terminal"), ("▤", "Scratchpad")]
                .into_iter()
                .enumerate()
        {
            let mut action = row()
                .w_full()
                .h(32.0)
                .px(12.0)
                .gap(8.0)
                .center_y()
                .child(label(symbol, 14.0, 400.0, t.muted))
                .child(label(title, 13.0, 400.0, t.ink_soft).grow(1.0))
                .child(label("›", 14.0, 400.0, t.muted));
            if row_index == 0 && !(count == 1 && s.studio.items.is_empty()) {
                action = action
                    .hover(t.hover)
                    .on_press_tx(move |s: &mut AppState, tx| {
                        s.studio_insert_menu = None;
                        s.select_studio_project(project_index);
                        s.insert_studio_thread(index);
                        s.center_studio_column(tx);
                    });
            } else {
                action = action.opacity(0.38);
            }
            menu = menu.child(action);
        }
        result = result.child(menu.absolute(x.max(0.0), y.max(0.0)));
    }
    result
}

fn parked_body(state: &StudioState, id: &str, t: Palette, mark: u32) -> El {
    let mut transcript = col().w_full().max_w(680.0).gap(34.0).self_center().py(34.0);
    for item in &state.items {
        if item.kind == "connected" || (item.text.is_empty() && item.name.is_empty()) {
            continue;
        }
        let value = if item.kind == "tool_call" {
            format!("{}  {}", item.name, item.text)
        } else {
            item.text.clone()
        };
        let mut line = label(value, 14.0, 400.0, t.muted).w_full();
        if item.kind == "user" {
            line = line.padding(14.0).radius(14.0).fill(t.hover);
        }
        transcript = transcript.child(line);
    }
    if state.items.is_empty() {
        transcript = transcript.child(el().w_full().h(580.0).child(crate::codegolf::slot(
            mark,
            false,
            [0.851, 0.475, 0.341, 0.06],
        )));
    }
    col()
        .key(format!("studio-parked-{id}"))
        .w_full()
        .grow(1.0)
        .shrink()
        .child(transcript)
}

fn resting_orb(t: Palette) -> El {
    el().w(55.0)
        .h(55.0)
        .radius(27.5)
        .fill(t.ink)
        .child(
            el().w(5.0)
                .h(11.0)
                .radius(2.5)
                .fill(t.ground)
                .rotate(-0.43)
                .absolute(30.0, 11.0),
        )
        .child(
            el().w(4.0)
                .h(9.0)
                .radius(2.0)
                .fill(t.ground)
                .rotate(-0.43)
                .absolute(41.0, 8.0),
        )
}

fn focused_body(s: &AppState, name: &str, t: Palette, mark: u32) -> El {
    let activity_plan = s.studio.conversation_fixture.as_deref() == Some("activity-plan");
    let dock =
        if activity_plan {
            col()
                .key("activity-tasks-dock")
                .w(288.0)
                .gap(6.0)
                .padding(4.0)
                .radius(18.0)
                .border(1.0, t.line)
                .fill(t.raised_high)
                .child(
                    row()
                        .center_y()
                        .gap(5.0)
                        .child(label("●", 8.0, 600.0, t.accent))
                        .child(brand_mark_size("gpt", 14.0, t))
                        .child(label("Studio activity reference", 12.0, 500.0, t.ink_soft)),
                )
                .child(
                    row()
                        .center_y()
                        .padding(4.0)
                        .radius(14.0)
                        .fill(t.ground)
                        .px(9.0)
                        .py(7.0)
                        .gap(7.0)
                        .child(label("Changes", 12.0, 550.0, t.ink_soft))
                        .child(el().grow(1.0))
                        .child(label(
                            "+4",
                            10.0,
                            500.0,
                            rune::color::hex("#329b70").unwrap(),
                        ))
                        .child(label(
                            "−2",
                            10.0,
                            500.0,
                            rune::color::hex("#d25c5c").unwrap(),
                        ))
                        .child(
                            icon(&ACTIVITY_CHEVRON, 14.0)
                                .color(t.muted)
                                .rotate(std::f32::consts::FRAC_PI_2),
                        ),
                )
                .child(el().w_full().h(1.0).fill(t.line_soft))
                .child(
                    row()
                        .center_y()
                        .padding(4.0)
                        .radius(14.0)
                        .fill(t.ground)
                        .px(9.0)
                        .py(7.0)
                        .gap(6.0)
                        .child(label("Tasks", 12.5, 500.0, t.ink_soft))
                        .child(el().grow(1.0))
                        .child(icon(&FOOTER_COPY01, 13.0).color(t.muted))
                        .child(label("1/4", 10.5, 500.0, t.muted))
                        .child(
                            icon(&ACTIVITY_CHEVRON, 14.0)
                                .color(t.muted)
                                .rotate(std::f32::consts::FRAC_PI_2),
                        ),
                )
                .child(
                    col()
                        .w_full()
                        .padding(4.0)
                        .radius(14.0)
                        .fill(t.ground)
                        .gap(2.0)
                        .child(
                            row()
                                .px(9.0)
                                .py(3.0)
                                .center_y()
                                .gap(9.0)
                                .child(
                                    el().w(15.0)
                                        .h(15.0)
                                        .center()
                                        .radius(4.0)
                                        .fill(t.accent)
                                        .child(label("✓", 10.0, 600.0, t.accent_ink)),
                                )
                                .child(
                                    el().w(228.0)
                                        .h(32.0)
                                        .center_y()
                                        .child(
                                            text("Inspect the conversation activity components")
                                                .font(TextStyle::new(12.5, 400.0).lh(16.0))
                                                .color(t.muted)
                                                .wrap()
                                                .w_full(),
                                        )
                                        .child(
                                            el().w(196.0)
                                                .h(1.0)
                                                .pin(Some(0.0), Some(8.0), None, None)
                                                .fill(t.muted.alpha(0.4)),
                                        ),
                                ),
                        )
                        .child(
                            row()
                                .px(9.0)
                                .py(3.0)
                                .center_y()
                                .gap(9.0)
                                .child(
                                    el().w(15.0)
                                        .h(15.0)
                                        .center()
                                        .radius(4.0)
                                        .fill(t.accent)
                                        .child(label("✓", 10.0, 600.0, t.accent_ink)),
                                )
                                .child(label(
                                    "Implement the turn activity layout",
                                    12.5,
                                    400.0,
                                    t.ink_soft,
                                )),
                        )
                        .child(
                            row()
                                .px(9.0)
                                .py(3.0)
                                .center_y()
                                .gap(9.0)
                                .child(
                                    el().w(15.0)
                                        .h(15.0)
                                        .center()
                                        .radius(4.0)
                                        .fill(t.accent)
                                        .child(label("✓", 10.0, 600.0, t.accent_ink)),
                                )
                                .child(label(
                                    "Verify light and dark themes",
                                    12.5,
                                    400.0,
                                    t.ink_soft,
                                )),
                        )
                        .child(
                            row()
                                .px(9.0)
                                .py(3.0)
                                .center_y()
                                .gap(9.0)
                                .child(
                                    el().w(15.0)
                                        .h(15.0)
                                        .center()
                                        .radius(4.0)
                                        .fill(t.accent)
                                        .child(label("✓", 10.0, 600.0, t.accent_ink)),
                                )
                                .child(label(
                                    "Capture reference screenshots",
                                    12.5,
                                    400.0,
                                    t.ink_soft,
                                )),
                        ),
                )
                .child(
                    row()
                        .w_full()
                        .center_y()
                        .px(9.0)
                        .py(4.0)
                        .child(label("1 file · 1/4 tasks", 10.5, 400.0, t.muted))
                        .child(el().grow(1.0))
                        .child(label("Expand all  ⌄", 10.5, 400.0, t.muted)),
                )
        } else if let Some(approval) = &s.studio.approval {
            col()
                .w_full()
                .max_w(680.0)
                .padding(18.0)
                .gap(12.0)
                .radius(20.0)
                .border(1.0, t.line)
                .fill(t.raised_high)
                .child(label("Approval requested", 12.0, 600.0, t.muted))
                .child(label(approval.title.clone(), 14.0, 600.0, t.ink))
                .child(label(approval.detail.clone(), 13.0, 400.0, t.ink_soft))
                .child(
                    row()
                        .gap(8.0)
                        .child(
                            el().key("approval-reject")
                                .px(14.0)
                                .h(32.0)
                                .center()
                                .radius(9.0)
                                .hover(t.hover)
                                .child(label("Decline", 12.5, 500.0, t.ink_soft))
                                .on_press(|s: &mut AppState| s.answer_approval("reject-once")),
                        )
                        .child(
                            el().key("approval-allow")
                                .px(14.0)
                                .h(32.0)
                                .center()
                                .radius(9.0)
                                .fill(t.accent)
                                .child(label("Allow once", 12.5, 500.0, t.accent_ink))
                                .on_press(|s: &mut AppState| s.answer_approval("allow-once")),
                        ),
                )
        } else if let Some(request) = &s.studio.question {
            let question = &request.questions[request.index];
            let mut card = col()
                .w_full()
                .max_w(680.0)
                .padding(18.0)
                .gap(12.0)
                .radius(20.0)
                .border(1.0, t.line)
                .fill(t.raised_high)
                .child(label(question.prompt.clone(), 14.0, 600.0, t.ink));
            for (index, option) in question.options.iter().enumerate() {
                let answer = option.clone();
                let multi = question.multi;
                let prefix = if multi {
                    if request.selected.contains(option) {
                        "☑  "
                    } else {
                        "□  "
                    }
                } else {
                    ""
                };
                card = card.child(
                    el().key(format!("question-option-{index}"))
                        .w_full()
                        .h(32.0)
                        .px(8.0)
                        .center_y()
                        .radius(8.0)
                        .hover(t.hover)
                        .child(label(format!("{prefix}{option}"), 13.0, 500.0, t.ink_soft))
                        .on_press(move |s: &mut AppState| {
                            if multi {
                                s.toggle_question_option(answer.clone());
                            } else {
                                s.answer_question(answer.clone().into());
                            }
                        }),
                );
            }
            if question.multi {
                card.child(
                    el().key("question-submit")
                        .h(32.0)
                        .px(12.0)
                        .center()
                        .radius(9.0)
                        .fill(t.accent)
                        .child(label("Continue", 12.5, 500.0, t.accent_ink))
                        .on_press(|s: &mut AppState| {
                            let selected = s
                                .studio
                                .question
                                .as_ref()
                                .map(|q| q.selected.clone())
                                .unwrap_or_default();
                            s.answer_question(serde_json::json!(selected));
                        }),
                )
            } else {
                card.child(
                    text_input(&s.studio.answer, TextStyle::new(14.0, 400.0))
                        .key("studio-answer")
                        .w_full()
                        .h(38.0)
                        .placeholder("Your answer…", t.placeholder)
                        .color(t.ink)
                        .on_edit(|s: &mut AppState| &mut s.studio.answer)
                        .on_submit(|s: &mut AppState, _: &mut rune::Tx| {
                            let answer = s.studio.answer.text.clone();
                            s.answer_question(answer.into());
                        }),
                )
            }
        } else if s.studio.composer_open {
            let input = text_input(&s.composer, TextStyle::new(14.0, 400.0))
                .key("studio-composer")
                .placeholder("Ask anything…", t.placeholder)
                .color(t.ink)
                .w_full()
                .h(54.0)
                .on_edit(|s: &mut AppState| &mut s.composer)
                .on_submit(AppState::send_studio);
            let bar = row()
                .w_full()
                .h(39.0)
                .center_y()
                .gap(8.0)
                .child(label("+", 21.0, 400.0, t.muted))
                .child(
                    el().key("studio-mode-picker")
                        .px(7.0)
                        .h(30.0)
                        .center()
                        .radius(9.0)
                        .hover(t.hover)
                        .child(label(
                            if s.studio.mode.is_empty() {
                                "Ask"
                            } else {
                                &s.studio.mode
                            },
                            12.0,
                            500.0,
                            t.ink_soft,
                        ))
                        .on_press(|s: &mut AppState| {
                            s.studio.mode_picker_open = !s.studio.mode_picker_open;
                            s.studio.effort_picker_open = false;
                            s.studio.picker_open = false;
                        }),
                )
                .child(el().grow(1.0))
                .child(
                    el().key("studio-model-picker")
                        .px(7.0)
                        .h(30.0)
                        .center()
                        .radius(9.0)
                        .hover(t.hover)
                        .child(label(
                            format!(
                                "{}  {}",
                                s.studio
                                    .providers
                                    .get(s.studio.provider_index)
                                    .map(|p| p.label.as_str())
                                    .unwrap_or("Select provider"),
                                s.studio
                                    .models
                                    .get(s.studio.model_index)
                                    .map(|m| m.label.as_str())
                                    .unwrap_or("")
                            ),
                            12.5,
                            500.0,
                            t.ink_soft,
                        ))
                        .on_press(|s: &mut AppState| s.studio.picker_open = !s.studio.picker_open),
                )
                .child(
                    el().key("studio-effort-picker")
                        .px(7.0)
                        .h(30.0)
                        .center()
                        .radius(9.0)
                        .hover(t.hover)
                        .child(label(
                            if s.studio.effort.is_empty() {
                                "Effort"
                            } else {
                                &s.studio.effort
                            },
                            12.0,
                            500.0,
                            t.ink_soft,
                        ))
                        .on_press(|s: &mut AppState| {
                            s.studio.effort_picker_open = !s.studio.effort_picker_open;
                            s.studio.mode_picker_open = false;
                            s.studio.picker_open = false;
                        }),
                )
                .child(
                    el().w(32.0)
                        .h(32.0)
                        .center()
                        .radius(16.0)
                        .fill(t.accent)
                        .child(label(
                            if s.studio.busy { "■" } else { "↑" },
                            18.0,
                            600.0,
                            t.accent_ink,
                        ))
                        .on_press_tx(|s: &mut AppState, tx| {
                            if s.studio.busy {
                                s.interrupt_studio();
                            } else {
                                s.send_studio(tx);
                            }
                        }),
                );
            let mut picker = col()
                .w_full()
                .max_w(360.0)
                .padding(6.0)
                .gap(2.0)
                .radius(14.0)
                .border(1.0, t.line)
                .fill(t.raised_high);
            if s.studio.picker_open {
                picker = picker.child(label("PROVIDER", 10.0, 600.0, t.muted).px(8.0).py(4.0));
                for (index, provider) in s.studio.providers.iter().enumerate() {
                    picker = picker.child(
                        el().key(format!("provider-{index}"))
                            .w_full()
                            .h(32.0)
                            .px(8.0)
                            .center_y()
                            .radius(8.0)
                            .hover(t.hover)
                            .child(label(
                                format!(
                                    "{}{}",
                                    if index == s.studio.provider_index {
                                        "✓  "
                                    } else {
                                        "    "
                                    },
                                    provider.label
                                ),
                                12.5,
                                500.0,
                                t.ink,
                            ))
                            .on_press(move |s: &mut AppState| s.select_provider(index)),
                    );
                }
                picker = picker.child(label("MODEL", 10.0, 600.0, t.muted).px(8.0).py(4.0));
                for (index, model) in s.studio.models.iter().enumerate() {
                    picker = picker.child(
                        el().key(format!("model-{index}"))
                            .w_full()
                            .h(32.0)
                            .px(8.0)
                            .center_y()
                            .radius(8.0)
                            .hover(t.hover)
                            .child(label(
                                format!(
                                    "{}{}",
                                    if index == s.studio.model_index {
                                        "✓  "
                                    } else {
                                        "    "
                                    },
                                    model.label
                                ),
                                12.5,
                                500.0,
                                t.ink,
                            ))
                            .on_press(move |s: &mut AppState| {
                                s.studio.model_index = index;
                                s.studio.effort = s.studio.models[index]
                                    .default_effort
                                    .clone()
                                    .unwrap_or_default();
                                if s.studio.handoff_picker {
                                    s.create_continuation(true);
                                } else {
                                    s.studio.picker_open = false;
                                }
                            }),
                    );
                }
            }
            let mut dock = col().w_full().max_w(680.0).items_center();
            if s.studio.picker_open {
                dock = dock.child(picker);
            }
            if s.studio.mode_picker_open {
                let mut menu = col()
                    .w_full()
                    .max_w(240.0)
                    .padding(6.0)
                    .radius(14.0)
                    .border(1.0, t.line)
                    .fill(t.raised_high);
                for (value, title) in [
                    ("ask", "Ask"),
                    ("accept-edits", "Accept edits"),
                    ("full-access", "Full access"),
                ] {
                    menu = menu.child(
                        el().key(format!("mode-{value}"))
                            .w_full()
                            .h(32.0)
                            .px(8.0)
                            .center_y()
                            .hover(t.hover)
                            .child(label(title, 12.5, 500.0, t.ink))
                            .on_press(move |s: &mut AppState| {
                                s.studio.mode = value.into();
                                s.studio.mode_picker_open = false;
                            }),
                    );
                }
                dock = dock.child(menu);
            }
            if s.studio.effort_picker_open {
                let mut menu = col()
                    .w_full()
                    .max_w(240.0)
                    .padding(6.0)
                    .radius(14.0)
                    .border(1.0, t.line)
                    .fill(t.raised_high);
                if let Some(model) = s.studio.models.get(s.studio.model_index) {
                    for effort in &model.efforts {
                        let value = effort.clone();
                        menu = menu.child(
                            el().key(format!("effort-{effort}"))
                                .w_full()
                                .h(32.0)
                                .px(8.0)
                                .center_y()
                                .hover(t.hover)
                                .child(label(effort.clone(), 12.5, 500.0, t.ink))
                                .on_press(move |s: &mut AppState| {
                                    s.studio.effort = value.clone();
                                    s.studio.effort_picker_open = false;
                                }),
                        );
                    }
                }
                dock = dock.child(menu);
            }
            dock.child(
                col()
                    .w_full()
                    .padding(14.0)
                    .radius(26.0)
                    .border(1.0, t.line)
                    .fill(t.raised_high)
                    .child(input)
                    .child(bar),
            )
            .child(
                row()
                    .w_full()
                    .h(26.0)
                    .px(20.0)
                    .gap(16.0)
                    .center_y()
                    .child(label("ϟ  Guest", 11.5, 500.0, t.ink_soft))
                    .child(label(format!("▱  {name}"), 11.5, 500.0, t.ink_soft))
                    .child(el().grow(1.0))
                    .child(label("New thread", 11.5, 500.0, t.muted)),
            )
        } else {
            col().w_full().items_center().child(
                resting_orb(t)
                    .key("studio-wake-composer")
                    .on_press(|s: &mut AppState| {
                        s.studio.composer_open = true;
                        s.composer.focused = true;
                    }),
            )
        };
    let mut transcript = col().w_full().max_w(720.0).self_center().gap(24.0).pt(24.0);
    if !s.studio.items.is_empty()
        && !s
            .studio
            .conversation_fixture
            .as_deref()
            .is_some_and(|x| x.starts_with("activity-"))
    {
        // Head of a populated thread: the day, then who picked it up — two
        // small marks the column's 24pt gap spaces like every other row
        // (the connected mark sits 14pt higher, per `.thread-mark +
        // .thread-mark`).
        let mut date_style = TextStyle::new(11.0, 500.0).mono().lh(16.0);
        date_style.tracking = 0.22;
        transcript = transcript.child(
            row()
                .w_full()
                .justify_center()
                .child(text("Today").font(date_style).color(t.muted)),
        );
        if let Some(identity) = &s.studio.connected_identity {
            let mut name_style = TextStyle::new(12.0, 600.0).lh(16.0);
            name_style.tracking = -0.12;
            transcript = transcript.child(
                row()
                    .w_full()
                    .justify_center()
                    .center_y()
                    .gap(6.0)
                    .mt(-14.0)
                    .child(connected_avatar(identity, t))
                    .child(
                        text(identity.name.clone())
                            .font(name_style)
                            .color(t.ink_soft),
                    )
                    .child(
                        text("connected")
                            .font(TextStyle::new(12.0, 400.0).lh(16.0))
                            .color(t.muted),
                    ),
            );
        }
    }
    let last_user = s.studio.items.iter().rposition(|item| item.kind == "user");
    let mut user_count = 0usize;
    let mut speaker_count = 0usize;
    // Thread-wide code-block index, so the fixture's forced-Copy target
    // (`fixture_cb_copy`) can be matched across assistant items.
    let mut cb_base = 0usize;
    let mut exchange: Option<El> = None;
    let activity_fixture = s
        .studio
        .conversation_fixture
        .as_deref()
        .is_some_and(|x| x.starts_with("activity-"));
    let is_activity = activity_fixture
        || (s.studio.busy && s.studio.items.iter().any(|item| item.kind == "tool_call"));
    let activity_rows_open = if activity_fixture {
        s.studio.activity_open
    } else {
        s.studio.busy
    };
    let mut activity_head = false;
    for (index, item) in s.studio.items.iter().enumerate() {
        if activity_fixture && !s.studio.activity_open && item.kind == "tool_call" {
            continue;
        }
        if item.kind == "connected" || (item.text.is_empty() && item.name.is_empty()) {
            continue;
        }
        if is_activity && s.studio.busy && item.kind == "assistant_text" {
            continue;
        }
        let activity_row_open = s.studio.activity_expanded.contains(&item.id);
        let line = match item.kind.as_str() {
            "user" => {
                user_count += 1;
                let rail = t.ink.alpha(0.12);
                let connector_shadow = rune::color::hex("#000000").unwrap().alpha(0.35);
                // The connector runs from the bubble's left edge at its
                // midline, corners down 12pt at the avatar column, and stops
                // 7.7pt above the speaker row (constants assume the fixture's
                // single-line bubbles).
                row()
                    .w_full()
                    .center_y()
                    .child(el().w(25.0))
                    .child(
                        el().grow(1.0)
                            .h(1.0)
                            .fill(rail)
                            .shadow(1.0, 1.0, connector_shadow),
                    )
                    .child(
                        text(item.text.clone())
                            .key(format!("studio-user-text-{user_count}"))
                            .font(TextStyle::new(14.0, 400.0).lh(22.68))
                            .color(t.ink)
                            .max_w(576.0)
                            .px(15.0)
                            .py(10.0)
                            .corners([16.0, 16.0, 5.0, 16.0])
                            .fill(crate::theme::mix_srgb(t.ground, t.accent, 0.09)),
                    )
                    .child(icon(&CONNECTOR_CORNER, 12.0).color(rail).pin(
                        Some(13.0),
                        Some(21.33),
                        None,
                        None,
                    ))
                    .child(
                        el().pin(Some(13.0), Some(33.33), None, None)
                            .w(1.0)
                            .h(55.67)
                            .fill(rail)
                            .shadow(1.0, 1.0, connector_shadow),
                    )
            }
            "compaction" => row().w_full().justify_center().child(
                text(if s.studio.conversation_fixture.is_some() {
                    format!("{} · 8:53 AM", item.text)
                } else {
                    item.text.clone()
                })
                .font(TextStyle::new(16.0, 400.0).lh(24.8))
                .color(t.ink),
            ),
            "setting_mark" => {
                let brains = |count: usize, color: &str| {
                    let mut stack = row().center_y().gap(1.0);
                    for _ in 0..count {
                        stack = stack.child(
                            icon(&PICKER_BRAIN, 13.0).color(rune::color::hex(color).unwrap()),
                        );
                    }
                    stack
                };
                row()
                    .w_full()
                    .center_y()
                    .justify_center()
                    .gap(6.0)
                    .child(
                        row().center_y().gap(4.0).child(brains(2, "#10B981")).child(
                            text("Medium")
                                .font(TextStyle::new(12.0, 550.0).lh(16.0))
                                .color(t.ink_soft),
                        ),
                    )
                    .child(icon(&SETTING_ARROW, 13.0).color(t.muted))
                    .child(
                        row().center_y().gap(4.0).child(brains(3, "#6366F1")).child(
                            text("High")
                                .font(TextStyle::new(12.0, 550.0).lh(16.0))
                                .color(t.ink_soft),
                        ),
                    )
            }
            "handoff_mark" => row()
                .w_full()
                .center_y()
                .justify_center()
                .gap(5.0)
                .py(2.0)
                .child(
                    text("Handed from")
                        .font(TextStyle::new(12.0, 400.0).lh(18.59))
                        .color(t.muted),
                )
                .child(brand_mark_size("gpt", 13.0, t))
                .child(
                    text("GPT 5.4")
                        .font(TextStyle::new(12.0, 550.0).lh(18.59))
                        .color(t.ink_soft),
                ),
            "assistant_text" => {
                let mut turn = col().w_full().gap(if is_activity { 8.0 } else { 15.0 });
                match s.studio.conversation_fixture.as_deref() {
                    Some("activity-expanded") => turn = turn.mt(10.0),
                    Some("activity-diff") => turn = turn.mt(18.0),
                    Some("activity-hover") => turn = turn.mt(13.0),
                    _ => {}
                }
                let first = index == 0 || s.studio.items[index - 1].kind != "assistant_text";
                if first && !is_activity {
                    speaker_count += 1;
                    let mut head = row()
                        .key(format!("studio-speaker-{speaker_count}"))
                        .center_y()
                        .gap(8.0)
                        .min_h(26.0)
                        .mb(-6.0);
                    if let Some(name) = s.studio.conversation_fixture.as_deref().and_then(|scene| {
                        conversation_fixture_speaker(
                            scene,
                            fixture_dark_theme(t.dark),
                            speaker_count,
                        )
                    }) {
                        let identity = crate::state::StudioIdentity {
                            name: name.into(),
                            svg: crate::review::conversation_avatar(name),
                            avatar: None,
                        };
                        head = head.child(avatar_at(&identity, 26.0, t));
                        head = head.child(
                            text(identity.name)
                                .font(TextStyle::new(13.0, 500.0).lh(13.0))
                                .color(t.ink_soft),
                        );
                    } else if let Some(identity) = &s.studio.connected_identity {
                        head = head.child(avatar_at(identity, 26.0, t));
                        head = head.child(
                            text(identity.name.clone())
                                .font(TextStyle::new(13.0, 500.0).lh(13.0))
                                .color(t.ink_soft),
                        );
                    } else {
                        head = head.child(
                            text("Assistant")
                                .font(TextStyle::new(13.0, 500.0).lh(13.0))
                                .color(t.ink_soft),
                        );
                    }
                    turn = turn.child(head);
                }
                if s.studio
                    .conversation_fixture
                    .as_deref()
                    .is_some_and(|x| x.starts_with("activity-"))
                {
                    for para in item.text.split("\n\n") {
                        turn = turn.child(
                            text(para.trim_start_matches("## ").to_owned())
                                .font(
                                    TextStyle::new(
                                        if para.starts_with("## ") { 18.0 } else { 14.0 },
                                        if para.starts_with("## ") {
                                            600.0
                                        } else {
                                            400.0
                                        },
                                    )
                                    .lh(22.0),
                                )
                                .color(t.ink)
                                .wrap()
                                .w_full()
                                .max_w(680.0),
                        );
                    }
                } else {
                    turn = turn.child(super::studio_markdown::render(
                        &item.text,
                        t,
                        cb_base,
                        s.studio.fixture_cb_copy,
                    ));
                }
                cb_base += item.text.matches("```").count() / 2;
                let copy = item.text.clone();
                let fixture = s.studio.conversation_fixture.is_some();
                let block_id = item.block_id.clone();
                let mut footer =
                    row()
                        .center_y()
                        .gap(2.0)
                        .mt(-7.0)
                        .min_h(24.0)
                        .child(
                            text(if fixture { "8:53 AM" } else { "" })
                                .font(TextStyle::new(12.0, 400.0).mono().lh(18.6))
                                .color(t.muted)
                                .opacity(0.92)
                                .mr(8.0),
                        )
                        .child(
                            // `.act`: a 24×24 button with the 14px icon centred.
                            el().w(24.0)
                                .h(24.0)
                                .center()
                                .radius(7.0)
                                .hover(t.hover)
                                .child(icon(&FOOTER_COPY01, 14.0).color(t.muted).on_press_tx(
                                    move |_: &mut AppState, tx| tx.copy(copy.clone()),
                                )),
                        )
                        .child(
                            el().w(24.0)
                                .h(24.0)
                                .center()
                                .radius(7.0)
                                .hover(t.hover)
                                .child(icon(&FOOTER_FOOTPRINTS, 14.0).color(t.muted)),
                        );
                // The fixture shows the same affordance as Electron, but the
                // parity scene leaves it inert. Live replies open the picker.
                if fixture {
                    footer = footer.child(
                        el().w(24.0)
                            .h(24.0)
                            .center()
                            .radius(7.0)
                            .hover(t.hover)
                            .child(icon(&FOOTER_GITFORK, 14.0).color(t.muted)),
                    );
                } else if let Some(block_id) = block_id {
                    footer =
                        footer.child(icon(&FOOTER_GITFORK, 14.0).color(t.muted).on_press(
                            move |s: &mut AppState| s.open_branch_picker(block_id.clone()),
                        ));
                }
                if is_activity {
                    turn
                } else {
                    turn.child(footer)
                }
            }
            "tool_call" => {
                let command = item.name == "run_command";
                let verb = if command {
                    "Ran"
                } else if item.name == "edit_file" {
                    if s.studio.busy { "Editing" } else { "Edited" }
                } else {
                    "Read"
                };
                let path = item.text.as_str();
                let (directory, filename) = path.rsplit_once('/').unwrap_or(("", path));
                let short_name = if filename.chars().count() > 11 {
                    format!("{}…", filename.chars().take(10).collect::<String>())
                } else {
                    filename.to_owned()
                };
                let short_path = format!("{directory}{short_name}");
                let step_icon = if command {
                    &ACTIVITY_COMMAND
                } else if item.name == "edit_file" {
                    &ACTIVITY_EDIT
                } else {
                    &ACTIVITY_FILE
                };
                let step_hue = if command {
                    rune::color::hex("#22a06b").unwrap()
                } else if item.name == "edit_file" {
                    rune::color::hex("#8b5cf6").unwrap()
                } else {
                    rune::color::hex("#4f9bea").unwrap()
                };
                let mut activity_row = row()
                    .key(format!("activity-row-{}", item.id))
                    .w_full()
                    .h(18.0)
                    .gap(7.0)
                    .center_y()
                    .radius(4.0)
                    .fill(
                        if s.studio.conversation_fixture.as_deref() == Some("activity-hover")
                            && item.name == "read_file"
                        {
                            t.hover
                        } else {
                            t.ground.alpha(0.0)
                        },
                    )
                    .hover(t.hover)
                    .child(if item.name == "edit_file" && s.studio.busy {
                        icon(&ACTIVITY_THINKING, 14.0)
                            .color(step_hue)
                            .rotate((s.start_actions.clock as f32 * 2.6) % std::f32::consts::TAU)
                    } else {
                        icon(step_icon, 14.0).color(step_hue)
                    })
                    .child(
                        text(verb)
                            .font(TextStyle::new(12.5, 400.0))
                            .color(t.ink_soft),
                    );
                if command {
                    activity_row = activity_row.child(
                        text(short_path)
                            .font(TextStyle::new(11.5, 400.0).mono())
                            .color(t.muted),
                    );
                } else {
                    activity_row = activity_row.child(
                        el().px(3.0)
                            .py(1.0)
                            .radius(3.0)
                            .fill(t.ink.alpha(0.035))
                            .child(
                                row()
                                    .center_y()
                                    .gap(3.0)
                                    .child(icon(super::file_icons::for_path(path), 13.0))
                                    .child(
                                        text(directory)
                                            .font(TextStyle::new(11.5, 400.0).mono())
                                            .color(t.muted),
                                    )
                                    .child(
                                        text(short_name)
                                            .font(TextStyle::new(11.5, 500.0).mono())
                                            .color(t.ink_soft),
                                    ),
                            ),
                    );
                }
                activity_row = activity_row
                    .child(el().grow(1.0))
                    .child(if item.name == "edit_file" && !s.studio.busy {
                        row()
                            .gap(3.0)
                            .child(
                                text("+4")
                                    .font(TextStyle::new(10.5, 500.0).mono())
                                    .color(rune::color::hex("#329b70").unwrap()),
                            )
                            .child(
                                text("−2")
                                    .font(TextStyle::new(10.5, 500.0).mono())
                                    .color(rune::color::hex("#d25c5c").unwrap()),
                            )
                    } else {
                        el()
                    })
                    .child(text("›").font(TextStyle::new(14.0, 400.0)).color(t.faint))
                    .on_press({
                        let row_id = item.id.clone();
                        move |s: &mut AppState| {
                            if s.studio.activity_expanded.contains(&row_id) {
                                s.studio.activity_expanded.retain(|id| id != &row_id);
                            } else {
                                s.studio.activity_expanded.push(row_id.clone());
                            }
                        }
                    });
                let mut body = col().w_full().gap(0.0).child(activity_row);
                if matches!(
                    s.studio.conversation_fixture.as_deref(),
                    Some(
                        "activity-running"
                            | "activity-expanded"
                            | "activity-diff"
                            | "activity-hover"
                    )
                ) && (command || item.name == "edit_file")
                {
                    if command && activity_rows_open {
                        let mut detail = col()
                            .w_full()
                            .pl(25.0)
                            .gap(3.0)
                            .child(
                                text("✓ No type errors found")
                                    .font(TextStyle::new(11.0, 400.0).mono())
                                    .color(t.ink_soft),
                            )
                            .child(
                                text("Done in 4.02s")
                                    .font(TextStyle::new(11.0, 400.0).mono())
                                    .color(t.muted),
                            );
                        if activity_row_open
                            && s.studio.conversation_fixture.as_deref() == Some("activity-expanded")
                        {
                            detail = detail
                                .child(
                                    row()
                                        .w_full()
                                        .h(24.0)
                                        .px(9.0)
                                        .center_y()
                                        .gap(6.0)
                                        .radius(7.0)
                                        .fill(t.ink.alpha(0.035))
                                        .child(icon(&ACTIVITY_COMMAND, 14.0).color(t.muted))
                                        .child(label("Tool detail", 11.0, 500.0, t.muted))
                                        .child(el().grow(1.0))
                                        .child(icon(&FOOTER_COPY01, 12.0).color(t.muted))
                                        .child(label("Copy", 10.5, 400.0, t.muted)),
                                )
                                .child(
                                    el().w_full()
                                        .px(9.0)
                                        .py(28.0)
                                        .radius(6.0)
                                        .fill(t.ink.alpha(0.025))
                                        .child(
                                            text(item.detail.clone())
                                                .font(TextStyle::new(10.5, 400.0).mono().lh(17.0))
                                                .color(t.ink_soft),
                                        ),
                                );
                        }
                        body = body.child(detail);
                    } else if matches!(
                        s.studio.conversation_fixture.as_deref(),
                        Some("activity-diff" | "activity-expanded" | "activity-hover")
                    ) && item.name == "edit_file"
                        && activity_row_open
                    {
                        body = body.child(
                            col()
                                .pl(25.0)
                                .gap(1.0)
                                .radius(7.0)
                                .child(
                                    row()
                                        .w_full()
                                        .h(20.0)
                                        .center_y()
                                        .px(7.0)
                                        .fill(
                                            rune::color::hex(if t.dark {
                                                "#7f303044"
                                            } else {
                                                "#fbe9e9"
                                            })
                                            .unwrap(),
                                        )
                                        .gap(8.0)
                                        .child(
                                            text("−")
                                                .font(TextStyle::new(12.0, 600.0).mono())
                                                .color(rune::color::hex("#bd5757").unwrap()),
                                        )
                                        .child(
                                            text("const gap = 12;")
                                                .font(TextStyle::new(12.0, 400.0).mono())
                                                .color(t.ink_soft),
                                        ),
                                )
                                .child(
                                    row()
                                        .w_full()
                                        .h(20.0)
                                        .center_y()
                                        .px(7.0)
                                        .fill(
                                            rune::color::hex(if t.dark {
                                                "#23594144"
                                            } else {
                                                "#e7f3ed"
                                            })
                                            .unwrap(),
                                        )
                                        .gap(8.0)
                                        .child(
                                            text("+")
                                                .font(TextStyle::new(12.0, 600.0).mono())
                                                .color(rune::color::hex("#32815e").unwrap()),
                                        )
                                        .child(
                                            text("const gap = 10;")
                                                .font(TextStyle::new(12.0, 400.0).mono())
                                                .color(t.ink_soft),
                                        ),
                                )
                                .child(
                                    row()
                                        .w_full()
                                        .h(20.0)
                                        .center_y()
                                        .px(7.0)
                                        .fill(
                                            rune::color::hex(if t.dark {
                                                "#23594144"
                                            } else {
                                                "#e7f3ed"
                                            })
                                            .unwrap(),
                                        )
                                        .gap(8.0)
                                        .child(
                                            text("+")
                                                .font(TextStyle::new(12.0, 600.0).mono())
                                                .color(rune::color::hex("#32815e").unwrap()),
                                        )
                                        .child(
                                            text("const reducedMotion = prefersReducedMotion();")
                                                .font(TextStyle::new(12.0, 400.0).mono())
                                                .color(t.ink_soft)
                                                .truncate(),
                                        ),
                                )
                                .child(label("3 more changed lines", 10.5, 400.0, t.muted)),
                        );
                        if s.studio.conversation_fixture.as_deref() == Some("activity-diff") {
                            let deleted =
                                rune::color::hex(if t.dark { "#7f3030" } else { "#d25c5c" })
                                    .unwrap();
                            let added =
                                rune::color::hex(if t.dark { "#2c6747" } else { "#329b70" })
                                    .unwrap();
                            let line = |old: &str,
                                        new: &str,
                                        sign: &str,
                                        code: &str,
                                        color: rune::Color| {
                                row()
                                    .w_full()
                                    .h(19.0)
                                    .center_y()
                                    .px(8.0)
                                    .fill(color.alpha(0.12))
                                    .child(
                                        row()
                                            .w(34.0)
                                            .center_y()
                                            .justify_end()
                                            .child(label(old, 10.0, 400.0, t.muted)),
                                    )
                                    .child(
                                        row()
                                            .w(34.0)
                                            .center_y()
                                            .justify_end()
                                            .child(label(new, 10.0, 400.0, t.muted)),
                                    )
                                    .child(label(sign, 11.0, 600.0, color).w(14.0))
                                    .child(
                                        text(code.to_owned())
                                            .font(TextStyle::new(12.0, 400.0).mono())
                                            .color(t.ink_soft),
                                    )
                            };
                            let hunk = |value: &str| {
                                el().w_full()
                                    .h(20.0)
                                    .px(8.0)
                                    .center_y()
                                    .fill(t.ink.alpha(0.03))
                                    .child(label(value, 10.0, 400.0, t.muted))
                            };
                            body = body.child(
                                col()
                                    .w_full()
                                    .pl(25.0)
                                    .mt(5.0)
                                    .gap(4.0)
                                    .child(
                                        row()
                                            .w_full()
                                            .h(24.0)
                                            .px(9.0)
                                            .center_y()
                                            .gap(6.0)
                                            .radius(8.0)
                                            .fill(t.ink.alpha(0.04))
                                            .child(icon(&ACTIVITY_EDIT, 14.0).color(t.muted))
                                            .child(label("Diff", 11.0, 500.0, t.muted))
                                            .child(el().grow(1.0))
                                            .child(icon(&FOOTER_COPY01, 12.0).color(t.muted))
                                            .child(label("Copy", 10.5, 400.0, t.muted)),
                                    )
                                    .child(
                                        col()
                                            .w_full()
                                            .padding(4.0)
                                            .gap(0.0)
                                            .radius(8.0)
                                            .fill(t.ink.alpha(0.025))
                                            .child(hunk("@@ -12,7 +12,8 @@"))
                                            .child(line("1", "", "−", "const gap = 12;", deleted))
                                            .child(line("", "1", "+", "const gap = 10;", added))
                                            .child(line(
                                                "",
                                                "2",
                                                "+",
                                                "const reducedMotion = prefersReducedMotion();",
                                                added,
                                            ))
                                            .child(hunk("@@ -41,6 +42,7 @@"))
                                            .child(line(
                                                "1",
                                                "",
                                                "−",
                                                ".fold { transition: all 380ms ease; }",
                                                deleted,
                                            ))
                                            .child(line(
                                                "",
                                                "1",
                                                "+",
                                                ".fold { transition: grid-template-rows 380ms …",
                                                added,
                                            ))
                                            .child(line(
                                                "",
                                                "2",
                                                "+",
                                                "@media (prefers-reduced-motion: reduce)…",
                                                added,
                                            )),
                                    ),
                            );
                        }
                    }
                }
                if !activity_fixture && command && activity_row_open && !item.detail.is_empty() {
                    body = body.child(
                        el().w_full()
                            .pl(25.0)
                            .px(9.0)
                            .py(8.0)
                            .radius(7.0)
                            .fill(t.ink.alpha(0.035))
                            .child(
                                text(item.detail.clone())
                                    .font(TextStyle::new(10.5, 400.0).mono().lh(15.0))
                                    .color(t.ink_soft)
                                    .wrap()
                                    .w_full(),
                            ),
                    );
                }
                if activity_rows_open {
                    body
                } else {
                    el().h(0.0)
                }
            }
            "plan_text" => el(),
            _ => label(
                if item.kind == "tool_call" {
                    format!("{}  {}", item.name, item.text)
                } else {
                    item.text.clone()
                },
                12.5,
                400.0,
                t.muted,
            )
            .w_full(),
        };
        if is_activity
            && ((item.kind == "tool_call" && activity_rows_open)
                || (item.kind == "assistant_text" && !activity_rows_open))
            && !activity_head
        {
            let agent = s.studio.connected_identity.as_ref();
            let mut head = row()
                .key("activity-turn-head")
                .w_full()
                .h(26.0)
                .center_y()
                .gap(7.0)
                .mt(4.0);
            if let Some(agent) = agent {
                head = head.child(avatar_at(agent, 22.0, t));
            }
            let assistant_name = if activity_fixture {
                if s.studio.busy { "Garnet" } else { "Marble" }
            } else {
                s.studio
                    .connected_identity
                    .as_ref()
                    .map_or("Assistant", |identity| identity.name.as_str())
            };
            head = head.child(label(assistant_name, 12.5, 500.0, t.ink_soft));
            if !s.studio.busy {
                head = head.child(label("17s", 11.5, 400.0, t.muted));
                head = head.child(
                    text(if s.studio.activity_open { "⌃" } else { "⌄" })
                        .font(TextStyle::new(11.0, 400.0))
                        .color(t.muted),
                );
            }
            let open = s.studio.activity_open;
            if s.studio.busy {
                head = head.mt(34.0);
            } else {
                head = head
                    .mt(43.0)
                    .mb(if s.studio.activity_open { 5.0 } else { 0.0 });
            }
            head = head.on_press(move |s: &mut AppState| s.studio.activity_open = !open);
            if let Some(group) = exchange.take() {
                exchange = Some(group.child(head));
            }
            activity_head = true;
            if s.studio.busy
                && let Some(group) = exchange.take()
            {
                let angle = (s.start_actions.clock as f32 * 2.6) % std::f32::consts::TAU;
                let status = row()
                    .key("activity-thinking-status")
                    .w_full()
                    .h(22.0)
                    .center_y()
                    .child(icon(&ACTIVITY_THINKING, 14.0).color(t.muted).rotate(angle))
                    .child(el().grow(1.0))
                    .child(icon(&ACTIVITY_CHEVRON, 14.0).color(t.faint));
                exchange = Some(group.child(status));
            } else if activity_rows_open && let Some(group) = exchange.take() {
                let status = row()
                    .key("activity-thinking-status")
                    .w_full()
                    .h(20.0)
                    .center_y()
                    .child(icon(&ACTIVITY_THINKING, 14.0).color(t.muted))
                    .child(el().grow(1.0))
                    .child(icon(&ACTIVITY_CHEVRON, 14.0).color(t.faint));
                exchange = Some(group.child(status));
            }
        }
        if item.kind == "user" {
            if let Some(previous) = exchange.take() {
                transcript = transcript.child(previous);
            }
            let activity_gap = 7.0;
            let mut group = col()
                .w_full()
                .gap(if is_activity { activity_gap } else { 54.0 });
            if Some(index) == last_user && !is_activity {
                let height = if s.studio_viewport.1 > 0.0 {
                    s.studio_viewport.1
                } else {
                    854.0
                };
                group = group.min_h((height * 0.72).min(620.0));
            }
            exchange = Some(group.child(line));
        } else if matches!(
            item.kind.as_str(),
            "compaction" | "setting_mark" | "handoff_mark"
        ) {
            if let Some(previous) = exchange.take() {
                transcript = transcript.child(previous);
            }
            let previous_was_mark = index > 0
                && matches!(
                    s.studio.items[index - 1].kind.as_str(),
                    "compaction" | "setting_mark" | "handoff_mark"
                );
            transcript = transcript.child(line.mt(if previous_was_mark { -14.0 } else { -25.0 }));
        } else if let Some(group) = exchange.take() {
            exchange = Some(group.child(line));
        } else {
            transcript = transcript.child(line);
        }
    }
    if let Some(group) = exchange {
        transcript = transcript.child(group);
    }
    if let Some(error) = &s.studio.error {
        transcript = transcript.child(label(error.clone(), 12.5, 400.0, t.accent));
    }
    // Only an empty thread keeps the codegolf art; a populated thread's head
    // carries the day and connected marks instead.
    let art = if s.studio.items.is_empty() {
        el().w_full().h(580.0).center().child(crate::codegolf::slot(
            mark,
            s.art_focused,
            [0.851, 0.475, 0.341, 0.06],
        ))
    } else {
        el()
    };
    col()
        .w_full()
        .grow(1.0)
        .shrink()
        .min_h(0.0)
        .child(
            col()
                .key("studio-transcript")
                .w_full()
                .grow(1.0)
                .shrink()
                .min_h(0.0)
                // Anchored fixture scenes settle mid-content, so they must not
                // fight the bottom stick; "mid" and live threads follow the end.
                .scroll(ScrollSpec {
                    stick_bottom: !is_activity
                        && !matches!(
                            s.studio.conversation_fixture.as_deref(),
                            Some("scrolled" | "compaction" | "marks" | "code"),
                        ),
                })
                .clip_fade_linear(0.0, 14.0, 0.0, 176.0)
                .child(art)
                .child(transcript)
                // The body's 208pt bottom padding (composer overlay clearance).
                .child(el().h(208.0)),
        )
        .child(if activity_plan {
            row()
                .pin(Some(0.0), None, Some(0.0), Some(14.0))
                .px(16.0)
                .justify_end()
                .child(dock)
        } else {
            row()
                .pin(Some(0.0), None, Some(0.0), Some(22.0))
                .px(16.0)
                .justify_center()
                .child(dock)
        })
}

#[cfg(test)]
#[allow(clippy::field_reassign_with_default)]
mod tests {
    use super::*;
    use crate::state::{Page, Project, StudioItem};
    use rune::{Env, Runtime};
    use serde_json::json;

    #[test]
    fn thread_info_shortens_long_ids_without_splitting_unicode() {
        assert_eq!(short_thread_id("abcdefgh123456789xyz"), "abcdefgh…789xyz");
        assert_eq!(short_thread_id("short"), "short");
        assert_eq!(short_thread_id("αβγδεζηθικλμνξοπρσ"), "αβγδεζηθ…νξοπρσ");
    }

    #[test]
    fn saved_project_rows_are_mounted_and_clicking_a_row_changes_focus() {
        let mut s = AppState {
            page: Page::Studio,
            studio_layout_ready: true,
            ..Default::default()
        };
        s.projects = vec![
            Project {
                name: "first".into(),
                path: "/first".into(),
            },
            Project {
                name: "second".into(),
                path: "/second".into(),
            },
        ];
        s.selected_project = Some(0);
        s.studio.project_path = "/first".into();
        s.studio.thread_id = "a".into();
        s.studio.thread_open = true;
        s.studio_layout = json!({"version":2,"rows":[
            {"projectPath":"/first","focusedId":"a","panes":[{"id":"a","anchor":{"threadId":"a"}}]},
            {"projectPath":"/second","focusedId":"b","panes":[{"id":"b","anchor":{"threadId":"b"}}]}
        ]});
        s.studio_threads.insert(
            "b".into(),
            StudioState {
                thread_id: "b".into(),
                project_path: "/second".into(),
                thread_open: true,
                ..Default::default()
            },
        );
        let mut rt = Runtime::new(s, view, (1280.0, 840.0), Env::new(false, 1.0));
        rt.frame(0.0);
        assert!(rt.find("studio-row-slot-/first").is_some());
        assert!(rt.find("studio-row-slot-/second").is_some());
        let (x, y) = rt.find("studio-row-1").unwrap();
        rt.pointer_move(x, y);
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.0);
        assert_eq!(rt.state.studio.project_path, "/second");
        assert_eq!(rt.state.studio.thread_id, "b");
        assert_eq!(rt.state.studio_layout["focusedRow"], "/second");
    }

    #[test]
    fn rail_renders_and_focuses_a_streaming_background_thread() {
        let mut s = AppState::default();
        s.page = Page::Studio;
        s.projects.push(Project {
            name: "demo".into(),
            path: "/demo".into(),
        });
        s.selected_project = Some(0);
        s.studio_layout_ready = true;
        s.studio_layout = json!({"version": 2, "focusedRow": "/demo", "rows": [{"projectPath":"/demo", "focusedId":"a", "panes":[
            {"id":"a", "anchor":{"threadId":"a"}, "width":0},
            {"id":"b", "anchor":{"threadId":"b"}, "width":0}
        ]}]});
        s.studio.thread_open = true;
        s.studio.thread_id = "a".into();
        s.studio.project_path = "/demo".into();
        s.studio.items.push(StudioItem {
            id: "one".into(),
            kind: "assistant_text".into(),
            text: "first response".into(),
            name: String::new(),
            ..Default::default()
        });
        s.studio_threads.insert(
            "b".into(),
            StudioState {
                thread_open: true,
                thread_id: "b".into(),
                project_path: "/demo".into(),
                items: vec![StudioItem {
                    id: "two".into(),
                    kind: "assistant_text".into(),
                    text: "background response".into(),
                    name: String::new(),
                    ..Default::default()
                }],
                ..Default::default()
            },
        );
        for (thread, content) in [("a", "foreground streaming"), ("b", "background streaming")] {
            s.studio_message(json!({"method":"agent.event", "params":{"threadId":thread, "type":"item.updated", "item":{"itemId":if thread == "a" { "one" } else { "two" }, "kind":"assistant_text", "text":content}}}));
        }
        let mut rt = Runtime::new(s, view, (1900.0, 800.0), Env::new(false, 1.0));
        rt.frame(0.0);
        assert!(rt.find("studio-pane-a").is_some());
        assert!(rt.find("studio-pane-b").is_some());
        assert!(
            rt.elements()
                .iter()
                .any(|e| e.text.as_deref() == Some("background streaming"))
        );
        let (x, y) = rt.find("studio-parked-b").unwrap();
        rt.pointer_move(x, y);
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.0);
        assert_eq!(rt.state.studio.thread_id, "b");
        assert_eq!(rt.state.studio.items[0].text, "background streaming");
        assert_eq!(
            rt.state.studio_threads["a"].items[0].text,
            "foreground streaming"
        );
    }
}

#[cfg(test)]
mod context_meter_tests {
    use super::*;
    use rune::{Env, Key, KeyEvent, Mods, Runtime};

    fn view(s: &AppState, cx: &mut Cx<AppState>) -> El {
        el().w_full().h_full().child(
            el().pin(Some(300.0), Some(50.0), None, None)
                .child(context_meter(&s.studio, Palette::new(cx.system_dark()))),
        )
    }

    fn click(rt: &mut Runtime<AppState>, x: f32, y: f32) {
        rt.pointer_move(x, y);
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.0);
    }

    #[test]
    fn meter_opens_by_keyboard_and_dismisses_only_outside_card() {
        let mut state = AppState::default();
        state.studio.context_usage = Some((40_000, 200_000));
        let mut rt = Runtime::new(
            state,
            view,
            (500.0, 400.0),
            Env {
                system_dark: false,
                scale: 1.0,
            },
        );
        rt.frame(0.0);
        rt.key(KeyEvent {
            key: Key::Tab,
            mods: Mods::default(),
        });
        rt.frame(0.0);
        rt.key(KeyEvent {
            key: Key::Enter,
            mods: Mods::default(),
        });
        rt.frame(0.0);
        assert!(rt.state.studio.context_open, "keyboard activates meter");
        rt.frame(1.0);
        click(&mut rt, 100.0, 120.0);
        assert!(rt.state.studio.context_open, "card body does not dismiss");
        click(&mut rt, 450.0, 300.0);
        assert!(!rt.state.studio.context_open, "outside press dismisses");
    }
}

#[cfg(test)]
mod title_info_tests {
    use super::*;
    use rune::{Env, Key, KeyEvent, Mods, Runtime};

    fn view(s: &AppState, cx: &mut Cx<AppState>) -> El {
        el().w_full()
            .h_full()
            .child(
                el().pin(Some(300.0), Some(50.0), None, None)
                    .child(column_title(
                        Some(&s.studio),
                        true,
                        Palette::new(cx.system_dark()),
                    )),
            )
    }

    fn click(rt: &mut Runtime<AppState>, x: f32, y: f32) {
        rt.pointer_move(x, y);
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.0);
    }

    #[test]
    fn title_info_opens_by_keyboard_and_dismisses_only_outside_panel() {
        let state = AppState::default();
        let mut rt = Runtime::new(state, view, (600.0, 500.0), Env::new(false, 1.0));
        rt.frame(0.0);
        rt.key(KeyEvent {
            key: Key::Tab,
            mods: Mods::default(),
        });
        rt.frame(0.0);
        rt.key(KeyEvent {
            key: Key::Enter,
            mods: Mods::default(),
        });
        rt.frame(0.0);
        assert!(rt.state.studio.title_info_open, "keyboard activates title");
        rt.frame(1.0);
        click(&mut rt, 220.0, 120.0);
        assert!(
            rt.state.studio.title_info_open,
            "panel body does not dismiss"
        );
        click(&mut rt, 550.0, 400.0);
        assert!(!rt.state.studio.title_info_open, "outside press dismisses");
    }
}

#[cfg(test)]
mod handoff_picker_tests {
    use super::*;
    use crate::state::{StudioModel, StudioProvider};
    use rune::{Env, Key, KeyEvent, Mods, Runtime};

    fn view(s: &AppState, cx: &mut Cx<AppState>) -> El {
        el().w_full()
            .h_full()
            .child(handoff_picker(s, Palette::new(cx.system_dark())))
    }

    #[test]
    fn keyboard_stages_model_without_creating_handoff() {
        let mut state = AppState::default();
        state.studio.providers = vec![StudioProvider {
            id: "codex".into(),
            label: "Codex".into(),
            supports_compaction: false,
        }];
        state.studio.models = vec![StudioModel {
            id: "model".into(),
            label: "Model".into(),
            efforts: vec![],
            default_effort: None,
        }];
        state.open_handoff_picker();
        let mut rt = Runtime::new(
            state,
            view,
            (500.0, 400.0),
            Env {
                system_dark: false,
                scale: 1.0,
            },
        );
        rt.frame(0.0);
        for _ in 0..3 {
            rt.key(KeyEvent {
                key: Key::Tab,
                mods: Mods::default(),
            });
            rt.frame(0.0);
        }
        rt.key(KeyEvent {
            key: Key::Enter,
            mods: Mods::default(),
        });
        rt.frame(0.0);
        assert!(rt.state.studio.handoff_staged);
        assert!(rt.state.studio.handoff_picker);
        assert!(rt.state.studio.continuation_request.is_none());
    }
}
