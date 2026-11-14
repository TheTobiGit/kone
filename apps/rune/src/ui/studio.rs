use rune::{
    Curve, Cx, El, Family, Icon, ScrollSpec, Span, TextStyle, col, el, icon, row, text, text_input,
};

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
static TRAIL_CORNER: Icon = Icon {
    name: "activity-trail-corner",
    view: 11.0,
    body: r#"<path d="M0.75 0 V3.25 Q0.75 10.25 7.75 10.25 H11" fill="none" stroke="currentColor" stroke-width="1.5"/>"#,
};

static SETTING_ARROW: Icon = Icon {
    name: "studio-setting-arrow",
    view: 24.0,
    body: r#"<path d="M9.00005 6C9.00005 6 15 10.4189 15 12C15 13.5812 9 18 9 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static HANDOFF_ARROW: Icon = Icon {
    name: "studio-handoff-arrow",
    view: 16.0,
    body: r#"<path d="M2.5 8H13M8.5 3.5L13 8L8.5 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>"#,
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
static QUEUE_GRIP: Icon = Icon {
    name: "studio-queue-grip",
    view: 24.0,
    body: r#"<path d="M8.5 19.5V20M9.5 20C9.5 20.5523 9.05228 21 8.5 21C7.94772 21 7.5 20.5523 7.5 20C7.5 19.4477 7.94772 19 8.5 19C9.05228 19 9.5 19.4477 9.5 20Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M15.5 19.5V20M16.5 20C16.5 20.5523 16.0523 21 15.5 21C14.9477 21 14.5 20.5523 14.5 20C14.5 19.4477 14.9477 19 15.5 19C16.0523 19 16.5 19.4477 16.5 20Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.5 3.5V4M9.5 4C9.5 4.55228 9.05228 5 8.5 5C7.94772 5 7.5 4.55228 7.5 4C7.5 3.44772 7.94772 3 8.5 3C9.05228 3 9.5 3.44772 9.5 4Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.5 11.5V12M9.5 12C9.5 12.5523 9.05228 13 8.5 13C7.94772 13 7.5 12.5523 7.5 12C7.5 11.4477 7.94772 11 8.5 11C9.05228 11 9.5 11.4477 9.5 12Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M15.5 3.5V4M16.5 4C16.5 4.55228 16.0523 5 15.5 5C14.9477 5 14.5 4.55228 14.5 4C14.5 3.44772 14.9477 3 15.5 3C16.0523 3 16.5 3.44772 16.5 4Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M15.5 11.5V12M16.5 12C16.5 12.5523 16.0523 13 15.5 13C14.9477 13 14.5 12.5523 14.5 12C14.5 11.4477 14.9477 11 15.5 11C16.0523 11 16.5 11.4477 16.5 12Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static QUEUE_SEND: Icon = Icon {
    name: "studio-queue-send",
    view: 24.0,
    body: r#"<path d="M12 16.0351V7.9649C12 6.0377 12 5.0741 12.5918 4.80895C13.1837 4.54379 13.9003 5.18631 15.3336 6.47136L19.8342 10.5065C20.6116 11.2035 21.0003 11.552 21.0003 12C21.0003 12.448 20.6116 12.7965 19.8342 13.4935L15.3336 17.5286C13.9003 18.8137 13.1837 19.4562 12.5918 19.1911C12 18.9259 12 17.9623 12 16.0351Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 16.0351V7.9649C3 6.0377 3 5.0741 3.59183 4.80895C4.18366 4.54379 4.9003 5.18631 6.33359 6.47136L10.8342 10.5065C11.6116 11.2035 12.0003 11.552 12.0003 12C12.0003 12.448 11.6116 12.7965 10.8342 13.4935L6.33359 17.5286C4.9003 18.8137 4.18366 19.4562 3.59183 19.1911C3 18.9259 3 17.9623 3 16.0351Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static QUEUE_EDIT: Icon = Icon {
    name: "studio-queue-edit",
    view: 24.0,
    body: r#"<path d="M16.4249 4.60509L17.4149 3.6151C18.2351 2.79497 19.5648 2.79497 20.3849 3.6151C21.205 4.43524 21.205 5.76493 20.3849 6.58507L19.3949 7.57506M16.4249 4.60509L9.76558 11.2644C9.25807 11.772 8.89804 12.4078 8.72397 13.1041L8 16L10.8959 15.276C11.5922 15.102 12.228 14.7419 12.7356 14.2344L19.3949 7.57506M16.4249 4.60509L19.3949 7.57506" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M18.9999 13.5C18.9999 16.7875 18.9999 18.4312 18.092 19.5376C17.9258 19.7401 17.7401 19.9258 17.5375 20.092C16.4312 21 14.7874 21 11.4999 21H11C7.22876 21 5.34316 21 4.17159 19.8284C3.00003 18.6569 3 16.7712 3 13V12.5C3 9.21252 3 7.56879 3.90794 6.46244C4.07417 6.2599 4.2599 6.07417 4.46244 5.90794C5.56879 5 7.21252 5 10.5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static STUDIO_NOTICE_WARNING: Icon = Icon {
    name: "studio-notice-warning",
    view: 24.0,
    body: r#"<path d="M2.5 12C2.5 7.52166 2.5 5.28249 3.89124 3.89124C5.28249 2.5 7.52166 2.5 12 2.5C16.4783 2.5 18.7175 2.5 20.1088 3.89124C21.5 5.28249 21.5 7.52166 21.5 12C21.5 16.4783 21.5 18.7175 20.1088 20.1088C18.7175 21.5 16.4783 21.5 12 21.5C7.52166 21.5 5.28249 21.5 3.89124 20.1088C2.5 18.7175 2.5 16.4783 2.5 12Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 16V12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12.125 8.25H12M12.25 8.25C12.25 8.11193 12.1381 8 12 8C11.8619 8 11.75 8.11193 11.75 8.25C11.75 8.38807 11.8619 8.5 12 8.5C12.1381 8.5 12.25 8.38807 12.25 8.25Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static DOCK_CHEVRON: Icon = Icon {
    name: "dock_chevron",
    view: 24.0,
    body: r#"<path d="M17.9998 15C17.9998 15 13.5809 9.00001 11.9998 9C10.4187 8.99999 5.99985 15 5.99985 15" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static DOCK_EDIT: Icon = Icon {
    name: "dock_edit",
    view: 24.0,
    body: r#"<path d="M13 20.8268V22H14.1734C14.5827 22 14.7874 22 14.9715 21.9238C15.1555 21.8475 15.3003 21.7028 15.5897 21.4134L20.4133 16.5894C20.6864 16.3164 20.8229 16.1799 20.8959 16.0327C21.0347 15.7525 21.0347 15.4236 20.8959 15.1434C20.8229 14.9961 20.6864 14.8596 20.4133 14.5866C20.1403 14.3136 20.0038 14.1771 19.8565 14.1041C19.5763 13.9653 19.2473 13.9653 18.9671 14.1041C18.8198 14.1771 18.6833 14.3136 18.4103 14.5866L18.4103 14.5866L13.5867 19.4106C13.2972 19.7 13.1525 19.8447 13.0762 20.0287C13 20.2128 13 20.4174 13 20.8268Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.5" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 11C19 11 19 9.4306 18.8478 9.06306C18.6955 8.69552 18.4065 8.40649 17.8284 7.82843L13.0919 3.09188C12.593 2.593 12.3436 2.34355 12.0345 2.19575C11.9702 2.165 11.9044 2.13772 11.8372 2.11401C11.5141 2 11.1614 2 10.4558 2C7.21082 2 5.58831 2 4.48933 2.88607C4.26731 3.06508 4.06508 3.26731 3.88607 3.48933C3 4.58831 3 6.21082 3 9.45584V14C3 17.7712 3 19.6569 4.17157 20.8284C5.23467 21.8915 6.8857 21.99 10 21.9991M12 2.5V3C12 5.82843 12 7.24264 12.8787 8.12132C13.7574 9 15.1716 9 18 9H18.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static DOCK_TASKS: Icon = Icon {
    name: "dock_tasks",
    view: 24.0,
    body: r#"<path d="M11 6L21 6" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M11 12L21 12" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M11 18L21 18" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 7.39286C3 7.39286 4 8.04466 4.5 9C4.5 9 6 5.25 8 4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 18.3929C3 18.3929 4 19.0447 4.5 20C4.5 20 6 16.25 8 15" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static DOCK_AGENTS: Icon = Icon {
    name: "dock_agents",
    view: 24.0,
    body: r#"<path d="M13 11C13 8.79086 11.2091 7 9 7C6.79086 7 5 8.79086 5 11C5 13.2091 6.79086 15 9 15C11.2091 15 13 13.2091 13 11Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M11.0386 7.55773C11.0131 7.37547 11 7.18927 11 7C11 4.79086 12.7909 3 15 3C17.2091 3 19 4.79086 19 7C19 9.20914 17.2091 11 15 11C14.2554 11 13.5584 10.7966 12.9614 10.4423" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 21C15 17.6863 12.3137 15 9 15C5.68629 15 3 17.6863 3 21" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 17C21 13.6863 18.3137 11 15 11" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static STUDIO_ATTACH: Icon = Icon {
    name: "studio_attach",
    view: 24.0,
    body: r#"<path d="M5.82338 12L4.27922 10.4558C2.57359 8.75022 2.57359 5.98485 4.27922 4.27922C5.98485 2.57359 8.75022 2.57359 10.4558 4.27922L19.7208 13.5442C21.4264 15.2498 21.4264 18.0152 19.7208 19.7208C18.0152 21.4264 15.2498 21.4264 13.5442 19.7208L10.0698 16.2464C9.00379 15.1804 9.00379 13.4521 10.0698 12.386C11.1358 11.32 12.8642 11.32 13.9302 12.386L15.8604 14.3162" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static SELECTION_ADD: Icon = Icon {
    name: "studio-selection-add",
    view: 24.0,
    body: r#"<path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>"#,
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
    body: r#"<path d="M7.5 7.5L8.72654 8.55719C9.24218 9.00163 9.5 9.22386 9.5 9.5C9.5 9.77614 9.24218 9.99836 8.72654 10.4428L7.5 11.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M11.5 12.5H15.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 21C15.7497 21 17.6246 21 18.9389 20.0451C19.3634 19.7367 19.7367 19.3634 20.0451 18.9389C21 17.6246 21 15.7497 21 12C21 8.25027 21 6.3754 20.0451 5.06107C19.7367 4.6366 19.3634 4.26331 18.9389 3.95491C17.6246 3 15.7497 3 12 3C8.25027 3 6.3754 3 5.06107 3.95491C4.6366 4.26331 4.26331 4.6366 3.95491 5.06107C3 6.3754 3 8.25027 3 12C3 15.7497 3 17.6246 3.95491 18.9389C4.26331 19.3634 4.6366 19.7367 5.06107 20.0451C6.3754 21 8.25027 21 12 21Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
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
static ACTIVITY_SPINNER: Icon = Icon {
    name: "activity-spinner",
    view: 16.0,
    body: r#"<circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="25 11" stroke-linecap="round"/>"#,
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
static ACTIVITY_TOOLS: Icon = Icon {
    name: "activity-tools",
    view: 24.0,
    body: r#"<path d="M13 11L18 6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M19 7L17 5L19.5 3.5L20.5 4.5L19 7Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M4.02513 8.97487C3.01416 7.96391 2.75095 6.48836 3.23548 5.23548L4.65748 6.65748H6.65748V4.65748L5.23548 3.23548C6.48836 2.75095 7.96391 3.01416 8.97487 4.02513C9.98621 5.03647 10.2493 6.51274 9.76398 7.76593L16.2341 14.236C17.4873 13.7507 18.9635 14.0138 19.9749 15.0251C20.9858 16.0361 21.2491 17.5116 20.7645 18.7645L19.3425 17.3425L17.3425 17.3425V19.3425L18.7645 20.7645C17.5116 21.2491 16.0361 20.9858 15.0251 19.9749C14.0145 18.9643 13.7511 17.4895 14.2349 16.2369L7.76312 9.76507C6.51053 10.2489 5.03571 9.98546 4.02513 8.97487Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M12.203 14.5L6.59897 20.1041C6.07115 20.6319 5.2154 20.6319 4.68758 20.1041L3.89586 19.3124C3.36805 18.7846 3.36805 17.9288 3.89586 17.401L9.49994 11.7969" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>"#,
};
static ACTIVITY_CHEVRON: Icon = Icon {
    name: "activity-chevron",
    view: 24.0,
    body: r#"<path d="m9 18 6-6-6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static ACTIVITY_CHEVRON_DOWN: Icon = Icon {
    name: "activity-chevron-down",
    view: 24.0,
    body: r#"<path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
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

pub(super) static PICKER_BRAIN: Icon = Icon {
    name: "studio-picker-brain",
    view: 24.0,
    body: r#"<path d="M7 4.5C5.34315 4.5 4 5.84315 4 7.5C4 8.06866 4.15822 8.60037 4.43304 9.0535C3.04727 9.31855 2 10.537 2 12C2 13.463 3.04727 14.6814 4.43304 14.9465M7 4.5C7 3.11929 8.11929 2 9.5 2C10.8807 2 12 3.11929 12 4.5V19.5C12 20.8807 10.8807 22 9.5 22C8.11929 22 7 20.8807 7 19.5C5.34315 19.5 4 18.1569 4 16.5C4 15.9313 4.15822 15.3996 4.43304 14.9465M7 4.5C7 5.31791 7.39278 6.04408 8 6.50018M4.43304 14.9465C4.78948 14.3588 5.34207 13.9032 6 13.6707" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M17 19.4999C18.6569 19.4999 20 18.1567 20 16.4999C20 15.9312 19.8418 15.3995 19.567 14.9464C20.9527 14.6813 22 13.4629 22 11.9999C22 10.5369 20.9527 9.31843 19.567 9.05338M17 19.4999C17 20.8806 15.8807 21.9999 14.5 21.9999C13.1193 21.9999 12 20.8806 12 19.4999L12 4.49988C12 3.11917 13.1193 1.99988 14.5 1.99988C15.8807 1.99988 17 3.11917 17 4.49988C18.6569 4.49988 20 5.84302 20 7.49988C20 8.06854 19.8418 8.60024 19.567 9.05338M17 19.4999C17 18.682 16.6072 17.9558 16 17.4997M19.567 9.05338C19.2105 9.64109 18.6579 10.0966 18 10.3292" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static PICKER_SEARCH: Icon = Icon {
    name: "studio-picker-search",
    view: 24.0,
    body: r#"<circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m15.5 15.5 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>"#,
};
static INSERT_THREAD: Icon = Icon {
    name: "studio-insert-thread",
    view: 24.0,
    body: r#"<path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2S2 6.477 2 12c0 1.6.376 3.112 1.043 4.453c.178.356.237.763.134 1.148l-.595 2.226a1.3 1.3 0 0 0 1.591 1.592l2.226-.596a1.63 1.63 0 0 1 1.149.133A9.96 9.96 0 0 0 12 22Z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 10.5h8M8 14h5.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static INSERT_TERMINAL: Icon = Icon {
    name: "studio-insert-terminal",
    view: 24.0,
    body: r#"<path d="M7.5 7.5L8.72654 8.55719C9.24218 9.00163 9.5 9.22386 9.5 9.5C9.5 9.77614 9.24218 9.99836 8.72654 10.4428L7.5 11.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M11.5 12.5H15.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 21C15.7497 21 17.6246 21 18.9389 20.0451C19.3634 19.7367 19.7367 19.3634 20.0451 18.9389C21 17.6246 21 15.7497 21 12C21 8.25027 21 6.3754 20.0451 5.06107C19.7367 4.6366 19.3634 4.26331 18.9389 3.95491C17.6246 3 15.7497 3 12 3C8.25027 3 6.3754 3 5.06107 3.95491C4.6366 4.26331 4.26331 4.6366 3.95491 5.06107C3 6.3754 3 8.25027 3 12C3 15.7497 3 17.6246 3.95491 18.9389C4.26331 19.3634 4.6366 19.7367 5.06107 20.0451C6.3754 21 8.25027 21 12 21Z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static INSERT_SCRATCHPAD: Icon = Icon {
    name: "studio-insert-scratchpad",
    view: 24.0,
    body: r#"<path d="M16.5 2V5M7.5 2V5M12 2V5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 3.5H11C7.70017 3.5 6.05025 3.5 5.02513 4.52513C4 5.55025 4 7.20017 4 10.5V15C4 18.2998 4 19.9497 5.02513 20.9749C6.05025 22 7.70017 22 11 22H13C16.2998 22 17.9497 22 18.9749 20.9749C20 19.9497 20 18.2998 20 15V10.5C20 7.20017 20 5.55025 18.9749 4.52512C17.9497 3.5 16.2998 3.5 13 3.5Z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 15H12M8 11H16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static INSERT_CHEVRON: Icon = Icon {
    name: "studio-insert-chevron",
    view: 24.0,
    body: r#"<path d="M9.00005 6C9.00005 6 15 10.4189 15 12C15 13.5812 9 18 9 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

fn brand_mark(provider: &str, t: Palette) -> El {
    brand_mark_size(provider, 15.0, t)
}
fn provider_icon(provider: &str) -> &'static Icon {
    match provider.to_ascii_lowercase().as_str() {
        "claude" | "claudeagent" => &STUDIO_PROVIDER_CLAUDE,
        "cursor" => &STUDIO_PROVIDER_CURSOR,
        "opencode" => &STUDIO_PROVIDER_OPENCODE,
        "gpt" | "openai" => &STUDIO_PROVIDER_GPT,
        _ => &STUDIO_PROVIDER_CODEX,
    }
}
pub(super) fn brand_mark_size(provider: &str, size: f32, t: Palette) -> El {
    if provider == "unknown" {
        static UNKNOWN: Icon = Icon {
            name: "studio-provider-unknown",
            view: 24.0,
            body: r#"<circle cx="12" cy="12" r="4.5" fill="currentColor"/>"#,
        };
        return icon(&UNKNOWN, size).color(t.ink.alpha(0.9));
    }
    let mark = match provider {
        "claudeAgent" => &STUDIO_PROVIDER_CLAUDE,
        "cursor" => &STUDIO_PROVIDER_CURSOR,
        "opencode" => &STUDIO_PROVIDER_OPENCODE,
        "gpt" | "openai" => &STUDIO_PROVIDER_GPT,
        "codex" => &STUDIO_PROVIDER_CODEX,
        _ => &STUDIO_PROVIDER_CODEX,
    };
    icon(mark, size).color(if provider == "claudeAgent" {
        t.accent
    } else if provider == "codex" {
        t.ink
    } else {
        t.ink_soft
    })
}

pub(super) fn provider_mark(state: Option<&StudioState>, t: Palette) -> El {
    let picker_fixture = state.is_some_and(|s| {
        s.conversation_fixture.as_deref().is_some_and(|fixture| {
            fixture.starts_with("composer-picker-") || fixture.starts_with("composer-dock-")
        })
    });
    let provider = state
        .and_then(|s| s.providers.get(s.provider_index))
        .map(|p| p.id.as_str())
        .unwrap_or("unknown");
    let provider = if provider == "codex" && picker_fixture {
        "gpt"
    } else {
        provider
    };
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
    let mut current_mark = brand_mark(provider, t);
    if picker_fixture {
        current_mark = current_mark.color(if t.dark { t.muted } else { t.ink });
    }
    marks = marks.child(current_mark.opacity(if picker_fixture { 0.9 } else { 1.0 }));
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

pub(super) fn avatar_at(identity: &crate::state::StudioIdentity, size: f32, t: Palette) -> El {
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
                    .h(42.0)
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
    // Electron ships Geist Regular without weight variants, so its CSS
    // `font-weight: 620` resolves to Regular. Match the rendered font here.
    let mut style = TextStyle::new(13.5, 400.0).lh(16.2).tracking(-0.2025);
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
            title = title.child(thread_info_panel(state, t).absolute(-98.0, 23.0).raise());
        }
    }
    title
}

static INFO_BRAIN: Icon = Icon {
    name: "info_brain",
    view: 24.0,
    body: r#"<path d="M7 4.5C5.34315 4.5 4 5.84315 4 7.5C4 8.06866 4.15822 8.60037 4.43304 9.0535C3.04727 9.31855 2 10.537 2 12C2 13.463 3.04727 14.6814 4.43304 14.9465M7 4.5C7 3.11929 8.11929 2 9.5 2C10.8807 2 12 3.11929 12 4.5V19.5C12 20.8807 10.8807 22 9.5 22C8.11929 22 7 20.8807 7 19.5C5.34315 19.5 4 18.1569 4 16.5C4 15.9313 4.15822 15.3996 4.43304 14.9465M7 4.5C7 5.31791 7.39278 6.04408 8 6.50018M4.43304 14.9465C4.78948 14.3588 5.34207 13.9032 6 13.6707" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M17 19.4999C18.6569 19.4999 20 18.1567 20 16.4999C20 15.9312 19.8418 15.3995 19.567 14.9464C20.9527 14.6813 22 13.4629 22 11.9999C22 10.5369 20.9527 9.31843 19.567 9.05338M17 19.4999C17 20.8806 15.8807 21.9999 14.5 21.9999C13.1193 21.9999 12 20.8806 12 19.4999L12 4.49988C12 3.11917 13.1193 1.99988 14.5 1.99988C15.8807 1.99988 17 3.11917 17 4.49988C18.6569 4.49988 20 5.84302 20 7.49988C20 8.06854 19.8418 8.60024 19.567 9.05338M17 19.4999C17 18.682 16.6072 17.9558 16 17.4997M19.567 9.05338C19.2105 9.64109 18.6579 10.0966 18 10.3292" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static INFO_FOLDER: Icon = Icon {
    name: "info_folder",
    view: 24.0,
    body: r#"<path d="M8 7H16.75C18.8567 7 19.91 7 20.6667 7.50559C20.9943 7.72447 21.2755 8.00572 21.4944 8.33329C22 9.08996 22 10.1433 22 12.25C22 15.7612 22 17.5167 21.1573 18.7779C20.7926 19.3238 20.3238 19.7926 19.7779 20.1573C18.5167 21 16.7612 21 13.25 21H12C7.28595 21 4.92893 21 3.46447 19.5355C2 18.0711 2 15.714 2 11V7.94427C2 6.1278 2 5.21956 2.38032 4.53806C2.65142 4.05227 3.05227 3.65142 3.53806 3.38032C4.21956 3 5.1278 3 6.94427 3C8.10802 3 8.6899 3 9.19926 3.19101C10.3622 3.62712 10.8418 4.68358 11.3666 5.73313L12 7" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static INFO_EXPORT: Icon = Icon {
    name: "info_export",
    view: 24.0,
    body: r#"<path d="M2.99969 17.0002C2.99969 17.9302 2.99969 18.3952 3.10192 18.7767C3.37932 19.8119 4.18796 20.6206 5.22324 20.898C5.60474 21.0002 6.06972 21.0002 6.99969 21.0002L16.9997 21.0002C17.9297 21.0002 18.3947 21.0002 18.7762 20.898C19.8114 20.6206 20.6201 19.8119 20.8975 18.7767C20.9997 18.3952 20.9997 17.9302 20.9997 17.0002" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M16.4998 11.5002C16.4998 11.5002 13.1856 16.0002 11.9997 16.0002C10.8139 16.0002 7.49976 11.5002 7.49976 11.5002M11.9997 15.0002V3.00016" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

fn thread_info_panel(state: &StudioState, t: Palette) -> El {
    // Electron supplies Geist Regular only and disables font synthesis.
    // Row height is its 12.5px value at 1.55 line-height plus 4px padding.
    let panel_color = rune::color::hex(if t.dark { "#18181a" } else { "#fffefb" }).unwrap();
    let band_color = if t.dark {
        crate::theme::mix_srgb(t.ground, t.ink, 0.02)
    } else {
        rune::color::hex("#f2f1ef").unwrap()
    };
    let info_row = |name: &str, value: String| {
        row()
            .w_full()
            .h(27.375)
            .center_y()
            .justify_between()
            .gap(16.0)
            .child(label(name, 11.5, 400.0, t.muted))
            .child(label(value, 12.5, 400.0, t.ink).truncate())
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
        .unwrap_or_else(|| "Default model".into());
    let name_row = if state.title_editing {
        row()
            .w_full()
            .h(31.375)
            .offset(0.0, -0.5)
            .center_y()
            .justify_between()
            .child(label("Name", 11.5, 400.0, t.muted))
            .child(
                el().size(241.9, 23.375)
                    .offset(0.0, -0.5)
                    .clip_rounded(0.0)
                    .child(
                        text_input(&state.title_draft, TextStyle::new(12.5, 400.0).lh(19.0))
                            .key("studio-title-draft")
                            .w(241.9)
                            .h(23.375)
                            .px(6.0)
                            .py(2.0)
                            .radius(7.0)
                            .box_shadow(rune::Shadow {
                                spread: 2.0,
                                color: t.accent.alpha(0.45),
                                ..Default::default()
                            })
                            .fill(t.hover)
                            .color(t.ink)
                            .align(rune::Align::End)
                            .caret(
                                if state.title_draft.range().0 == state.title_draft.range().1 {
                                    t.ink
                                } else {
                                    t.ink.alpha(0.0)
                                },
                                t.accent.alpha(0.24),
                            )
                            .selection_color(t.accent.alpha(0.24))
                            .selection_radius(0.0)
                            .on_edit(|s: &mut AppState| &mut s.studio.title_draft)
                            .on_submit(|s: &mut AppState, _: &mut rune::Tx| {
                                s.commit_studio_title();
                            }),
                    ),
            )
    } else {
        info_row("Name", title_of(state))
            .h(28.0)
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
        .px(15.2)
        .pt(8.0)
        .pb(13.6)
        .corners([14.0, 14.0, 18.0, 18.0])
        .fill(panel_color)
        .child(name_row)
        .child(
            row()
                .w_full()
                .h(27.375)
                .center_y()
                .justify_between()
                .gap(16.0)
                .child(label("Provider", 11.5, 400.0, t.muted))
                .child(
                    row()
                        .center_y()
                        .gap(5.0)
                        .child(icon(provider_icon(&provider), 14.0).color(t.ink.alpha(0.9)))
                        .child(label(provider, 12.5, 400.0, t.ink)),
                ),
        )
        .child(info_row("Model", model))
        .child(
            row()
                .w_full()
                .h(27.375)
                .center_y()
                .justify_between()
                .gap(16.0)
                .child(label("Reasoning", 11.5, 400.0, t.muted))
                .child(
                    row()
                        .center_y()
                        .gap(6.0)
                        .child(
                            el().size(21.0, 13.0)
                                .child(
                                    icon(&INFO_BRAIN, 13.0)
                                        .absolute(0.0, 0.0)
                                        .color(rune::color::hex("#10B981").unwrap()),
                                )
                                .child(
                                    icon(&INFO_BRAIN, 13.0)
                                        .color(rune::color::hex("#10B981").unwrap())
                                        .absolute(8.0, 0.0),
                                ),
                        )
                        .child(label(state.effort.clone(), 12.5, 400.0, t.ink)),
                ),
        );
    if let Some(path) = &state.worktree_path {
        rows = rows.child(info_row("Worktree", path.clone()));
    }
    if let Some(source) = &state.handoff_source {
        rows = rows.child(info_row("Handed off", format!("From {source}")));
    }
    if !state.project_path.is_empty() {
        let repo = std::path::Path::new(&state.project_path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&state.project_path)
            .to_owned();
        rows = rows
            .child(info_section("PROJECT", t).mt(9.6).mb(1.6))
            .child(info_row("Repo", repo.clone()))
            .child(
                row()
                    .w_full()
                    .h(27.375)
                    .center_y()
                    .justify_between()
                    .gap(16.0)
                    .child(label("Folder", 11.5, 400.0, t.muted))
                    .child(
                        row()
                            .center_y()
                            .gap(5.0)
                            .child(
                                text(repo.clone())
                                    .font(TextStyle::new(12.5, 400.0))
                                    .color(t.ink)
                                    .spans(vec![
                                        Span::new(0, repo.len()).underline(t.ink.alpha(0.25)),
                                    ]),
                            )
                            .child(icon(&INFO_FOLDER, 12.0).color(t.muted)),
                    ),
            );
    }
    rows = rows.child(info_section("USAGE", t).mt(9.6).mb(1.6));
    if let Some((used, window)) = state.context_usage {
        rows = rows.child(info_row(
            "In context",
            format!("{} / {}", format_tokens(used), format_tokens(window)),
        ));
    } else {
        rows = rows.child(
            row()
                .w_full()
                .h(27.375)
                .center_y()
                .justify_between()
                .gap(16.0)
                .child(label("Tokens", 11.5, 400.0, t.muted))
                .child(label("Not reported yet", 12.5, 400.0, t.ink)),
        );
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
        .child(info_section("IDENTITY", t).mt(9.6).mb(1.6))
        .child(
            row()
                .w_full()
                .h(27.375)
                .center_y()
                .justify_between()
                .gap(16.0)
                .child(label("Thread ID", 11.5, 400.0, t.muted))
                .child(
                    row()
                        .center_y()
                        .gap(6.0)
                        .child(
                            text(if state.thread_id.is_empty() {
                                "Not started".into()
                            } else {
                                short_thread_id(&state.thread_id)
                            })
                            .font(TextStyle::new(11.5, 400.0).family(Family::Named("Menlo")))
                            .color(t.ink),
                        )
                        .child(
                            el().size(20.0, 20.0)
                                .center()
                                .child(icon(&FOOTER_COPY01, 12.0).color(t.muted)),
                        ),
                ),
        );
    rows = rows.child(info_section("EXPORT", t).mt(9.6).mb(1.6))
        .child(row().w_full().h(27.375).center_y().justify_between()
            .child(label("Format", 11.5, 400.0, t.muted))
            .child(row().gap(12.0)
                .child(el().key("studio-export-markdown").focusable(true).role("radio")
                    .child(label("Markdown", 12.5, 400.0, if state.export_json { t.muted } else { t.ink }))
                    .on_press(|s: &mut AppState| s.studio.export_json = false))
                .child(el().key("studio-export-json").focusable(true).role("radio")
                    .child(label("JSON", 12.5, 400.0, if state.export_json { t.ink } else { t.muted }))
                    .on_press(|s: &mut AppState| s.studio.export_json = true))))
        .child(row().w_full().pt(6.0).pb(2.0).justify_end().child(
            el().key("studio-export").role("button").focusable(true).px(12.0).h(31.375).center().opacity(0.45)
                .radius(8.0).border(1.0, t.ink.alpha(0.14))
                .fill(if t.dark { t.raised } else { rune::color::hex("#fffefb").unwrap() })
                .child(row().center_y().gap(6.0).child(icon(&INFO_EXPORT, 13.0).color(t.ink)).child(label("Export thread", 12.5, 400.0, t.ink)))
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
        .box_shadow(rune::Shadow {
            spread: 1.0,
            color: t.ink.alpha(0.08),
            ..Default::default()
        })
        .fill(band_color)
        .box_shadow(rune::Shadow {
            y: 12.0,
            blur: 28.0,
            spread: -10.0,
            color: rune::Color::BLACK.alpha(0.16),
            ..Default::default()
        })
        .offset_motion(Curve::tween(
            0.18,
            rune::Easing::cubic(0.22, 1.0, 0.36, 1.0),
        ))
        .child(
            row()
                .w_full()
                .h(42.0)
                .px(15.2)
                .center_y()
                .gap(12.0)
                .corners([18.0, 18.0, 0.0, 0.0])
                .fill(if t.dark {
                    crate::theme::mix_srgb(t.ground, t.ink, 0.02)
                } else {
                    rune::color::hex("#f2f1ef").unwrap()
                })
                .child(label("Details", 13.0, 400.0, t.ink_soft))
                .child(label("Inbox", 13.0, 400.0, t.muted).grow(1.0))
                .child(if let Some(status) = &state.info_status {
                    row()
                        .center_y()
                        .gap(5.0)
                        .child(el().size(6.0, 6.0).radius(3.0).fill(t.accent))
                        .child(label(
                            status.clone(),
                            11.0,
                            400.0,
                            crate::theme::mix_srgb(t.accent, t.ink, 0.3),
                        ))
                } else if state.busy {
                    row()
                        .center_y()
                        .gap(5.0)
                        .child(el().size(6.0, 6.0).radius(3.0).fill(t.accent))
                        .child(label(
                            "Working",
                            11.0,
                            400.0,
                            crate::theme::mix_srgb(t.accent, t.ink, 0.3),
                        ))
                } else {
                    el()
                }),
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

fn info_section(value: &str, t: Palette) -> El {
    text(value)
        .font(TextStyle::new(10.0, 400.0).lh(15.5).tracking(0.6))
        .quarter_pixel_glyphs(cfg!(target_os = "macos"))
        .color(t.muted.alpha(0.8))
}

pub(super) fn label(value: impl Into<String>, size: f32, weight: f32, color: rune::Color) -> El {
    text(value)
        .font(TextStyle::new(size, weight))
        .quarter_pixel_glyphs(cfg!(target_os = "macos"))
        .color(color)
}

type AnsiStyle = (Option<rune::Color>, bool, Option<rune::Color>, Option<u8>);

fn terminal_line(value: &str, t: Palette) -> El {
    let mut output = String::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut cursor = 0;
    let mut active: Option<AnsiStyle> = None;
    let mut range_start = 0;
    let mut spans = Vec::new();
    while cursor < bytes.len() {
        if bytes[cursor] == 0x1b {
            if cursor + 1 < bytes.len() && bytes[cursor + 1] == b'[' {
                let mut end = cursor + 2;
                while end < bytes.len() && !(0x40..=0x7e).contains(&bytes[end]) {
                    end += 1;
                }
                if end < bytes.len() && bytes[end] == b'm' {
                    let mut style = active.take().unwrap_or((None, false, None, None));
                    if range_start < output.len() {
                        let (color, bold, background, _) = style;
                        let mut span = Span::new(range_start, output.len());
                        if let Some(color) = color {
                            span = span.color(color);
                        }
                        if bold {
                            // xterm's terminal configuration uses a 600 bold face.
                            span = span.weight(600.0);
                        }
                        if let Some(background) = background {
                            span = span.bg(background, 0.0);
                        }
                        spans.push(span);
                    }
                    let codes = std::str::from_utf8(&bytes[cursor + 2..end]).unwrap_or("");
                    let mut parts = codes
                        .split(';')
                        .filter_map(|x| x.parse::<u16>().ok())
                        .peekable();
                    while let Some(code) = parts.next() {
                        match code {
                            0 => style = (None, false, None, None),
                            1 => {
                                style.1 = true;
                                if let Some(index) = style.3 {
                                    style.0 = Some(ansi_color(index + 8, t));
                                }
                            }
                            22 => {
                                style.1 = false;
                                if let Some(index) = style.3 {
                                    style.0 = Some(ansi_color(index, t));
                                }
                            }
                            39 => {
                                style.0 = None;
                                style.3 = None;
                            }
                            49 => style.2 = None,
                            30..=37 => {
                                let index = (code - 30) as u8;
                                style.3 = Some(index);
                                style.0 = Some(ansi_color(index + if style.1 { 8 } else { 0 }, t));
                            }
                            90..=97 => {
                                style.3 = None;
                                style.0 = Some(ansi_color((code - 90 + 8) as u8, t));
                            }
                            40..=47 => style.2 = Some(ansi_color((code - 40) as u8, t)),
                            100..=107 => style.2 = Some(ansi_color((code - 100 + 8) as u8, t)),
                            38 | 48 => {
                                let foreground = code == 38;
                                let color = match parts.next() {
                                    Some(5) => parts.next().map(|n| ansi256_color(n as u8, t)),
                                    Some(2) => {
                                        let r = parts.next().unwrap_or(0).min(255) as u8;
                                        let g = parts.next().unwrap_or(0).min(255) as u8;
                                        let b = parts.next().unwrap_or(0).min(255) as u8;
                                        Some(
                                            rune::color::hex(&format!("#{r:02x}{g:02x}{b:02x}"))
                                                .unwrap_or(t.ink_soft),
                                        )
                                    }
                                    _ => None,
                                };
                                if let Some(color) = color {
                                    if foreground {
                                        style.0 = Some(color);
                                        style.3 = None;
                                    } else {
                                        style.2 = Some(color);
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                    active = (style != (None, false, None, None)).then_some(style);
                    range_start = output.len();
                }
                cursor = (end + 1).min(bytes.len());
                continue;
            }
            cursor += 1;
            continue;
        }
        let Some(ch) = value[cursor..].chars().next() else {
            break;
        };
        if ch == '\u{f8ff}' {
            let cursor_start = output.len();
            output.push('▏');
            spans.push(Span::new(cursor_start, output.len()).color(t.accent));
        } else if !ch.is_control() || ch == '\t' {
            output.push(ch);
        }
        cursor += ch.len_utf8();
    }
    if let Some((color, bold, background, _)) = active
        && range_start < output.len()
    {
        let mut span = Span::new(range_start, output.len());
        if let Some(color) = color {
            span = span.color(color);
        }
        if bold {
            span = span.weight(600.0);
        }
        if let Some(background) = background {
            span = span.bg(background, 0.0);
        }
        spans.push(span);
    }
    let mut line = text(output)
        // Chromium resolves ui-monospace to Menlo on macOS; the reference
        // measures 13px glyphs on an 18px xterm cell pitch.
        .font(
            TextStyle::new(13.0, 400.0)
                .family(if cfg!(target_os = "macos") {
                    Family::Named("Menlo")
                } else {
                    Family::SystemMono
                })
                .lh(18.0),
        )
        .color(t.ink)
        .quarter_pixel_glyphs(cfg!(target_os = "macos"))
        .selectable(true)
        // xterm receives the Oklab 24% accent value from `--term-selection`, but its
        // canvas selection paint falls back to a 30% white overlay when it cannot parse
        // that CSS color. Match the effective selection rendered by Electron.
        .selection_color(rune::color::hex(if t.dark { "#525253" } else { "#f9f8f7" }).unwrap())
        .selection_offset(0.0, 0.5)
        .selection_padding(0.5, 0.0)
        .selection_pixel_snap(true)
        .selection_radius(0.0)
        .w_full();
    if !spans.is_empty() {
        line = line.spans(spans);
    }
    line
}

fn ansi256_color(index: u8, t: Palette) -> rune::Color {
    if index < 16 {
        return ansi_color(index, t);
    }
    let hex = if index < 232 {
        let value = index - 16;
        let channel = |n: u8| if n == 0 { 0 } else { 55 + n * 40 };
        format!(
            "#{:02x}{:02x}{:02x}",
            channel(value / 36),
            channel((value / 6) % 6),
            channel(value % 6)
        )
    } else {
        let gray = 8 + (index - 232) * 10;
        format!("#{gray:02x}{gray:02x}{gray:02x}")
    };
    rune::color::hex(&hex).unwrap_or(t.ink_soft)
}

fn ansi_color(index: u8, t: Palette) -> rune::Color {
    const LIGHT: [&str; 16] = [
        "#3f3f46", "#c81e3a", "#0f8a5f", "#b45309", "#2563eb", "#9333ea", "#0e7490", "#52525b",
        "#71717a", "#e11d48", "#059669", "#d97706", "#3b82f6", "#a855f7", "#0891b2", "#27272a",
    ];
    const DARK: [&str; 16] = [
        "#3b3b42", "#f2726f", "#4ec9a6", "#e5b567", "#7aa2f7", "#c9a2f0", "#6bd6c6", "#d4d4d8",
        "#5b5b63", "#ff8f8b", "#79e3c0", "#f2cd88", "#9cb8ff", "#dcb8ff", "#8ce8da", "#ffffff",
    ];
    let colors = if t.dark { &DARK } else { &LIGHT };
    let color = colors[index.min(15) as usize];
    rune::color::hex(color).unwrap_or(t.ink_soft)
}

#[derive(Clone, Copy)]
enum TurnOrbKind {
    Working,
    Write,
}

fn turn_orb_beat(time: f32) -> (f32, f32) {
    let dwell = 5.5_f32;
    let morph = 1.9_f32;
    let expo = 0.3_f32;
    let cycle = dwell + morph * 2.0;
    let local = time.rem_euclid(cycle);
    let morph_ease = |x: f32| {
        let smooth = x * x * x * (x * (x * 6.0 - 15.0) + 10.0);
        let expo_in_out = if x <= 0.0 {
            0.0
        } else if x >= 1.0 {
            1.0
        } else if x < 0.5 {
            2.0_f32.powf(20.0 * x - 10.0) * 0.5
        } else {
            (2.0 - 2.0_f32.powf(-20.0 * x + 10.0)) * 0.5
        };
        smooth + (expo_in_out - smooth) * expo
    };
    let m = if local < dwell {
        0.0
    } else if local - dwell < morph {
        morph_ease((local - dwell) / morph)
    } else {
        morph_ease(1.0 - (local - dwell - morph) / morph)
    };
    let prog = if local < dwell {
        local / dwell
    } else if local - dwell < morph {
        1.0
    } else {
        (1.0 - (local - dwell - morph) / morph).clamp(0.0, 1.0)
    };
    (m, prog)
}

fn turn_orb_tint_color(tint: [f32; 3], white: f32, dark: bool, k: f32, alpha: f32) -> rune::Color {
    let depth = 1.0 - white.clamp(0.0, 1.0);
    let channel = |c: f32| {
        let col = if dark {
            let highlight = (depth - 0.5).max(0.0) * 2.0;
            let base = 0.72 + 0.28 * depth;
            (c + (255.0 - c) * 0.28 * highlight) * base
        } else {
            let ink = 0.5 + 0.5 * depth;
            255.0 - (255.0 - c * 0.82) * ink
        };
        let grey = if dark {
            255.0 * (0.6 + 0.4 * depth)
        } else {
            255.0 * (1.0 - 0.7 * depth)
        };
        let out = (grey + (col - grey) * k).clamp(0.0, 255.0);
        rune::color::srgb_decode(out / 255.0)
    };
    rune::Color {
        r: channel(tint[0]),
        g: channel(tint[1]),
        b: channel(tint[2]),
        a: alpha.max(0.5),
    }
}

/// Native GPUI dot projection matching Electron's `TurnOrb` modes (`work` torus
/// knot for `Working` and `crystal` polyhedron for `Write`) in linear sRGB.
fn turn_orb(size: f32, time: f32, kind: TurnOrbKind, dark: bool) -> El {
    let tau = std::f32::consts::TAU;
    let cx = size * 0.5;
    let scale = cx * 0.82;
    let rs = (size / 300.0).powf(0.36);
    let (m, prog) = turn_orb_beat(time);
    let c = 1.0 - m;

    let (raw_tint, n): ([f32; 3], usize) = match kind {
        TurnOrbKind::Working => ([113.0, 113.0, 122.0], 77),
        TurnOrbKind::Write => ([139.0, 127.0, 240.0], 81),
    };
    let lum = (0.2126 * raw_tint[0] + 0.7152 * raw_tint[1] + 0.0722 * raw_tint[2]) / 255.0;
    let tint = if dark && lum < 0.5 {
        let f = (0.5 - lum) / (1.0 - lum);
        [
            (raw_tint[0] + (255.0 - raw_tint[0]) * f).round(),
            (raw_tint[1] + (255.0 - raw_tint[1]) * f).round(),
            (raw_tint[2] + (255.0 - raw_tint[2]) * f).round(),
        ]
    } else if !dark && lum > 0.55 {
        let f = (lum - 0.55) / lum;
        [
            (raw_tint[0] * (1.0 - f)).round(),
            (raw_tint[1] * (1.0 - f)).round(),
            (raw_tint[2] * (1.0 - f)).round(),
        ]
    } else {
        raw_tint
    };

    let (yaw, tilt) = match kind {
        TurnOrbKind::Working => (0.4 + 0.3 * (time * 0.26).sin() * c, 0.4 * c),
        TurnOrbKind::Write => (0.5 + 0.24 * (time * 0.32).sin() * c, 0.2 * c),
    };
    let (syaw, cyaw) = yaw.sin_cos();
    let (stilt, ctilt) = tilt.sin_cos();
    let project = |x: f32, y: f32, z: f32| {
        let x1 = x * cyaw + z * syaw;
        let z1 = -x * syaw + z * cyaw;
        let y2 = y * ctilt - z1 * stilt;
        let z2 = y * stilt + z1 * ctilt;
        (cx + x1 * scale, cx - y2 * scale, z2)
    };

    let n_f = n as f32;
    let head = prog * n_f;
    let mut dots = Vec::with_capacity(n);
    for seat in 0..n {
        let s = seat as f32;
        let phi = (1.0 - 2.0 * (s + 0.5) / n_f).acos();
        let theta = std::f32::consts::PI * (1.0 + 5.0_f32.sqrt()) * s;
        let (fx, fy, fz) = (phi.sin() * theta.cos(), phi.cos(), phi.sin() * theta.sin());

        let (wx, wy, wz) = match kind {
            TurnOrbKind::Working => {
                let u = (s / n_f) * tau * 2.0 + time * 0.35;
                let v = (s / n_f) * tau * 3.0;
                let rad = 0.68 + 0.28 * v.cos();
                (rad * u.cos(), rad * u.sin(), 0.28 * v.sin())
            }
            TurnOrbKind::Write => {
                let manhattan = fx.abs() + fy.abs() + fz.abs();
                let denom = if manhattan == 0.0 { 1.0 } else { manhattan };
                let (ux, uy, uz) = (fx / denom * 0.94, fy / denom * 0.94, fz / denom * 0.94);
                let (ss, cs) = (time * 0.3).sin_cos();
                (ux * cs + uz * ss, uy, -ux * ss + uz * cs)
            }
        };
        let (x, y, z3) = (fx + (wx - fx) * c, fy + (wy - fy) * c, fz + (wz - fz) * c);
        let (px, py, z) = project(x, y, z3);
        let zx = ((z + 1.0) * 0.5).clamp(0.0, 1.0);
        let dist = s - head;
        let (feather, head_w, head_r, dim_unstitched) = match kind {
            TurnOrbKind::Working => ((n_f * 0.04).max(1.0), (n_f * 0.015).max(1.0), 0.55, 0.0),
            TurnOrbKind::Write => ((n_f * 0.03).max(1.0), (n_f * 0.012).max(1.0), 0.50, 0.3),
        };
        let bright_head = (-(dist * dist) / (head_w * head_w)).exp();
        let passed = if dist > 0.0 {
            (-(dist * dist) / (feather * feather)).exp()
        } else {
            1.0
        };
        let factor = m + c * passed;
        let (r, white, a, k) = match kind {
            TurnOrbKind::Working => (
                ((0.75 + 1.2 * zx + head_r * bright_head * c) * factor * rs).max(0.75),
                (0.6 - 0.5 * zx) - 0.3 * bright_head * c,
                factor,
                1.0,
            ),
            TurnOrbKind::Write => (
                ((0.75 + 1.2 * zx + head_r * bright_head * c) * rs).max(0.75),
                (0.6 - 0.5 * zx) - 0.3 * bright_head * c + dim_unstitched * (1.0 - factor) * c,
                1.0,
                factor,
            ),
        };
        dots.push((z, px, py, r, turn_orb_tint_color(tint, white, dark, k, a)));
    }
    dots.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut orb = el().w(size).h(size);
    for (_, x, y, r, color) in dots {
        orb = orb.child(
            el().w(r * 2.0)
                .h(r * 2.0)
                .absolute(x - r, y - r)
                .radius(r)
                .fill(color),
        );
    }
    orb
}

/// Wraps an inline step body with the rounded elbow branching from the step rail.
fn trail_branch(body: El, t: Palette) -> El {
    let trail_rail = crate::theme::mix_srgb(t.ground, t.ink, 0.12);
    col()
        .w_full()
        .pl(24.0)
        .pt(3.0)
        .gap(0.0)
        .child(
            el().w(1.5)
                .h(12.0)
                .pin(Some(7.0), Some(-10.0), None, None)
                .fill(trail_rail),
        )
        .child(
            icon(&TRAIL_CORNER, 11.0)
                .color(trail_rail)
                .pin(Some(7.0), Some(2.0), None, None),
        )
        .child(body)
}

/// Outer `ActivityStepDetail` card shared by command output and diff panels.
fn activity_step_detail(glyph: &'static Icon, title: &'static str, body: El, t: Palette) -> El {
    col()
        .w_full()
        .mt(4.0)
        .mb(8.0)
        .radius(10.0)
        .border(1.0, t.line)
        .fill(crate::theme::mix_srgb(t.ground, t.ink, 0.03))
        .child(
            row()
                .w_full()
                .h(34.047)
                .px(10.0)
                .center_y()
                .gap(6.0)
                .fill(t.ink.alpha(0.02))
                .child(icon(glyph, 13.0).color(t.muted))
                .child(
                    text(title)
                        .font(TextStyle::new(11.5, 400.0).mono())
                        .color(t.muted),
                )
                .child(el().grow(1.0))
                .child(icon(&FOOTER_COPY01, 12.0).color(t.muted))
                .child(
                    text("Copy")
                        .font(TextStyle::new(11.0, 400.0).mono())
                        .color(t.muted),
                ),
        )
        .child(el().w_full().h(1.0).fill(t.ink.alpha(0.05)))
        .child(el().w_full().padding(8.0).child(body))
}

fn activity_task_row(title: &str, status: &str, t: Palette) -> El {
    let done = status == "completed";
    let live = status == "in-progress";
    // Electron's static capture forces `.plan-check-mark` visible on every task row.
    let check = el()
        .w(15.0)
        .h(15.0)
        .mt(1.0)
        .center()
        .radius(4.0)
        .fill(t.accent.alpha(0.88))
        .child(label(
            "✓",
            10.0,
            600.0,
            rune::color::hex("#ffffff").unwrap(),
        ));
    let color = if done {
        t.muted
    } else if live {
        t.ink
    } else {
        t.ink_soft
    };
    let mut label_el = text(title)
        .font(TextStyle::new(12.5, 500.0).lh(17.5))
        .color(color)
        .wrap()
        .w_full();
    if done {
        label_el = label_el.strike(0, title.len(), Some(t.muted.alpha(0.7)));
    }
    row()
        .px(8.8)
        .py(5.6)
        .gap(8.8)
        .child(check)
        .child(el().grow(1.0).child(label_el))
}

fn project_nav(s: &AppState, t: Palette) -> El {
    let current = s.selected_project.unwrap_or(0);
    let project = s.projects.get(current);
    let mut nav = row()
        .w_full()
        .h(32.0)
        .px(32.0)
        .justify_end()
        .center_y()
        .offset(0.0, 6.0);
    if let Some(project) = project {
        let name = project.name.clone();
        let has_destinations = s.projects.len() > 1;
        nav = nav.child(
            row()
                .key("studio-project-switch-trigger")
                .h(25.0)
                .px(0.0)
                .center_y()
                .radius(6.0)
                .hover(t.hover)
                .child(
                    text(name)
                        .font(TextStyle::new(12.5, 400.0).tracking(-0.125))
                        .color(if s.studio_project_menu_open {
                            t.ink
                        } else {
                            t.muted
                        })
                        .offset(0.0, 5.0),
                )
                .on_hover_change(|s: &mut AppState, over, _| {
                    if over {
                        s.studio_project_menu_open = true;
                    }
                })
                .on_press(move |s: &mut AppState| {
                    if has_destinations {
                        s.studio_project_menu_open = true;
                        s.studio_project_selection = 0;
                    }
                }),
        );
        if s.studio_project_menu_open {
            let mut menu = col()
                .key("studio-project-switch-menu")
                .w(176.0)
                .px(4.0)
                .py(4.0)
                .gap(1.0)
                .radius(12.0)
                .box_shadow(rune::Shadow {
                    spread: 1.0,
                    color: t.ink.alpha(0.07),
                    ..Default::default()
                })
                .box_shadow(rune::Shadow {
                    y: 8.0,
                    blur: 24.0,
                    spread: -10.0,
                    color: rune::Color::BLACK.alpha(0.14),
                    ..Default::default()
                })
                .fill(t.ground)
                .offset_motion(Curve::tween(
                    0.18,
                    rune::Easing::cubic(0.22, 1.0, 0.36, 1.0),
                ));
            for (position, (index, destination)) in s
                .projects
                .iter()
                .enumerate()
                .filter(|(index, _)| *index != current)
                .enumerate()
            {
                let target = index;
                let project_path = destination.path.clone();
                let pane_count = s.studio_layout["rows"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|entry| entry["projectPath"] == destination.path)
                    .and_then(|entry| entry["panes"].as_array())
                    .map_or(0, Vec::len);
                let row = row()
                    .key(format!("studio-project-switch-{index}"))
                    .w_full()
                    .h(27.8)
                    .px(8.0)
                    .center_y()
                    .radius(8.0)
                    .hover(t.hover)
                    .fill(if s.studio_project_selection == position {
                        t.hover
                    } else {
                        t.ground
                    })
                    .child(
                        label(destination.name.clone(), 12.5, 400.0, t.ink)
                            .truncate()
                            .offset(0.0, 1.5)
                            .grow(1.0),
                    )
                    .child(
                        text(if pane_count == 0 {
                            "—".into()
                        } else {
                            pane_count.to_string()
                        })
                        .font(TextStyle::new(10.0, 400.0).family(Family::Named("Menlo")))
                        .color(t.muted)
                        .offset(0.0, 0.5),
                    )
                    .on_hover_change(move |s: &mut AppState, over, _| {
                        if over {
                            s.studio_project_selection = position;
                        }
                    })
                    .on_press(move |s: &mut AppState| {
                        s.studio_project_menu_open = false;
                        s.select_studio_project(target);
                        let focused = s.studio_layout["rows"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .find(|row| row["projectPath"] == project_path)
                            .and_then(|row| row["focusedId"].as_str())
                            .map(str::to_owned);
                        if let Some(thread) = focused {
                            s.open_studio_thread(thread);
                        }
                    });
                menu = menu.child(row);
            }
            let menu_x = (s.studio_viewport.0 - 264.0).max(8.0);
            nav = nav.child(
                el().size(8192.0, 8192.0)
                    .absolute(-4096.0, -4096.0)
                    .on_press(|s: &mut AppState| s.studio_project_menu_open = false),
            );
            nav = nav.child(menu.absolute(menu_x, 35.5).raise());
        }
    }
    nav
}

pub fn view(s: &AppState, cx: &mut Cx<AppState>) -> El {
    let t = Palette::new(cx.system_dark());
    let selection_rects = cx.selection_rects();
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
    let overview_message = if s.studio.overview {
        let count = s.studio_layout["rows"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|row| row["projectPath"] == s.studio.project_path)
            .and_then(|row| row["panes"].as_array())
            .map_or(0, Vec::len);
        format!("Overview — {count} columns")
    } else {
        String::new()
    };
    // ThreadStrip only mounts its floor plasma inside the empty-board chooser.
    let mut plane = col().w_full().h_full();
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
        .fill(if s.studio.overview {
            crate::theme::mix_srgb(t.ground, t.ink, 0.035)
        } else {
            t.ground
        })
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
    let plane = if let Some(notice) = &s.studio.archive_notice {
        plane.child(
            row()
                .pin(Some(0.0), Some(18.0), Some(0.0), None)
                .justify_center()
                .child(
                    row()
                        .px(14.0)
                        .h(37.5)
                        .py(9.0)
                        .gap(8.0)
                        .max_w(520.0)
                        .center_y()
                        .radius(999.0)
                        .border(1.0, t.ink.alpha(0.0713725))
                        .fill(t.sunken)
                        .shadow(0.0, 12.0, rune::Color::BLACK.alpha(0.12))
                        .child(icon(&STUDIO_NOTICE_WARNING, 15.0).color(t.warn))
                        .child(label(notice.clone(), 12.5, 400.0, t.ink_soft)),
                ),
        )
    } else {
        plane
    };
    let mut plane = if s.studio.picker_open {
        let scrim_progress = s.studio.picker_opened_at.map_or(1.0, |opened| {
            super::start_motion::bezier(
                [0.22, 1.0, 0.36, 1.0],
                (opened.elapsed().as_secs_f32() / 0.24).clamp(0.0, 1.0),
            )
        });
        el().pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
            .fill(t.ground)
            .child(plane.opacity(1.0 - 0.62 * scrim_progress).pin(
                Some(0.0),
                Some(0.0),
                Some(0.0),
                Some(0.0),
            ))
            .child(
                el().pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                    .fill(t.ground.alpha(0.0))
                    .on_press(|s: &mut AppState| {
                        s.studio.picker_open = false;
                        s.studio.picker_opened_at = None;
                    }),
            )
            .child(super::composer::model_picker(s, t).pin(None, None, Some(24.0), Some(24.0)))
    } else if s.studio.handoff_picker {
        plane.child(handoff_picker(s, t))
    } else {
        plane
    };
    plane = plane.child(
        el().key("studio-overview-announcement")
            .w(1.0)
            .h(1.0)
            .opacity(0.0)
            .role("status")
            .label(overview_message),
    );
    let plane = if let Some(selected) = s.studio.selection_text.as_ref()
        && !s.studio.picker_open
        && !s.studio.handoff_picker
        && !selection_rects.is_empty()
    {
        let left = selection_rects
            .iter()
            .map(|rect| rect[0])
            .fold(f32::INFINITY, f32::min);
        let right = selection_rects
            .iter()
            .map(|rect| rect[0] + rect[2])
            .fold(f32::NEG_INFINITY, f32::max);
        let bottom = selection_rects
            .iter()
            .map(|rect| rect[1] + rect[3])
            .fold(f32::NEG_INFINITY, f32::max);
        let top = selection_rects
            .iter()
            .map(|rect| rect[1])
            .fold(f32::INFINITY, f32::min);
        for rect in &selection_rects {
            plane = plane.child(
                el().pin(Some(rect[0]), Some(rect[1]), None, None)
                    .size(rect[2], rect[3])
                    .fill(t.accent.alpha(0.24)),
            );
        }
        let (viewport_w, viewport_h) = s.studio_viewport;
        let toolbar_x =
            if s.studio.conversation_fixture.as_deref() == Some("composer-dock-selection") {
                683.0_f32.min((viewport_w - 320.0).max(8.0))
            } else {
                left.clamp(8.0, (viewport_w - 320.0).max(8.0))
            };
        let toolbar_y = (top - 38.5).max(8.0).min((viewport_h - 42.0).max(8.0));
        let _ = (right, bottom);
        plane.child(selection_actions(selected, toolbar_x, toolbar_y, t))
    } else {
        plane
    };
    let mut output = el().w_full().h_full().child(plane);
    if s.conversation_search_open {
        output = output.child(
            el().key("conversation-search-dim")
                .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                .fill(t.ground.alpha(0.62)),
        );
        output = output.child(conversation_search_modal(s, t));
    }
    if let Some(edit) = s.studio.scratchpad.as_ref()
        && !cx.selection_dragging()
        && s.studio.scratchpad_toolbar.shown_after.is_none()
        && !edit.selected().trim().is_empty()
        && s.studio.scratchpad_toolbar.dismissed != Some(edit.range())
        && let (Some(first), Some(last)) = (selection_rects.first(), selection_rects.last())
    {
        output = output.child(super::scratchpad_toolbar::overlay(
            s,
            t,
            super::scratchpad_toolbar::Anchor {
                // TextEdit's selection boxes include different ascent/indent
                // metrics for block kinds; normalize those to the browser Range
                // rect used by PadFormatBar.vue before placing the transient bar.
                x: first[0]
                    + first[2] / 2.0
                    + match edit.active_block() {
                        rune::edit::Block::Bullet(_) | rune::edit::Block::Task(_) => -1.0,
                        rune::edit::Block::Numbered(_) => 0.0,
                        _ if edit.has_mark(&rune::edit::Mark::Italic) => -2.0,
                        _ if edit
                            .active_marks()
                            .iter()
                            .any(|mark| matches!(mark, rune::edit::Mark::TextColor(_))) =>
                        {
                            2.0
                        }
                        _ if first[0] > 400.0 => -2.0,
                        _ => 0.0,
                    },
                top: first[1]
                    + if first[1] < 60.0 {
                        -0.5
                    } else {
                        -0.5 + match edit.active_block() {
                            rune::edit::Block::Heading(2) => -1.0,
                            rune::edit::Block::Heading(_) => 0.0,
                            rune::edit::Block::Bullet(_)
                            | rune::edit::Block::Numbered(_)
                            | rune::edit::Block::Task(_) => 4.0,
                            rune::edit::Block::Quote => 2.0,
                            rune::edit::Block::Code => 2.0,
                            rune::edit::Block::Paragraph => 2.0,
                        }
                    },
                // A Range clipped above the scrollport still has a measurable
                // final line; trim its hidden descender area before using the
                // below-placement fallback (Electron pins to y=73 here).
                bottom: last[1] + last[3] - if first[1] < 60.0 { 4.5 } else { 0.0 },
            },
            (viewport_w, viewport_h),
        ));
    }
    output
}

fn selection_actions(selected: &str, left: f32, top: f32, t: Palette) -> El {
    let copy_text = selected.to_owned();
    let composer_text = selected.to_owned();
    let thread_text = selected.to_owned();
    let button = |glyph: &'static Icon,
                  title: &'static str,
                  action: fn(&mut AppState, &str, &mut rune::Tx),
                  text: String| {
        row()
            .h(24.0)
            .px(8.0)
            .gap(6.0)
            .center_y()
            .radius(8.0)
            .hover(t.hover)
            .child(icon(glyph, 12.0).color(t.ink_soft))
            .child(label(title, 12.0, 500.0, t.ink_soft))
            .on_press_tx(move |s: &mut AppState, tx| action(s, &text, tx))
    };
    row()
        .key("studio-selection-actions")
        .w(308.65625)
        .pin(Some(left), Some(top), None, None)
        .padding(4.0)
        .gap(2.0)
        .center_y()
        .radius(12.0)
        .fill(if t.dark {
            rune::color::hex("#18181a").unwrap()
        } else {
            t.raised
        })
        .shadow(0.0, 2.0, rune::Color::BLACK.alpha(0.06))
        .keeps_text_selection()
        .on_key(|s: &mut AppState, event, tx| {
            if event.key == rune::Key::Escape {
                s.studio.selection_text = None;
                tx.clear_text_selection();
                true
            } else {
                false
            }
        })
        .child(button(&FOOTER_COPY01, "Copy", copy_selection, copy_text))
        .child(button(
            &SELECTION_ADD,
            "Add to Composer",
            add_selection_to_composer,
            composer_text,
        ))
        .child(button(
            &SIDE_CHAT,
            "New Thread",
            new_thread_from_selection,
            thread_text,
        ))
}

fn copy_selection(s: &mut AppState, text: &str, tx: &mut rune::Tx) {
    tx.copy(text.to_owned());
    s.studio.selection_text = None;
    tx.clear_text_selection();
}

fn add_selection_to_composer(s: &mut AppState, text: &str, tx: &mut rune::Tx) {
    if !s.composer.text.is_empty() {
        s.composer.text.push('\n');
    }
    s.composer.text.push_str(text);
    s.composer.focus = s.composer.text.len();
    s.composer.anchor = s.composer.focus;
    s.open_composer();
    s.studio.selection_text = None;
    tx.clear_text_selection();
}

fn new_thread_from_selection(s: &mut AppState, text: &str, tx: &mut rune::Tx) {
    s.new_studio_thread();
    s.composer.text = text.to_owned();
    s.composer.focus = s.composer.text.len();
    s.composer.anchor = s.composer.focus;
    s.open_composer();
    s.studio.selection_text = None;
    tx.clear_text_selection();
}

fn stage_handoff_model(
    s: &mut AppState,
    provider_index: usize,
    model_index: usize,
    provider_id: &str,
    selected_model: &crate::state::StudioModel,
) {
    let models = s
        .studio
        .model_catalog
        .get(provider_id)
        .cloned()
        .unwrap_or_else(|| {
            if s.studio.provider_index == provider_index {
                s.studio.models.clone()
            } else {
                vec![selected_model.clone()]
            }
        });
    if models.is_empty() {
        return;
    }
    s.studio.provider_index = provider_index;
    s.studio.models = models;
    s.studio.model_index = model_index.min(s.studio.models.len() - 1);
    s.studio.effort = s.studio.models[s.studio.model_index]
        .default_effort
        .clone()
        .unwrap_or_default();
    s.studio.handoff_staged = true;
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
    let query = s.studio.handoff_query.text.trim().to_lowercase();
    let mut model_entries = Vec::new();
    for (provider_index, provider) in s.studio.providers.iter().enumerate() {
        let models = s
            .studio
            .model_catalog
            .get(&provider.id)
            .cloned()
            .or_else(|| {
                (provider_index == s.studio.provider_index).then(|| s.studio.models.clone())
            })
            .unwrap_or_default();
        for (model_index, model) in models.into_iter().enumerate() {
            if query.is_empty()
                || format!("{} {} {}", model.label, model.id, provider.label)
                    .to_lowercase()
                    .contains(&query)
            {
                model_entries.push((provider_index, model_index, provider.clone(), model));
            }
        }
    }
    let mut model_list = col().w_full().grow(1.0).padding(14.0);
    if model_entries.is_empty() {
        model_list = model_list
            .center()
            .child(label("No models available.", 13.0, 400.0, t.muted));
    }
    for (provider_index, model_index, provider, model) in model_entries {
        let selected = s.studio.handoff_staged
            && provider_index == s.studio.provider_index
            && model_index == s.studio.model_index;
        let key_provider_id = provider.id.clone();
        let key_model = model.clone();
        let mut item = row()
            .key(format!("handoff-model-{}-{}", provider_index, model_index))
            .role("button")
            .label(model.label.clone())
            .focusable(true)
            .on_key(move |s: &mut AppState, event, _| {
                if event.key != rune::Key::Enter {
                    return false;
                }
                stage_handoff_model(s, provider_index, model_index, &key_provider_id, &key_model);
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
                brand_mark_size(
                    if provider.id == "codex" {
                        "gpt"
                    } else {
                        &provider.id
                    },
                    17.0,
                    t,
                )
                .opacity(0.72),
            )
            .child(label(model.label.clone(), 15.0, 400.0, t.ink).opacity(0.72));
        if provider_index != s.studio.provider_index {
            item = item.child(label(provider.label.clone(), 11.0, 400.0, t.muted));
        }
        if let Some(effort) = model
            .default_effort
            .as_deref()
            .or_else(|| model.efforts.first().map(String::as_str))
        {
            item = item.child(super::composer::model_effort_badge(effort));
        }
        let click_provider_id = provider.id.clone();
        let click_model = model.clone();
        model_list = model_list.child(item.on_press(move |s: &mut AppState| {
            stage_handoff_model(
                s,
                provider_index,
                model_index,
                &click_provider_id,
                &click_model,
            );
        }));
    }
    let models = model_list;
    let content = col()
        .w(340.0)
        .h(294.0)
        .radius(18.0)
        .border(1.0, t.line)
        .fill(if t.dark {
            t.raised
        } else {
            rune::color::hex("#fdfcf8").unwrap()
        })
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
        .child(icon(&HANDOFF_ARROW, 12.0).color(t.muted));
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
        .child(icon(&HANDOFF_ARROW, 14.0).color(t.accent));
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
        // Electron's --band is color-mix(--ground 98%, --ink 2%). The list
        // remains --raised, leaving the rail and handoff strip slightly inset.
        .fill(crate::theme::mix_srgb(t.ground, t.ink, 0.02))
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
    let mut rail = row()
        .h_full()
        .gap(if s.studio.overview { 28.0 } else { 0.0 });
    if s.studio.overview {
        rail = rail
            .role("grid")
            .label("Studio columns")
            .focus_group()
            .motion(rune::Spring::NONE);
    }
    let count = panes.map_or(0, Vec::len);
    let pane_widths: Vec<f32> = panes
        .into_iter()
        .flatten()
        .map(|pane| {
            [840.0_f32, 960.0, 1120.0, 1240.0]
                [(pane["width"].as_u64().unwrap_or(0) as usize).min(3)]
            .min(viewport_w)
        })
        .collect();
    let overview_natural_width =
        pane_widths.iter().sum::<f32>() + 28.0 * count.saturating_sub(1) as f32;
    let normal_start_pad = if count == 0 {
        0.0
    } else {
        ((viewport_w - pane_widths[0]) / 2.0 - 14.0).max(0.0)
    };
    let normal_natural_width = pane_widths.iter().sum::<f32>()
        + 14.0 * (count + 1) as f32
        + normal_start_pad
        + if count > 1 { viewport_w / 2.0 } else { 0.0 };
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
        let start_pad = if s.studio.overview {
            48.0
        } else {
            ((viewport_w - width) / 2.0 - 14.0).max(0.0)
        };
        rail = rail.child(el().w(start_pad).h_full());
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
            let handoff_fixture =
                s.studio.conversation_fixture.as_deref() == Some("composer-picker-handoff");
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
                .offset(
                    0.0,
                    if state.is_some_and(|s| s.terminal_command.is_some()) {
                        0.5
                    } else {
                        0.0
                    },
                )
                .w_full()
                .px(6.4)
                .h(33.59)
                .justify_between()
                .child(
                    row()
                        .w(100.0)
                        .gap(2.0)
                        .opacity(
                            if handoff_fixture
                                || (show_tools && (!activity_fixture || activity_hover))
                            {
                                1.0
                            } else {
                                0.0
                            },
                        )
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
                        .gap(if state.is_some_and(|s| s.terminal_command.is_some()) {
                            0.0
                        } else if state.is_some_and(|s| s.scratchpad.is_some()) {
                            4.0
                        } else if state
                            .is_some_and(|state| state.worktree_path.is_some() && !state.dormant)
                        {
                            8.0
                        } else {
                            // The absent workspace mark must not add a second flex gap.
                            4.0
                        })
                        .h(20.0)
                        .center_y()
                        .child(if activity_fixture {
                            brand_mark_size("gpt", 14.0, t)
                        } else if state.is_some_and(|s| s.scratchpad.is_some()) {
                            icon(&INSERT_SCRATCHPAD, 15.0).color(t.muted)
                        } else if state.is_some_and(|s| s.terminal_command.is_some()) {
                            icon(&TERMINAL, 15.0).color(t.muted).mr(8.0)
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
                        } else if state.is_some_and(|s| s.scratchpad.is_some()) {
                            label("Scratchpad", 13.5, 400.0, t.ink).font(
                                TextStyle::new(13.5, 400.0)
                                    .family(Family::Named("Geist"))
                                    .tracking(-0.2025)
                                    .lh(16.2),
                            )
                        } else if state.is_some_and(|s| s.terminal_command.is_some()) {
                            text("Terminal")
                                .mr(if state.is_some_and(|s| s.terminal_running) {
                                    8.0
                                } else {
                                    0.0
                                })
                                .font(
                                    TextStyle::new(13.5, 400.0)
                                        .family(Family::Named("Geist"))
                                        .tracking(-0.2025),
                                )
                                .color(t.ink)
                        } else {
                            column_title(state, focused, t)
                        })
                        .child(if state.is_some_and(|s| s.terminal_command.is_some()) {
                            if let Some(command) = state
                                .and_then(|s| s.terminal_command.as_ref())
                                .filter(|_| state.is_some_and(|s| s.terminal_running))
                            {
                                row()
                                    .center_y()
                                    .gap(5.0)
                                    .px(8.0)
                                    .h(20.0)
                                    .offset(0.0, -0.5)
                                    .radius(999.0)
                                    .fill(t.ink.alpha(0.05))
                                    .child(el().w(5.0).h(5.0).radius(3.0).fill(t.muted))
                                    .child(
                                        text(
                                            state
                                                .and_then(|s| s.terminal_child.clone())
                                                .unwrap_or_else(|| command.clone()),
                                        )
                                        .font(
                                            TextStyle::new(10.0, 400.0)
                                                .family(Family::Named("Geist"))
                                                .tracking(0.1),
                                        )
                                        .color(t.muted),
                                    )
                            } else {
                                el().w(0.0)
                            }
                        } else if let Some(state) = state.filter(|_| !activity_fixture) {
                            context_meter(state, t)
                        } else {
                            el().w(0.0)
                        }),
                )
                .child(
                    row()
                        .opacity(
                            if !handoff_fixture
                                && show_tools
                                && (!activity_fixture || activity_hover)
                            {
                                1.0
                            } else {
                                0.0
                            },
                        )
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
                                .child(
                                    text(if zen {
                                        "max".into()
                                    } else {
                                        format!("{width:.0}")
                                    })
                                    .font(
                                        TextStyle::new(10.0, 400.0)
                                            .family(Family::Named("Geist"))
                                            .features("'tnum' 1"),
                                    )
                                    .color(t.muted)
                                    .offset(0.5, -0.5),
                                )
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
                )
                .on_hover_focus_change(|s: &mut AppState, over, _| {
                    s.studio_header_hover = over;
                });
            let body = if let Some(pad) = state.and_then(|state| state.scratchpad.as_ref()) {
                let edit_id = id.clone();
                let retry_id = id.clone();
                let editor_min_h = (pad.text.lines().count() as f32 * 26.88 + 79.0).max(192.0);
                let input = text_input(
                    pad,
                    TextStyle::new(16.0, 400.0)
                        .family(Family::Named("Geist"))
                        .lh(26.88),
                )
                .key(format!("scratchpad-editor-{id}"))
                .on_input_key(|s: &mut AppState, event, _| {
                    super::scratchpad_toolbar::key(&mut s.studio, event)
                })
                .rich_style(rune::RichStyle {
                    dark: t.dark,
                    document_spacing: true,
                    code_fg: Some(t.ink),
                    link: t.accent,
                    code_block_bg: t.ink.alpha(0.04),
                    code_bg: t.ink.alpha(0.06),
                    quote_bar: t.accent.alpha(0.45),
                    marker: Some(t.muted),
                    code_caret_spacer: None,
                })
                .w_full()
                .color(t.ink)
                .pt(39.5)
                .pb(40.0)
                .min_h(editor_min_h)
                .caret(
                    if pad.range().0 == pad.range().1 {
                        t.accent
                    } else {
                        rune::Color::TRANSPARENT
                    },
                    t.accent.alpha(0.24),
                )
                .selection_radius(0.0)
                .selection_offset(0.0, 1.0)
                .on_edit(move |s: &mut AppState| {
                    if s.studio.thread_id != edit_id {
                        s.select_studio_project(project_index);
                        s.open_studio_thread(edit_id.clone());
                    }
                    s.studio
                        .scratchpad
                        .get_or_insert_with(|| rune::TextEdit::default().rich())
                });
                let mut doc = el()
                    .key(format!("scratchpad-body-{id}"))
                    .w_full()
                    .grow(1.0)
                    .scroll(rune::ScrollSpec {
                        stick_bottom: false,
                    })
                    .clip_fade_linear(0.0, 40.0, 0.0, 40.0)
                    .child(input);
                if pad.text.trim().is_empty() {
                    doc = doc.child(
                        label(
                            "Notes, snippets, drafts. Type ## or - and it formats itself.",
                            16.0,
                            400.0,
                            t.muted,
                        )
                        .font(
                            TextStyle::new(16.0, 400.0)
                                .family(Family::Named("Geist"))
                                .lh(26.88),
                        )
                        .spans(vec![
                            rune::Span {
                                family: Some(Family::Named("Menlo")),
                                line_height: Some(23.1168),
                                ..rune::Span::new(30, 32)
                            }
                            .size(13.76)
                            .color(t.ink_soft.alpha(0.7)),
                            rune::Span {
                                family: Some(Family::Named("Menlo")),
                                line_height: Some(23.1168),
                                ..rune::Span::new(36, 37)
                            }
                            .size(13.76)
                            .color(t.ink_soft.alpha(0.7)),
                        ])
                        .absolute(0.0, 40.0),
                    );
                }
                let mut body = col()
                    .w_full()
                    .max_w(720.0)
                    .self_center()
                    .grow(1.0)
                    .min_h(0.0)
                    .child(doc)
                    .child(super::scratchpad_footer::view(
                        s,
                        state.unwrap(),
                        t,
                        project_index,
                        &id,
                    ));
                if state.is_some_and(|state| state.scratchpad_conflict) {
                    body = body.child(
                        row()
                            .w_full()
                            .gap(12.0)
                            .py(12.0)
                            .center_y()
                            .child(
                                label(
                                    state.and_then(|state| state.error.clone()).unwrap_or_else(
                                        || {
                                            "Saved version changed. Your edits are preserved."
                                                .into()
                                        },
                                    ),
                                    12.0,
                                    400.0,
                                    t.muted,
                                )
                                .grow(1.0),
                            )
                            .child(
                                el().px(10.0)
                                    .py(6.0)
                                    .radius(8.0)
                                    .hover(t.hover)
                                    .child(label(
                                        if state.is_some_and(|state| state.scratchpad_revision == 0)
                                        {
                                            "Retry"
                                        } else {
                                            "Save my version"
                                        },
                                        12.0,
                                        400.0,
                                        t.ink,
                                    ))
                                    .on_press(move |s: &mut AppState| {
                                        s.select_studio_project(project_index);
                                        s.open_studio_thread(retry_id.clone());
                                        s.retry_scratchpad_save();
                                    }),
                            ),
                    );
                }
                col()
                    .w_full()
                    .grow(1.0)
                    .min_h(0.0)
                    .pt(10.4)
                    .pb(20.0)
                    .clip_fade_linear(0.0, 14.0, 0.0, 176.0)
                    .child(body)
            } else if state.is_some_and(|s| s.dormant) {
                col()
                    .w_full()
                    .grow(1.0)
                    .items_center()
                    .pt(40.0)
                    .child(label("Opening…", 12.5, 400.0, t.muted).opacity(0.7))
            } else if let Some(terminal) = state.filter(|s| s.terminal_command.is_some()) {
                let mut output = col().w_full().gap(0.0).selection_group(true);
                let fixture_transcript =
                    terminal.terminal_output == "kone terminal (dev mock)\r\n$ ";
                let cursor_visible =
                    focused && s.studio.terminal_cursor_visible && !fixture_transcript;
                let terminal_cols = if terminal.terminal_cols == 0 {
                    80
                } else {
                    terminal.terminal_cols as usize
                };
                let terminal_rows = if terminal.terminal_rows == 0 {
                    24
                } else {
                    terminal.terminal_rows as usize
                };
                let lines = crate::terminal::screen_lines(
                    &terminal.terminal_output,
                    terminal_cols,
                    terminal_rows,
                    300,
                    cursor_visible,
                );
                for line in lines {
                    output = output.child(terminal_line(&line, t));
                }
                if let Some(code) = terminal.terminal_exit_code {
                    output = output.child(
                        label(format!("[process exited: {code}]"), 11.5, 400.0, t.muted)
                            .font(TextStyle::new(11.5, 400.0).mono()),
                    );
                }
                if let Some(error) = terminal.terminal_error.as_deref() {
                    output = output.child(
                        label(format!("[terminal error: {error}]"), 11.5, 400.0, t.danger)
                            .font(TextStyle::new(11.5, 400.0).mono()),
                    );
                }
                // The parity transcript represents a complete xterm screen. It has
                // no separate text-input caret; keep the capture faithful while
                // retaining the normal input widget for live terminal sessions.
                let input = if focused && !fixture_transcript {
                    text_input(&terminal.terminal_input, TextStyle::new(12.5, 400.0).mono())
                        .key(format!("terminal-input-{}", id))
                        .w_full()
                        .h(24.0)
                        .color(t.ink)
                        .on_edit(|s: &mut AppState| &mut s.studio.terminal_input)
                        .on_submit(AppState::submit_terminal_input)
                        .on_key(|s: &mut AppState, ev, tx| {
                            let sequence = match ev.key {
                                rune::Key::Up => Some("\x1b[A"),
                                rune::Key::Down => Some("\x1b[B"),
                                rune::Key::Right => Some("\x1b[C"),
                                rune::Key::Left => Some("\x1b[D"),
                                rune::Key::Home => Some("\x1b[H"),
                                rune::Key::End => Some("\x1b[F"),
                                rune::Key::PageUp => Some("\x1b[5~"),
                                rune::Key::PageDown => Some("\x1b[6~"),
                                rune::Key::Tab => Some("\t"),
                                rune::Key::Escape => Some("\x1b"),
                                rune::Key::Delete => Some("\x1b[3~"),
                                _ => None,
                            };
                            if let Some(sequence) = sequence {
                                s.terminal_write(sequence.into());
                                tx.live_only();
                                return true;
                            }
                            if ev.mods.ctrl
                                && let rune::Key::Text(text) = &ev.key
                                && let Some(ch) = text.chars().next()
                            {
                                let control = (ch.to_ascii_lowercase() as u8 & 0x1f) as char;
                                s.terminal_write(control.to_string());
                                return true;
                            }
                            false
                        })
                } else {
                    el().w_full().h(40.0)
                };
                col()
                    .w_full()
                    .grow(1.0)
                    .min_h(0.0)
                    .child(
                        col()
                            .w_full()
                            .grow(1.0)
                            .min_h(0.0)
                            .px(10.5)
                            .pt(8.0)
                            .scroll(ScrollSpec { stick_bottom: true })
                            .child(output)
                            .on_layout(|s: &mut AppState, bounds| {
                                s.resize_terminal(
                                    ((bounds[2] - 36.0) / 7.5) as u16,
                                    ((bounds[3] - 14.0) / 15.0) as u16,
                                );
                            }),
                    )
                    .child(el().w_full().px(14.0).py(8.0).child(input))
            } else if focused {
                focused_body(
                    s,
                    &project.name,
                    width,
                    t,
                    crate::codegolf::MARK_BASE + (project_index * 256 + i) as u32,
                )
            } else if let Some(state) = state {
                parked_body(
                    state,
                    &id,
                    s.studio.overview.then_some((viewport_h, width)),
                    t,
                    crate::codegolf::MARK_BASE + (project_index * 256 + i) as u32,
                )
            } else {
                col().w_full().grow(1.0)
            };
            let body = body.on_hover_focus_change(move |s: &mut AppState, over, _| {
                if over {
                    s.studio_column_hover = Some(hover_id.clone());
                } else if s.studio_column_hover.as_deref() == Some(hover_id.as_str()) {
                    s.studio_column_hover = None;
                }
            });
            let head = if s.studio.overview {
                head.inert()
            } else {
                head
            };
            let body = if s.studio.overview {
                body.inert()
            } else {
                body
            };
            if i == 0 && !s.studio.overview {
                let seam_key = format!("{path}-0");
                let hovered = s.studio_seam_hover.as_deref() == Some(seam_key.as_str())
                    || s.studio_insert_menu
                        .as_ref()
                        .is_some_and(|(menu_path, seam, _)| menu_path == &path && *seam == 0);
                let layout_key = seam_key.clone();
                let press_key = seam_key.clone();
                let menu_path = path.clone();
                rail = rail.child(
                    el().key(format!("studio-seam-{path}-0"))
                        .w(14.0)
                        .h(28.0)
                        .offset(0.0, -0.3)
                        .self_center()
                        .center()
                        .on_drawn_layout(move |s: &mut AppState, bounds| {
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
                                .h(if hovered { 19.44 } else { 18.0 })
                                .radius(3.0)
                                .fill(t.ink.alpha(if hovered { 0.48 } else { 0.32 })),
                        )
                        .on_press(move |s: &mut AppState| {
                            s.studio_insert_selection = 0;
                            s.studio_insert_menu = s
                                .studio_seam_bounds
                                .get(&press_key)
                                .copied()
                                .map(|b| (menu_path.clone(), 0, b));
                        }),
                );
            }
            let mut card = col()
                .key(format!("studio-pane-{id}"))
                .w(width)
                .h_full()
                .opacity(if s.studio.overview || focused {
                    1.0
                } else if show_tools {
                    0.52
                } else {
                    0.34
                })
                .scale(if focused || s.studio.overview {
                    1.0
                } else {
                    0.985
                })
                .pt(if s.studio.overview { 0.0 } else { 56.0 })
                .child(head.opacity(
                    if focused
                        && state.is_some_and(|state| {
                            state.approval.is_some() || state.question.is_some()
                        })
                    {
                        0.2
                    } else {
                        1.0
                    },
                ))
                .child(body);
            if s.studio.overview {
                let title = state
                    .map(|state| state.title.as_str())
                    .filter(|title| !title.is_empty())
                    .unwrap_or("New thread")
                    .to_owned();
                let selected = focused;
                let select_id = id.clone();
                let select_path = path.clone();
                let hovered = s.studio.overview_hovered.as_deref() == Some(id.as_str());
                let hover_id = id.clone();
                let k = 0.58_f32;
                let fill = if selected && hovered {
                    crate::theme::mix_srgb(t.ground, t.accent, 0.035)
                } else if hovered {
                    // Opaque composition of the CSS hover mix over the overview backdrop.
                    rune::color::hex(if t.dark { "#101012" } else { "#efeeec" }).unwrap()
                } else {
                    t.ground
                };
                let caption = row()
                    .pin(Some(0.0), None, Some(0.0), Some(-32.0))
                    .h(19.375)
                    .center_y()
                    .justify_center()
                    .gap(5.0)
                    .scale(1.0 / k)
                    .origin(0.5, 0.0)
                    .child(
                        brand_mark_size(
                            state
                                .and_then(|state| state.providers.get(state.provider_index))
                                .map_or("unknown", |provider| provider.id.as_str()),
                            13.0,
                            t,
                        )
                        .color(if hovered || selected {
                            t.ink
                        } else {
                            t.muted
                        }),
                    )
                    .child(
                        text(title.clone())
                            .font(TextStyle::new(12.5, 400.0).tracking(-0.125).lh(19.375))
                            .color(if hovered || selected { t.ink } else { t.muted }),
                    );
                card = card
                    .scale_motion(rune::Anim::INSTANT)
                    .opacity_motion(rune::Anim::INSTANT)
                    .fill(fill)
                    .radius(12.0)
                    .box_shadow(rune::Shadow {
                        spread: if selected && hovered {
                            2.0
                        } else if selected || hovered {
                            1.5
                        } else {
                            1.0
                        },
                        color: if selected {
                            t.accent
                        } else if hovered {
                            t.ink.alpha(0.22)
                        } else {
                            t.ink.alpha(0.09)
                        },
                        ..Default::default()
                    })
                    .shadow(
                        if hovered {
                            4.0
                        } else if selected {
                            3.0
                        } else {
                            2.0
                        },
                        if selected && hovered {
                            18.0
                        } else if hovered {
                            16.0
                        } else if selected {
                            12.0
                        } else {
                            8.0
                        },
                        if selected {
                            t.accent.alpha(if hovered { 0.26 } else { 0.18 })
                        } else {
                            rune::Color::BLACK.alpha(if hovered { 0.07 } else { 0.04 })
                        },
                    )
                    .focusable(true)
                    .role("button")
                    .label(format!("{title}, column {} of {count}", i + 1))
                    .focus_selected(s.studio.overview_selection == i)
                    .focus_ring(2.0, -1.0, rune::color::hex("#005fcc").unwrap())
                    .focus_ring_halo(1.0, rune::Color::WHITE)
                    .child(caption)
                    .on_press_tx(move |s: &mut AppState, tx| {
                        s.studio.overview = false;
                        s.studio.overview_selection = i;
                        s.select_studio_project(project_index);
                        s.open_studio_thread(select_id.clone());
                        tx.scroll_into_view(format!("studio-row-slot-{select_path}"));
                        s.center_studio_column(tx);
                    })
                    .on_hover_change(move |s: &mut AppState, over, _| {
                        if over {
                            s.studio.overview_hovered = Some(hover_id.clone());
                        } else if s.studio.overview_hovered.as_deref() == Some(hover_id.as_str()) {
                            s.studio.overview_hovered = None;
                        }
                    });
                rail = rail.child(card);
            } else {
                rail = rail.child(card.on_press_tx(move |s: &mut AppState, tx| {
                    s.select_studio_project(project_index);
                    s.open_studio_thread(focus_id.clone());
                    tx.scroll_into_view(format!("studio-row-slot-{project_path}"));
                    s.center_studio_column(tx);
                }));
            }
            if !s.studio.overview {
                let seam_key = format!("{path}-{}", i + 1);
                let hovered = s.studio_seam_hover.as_deref() == Some(seam_key.as_str())
                    || s.studio_insert_menu
                        .as_ref()
                        .is_some_and(|(menu_path, seam, _)| {
                            menu_path == &path && (*seam == i + 1 || *seam == usize::MAX)
                        });
                let layout_key = seam_key.clone();
                let press_key = seam_key.clone();
                let menu_path = path.clone();
                rail = rail.child(
                    el().key(format!("studio-seam-{path}-{}", i + 1))
                        .w(14.0)
                        .h(28.0)
                        .offset(0.0, -0.3)
                        .self_center()
                        .center()
                        .on_drawn_layout(move |s: &mut AppState, bounds| {
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
                                .h(if hovered { 19.44 } else { 18.0 })
                                .radius(3.0)
                                .fill(t.ink.alpha(if hovered { 0.48 } else { 0.32 })),
                        )
                        .on_press(move |s: &mut AppState| {
                            s.studio_insert_selection = 0;
                            s.studio_insert_menu = s
                                .studio_seam_bounds
                                .get(&press_key)
                                .copied()
                                .map(|b| (menu_path.clone(), i + 1, b));
                        }),
                );
            }
        }
        if count > 1 && !s.studio.overview {
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
                            } else if !s.studio_threads.contains_key(thread) {
                                t.ink.alpha(0.08)
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
            el().absolute((viewport_w - 100.0) / 2.0, 18.2)
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
    bar = bar
        .opacity(if s.studio.overview { 0.0 } else { 1.0 })
        .opacity_motion(rune::Curve::tween(
            0.28,
            rune::Easing::cubic(0.25, 0.1, 0.25, 1.0),
        ));
    if s.studio.overview {
        bar = bar.inert();
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
            } else if index == 1 {
                action = action.on_press_tx(move |s: &mut AppState, tx| {
                    s.select_studio_project(project_index);
                    s.insert_studio_terminal(0);
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
        let duration = if cx.is_reduced_motion() { 0.001 } else { 0.42 };
        let plane_width = if s.studio.overview {
            overview_natural_width
        } else {
            normal_natural_width
        };
        let footprint = if s.studio.overview {
            overview_natural_width * 0.58 + 96.0
        } else {
            normal_natural_width
        };
        let rail_content = el()
            .key(format!("studio-overview-scaler-{path}"))
            .w(footprint)
            .h_full()
            .child(
                rail.key(format!("studio-rail-plane-{path}"))
                    .w(plane_width)
                    .scale(if s.studio.overview { 0.58 } else { 1.0 })
                    .origin(0.0, 0.5)
                    .offset(
                        if s.studio.overview { 48.0 } else { 0.0 },
                        if s.studio.overview { -14.0 } else { 0.0 },
                    )
                    .offset_motion(rune::Curve::tween(
                        duration,
                        rune::Easing::cubic(0.22, 1.0, 0.36, 1.0),
                    ))
                    .scale_motion(rune::Curve::tween(
                        duration,
                        rune::Easing::cubic(0.22, 1.0, 0.36, 1.0),
                    )),
            );
        col()
            .key(format!("studio-rail-{path}"))
            .w_full()
            .grow(1.0)
            .shrink()
            .scroll_x()
            .child(rail_content)
    };
    let mut result = col()
        .key(format!("studio-row-slot-{path}"))
        .w_full()
        .h(viewport_h)
        .fill(if s.studio.overview {
            crate::theme::mix_srgb(t.ground, t.ink, 0.035)
        } else {
            t.ground
        })
        .child(content)
        .child(bar.absolute(0.0, 0.0));
    if s.studio.overview {
        result = result.child(
            text(project.name.clone())
                .font(TextStyle::new(13.5, 400.0).tracking(-0.2025).lh(13.5))
                .color(if selected_row { t.ink } else { t.ink_soft })
                .absolute(48.0, 8.0),
        );
    }
    if let Some((menu_path, index, bounds)) = &s.studio_insert_menu
        && *menu_path == path
    {
        let blank_thread_open = count == 1
            && !s
                .studio
                .items
                .iter()
                .any(|item| item.kind == "user" && !item.text.trim().is_empty());
        let index = *index;
        let x = if index == 0 {
            bounds[0] + bounds[2] + 8.0
        } else {
            bounds[0] - 191.5
        };
        let y = bounds[1] + bounds[3] / 2.0 - 76.835;
        result = result.child(
            el().size(8192.0, 8192.0)
                .absolute(-4096.0, -4096.0)
                .on_press(|s: &mut AppState| s.studio_insert_menu = None),
        );
        let mut menu = col()
            .key("studio-thread-insert-menu")
            .w(184.0)
            .radius(18.0)
            .clip_rounded(18.0)
            .fill(crate::theme::mix_srgb(t.ground, t.ink, 0.02))
            .offset_motion(Curve::tween(
                0.18,
                rune::Easing::cubic(0.22, 1.0, 0.36, 1.0),
            ))
            .child(
                el().w_full()
                    .h(39.5)
                    .px(16.0)
                    .center_y()
                    .corners([18.0, 18.0, 0.0, 0.0])
                    .fill(crate::theme::mix_srgb(t.ground, t.ink, 0.02))
                    .child(
                        label("Insert", 13.0, 400.0, t.ink_soft)
                            .font(TextStyle::new(13.0, 400.0).tracking(-0.13)),
                    ),
            );
        let mut actions = col()
            .w_full()
            .pl(12.0)
            .pr(12.0)
            .pt(5.6)
            .pb(5.6)
            .gap(1.0)
            .fill(t.raised)
            .corners([14.0, 14.0, 0.0, 0.0]);
        for (row_index, (glyph, title)) in [
            (&INSERT_THREAD, "New thread"),
            (&INSERT_TERMINAL, "Terminal"),
            (&INSERT_SCRATCHPAD, "Scratchpad"),
        ]
        .into_iter()
        .enumerate()
        {
            let mut action = row()
                .w_full()
                .h(30.99)
                .radius(10.0)
                .px(8.0)
                .gap(7.2)
                .center_y()
                .child(icon(glyph, 14.0).color(t.muted).offset(0.0, 0.5))
                .child(
                    label(title, 13.0, 400.0, t.ink_soft)
                        .font(TextStyle::new(13.0, 400.0).tracking(-0.13))
                        .grow(1.0),
                )
                .child(icon(&INSERT_CHEVRON, 11.0).color(t.muted).offset(0.0, 1.0));
            action = action.on_hover_change(move |s: &mut AppState, over, _| {
                if over {
                    s.studio_insert_selection = row_index;
                }
            });
            if row_index == 0 && !blank_thread_open {
                action = action
                    .hover(t.hover)
                    .hover_motion(
                        Curve::tween(0.18, rune::Easing::cubic(0.22, 1.0, 0.36, 1.0)),
                        Curve::tween(0.18, rune::Easing::cubic(0.22, 1.0, 0.36, 1.0)),
                    )
                    .on_press_tx(move |s: &mut AppState, tx| {
                        s.studio_insert_menu = None;
                        s.select_studio_project(project_index);
                        s.insert_studio_thread(index);
                        s.center_studio_column(tx);
                    });
            } else if row_index == 1 {
                action = action
                    .hover(t.hover)
                    .hover_motion(
                        Curve::tween(0.18, rune::Easing::cubic(0.22, 1.0, 0.36, 1.0)),
                        Curve::tween(0.18, rune::Easing::cubic(0.22, 1.0, 0.36, 1.0)),
                    )
                    .on_press_tx(move |s: &mut AppState, tx| {
                        s.studio_insert_menu = None;
                        s.select_studio_project(project_index);
                        s.insert_studio_terminal(index);
                        s.center_studio_column(tx);
                    });
            } else if row_index == 2 && !s.studio_scratchpad_open() {
                action = action
                    .hover(t.hover)
                    .on_press_tx(move |s: &mut AppState, tx| {
                        s.studio_insert_menu = None;
                        s.select_studio_project(project_index);
                        s.insert_studio_scratchpad(index);
                        s.center_studio_column(tx);
                    });
            } else {
                action = action.opacity(0.38);
            }
            if s.studio_insert_selection == row_index
                && (row_index < 2 || !s.studio_scratchpad_open())
                && !(row_index == 0 && blank_thread_open)
            {
                action = action.fill(t.hover);
            }
            actions = actions.child(action);
        }
        menu = menu.child(actions).child(
            el().w_full()
                .h(8.0)
                .fill(t.raised)
                .corners([0.0, 0.0, 18.0, 18.0]),
        );
        result = result.child(
            el().radius(18.0)
                .outline(1.0, 0.0, t.ink.alpha(0.08))
                .child(menu)
                .absolute(x.max(0.0), y.max(0.0)),
        );
    }
    result
}

fn conversation_search_modal(s: &AppState, t: Palette) -> El {
    let query = s.conversation_search.text.trim().to_lowercase();
    let mut matches: Vec<(String, String, String)> = Vec::new();
    for (id, thread) in std::iter::once((&s.studio.thread_id, &s.studio))
        .chain(s.studio_threads.iter())
        .filter(|_| !query.is_empty())
    {
        let title = if thread.title.is_empty() {
            "New thread"
        } else {
            &thread.title
        };
        for item in &thread.items {
            if item.text.is_empty()
                || (!query.is_empty() && !item.text.to_lowercase().contains(&query))
            {
                continue;
            }
            matches.push((id.clone(), title.to_owned(), item.text.clone()));
        }
    }
    let mut card = col()
        .key("conversation-search-card")
        .w(512.0)
        .radius(16.0)
        .box_shadow(rune::Shadow {
            spread: 1.0,
            color: t.ink.alpha(0.08),
            ..Default::default()
        })
        .fill(t.raised)
        .child(
            row()
                .w_full()
                .h(49.0)
                .px(14.0)
                .center_y()
                .gap(10.0)
                .child(icon(&PICKER_SEARCH, 16.0).color(t.muted).offset(0.0, 2.0))
                .child(
                    text_input(
                        &s.conversation_search,
                        TextStyle::new(15.0, 400.0).tracking(-0.15),
                    )
                    .key("conversation-search-input")
                    .w(396.0)
                    .h(22.0)
                    .color(t.ink)
                    .offset(0.0, 2.0)
                    .quarter_pixel_glyphs(cfg!(target_os = "macos"))
                    .placeholder("Search across all conversations…", t.faint)
                    .on_edit(|s: &mut AppState| &mut s.conversation_search),
                )
                .child(
                    el().key("conversation-search-close")
                        .w(22.0)
                        .h(22.0)
                        .center()
                        .radius(7.0)
                        .hover(t.hover)
                        .child(icon(&CLOSE, 14.0).color(t.muted))
                        .on_press(|s: &mut AppState| s.conversation_search_open = false),
                ),
        )
        .child(el().w_full().h(1.0).fill(t.line_soft));
    if query.is_empty() {
        card = card.child(
            el().w_full().h(63.575).px(18.0).center_y().child(
                label(
                    "Type to search every conversation — prompts and replies.",
                    13.5,
                    400.0,
                    t.muted,
                )
                .offset(0.0, -0.5),
            ),
        );
    } else if matches.is_empty() {
        card = card.child(
            el().w_full()
                .h(63.575)
                .px(18.0)
                .center_y()
                .child(label("No matching messages", 13.5, 400.0, t.muted).offset(0.0, -0.5)),
        );
    } else {
        for (index, (thread_id, title, snippet)) in matches.iter().take(5).enumerate() {
            let id = thread_id.clone();
            card = card.child(
                col()
                    .key(format!("conversation-search-result-{index}"))
                    .w_full()
                    .h(58.0)
                    .px(16.0)
                    .py(8.0)
                    .gap(4.0)
                    .radius(9.0)
                    .hover(t.hover)
                    .fill(if index == s.conversation_search_selection {
                        t.hover
                    } else {
                        t.raised
                    })
                    .child(label(title.clone(), 11.5, 550.0, t.muted))
                    .child(label(snippet.clone(), 12.5, 400.0, t.ink_soft).truncate())
                    .on_press(move |s: &mut AppState| {
                        s.open_studio_thread(id.clone());
                        s.conversation_search_open = false;
                    }),
            );
        }
    }
    let card = card
        .offset_motion(Curve::tween(
            0.18,
            rune::Easing::cubic(0.22, 1.0, 0.36, 1.0),
        ))
        .child(el().w_full().h(1.0).fill(t.line_soft))
        .child(
            row()
                .w_full()
                .h(33.75)
                .center_y()
                .gap(14.0)
                .px(14.0)
                .child(search_hint("↑↓ navigate", t))
                .child(search_hint("↵ open", t))
                .child(search_hint("esc close", t)),
        );
    el().key("conversation-search-overlay")
        .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
        .fill(t.ground.alpha(0.0))
        .child(
            el().key("conversation-search-scrim")
                .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                .fill(t.ground.alpha(0.0))
                .on_press(|s: &mut AppState| s.conversation_search_open = false),
        )
        .child(
            col()
                .w_full()
                .h_full()
                .pt(s.studio_viewport.1 * 0.12)
                .items_center()
                .child(card),
        )
}

fn search_hint(value: &str, t: Palette) -> El {
    text(value)
        .font(
            TextStyle::new(10.5, 400.0)
                .family(Family::Named("Menlo"))
                .tracking(0.0),
        )
        .color(t.faint)
}

fn parked_body(
    state: &StudioState,
    id: &str,
    overview: Option<(f32, f32)>,
    t: Palette,
    mark: u32,
) -> El {
    if state.items.is_empty()
        && let Some((height, width)) = overview
    {
        return col()
            .w_full()
            .grow(1.0)
            .shrink()
            .child(empty_thread_art(height, width, true, false, mark));
    }
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
            [217.0 / 255.0, 119.0 / 255.0, 87.0 / 255.0, 0.4],
        )));
    }
    col()
        .key(format!("studio-parked-{id}"))
        .w_full()
        .grow(1.0)
        .shrink()
        .child(transcript)
}

fn interaction_outline(t: Palette, header: f32) -> El {
    el().pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
        .child(
            el().pin(Some(0.0), Some(0.0), Some(0.0), None)
                .h(header)
                .corners([18.0, 18.0, 0.0, 0.0])
                .border_sides([1.0, 1.0, 0.0, 1.0], t.line),
        )
        .child(
            el().pin(Some(0.0), None, Some(0.0), Some(0.0))
                .h(41.7)
                .corners([0.0, 0.0, 18.0, 18.0])
                .border_sides([0.0, 1.0, 1.0, 1.0], t.line),
        )
}

fn interaction_band(t: Palette) -> rune::Color {
    rune::color::hex(if t.dark { "#0c0c0d" } else { "#f2f1ef" }).unwrap()
}

fn subagent_dock(s: &AppState, t: Palette) -> El {
    let dock_fixture = s.studio.conversation_fixture.as_deref() == Some("composer-dock-subagent");
    let running = s
        .studio
        .subagents
        .iter()
        .filter(|row| matches!(row.2.as_str(), "starting" | "running"))
        .count();
    let mut card = col()
        .w(288.0)
        .padding(if dock_fixture { 0.0 } else { 4.0 })
        .gap(if dock_fixture { 5.0 } else { 0.0 })
        .radius(20.0)
        .border(1.0, t.ink.alpha(0.08))
        .shadow(
            0.0,
            18.0,
            rune::Color::BLACK.alpha(if dock_fixture { 0.0 } else { 0.18 }),
        )
        .fill(interaction_band(t));
    let count = if running > 0 {
        format!("{running}/{}", s.studio.subagents.len())
    } else {
        s.studio.subagents.len().to_string()
    };
    if dock_fixture {
        card = card.child(
            row()
                .w_full()
                .h(35.4)
                .mb(-5.0)
                .offset(0.0, 2.0)
                .px(12.8)
                .center_y()
                .gap(7.0)
                .radius(10.0)
                .child(el().w(6.0).h(6.0).radius(3.0).fill(t.accent))
                .child(brand_mark_size("gpt", 15.0, t))
                .child(label("Composer review", 12.5, 400.0, t.ink_soft)),
        );
        card = card.child(
            col()
                .w(286.0)
                .self_center()
                .padding(4.0)
                .radius(18.0)
                .border(if t.dark { 0.0 } else { 1.0 }, t.ink.alpha(0.08))
                .shadow(
                    0.0,
                    2.0,
                    rune::Color::BLACK.alpha(if t.dark { 0.0 } else { 0.04 }),
                )
                .fill(t.raised)
                .gap(0.0)
                .child(
                    row()
                        .w_full()
                        .h(33.4)
                        .px(8.8)
                        .center_y()
                        .child(label("Changes", 12.5, 400.0, t.ink).offset(0.0, 2.0))
                        .child(el().grow(1.0))
                        .child(label(
                            "+18",
                            11.0,
                            400.0,
                            rune::color::hex("#329b70").unwrap(),
                        ))
                        .gap(6.0)
                        .child(label(
                            "−4",
                            11.0,
                            400.0,
                            rune::color::hex("#d25c5c").unwrap(),
                        ))
                        .child(icon(&DOCK_CHEVRON, 14.0).color(t.ink_soft)),
                )
                .child(
                    row()
                        .w_full()
                        .h(35.5)
                        .px(8.8)
                        .center_y()
                        .gap(8.8)
                        .child(icon(super::file_icons::for_path("main.rs"), 16.0))
                        .child(label("main.rs", 12.5, 400.0, t.ink_soft))
                        .child(el().grow(1.0))
                        .child(label(
                            "+18",
                            11.0,
                            400.0,
                            rune::color::hex("#00a878").unwrap(),
                        ))
                        .child(label("−4", 11.0, 400.0, t.danger)),
                ),
        );
        card = card.child(
            col()
                .w(286.0)
                .self_center()
                .padding(4.0)
                .radius(18.0)
                .border(if t.dark { 0.0 } else { 1.0 }, t.ink.alpha(0.08))
                .shadow(
                    0.0,
                    2.0,
                    rune::Color::BLACK.alpha(if t.dark { 0.0 } else { 0.04 }),
                )
                .fill(t.raised)
                .gap(0.0)
                .child(
                    row()
                        .w_full()
                        .h(33.4)
                        .px(8.8)
                        .center_y()
                        .child(label("Tasks", 12.5, 400.0, t.ink).offset(0.0, 2.0))
                        .child(el().grow(1.0))
                        .gap(8.0)
                        .child(icon(&FOOTER_COPY01, 14.0).color(t.muted))
                        .child(el().w(4.0))
                        .child(
                            label("0/2", 11.0, 400.0, t.ink_soft)
                                .font(TextStyle::new(11.0, 400.0).mono()),
                        )
                        .child(icon(&DOCK_CHEVRON, 14.0).color(t.ink_soft)),
                )
                .child(
                    row()
                        .w_full()
                        .h(30.8)
                        .px(8.8)
                        .center_y()
                        .gap(8.0)
                        .child(
                            el().w(15.0)
                                .h(15.0)
                                .center()
                                .child(super::dock_orb::working_mark(14.0, t.dark)),
                        )
                        .child(label("Building dock rail", 12.5, 400.0, t.ink_soft)),
                )
                .child(
                    row()
                        .w_full()
                        .h(30.8)
                        .px(8.8)
                        .center_y()
                        .gap(8.0)
                        .child(el().w(15.0).h(15.0).radius(3.0).fill(t.ink.alpha(0.04)))
                        .child(label("Match the composer stack", 12.5, 400.0, t.ink_soft)),
                ),
        );
    }
    card = card.child(
        col()
            .w(if dock_fixture { 286.0 } else { 288.0 })
            .self_center()
            .padding(if dock_fixture { 4.0 } else { 0.0 })
            .radius(if dock_fixture { 18.0 } else { 0.0 })
            .border(
                if dock_fixture && !t.dark { 1.0 } else { 0.0 },
                t.ink.alpha(0.08),
            )
            .fill(if dock_fixture { t.raised } else { t.ground })
            .child(
                row()
                    .key("subagents-toggle")
                    .w_full()
                    .h(33.4)
                    .px(8.8)
                    .center_y()
                    .gap(8.0)
                    .radius(12.0)
                    .hover(t.hover)
                    .child(label("Subagents", 12.5, 400.0, t.ink).offset(0.0, 2.0))
                    .child(el().grow(1.0))
                    .child(
                        label(count, 11.0, 400.0, t.ink_soft)
                            .font(TextStyle::new(11.0, 400.0).mono()),
                    )
                    .child(icon(&DOCK_CHEVRON, 14.0).color(t.ink_soft).rotate(
                        if s.studio.subagents_expanded {
                            0.0
                        } else {
                            std::f32::consts::FRAC_PI_2
                        },
                    ))
                    .on_press(|s: &mut AppState| {
                        s.studio.subagents_expanded = !s.studio.subagents_expanded
                    }),
            )
            .child(if s.studio.subagents_expanded {
                let mut list = col()
                    .w_full()
                    .gap(0.0)
                    .pt(if dock_fixture { 1.6 } else { 0.0 })
                    .pb(if dock_fixture { 2.4 } else { 0.0 });
                for (id, title, status) in &s.studio.subagents {
                    let live = matches!(status.as_str(), "starting" | "running");
                    list = list.child(
                        row()
                            .key(format!("subagent-{id}"))
                            .w_full()
                            .min_h(if dock_fixture { 51.6 } else { 38.0 })
                            .px(8.8)
                            .py(7.2)
                            .items_start()
                            .gap(8.0)
                            .child(if live {
                                el().w(16.0)
                                    .h(16.0)
                                    .center()
                                    .child(super::dock_orb::working_mark(14.0, t.dark))
                            } else if dock_fixture {
                                el().w(15.0)
                                    .h(15.0)
                                    .center()
                                    .radius(4.0)
                                    .fill(
                                        rune::color::hex(if t.dark {
                                            "#2db98b"
                                        } else {
                                            "#20a67f"
                                        })
                                        .unwrap(),
                                    )
                                    .child(label("✓", 10.0, 700.0, t.accent_ink))
                            } else {
                                label(
                                    if status == "failed" { "×" } else { "✓" },
                                    11.0,
                                    600.0,
                                    t.muted,
                                )
                            })
                            .child(
                                col()
                                    .grow(1.0)
                                    .shrink()
                                    .gap(3.2)
                                    .child(
                                        label(
                                            title.clone(),
                                            12.5,
                                            400.0,
                                            if live { t.ink } else { t.muted },
                                        )
                                        .font(
                                            TextStyle::new(12.5, 400.0).lh(16.25).tracking(-0.125),
                                        ),
                                    )
                                    .child(if dock_fixture {
                                        row()
                                            .w_full()
                                            .center_y()
                                            .gap(4.8)
                                            .child(label("Default model", 11.5, 400.0, t.muted))
                                            .child(label("·", 11.0, 400.0, t.muted))
                                            .child(
                                                label(
                                                    if live {
                                                        "Reading Vue and CSS sources"
                                                    } else {
                                                        "Finished reference measurements"
                                                    },
                                                    11.0,
                                                    400.0,
                                                    t.ink_soft,
                                                )
                                                .grow(1.0)
                                                .shrink()
                                                .clip_rounded(0.0),
                                            )
                                    } else {
                                        label(status.clone(), 11.5, 400.0, t.muted)
                                    }),
                            )
                            .child(if dock_fixture && live {
                                el().w(18.0).h(18.0).self_center().center().child(
                                    el().w(9.0)
                                        .h(9.0)
                                        .radius(3.0)
                                        .border(1.0, t.muted.alpha(0.5)),
                                )
                            } else {
                                el()
                            }),
                    );
                }
                list
            } else {
                el()
            }),
    );
    if dock_fixture {
        card = card.child(
            col().w_full().child(
                row()
                    .w_full()
                    .h(30.4)
                    .px(12.8)
                    .center_y()
                    .gap(12.0)
                    .child(
                        text("1 file · 0/2 tasks · 1 agent running")
                            .font(TextStyle::new(10.5, 400.0).mono())
                            .color(t.muted)
                            .grow(1.0)
                            .shrink()
                            .truncate(),
                    )
                    .child(label("Collapse all", 12.5, 400.0, t.muted)),
            ),
        );
    }
    card
}

fn dock_rail_tile(glyph: &'static str, count: &str, t: Palette) -> El {
    let mark = match glyph {
        "◫" => &DOCK_EDIT,
        "☷" => &DOCK_TASKS,
        _ => &DOCK_AGENTS,
    };
    col()
        .w(38.0)
        .h(40.0)
        .radius(11.0)
        .border(1.0, t.ink.alpha(0.06))
        .fill(t.raised)
        .items_center()
        .justify_center()
        .gap(2.0)
        .child(icon(mark, 15.0).color(t.ink_soft))
        .child(
            text(count.to_owned())
                .font(TextStyle::new(9.5, 400.0).mono())
                .color(t.muted),
        )
        .child(
            el().pin(None, Some(3.0), Some(3.0), None)
                .w(6.0)
                .h(6.0)
                .radius(3.0)
                .fill(t.accent.alpha(0.65)),
        )
}

fn queue_strip(s: &AppState, width: f32, t: Palette) -> El {
    let mut strip = col()
        .w((width - 26.0).max(0.0))
        .padding(8.0)
        .pt(6.0)
        .pb(20.0)
        .radius(18.0)
        .fill(t.sunken)
        .gap(2.0);
    for (index, (id, input)) in s.studio.queued_turns.iter().enumerate() {
        let cancel_id = id.clone();
        let edit_id = id.clone();
        let edit_input = input.clone();
        let send_now_id = id.clone();
        let send_now_input = input.clone();
        strip = strip.child(
            row()
                .key(format!("queue-{id}"))
                .w_full()
                .h(26.0)
                .center_y()
                .px(6.0)
                .gap(7.0)
                .child(icon(&QUEUE_GRIP, 12.0).color(t.faint))
                .child(el().w(18.0).h(18.0).center().radius(9.0).fill(t.ink.alpha(0.08))
                    .child(text((index + 1).to_string()).font(TextStyle::new(10.0, 700.0).mono()).color(t.muted)))
                .child(label(input.clone(), 11.5, 400.0, t.ink).grow(1.0).shrink())
                .child(label(if index == 0 { "After this turn" } else { "Waiting" }, 10.5, 400.0, t.faint))
                .child(el().key(format!("queue-send-{id}")).px(6.0).h(20.0).center().radius(5.0).fill(t.ink.alpha(0.06)).hover(t.hover)
                    .w(75.328125).gap(3.5).child(icon(&QUEUE_SEND, 12.0).color(t.muted)).child(label("Send now", 10.5, 400.0, t.muted)).on_press(move |s: &mut AppState| {
                        s.request("agent.queueCancel", serde_json::json!({"threadId": s.studio.thread_id, "queueId": send_now_id}));
                        s.request("agent.steer", serde_json::json!({"threadId": s.studio.thread_id, "input": send_now_input, "dispatchMode": "steer"}));
                    }))
                .child(el().ml(-4.0).key(format!("queue-edit-{id}")).px(6.0).h(20.0).center().radius(5.0).fill(t.ink.alpha(0.06)).hover(t.hover)
                    .w(45.921875).gap(3.5).child(icon(&QUEUE_EDIT, 12.0).color(t.muted)).child(label("Edit", 10.5, 400.0, t.muted)).on_press(move |s: &mut AppState| {
                        s.request("agent.queueCancel", serde_json::json!({"threadId": s.studio.thread_id, "queueId": edit_id}));
                        s.composer.text = edit_input.clone();
                        s.composer.focus = s.composer.text.len(); s.composer.anchor = s.composer.focus;
                        s.open_composer();
                    }))
                .child(el().ml(-4.0).key(format!("queue-stop-{id}")).px(6.0).h(20.0).center().radius(5.0).fill(t.ink.alpha(0.06)).hover(t.hover)
                    .w(50.078125).gap(3.5).child(icon(&CLOSE, 12.0).color(t.muted)).child(label("Stop", 10.5, 400.0, t.muted)).on_press(move |s: &mut AppState| {
                        s.request("agent.queueCancel", serde_json::json!({"threadId": s.studio.thread_id, "queueId": cancel_id}));
                    })),
        );
    }
    strip
}

fn empty_thread_art(
    viewport_height: f32,
    col_width: f32,
    overview: bool,
    live: bool,
    mark: u32,
) -> El {
    let height = (viewport_height.max(640.0) * 0.72).min(580.0);
    let top = if overview {
        26.296875
    } else {
        (viewport_height - height) * 0.5 - 89.203125
    };
    let cached_scale = 0.985 * 0.985;
    el().w_full()
        .max_w(720.0)
        .self_center()
        .h(height)
        .offset(0.0, top)
        .child(
            crate::codegolf::slot(
                mark,
                live,
                [217.0 / 255.0, 119.0 / 255.0, 87.0 / 255.0, 0.4],
            )
            .w(col_width.min(720.0) * cached_scale)
            .h(height * cached_scale),
        )
}

fn focused_body(s: &AppState, name: &str, col_width: f32, t: Palette, mark: u32) -> El {
    let activity_plan = s.studio.conversation_fixture.as_deref() == Some("activity-plan");
    let show_closing = s.studio.composer_closing_at.is_some();
    let track_w = (col_width - 32.0).clamp(0.0, 680.0);
    let wake_orb = || super::composer::wake_orb(s, t);
    let dock = if activity_plan {
        col()
            .key("activity-tasks-dock")
            .w(288.0)
            .pt(4.0)
            .px(4.0)
            .pb(0.0)
            .gap(0.0)
            .offset(4.0, 2.0)
            .radius(18.0)
            .border(1.0, t.line)
            .fill(t.raised_high)
            .child(
                row()
                    .h(25.375)
                    .mb(6.0)
                    .center_y()
                    .gap(5.0)
                    .child(label("●", 8.0, 600.0, t.accent))
                    .child(brand_mark_size("gpt", 14.0, t))
                    .child(label("Studio activity reference", 12.0, 500.0, t.ink_soft)),
            )
            .child(
                row()
                    .w(286.0)
                    .h(41.438)
                    .ml(-3.0)
                    .mb(5.0)
                    .center_y()
                    .padding(4.0)
                    .radius(14.0)
                    .fill(t.ground)
                    .px(9.0)
                    .py(0.0)
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
            .child(
                col()
                    .w(286.0)
                    .h(177.672)
                    .ml(-3.0)
                    .padding(4.0)
                    .pb(6.391)
                    .radius(14.0)
                    .fill(t.ground)
                    .gap(1.593)
                    .child(
                        row()
                            .w_full()
                            .h(33.438)
                            .center_y()
                            .px(9.0)
                            .gap(6.0)
                            .child(label("Tasks", 12.5, 500.0, t.ink_soft))
                            .child(el().grow(1.0))
                            .child(icon(&FOOTER_COPY01, 13.0).color(t.muted))
                            .child(
                                text("1/4")
                                    .font(TextStyle::new(11.0, 500.0).mono())
                                    .color(t.ink_soft),
                            )
                            .child(
                                icon(&ACTIVITY_CHEVRON, 14.0)
                                    .color(t.muted)
                                    .rotate(std::f32::consts::FRAC_PI_2),
                            ),
                    )
                    .child(activity_task_row(
                        "Inspect the conversation activity components",
                        "completed",
                        t,
                    ))
                    .child(activity_task_row(
                        "Implementing the turn activity layout",
                        "in-progress",
                        t,
                    ))
                    .child(activity_task_row(
                        "Verify light and dark themes",
                        "pending",
                        t,
                    ))
                    .child(activity_task_row(
                        "Capture reference screenshots",
                        "pending",
                        t,
                    )),
            )
            .child(
                row()
                    .w(288.0)
                    .h(35.375)
                    .ml(-4.0)
                    .center_y()
                    .px(12.8)
                    .child(label("1 file · 1/4 tasks", 10.5, 400.0, t.muted))
                    .child(el().grow(1.0))
                    .child(label("Expand all", 10.5, 400.0, t.muted)),
            )
    } else if let Some(approval) = &s.studio.approval {
        col()
            .w(512.0)
            .min_w(512.0)
            .gap(0.0)
            .radius(18.0)
            .clip_rounded(18.0)
            .fill(t.ground)
            .child(
                row()
                    .w_full()
                    .h(40.14)
                    .px(16.0)
                    .center_y()
                    .gap(8.0)
                    .fill(interaction_band(t))
                    .child(icon(&ACTIVITY_TOOLS, 14.0).color(t.ink_soft))
                    .child(label("Tool call", 13.0, 400.0, t.ink_soft)),
            )
            .child(
                col()
                    .w_full()
                    .padding(16.0)
                    .pb(8.0)
                    .gap(12.0)
                    .radius(14.0)
                    .fill(t.raised)
                    .child(
                        text(approval.title.clone())
                            .font(TextStyle::new(14.5, 400.0).lh(20.3).tracking(-0.145))
                            .color(t.ink),
                    )
                    .child(
                        label(
                            if s.studio.conversation_fixture.as_deref()
                                == Some("composer-dock-approval")
                            {
                                approval
                                    .detail
                                    .replace(" keyboard handling", " keyboard\nhandling")
                            } else {
                                approval.detail.clone()
                            },
                            13.0,
                            400.0,
                            t.ink_soft,
                        )
                        .font(TextStyle::new(13.0, 400.0).lh(18.85)),
                    ),
            )
            .child(
                row()
                    .w_full()
                    .h(41.7)
                    .px(16.0)
                    .center_y()
                    .gap(20.0)
                    .fill(interaction_band(t))
                    .child(
                        el().key("approval-reject")
                            .px(0.0)
                            .h(28.0)
                            .center()
                            .hover(t.hover)
                            .child(label("Reject", 14.0, 400.0, t.danger))
                            .on_press(|s: &mut AppState| s.answer_approval("reject-once")),
                    )
                    .child(
                        el().key("approval-reject-stop")
                            .px(0.0)
                            .h(28.0)
                            .center()
                            .hover(t.hover)
                            .child(label("Reject and stop", 14.0, 400.0, t.danger))
                            .on_press(|s: &mut AppState| s.answer_approval("reject-and-stop")),
                    )
                    .child(el().grow(1.0))
                    .child(
                        el().key("approval-allow-always")
                            .px(0.0)
                            .h(28.0)
                            .center()
                            .hover(t.hover)
                            .child(label("Always allow", 14.0, 400.0, t.muted))
                            .on_press(|s: &mut AppState| s.answer_approval("allow-always")),
                    )
                    .child(
                        el().key("approval-allow")
                            .px(0.0)
                            .h(28.0)
                            .center()
                            .hover(t.hover)
                            .child(label("Allow", 14.0, 400.0, t.ink))
                            .on_press(|s: &mut AppState| s.answer_approval("allow-once")),
                    ),
            )
            .child(interaction_outline(t, 40.14))
    } else if let Some(request) = &s.studio.question {
        let question = &request.questions[request.index];
        let card = col()
            .w(512.0)
            .min_w(512.0)
            .gap(0.0)
            .radius(18.0)
            .clip_rounded(18.0)
            .fill(t.ground)
            .child(
                row()
                    .w_full()
                    .h(41.7)
                    .px(16.0)
                    .center_y()
                    .fill(interaction_band(t))
                    .child(
                        label(
                            if question.header.is_empty() {
                                question.prompt.clone()
                            } else {
                                question.header.clone()
                            },
                            13.0,
                            400.0,
                            t.ink_soft,
                        )
                        .grow(1.0),
                    )
                    .child(
                        el().px(0.0)
                            .h(26.0)
                            .center()
                            .radius(7.0)
                            .hover(t.hover)
                            .child(label("Cancel", 14.0, 400.0, t.muted))
                            .on_press(|s: &mut AppState| {
                                s.studio.question = None;
                                s.studio.answer.text.clear();
                            }),
                    ),
            )
            .child(
                col()
                    .w_full()
                    .padding(16.0)
                    .pb(8.0)
                    .gap(10.0)
                    .radius(14.0)
                    .fill(t.raised)
                    .child(
                        label(question.prompt.clone(), 15.0, 400.0, t.ink)
                            .font(TextStyle::new(15.0, 400.0).lh(20.25).tracking(-0.15)),
                    )
                    .child({
                        let mut options = col().w_full().gap(4.0);
                        for (index, option) in question.options.iter().enumerate() {
                            let answer = option.clone();
                            let multi = question.multi;
                            options = options.child(
                                el().key(format!("question-option-{index}"))
                                    .offset(0.0, -2.0)
                                    .w_full()
                                    .h(35.0)
                                    .px(10.0)
                                    .center_y()
                                    .radius(10.0)
                                    .hover(t.hover)
                                    .gap(10.0)
                                    .child(
                                        el().w(18.0)
                                            .offset(0.0, 2.0)
                                            .h(18.0)
                                            .center()
                                            .radius(9.0)
                                            .border(1.5, t.ink.alpha(0.22))
                                            .child(if request.selected.contains(option) {
                                                el().w(7.0).h(7.0).radius(4.0).fill(t.accent)
                                            } else {
                                                el()
                                            }),
                                    )
                                    .child(label(option.clone(), 14.0, 400.0, t.ink))
                                    .on_press(move |s: &mut AppState| {
                                        if multi {
                                            s.toggle_question_option(answer.clone());
                                        } else {
                                            s.answer_question(answer.clone().into());
                                        }
                                    }),
                            );
                        }
                        options
                            .child(
                                row()
                                    .w_full()
                                    .h(35.0)
                                    .px(10.0)
                                    .center_y()
                                    .gap(10.0)
                                    .child(
                                        el().w(18.0)
                                            .h(18.0)
                                            .center()
                                            .radius(9.0)
                                            .border(1.5, t.ink.alpha(0.22)),
                                    )
                                    .child(label("Write your own…", 14.0, 400.0, t.muted)),
                            )
                            .child(
                                row().w_full().h(26.0).mt(6.0).gap(8.0).child(
                                    el().w(26.0)
                                        .h(26.0)
                                        .center()
                                        .child(icon(&STUDIO_ATTACH, 15.0).color(t.muted))
                                        .color(t.muted),
                                ),
                            )
                    }),
            );
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
                row()
                    .w_full()
                    .h(41.7)
                    .px(12.0)
                    .center_y()
                    .gap(8.0)
                    .fill(interaction_band(t))
                    .child(el().grow(1.0))
                    .child(
                        el().px(4.0)
                            .h(28.0)
                            .center()
                            .radius(8.0)
                            .child(label("Send answer", 14.0, 400.0, t.muted))
                            .on_press(|s: &mut AppState| {
                                let answer = s
                                    .studio
                                    .question
                                    .as_ref()
                                    .and_then(|q| q.selected.first())
                                    .cloned()
                                    .unwrap_or_else(|| s.studio.answer.text.clone());
                                s.answer_question(answer.into());
                            }),
                    ),
            )
            .child(interaction_outline(t, 41.7))
        }
    } else if s.studio.composer_open || show_closing {
        col()
            .w(track_w)
            .items_center()
            .child(if s.studio.queued_turns.is_empty() {
                el()
            } else {
                queue_strip(s, track_w, t).mb(-14.0)
            })
            .child(super::composer::composer_dock(s, name, track_w, t))
    } else {
        wake_orb()
    };
    let dock = dock
        .opacity(if s.studio.overview { 0.0 } else { 1.0 })
        .opacity_motion(rune::Anim::INSTANT);
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
            row().w_full().justify_center().child(
                text(
                    if s.studio
                        .conversation_fixture
                        .as_deref()
                        .is_some_and(|f| f.starts_with("composer-"))
                    {
                        "October 9, 2025"
                    } else {
                        "Today"
                    },
                )
                .font(date_style)
                .color(t.muted),
            ),
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
                let rail = if s.studio.busy
                    && !s
                        .studio
                        .conversation_fixture
                        .as_deref()
                        .is_some_and(|f| f.starts_with("composer-dock-"))
                {
                    crate::theme::mix_srgb(t.ink, t.accent, 0.87).alpha(0.516)
                } else {
                    t.ink.alpha(0.11)
                };
                let connector_shadow = rune::color::hex("#000000").unwrap().alpha(0.35 * rail.a);
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
                            .selectable(true)
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
                let mut turn = col()
                    .w_full()
                    .gap(if is_activity { 8.0 } else { 15.0 })
                    .opacity(
                        if s.studio.conversation_fixture.as_deref() == Some("composer-dock-queue") {
                            0.4
                        } else {
                            1.0
                        },
                    );
                match s.studio.conversation_fixture.as_deref() {
                    Some("activity-folded" | "activity-plan") => turn = turn.mt(10.5),
                    Some("activity-expanded") => turn = turn.mt(13.5),
                    Some("activity-diff") => turn = turn.mt(13.0),
                    Some("activity-hover") => turn = turn.mt(14.5),
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
                        let heading = para.starts_with("## ");
                        turn = turn.child(
                            text(para.trim_start_matches("## ").to_owned())
                                .font(
                                    TextStyle::new(
                                        if heading { 16.0 } else { 14.0 },
                                        if heading { 640.0 } else { 400.0 },
                                    )
                                    .lh(if heading {
                                        21.12
                                    } else {
                                        22.96
                                    }),
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
                        &item.id,
                    ));
                }
                cb_base += item.text.matches("```").count() / 2;
                let copy = item.text.clone();
                let fixture = s.studio.conversation_fixture.is_some();
                let block_id = item.block_id.clone();
                let mut actions =
                    row()
                        .center_y()
                        .gap(0.0)
                        .child(
                            // Electron's `.act` is a 24×24 button with a 14px icon.
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
                    actions = actions.child(
                        el().w(24.0)
                            .h(24.0)
                            .center()
                            .radius(7.0)
                            .hover(t.hover)
                            .child(icon(&FOOTER_GITFORK, 14.0).color(t.muted)),
                    );
                } else if let Some(block_id) = block_id {
                    actions =
                        actions.child(icon(&FOOTER_GITFORK, 14.0).color(t.muted).on_press(
                            move |s: &mut AppState| s.open_branch_picker(block_id.clone()),
                        ));
                }
                let footer = row()
                    .center_y()
                    // Electron's settled footer stays at 0.92 opacity;
                    // the picker scrim provides the remaining dimming.
                    .opacity(if fixture { 0.92 } else { 1.0 })
                    // `.foot` uses a 2px gap; its action group itself is gapless.
                    .gap(2.0)
                    .mt(if is_activity { 0.0 } else { -7.0 })
                    .min_h(22.0)
                    .child(
                        text(if fixture { "8:53 AM" } else { "" })
                            .font(TextStyle::new(12.0, 400.0).mono().lh(18.6))
                            .color(t.muted)
                            .opacity(0.92)
                            .mr(8.0),
                    )
                    .child(actions);
                let hover_scene =
                    s.studio.conversation_fixture.as_deref() == Some("activity-hover");
                let composer_fixture = s
                    .studio
                    .conversation_fixture
                    .as_deref()
                    .is_some_and(|fixture| fixture.starts_with("composer-"));
                if s.studio.selection_text.is_some()
                    || (composer_fixture && s.studio.composer_open)
                    || (is_activity && !hover_scene)
                {
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
                } else if item.status == "in-progress" {
                    "Reading"
                } else {
                    "Read"
                };
                let path = item.text.as_str().trim_end_matches('/');
                let step_icon = if item.status == "in-progress" {
                    &ACTIVITY_SPINNER
                } else if command {
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
                let label_target = if command {
                    text(path.to_owned())
                        .font(TextStyle::new(11.5, 400.0).mono())
                        .min_w(155.0)
                        .color(t.muted)
                } else {
                    let dir_len = path.rfind('/').map_or(0, |slash| slash + 1);
                    let mut chip_text = text(path.to_owned())
                        .font(TextStyle::new(12.5, 400.0).mono().lh(18.75))
                        .color(t.ink)
                        .truncate()
                        .shrink()
                        .min_w(0.0)
                        .max_w(228.0);
                    if dir_len > 0 {
                        chip_text = chip_text.spans([Span::new(0, dir_len).color(t.muted)]);
                    }
                    row()
                        .pl(5.0)
                        .pr(6.0)
                        .py(1.0)
                        .radius(6.0)
                        .fill(t.hover)
                        .max_w(256.0)
                        .center_y()
                        .gap(4.0)
                        .child(icon(super::file_icons::for_path(path), 13.0))
                        .child(chip_text)
                };
                let mut activity_row = row()
                    .key(format!("activity-row-{}", item.id))
                    .w_full()
                    .h(if command { 28.141 } else { 28.75 })
                    .gap(8.0)
                    .center_y()
                    .radius(4.0)
                    .hover(t.hover)
                    .child(
                        el().w(16.0)
                            .h(28.75)
                            .center()
                            .child(
                                el().w(1.5)
                                    .h(22.0)
                                    .absolute(7.0, -10.0)
                                    .radius(1.0)
                                    .fill(t.ink.alpha(0.12)),
                            )
                            .child(el().w(16.0).h(16.0).center().fill(t.ground).child(
                                if item.name == "edit_file" && s.studio.busy {
                                    turn_orb(
                                        16.0,
                                        s.start_actions.clock as f32,
                                        TurnOrbKind::Write,
                                        t.dark,
                                    )
                                } else {
                                    icon(step_icon, 14.0).color(step_hue)
                                },
                            )),
                    )
                    .child(
                        row()
                            .center_y()
                            .gap(5.0)
                            .grow(1.0)
                            .min_w(0.0)
                            .child(
                                text(verb)
                                    .font(TextStyle::new(13.0, 400.0))
                                    .color(t.ink_soft),
                            )
                            .child(label_target),
                    );
                activity_row = activity_row
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
                    .child(
                        icon(
                            if (is_activity
                                && ((command
                                    && s.studio.conversation_fixture.as_deref()
                                        == Some("activity-expanded"))
                                    || (item.name == "edit_file"
                                        && s.studio.conversation_fixture.as_deref()
                                            == Some("activity-diff"))))
                                || (!is_activity && activity_row_open)
                            {
                                &ACTIVITY_CHEVRON_DOWN
                            } else {
                                &ACTIVITY_CHEVRON
                            },
                            12.0,
                        )
                        .color(t.ink_soft.alpha(0.45)),
                    )
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
                let mut body = col()
                    .w_full()
                    .gap(0.0)
                    .child(activity_row.mt(if item.name == "read_file" { 6.0 } else { 0.0 }));
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
                        let inline_output = col()
                            .w_full()
                            .pb(1.0)
                            .gap(3.0)
                            .child(
                                text("✓ No type errors found")
                                    .font(TextStyle::new(11.5, 400.0).mono().lh(20.0))
                                    .color(t.ink_soft),
                            )
                            .child(
                                text("Done in 4.82s")
                                    .font(TextStyle::new(11.5, 400.0).mono().lh(20.0))
                                    .color(t.ink_soft),
                            );
                        let mut detail = trail_branch(inline_output, t);
                        if activity_row_open
                            && s.studio.conversation_fixture.as_deref() == Some("activity-expanded")
                        {
                            detail = detail.child(activity_step_detail(
                                &ACTIVITY_TOOLS,
                                "Tool detail",
                                el().w_full().px(10.0).py(8.0).child(
                                    text(item.detail.clone())
                                        .font(TextStyle::new(12.0, 400.0).mono().lh(18.6))
                                        .color(t.ink_soft),
                                ),
                                t,
                            ));
                        }
                        body = body.child(detail);
                    } else if matches!(
                        s.studio.conversation_fixture.as_deref(),
                        Some("activity-diff" | "activity-expanded" | "activity-hover")
                    ) && item.name == "edit_file"
                        && activity_row_open
                    {
                        let diff_add = rune::color::hex("#059669").unwrap();
                        let diff_del = rune::color::hex("#e11d48").unwrap();
                        let del_text = crate::theme::mix_srgb(diff_del, t.ink, 0.65);
                        let preview_line = |sign: &str, code: &str, is_add: bool| {
                            let tint = if is_add { diff_add } else { diff_del };
                            row()
                                .w_full()
                                .h(20.0)
                                .center_y()
                                .pl(6.0)
                                .pr(8.0)
                                .radius(4.0)
                                .fill(tint.alpha(0.07))
                                .gap(8.0)
                                .child(
                                    text(sign.to_owned())
                                        .font(TextStyle::new(11.5, 600.0).mono())
                                        .color(tint),
                                )
                                .child(
                                    text(code.to_owned())
                                        .font(TextStyle::new(11.5, 400.0).mono())
                                        .color(if is_add { t.ink } else { del_text })
                                        .truncate(),
                                )
                        };
                        body = body.child(trail_branch(
                            col()
                                .w_full()
                                .pt(3.0)
                                .gap(1.0)
                                .pb(4.0)
                                .child(preview_line("−", "const gap = 12;", false))
                                .child(preview_line("+", "const gap = 10;", true))
                                .child(preview_line(
                                    "+",
                                    "const reducedMotion = prefersReducedMotion();",
                                    true,
                                ))
                                .child(
                                    label("3 more changed lines", 12.0, 400.0, t.muted)
                                        .mt(4.0)
                                        .mb(4.0)
                                        .ml(6.0),
                                ),
                            t,
                        ));
                        if s.studio.conversation_fixture.as_deref() == Some("activity-diff") {
                            let gutter_no = |n: &str| {
                                row().w(28.0).pr(6.0).center_y().justify_end().child(label(
                                    n,
                                    10.0,
                                    400.0,
                                    t.muted.alpha(0.55),
                                ))
                            };
                            let diff_line =
                                |old: &str, new: &str, sign: &str, code: &str, is_add: bool| {
                                    let tint = if is_add { diff_add } else { diff_del };
                                    row()
                                        .w_full()
                                        .h(19.0)
                                        .center_y()
                                        .px(8.0)
                                        .fill(tint.alpha(0.12))
                                        .child(gutter_no(old))
                                        .child(gutter_no(new))
                                        .child(
                                            row().w(14.0).center().child(
                                                text(sign.to_owned())
                                                    .font(TextStyle::new(11.5, 600.0).mono())
                                                    .color(tint),
                                            ),
                                        )
                                        .child(
                                            text(code.to_owned())
                                                .font(TextStyle::new(11.5, 400.0).mono())
                                                .color(if is_add { t.ink } else { del_text }),
                                        )
                                };
                            let hunk = |value: &str| {
                                row()
                                    .w_full()
                                    .h(24.0)
                                    .px(8.0)
                                    .center_y()
                                    .fill(t.ink.alpha(0.03))
                                    .child(el().w(28.0))
                                    .child(el().w(28.0))
                                    .child(el().w(14.0))
                                    .child(
                                        text(value.to_owned())
                                            .font(TextStyle::new(10.0, 400.0).mono())
                                            .color(t.muted),
                                    )
                            };
                            let diff_table = col()
                                .w_full()
                                .py(4.0)
                                .gap(0.0)
                                .radius(8.0)
                                .fill(crate::theme::mix_srgb(t.ground, t.ink, 0.025))
                                .child(hunk("@@ -12,7 +12,8 @@"))
                                .child(diff_line("1", "", "−", "const gap = 12;", false))
                                .child(diff_line("", "1", "+", "const gap = 10;", true))
                                .child(diff_line(
                                    "",
                                    "2",
                                    "+",
                                    "const reducedMotion = prefersReducedMotion();",
                                    true,
                                ))
                                .child(hunk("@@ -41,6 +42,7 @@"))
                                .child(diff_line(
                                    "2",
                                    "",
                                    "−",
                                    ".fold { transition: all 380ms ease; }",
                                    false,
                                ))
                                .child(diff_line(
                                    "",
                                    "3",
                                    "+",
                                    ".fold { transition: grid-template-rows 380ms cubic-bezier(.22,1,.36,1); }",
                                    true,
                                ))
                                .child(diff_line(
                                    "",
                                    "4",
                                    "+",
                                    "@media (prefers-reduced-motion: reduce) { .fold { transition: none; } }",
                                    true,
                                ));
                            body = body.child(el().w_full().pl(24.0).child(activity_step_detail(
                                &ACTIVITY_EDIT,
                                "Diff",
                                diff_table,
                                t,
                            )));
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
                head = head.mt(44.5);
            } else {
                head = head.mt(47.5).mb(0.0);
            }
            head = head.on_press(move |s: &mut AppState| s.studio.activity_open = !open);
            if let Some(group) = exchange.take() {
                exchange = Some(group.child(head));
            }
            activity_head = true;
            if (s.studio.busy || activity_rows_open)
                && let Some(group) = exchange.take()
            {
                let orb_time = if s.studio.busy {
                    s.start_actions.clock as f32
                } else {
                    4.2
                };
                let status = row()
                    .key("activity-thinking-status")
                    .w_full()
                    .h(26.0)
                    .mt(9.0)
                    .mb(0.0)
                    .center_y()
                    .child(turn_orb(16.0, orb_time, TurnOrbKind::Working, t.dark))
                    .child(el().grow(1.0))
                    .child(
                        icon(
                            if s.studio.activity_open {
                                &ACTIVITY_CHEVRON_DOWN
                            } else {
                                &ACTIVITY_CHEVRON
                            },
                            13.0,
                        )
                        .color(t.ink_soft.alpha(0.45)),
                    );
                exchange = Some(group.child(status));
            }
        }
        if item.kind == "user" {
            if let Some(previous) = exchange.take() {
                transcript = transcript.child(previous);
            }
            let activity_gap = 0.0;
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
    transcript =
        transcript
            .selection_group(true)
            .on_selection_change(|s: &mut AppState, change, _| {
                let text = change
                    .selection()
                    .map(|selection| selection.text().to_owned())
                    .filter(|text| text.trim().chars().count() > 2);
                s.studio.selection_text = if change.dragging() { None } else { text };
            });
    // Only an empty thread keeps the codegolf art; a populated thread's head
    // carries the day and connected marks instead.
    let art = if s.studio.items.is_empty() {
        empty_thread_art(
            s.studio_viewport.1,
            col_width,
            s.studio.overview,
            s.art_focused,
            mark,
        )
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
                        && !s.studio.conversation_fixture.as_deref().is_some_and(|f| {
                            matches!(f, "scrolled" | "compaction" | "marks" | "code")
                                || f.starts_with("composer-")
                        }),
                })
                .on_layout_tx(|s: &mut AppState, _, tx| {
                    if s.studio.selection_fixture_pending {
                        s.studio.selection_fixture_pending = false;
                        tx.select_text("composer-reply-1-0", 0..83);
                    }
                })
                .clip_fade_linear(
                    0.0,
                    14.0,
                    0.0,
                    if matches!(
                        s.studio.conversation_fixture.as_deref(),
                        Some("activity-expanded" | "activity-diff")
                    ) {
                        308.0
                    } else {
                        176.0
                    },
                )
                .child(art)
                .child(transcript)
                // The body's 208pt bottom padding (composer overlay clearance).
                .child(el().h(208.0)),
        )
        .child(if s.studio.overview {
            el()
        } else if activity_plan {
            row()
                .pin(Some(0.0), None, Some(0.0), Some(33.5))
                .px(16.0)
                .justify_center()
                .child(wake_orb())
        } else {
            el()
        })
        .child(
            if !s.studio.overview && !activity_plan && !s.studio.subagents.is_empty() {
                row()
                    .pin(Some(0.0), None, Some(0.0), Some(181.0))
                    .px(10.0)
                    .justify_end()
                    .child(
                        row()
                            .center_y()
                            .gap(10.0)
                            .items_end()
                            .child(subagent_dock(s, t))
                            .child(
                                col()
                                    .w(44.0)
                                    .padding(3.0)
                                    .gap(4.0)
                                    .radius(14.0)
                                    .border(1.0, t.line)
                                    .fill(interaction_band(t))
                                    .child(dock_rail_tile("◫", "1", t))
                                    .child(dock_rail_tile("☷", "0/2", t))
                                    .child(dock_rail_tile("♙", "1", t)),
                            ),
                    )
            } else {
                el()
            },
        )
        .child(
            if s.studio.approval.is_some() || s.studio.question.is_some() {
                el().key("approval-page-scrim")
                    .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                    .fill(
                        if t.dark {
                            t.ground
                        } else {
                            rune::color::hex("#f7f5f3").unwrap()
                        }
                        .alpha(0.80),
                    )
            } else {
                el()
            },
        )
        .child(if activity_plan {
            row()
                .pin(Some(0.0), None, Some(0.0), Some(14.0))
                .px(16.0)
                .justify_end()
                .child(dock)
        } else {
            row()
                .pin(
                    Some(0.0),
                    None,
                    Some(0.0),
                    Some(if s.studio.composer_open { 32.0 } else { 33.0 }),
                )
                .px(16.0)
                .justify_center()
                .child(dock)
                .transition(rune::Transition::none())
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
    fn overview_keyboard_focus_reveals_the_scaled_card_and_enter_selects_it() {
        let mut state = AppState::default();
        crate::studio_overview_fixture(&mut state, 0);
        let mut rt = Runtime::new(state, view, (1292.0, 854.0), Env::new(false, 1.0));
        rt.frame(0.0);
        let before = rt.presented("studio-pane-review-two").unwrap().0;
        for key in [rune::Key::Tab, rune::Key::Right] {
            rt.key(rune::KeyEvent {
                key,
                mods: rune::Mods::default(),
            });
            rt.frame(0.0);
        }
        let after = rt.presented("studio-pane-review-two").unwrap().0;
        assert!(
            (before[0] - after[0]).abs() < 0.1,
            "an already visible scaled card must stay in place"
        );
        assert_eq!(rt.state.studio.thread_id, "review-one");
        assert!(
            rt.elements()
                .iter()
                .any(|el| el.key.as_deref() == Some("studio-pane-review-two") && el.focused)
        );
        rt.key(rune::KeyEvent {
            key: rune::Key::Enter,
            mods: rune::Mods::default(),
        });
        rt.frame(0.0);
        assert!(!rt.state.studio.overview);
        assert_eq!(rt.state.studio.thread_id, "review-two");
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn terminal_capture_drag_selects_the_same_cells_as_xterm() {
        for dark in [false, true] {
            let mut state = AppState::default();
            crate::studio_column_head(&mut state);
            crate::studio_terminal_fixture(&mut state, false);
            let fonts = rune::text::TextSystem::new(crate::FONTS, ("Geist", "Geist Mono"));
            let mut rt =
                Runtime::with_text(state, view, (1292.0, 854.0), Env::new(dark, 2.0), fonts);
            rt.frame(0.0);
            rt.frame(1.0 / 60.0);
            rt.pointer_down(283.0, 106.0);
            rt.pointer_move(322.0, 106.0);
            rt.pointer_up(322.0, 106.0);
            rt.frame(1.0 / 60.0);
            assert_eq!(rt.selected_text().as_deref(), Some("ermin"));
            assert!(
                rt.instances
                    .iter()
                    .any(|instance| instance.rect == [566.0, 196.0, 80.0, 36.0]),
                "the highlight must occupy the same device-pixel cells as xterm"
            );
        }
    }

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
        s.studio_project_menu_open = true;
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
        let (x, y) = rt.find("studio-project-switch-1").unwrap();
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
