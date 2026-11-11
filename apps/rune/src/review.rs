//! Isolated, deterministic data for visual review. No sidecar or user database is used.
use serde_json::{Value, json};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::{
    project_state::{ProjectMeta, parse_sessions},
    state::{AppState, Page, Project},
};

// Generated from the pure guest identity function for the fixed review IDs.
const IDENTITIES: &str = r###"{"mock-1":{"seed":"mock-1","name":"Aster","svg":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\" fill=\"none\" shape-rendering=\"auto\"><metadata xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\"><rdf:RDF><rdf:Description><dc:title>Thumbs</dc:title><dc:creator>DiceBear</dc:creator><dc:source xsi:type=\"dcterms:URI\">https://www.dicebear.com</dc:source><dcterms:license xsi:type=\"dcterms:URI\">https://creativecommons.org/publicdomain/zero/1.0/</dcterms:license><dc:rights>„Thumbs” (https://www.dicebear.com) by „DiceBear”, licensed under „CC0 1.0” (https://creativecommons.org/publicdomain/zero/1.0/)</dc:rights></rdf:Description></rdf:RDF></metadata><mask id=\"81jdgqkd\"><rect width=\"100\" height=\"100\" rx=\"50\" ry=\"50\" x=\"0\" y=\"0\" fill=\"#fff\" /></mask><g mask=\"url(#81jdgqkd)\"><rect fill=\"#c9d0ce\" width=\"100\" height=\"100\" x=\"0\" y=\"0\" /><g transform=\"translate(0 8)\"><g transform=\"translate(14.000000000000002 14.000000000000002) scale(0.72)\"><g transform=\"translate(-2, -5) rotate(-5 50 70)\"><path d=\"M95 53.33C95 29.4 74.85 10 50 10S5 29.4 5 53.33V140h90V53.33Z\" fill=\"#5f7a76\"/><g transform=\"translate(29 33)\"><g transform=\"translate(15, -13) rotate(8 21 21)\"><g transform=\"translate(0 4)\"><path d=\"M-.75 8.12C.66 11.86 11 16 11 16s5.17-9.58 3.76-13.32c0 0-1.41-3.74-5.3-2.38-3.87 1.36-2.7 4.48-2.7 4.48S5.6 1.66 1.73 3.02c-3.88 1.36-2.47 5.1-2.47 5.1ZM27.24 2.68C25.84 6.42 31 16 31 16s10.34-4.14 11.75-7.88c0 0 1.41-3.74-2.47-5.1-3.87-1.36-5.05 1.76-5.05 1.76s1.18-3.12-2.7-4.48c-3.88-1.36-5.29 2.38-5.29 2.38Z\" fill=\"#18181b\"/></g><g transform=\"translate(6 24)\"><path d=\"M15 10C6.79 10 3.02 3.88 4.22 3.12 5.42 2.35 6.1 6.6 15 6.49c8.9-.12 9.58-4.23 10.78-3.37C26.98 3.98 23.21 10 15 10Z\" fill=\"#18181b\"/></g></g></g></g></g></g></g></svg>"},"mock-2":{"seed":"mock-2","name":"Ridge","svg":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\" fill=\"none\" shape-rendering=\"auto\"><metadata xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\"><rdf:RDF><rdf:Description><dc:title>Thumbs</dc:title><dc:creator>DiceBear</dc:creator><dc:source xsi:type=\"dcterms:URI\">https://www.dicebear.com</dc:source><dcterms:license xsi:type=\"dcterms:URI\">https://creativecommons.org/publicdomain/zero/1.0/</dcterms:license><dc:rights>„Thumbs” (https://www.dicebear.com) by „DiceBear”, licensed under „CC0 1.0” (https://creativecommons.org/publicdomain/zero/1.0/)</dc:rights></rdf:Description></rdf:RDF></metadata><mask id=\"347we69l\"><rect width=\"100\" height=\"100\" rx=\"50\" ry=\"50\" x=\"0\" y=\"0\" fill=\"#fff\" /></mask><g mask=\"url(#347we69l)\"><rect fill=\"#ccced6\" width=\"100\" height=\"100\" x=\"0\" y=\"0\" /><g transform=\"translate(0 8)\"><g transform=\"translate(14.000000000000002 14.000000000000002) scale(0.72)\"><g transform=\"translate(0, 2) rotate(-3 50 70)\"><path d=\"M95 53.33C95 29.4 74.85 10 50 10S5 29.4 5 53.33V140h90V53.33Z\" fill=\"#6b7391\"/><g transform=\"translate(29 33)\"><g transform=\"translate(-11, 13) rotate(-6 21 21)\"><g transform=\"translate(0 4)\"><path d=\"M-1.75 8.12C-.34 11.86 10 16 10 16s5.17-9.58 3.76-13.32c0 0-1.41-3.74-5.3-2.38-3.87 1.36-2.7 4.48-2.7 4.48S4.6 1.66.73 3.02c-3.88 1.36-2.47 5.1-2.47 5.1ZM28.24 2.68C26.84 6.42 32 16 32 16s10.34-4.14 11.75-7.88c0 0 1.41-3.74-2.47-5.1-3.87-1.36-5.05 1.76-5.05 1.76s1.18-3.12-2.7-4.48c-3.88-1.36-5.29 2.38-5.29 2.38Z\" fill=\"#18181b\"/></g><g transform=\"translate(6 24)\"><path d=\"M15.5 10c-5.07 0-9.3-5.23-8.37-5.88.93-.65 3.45 2.15 8.37 2.15 4.92 0 7.44-2.88 8.37-2.15.93.73-3.3 5.88-8.37 5.88Z\" fill=\"#18181b\"/></g></g></g></g></g></g></g></svg>"},"mock-3":{"seed":"mock-3","name":"Cinder","svg":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\" fill=\"none\" shape-rendering=\"auto\"><metadata xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\"><rdf:RDF><rdf:Description><dc:title>Thumbs</dc:title><dc:creator>DiceBear</dc:creator><dc:source xsi:type=\"dcterms:URI\">https://www.dicebear.com</dc:source><dcterms:license xsi:type=\"dcterms:URI\">https://creativecommons.org/publicdomain/zero/1.0/</dcterms:license><dc:rights>„Thumbs” (https://www.dicebear.com) by „DiceBear”, licensed under „CC0 1.0” (https://creativecommons.org/publicdomain/zero/1.0/)</dc:rights></rdf:Description></rdf:RDF></metadata><mask id=\"k8xhuiq3\"><rect width=\"100\" height=\"100\" rx=\"50\" ry=\"50\" x=\"0\" y=\"0\" fill=\"#fff\" /></mask><g mask=\"url(#k8xhuiq3)\"><rect fill=\"#e6d5c5\" width=\"100\" height=\"100\" x=\"0\" y=\"0\" /><g transform=\"translate(0 8)\"><g transform=\"translate(14.000000000000002 14.000000000000002) scale(0.72)\"><g transform=\"translate(-3, 4) rotate(-6 50 70)\"><path d=\"M95 53.33C95 29.4 74.85 10 50 10S5 29.4 5 53.33V140h90V53.33Z\" fill=\"#c08a5b\"/><g transform=\"translate(29 33)\"><g transform=\"translate(-3, -1) rotate(7 21 21)\"><g transform=\"translate(0 5)\"><path d=\"M.25 8.12C1.66 11.86 12 16 12 16s5.17-9.58 3.76-13.32c0 0-1.41-3.74-5.3-2.38-3.87 1.36-2.7 4.48-2.7 4.48S6.6 1.66 2.73 3.02C-1.16 4.38.25 8.12.25 8.12ZM26.24 2.68C24.84 6.42 30 16 30 16s10.34-4.14 11.75-7.88c0 0 1.41-3.74-2.47-5.1-3.87-1.36-5.05 1.76-5.05 1.76s1.18-3.12-2.7-4.48c-3.88-1.36-5.29 2.38-5.29 2.38Z\" fill=\"#18181b\"/></g><g transform=\"translate(6 23)\"><path d=\"M15.5 10c-5.07 0-9.3-5.23-8.37-5.88.93-.65 3.45 2.15 8.37 2.15 4.92 0 7.44-2.88 8.37-2.15.93.73-3.3 5.88-8.37 5.88Z\" fill=\"#18181b\"/></g></g></g></g></g></g></g></svg>"},"mock-6":{"seed":"mock-6","name":"Meridian","svg":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\" fill=\"none\" shape-rendering=\"auto\"><metadata xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\"><rdf:RDF><rdf:Description><dc:title>Thumbs</dc:title><dc:creator>DiceBear</dc:creator><dc:source xsi:type=\"dcterms:URI\">https://www.dicebear.com</dc:source><dcterms:license xsi:type=\"dcterms:URI\">https://creativecommons.org/publicdomain/zero/1.0/</dcterms:license><dc:rights>„Thumbs” (https://www.dicebear.com) by „DiceBear”, licensed under „CC0 1.0” (https://creativecommons.org/publicdomain/zero/1.0/)</dc:rights></rdf:Description></rdf:RDF></metadata><mask id=\"rxgy8iaa\"><rect width=\"100\" height=\"100\" rx=\"50\" ry=\"50\" x=\"0\" y=\"0\" fill=\"#fff\" /></mask><g mask=\"url(#rxgy8iaa)\"><rect fill=\"#dbccc5\" width=\"100\" height=\"100\" x=\"0\" y=\"0\" /><g transform=\"translate(0 8)\"><g transform=\"translate(14.000000000000002 14.000000000000002) scale(0.72)\"><g transform=\"translate(-4, 5) rotate(-1 50 70)\"><path d=\"M95 53.33C95 29.4 74.85 10 50 10S5 29.4 5 53.33V140h90V53.33Z\" fill=\"#9c6b58\"/><g transform=\"translate(29 33)\"><g transform=\"translate(-11, 8) rotate(-3 21 21)\"><g transform=\"translate(0 5)\"><path d=\"M6 8.36S6 4 10 4s4 4.36 4 4.36v2.91s0 .73-.67.73c-.66 0-.66-2.9-3.33-2.9S7.33 12 6.67 12C6 12 6 11.27 6 11.27v-2.9ZM28 8.36S28 4 32 4s4 4.36 4 4.36v2.91s0 .73-.67.73c-.66 0-.66-2.9-3.33-2.9S29.33 12 28.67 12c-.67 0-.67-.73-.67-.73v-2.9Z\" fill=\"#18181b\"/></g><g transform=\"translate(6 23)\"><path d=\"M15.2 3.84c0-.67-4.2-2-4.2-2.67 0-.66 7 .67 7 2.67S13.8 6.5 13.8 6.5s4.2.67 4.2 2.66c0 2-7 3.33-7 2.67 0-.67 4.2-2 4.2-2.67 0-.66-3.5-1.33-3.5-2.66s3.5-2 3.5-2.66Z\" fill=\"#18181b\"/></g></g></g></g></g></g></g></svg>"},"all-mock-1":{"seed":"all-mock-1","name":"Ember","svg":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\" fill=\"none\" shape-rendering=\"auto\"><metadata xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\"><rdf:RDF><rdf:Description><dc:title>Thumbs</dc:title><dc:creator>DiceBear</dc:creator><dc:source xsi:type=\"dcterms:URI\">https://www.dicebear.com</dc:source><dcterms:license xsi:type=\"dcterms:URI\">https://creativecommons.org/publicdomain/zero/1.0/</dcterms:license><dc:rights>„Thumbs” (https://www.dicebear.com) by „DiceBear”, licensed under „CC0 1.0” (https://creativecommons.org/publicdomain/zero/1.0/)</dc:rights></rdf:Description></rdf:RDF></metadata><mask id=\"worvyvlt\"><rect width=\"100\" height=\"100\" rx=\"50\" ry=\"50\" x=\"0\" y=\"0\" fill=\"#fff\" /></mask><g mask=\"url(#worvyvlt)\"><rect fill=\"#e6d5c5\" width=\"100\" height=\"100\" x=\"0\" y=\"0\" /><g transform=\"translate(0 8)\"><g transform=\"translate(14.000000000000002 14.000000000000002) scale(0.72)\"><g transform=\"translate(-4, -4) rotate(-3 50 70)\"><path d=\"M95 53.33C95 29.4 74.85 10 50 10S5 29.4 5 53.33V140h90V53.33Z\" fill=\"#c08a5b\"/><g transform=\"translate(29 33)\"><g transform=\"translate(13, -15) rotate(-5 21 21)\"><g transform=\"translate(0 2)\"><path d=\"M10.86 7.5c0-1.42-4.14-2.85-4.82-4.98C5.34.4 15 5.37 15 7.5c0 2.13-9.65 7.11-8.96 4.98.68-2.13 4.82-3.56 4.82-4.98ZM31.14 7.5c0-1.42 4.14-2.85 4.82-4.98C36.66.4 27 5.37 27 7.5c0 2.13 9.65 7.11 8.96 4.98-.68-2.13-4.82-3.56-4.82-4.98Z\" fill=\"#18181b\"/></g><g transform=\"translate(6 26)\"><path d=\"M15.2 3.84c0-.67-4.2-2-4.2-2.67 0-.66 7 .67 7 2.67S13.8 6.5 13.8 6.5s4.2.67 4.2 2.66c0 2-7 3.33-7 2.67 0-.67 4.2-2 4.2-2.67 0-.66-3.5-1.33-3.5-2.66s3.5-2 3.5-2.66Z\" fill=\"#18181b\"/></g></g></g></g></g></g></g></svg>"},"all-mock-2":{"seed":"all-mock-2","name":"Relay","svg":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\" fill=\"none\" shape-rendering=\"auto\"><metadata xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\"><rdf:RDF><rdf:Description><dc:title>Thumbs</dc:title><dc:creator>DiceBear</dc:creator><dc:source xsi:type=\"dcterms:URI\">https://www.dicebear.com</dc:source><dcterms:license xsi:type=\"dcterms:URI\">https://creativecommons.org/publicdomain/zero/1.0/</dcterms:license><dc:rights>„Thumbs” (https://www.dicebear.com) by „DiceBear”, licensed under „CC0 1.0” (https://creativecommons.org/publicdomain/zero/1.0/)</dc:rights></rdf:Description></rdf:RDF></metadata><mask id=\"j0zet7ek\"><rect width=\"100\" height=\"100\" rx=\"50\" ry=\"50\" x=\"0\" y=\"0\" fill=\"#fff\" /></mask><g mask=\"url(#j0zet7ek)\"><rect fill=\"#d9d0c2\" width=\"100\" height=\"100\" x=\"0\" y=\"0\" /><g transform=\"translate(0 8)\"><g transform=\"translate(14.000000000000002 14.000000000000002) scale(0.72)\"><g transform=\"translate(1, -2) rotate(-6 50 70)\"><path d=\"M95 53.33C95 29.4 74.85 10 50 10S5 29.4 5 53.33V140h90V53.33Z\" fill=\"#94794f\"/><g transform=\"translate(29 33)\"><g transform=\"translate(5, 3) rotate(7 21 21)\"><g transform=\"translate(0 1)\"><path d=\"M8 8.36S8 4 12 4s4 4.36 4 4.36v2.91s0 .73-.67.73c-.66 0-.66-2.9-3.33-2.9S9.33 12 8.67 12C8 12 8 11.27 8 11.27v-2.9ZM26 8.36S26 4 30 4s4 4.36 4 4.36v2.91s0 .73-.67.73c-.66 0-.66-2.9-3.33-2.9S27.33 12 26.67 12c-.67 0-.67-.73-.67-.73v-2.9Z\" fill=\"#18181b\"/></g><g transform=\"translate(6 27)\"><path d=\"M15 14C1.9 14-.72 1.29.15.23 1.03-.83 6.27 2.11 15 2.11S28.97-.83 29.85.23C30.72 1.3 28.1 14 15 14Z\" fill=\"#18181b\"/></g></g></g></g></g></g></g></svg>"},"all-mock-3":{"seed":"all-mock-3","name":"Chalk","svg":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\" fill=\"none\" shape-rendering=\"auto\"><metadata xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\"><rdf:RDF><rdf:Description><dc:title>Thumbs</dc:title><dc:creator>DiceBear</dc:creator><dc:source xsi:type=\"dcterms:URI\">https://www.dicebear.com</dc:source><dcterms:license xsi:type=\"dcterms:URI\">https://creativecommons.org/publicdomain/zero/1.0/</dcterms:license><dc:rights>„Thumbs” (https://www.dicebear.com) by „DiceBear”, licensed under „CC0 1.0” (https://creativecommons.org/publicdomain/zero/1.0/)</dc:rights></rdf:Description></rdf:RDF></metadata><mask id=\"lp1q4ua0\"><rect width=\"100\" height=\"100\" rx=\"50\" ry=\"50\" x=\"0\" y=\"0\" fill=\"#fff\" /></mask><g mask=\"url(#lp1q4ua0)\"><rect fill=\"#c9d0ce\" width=\"100\" height=\"100\" x=\"0\" y=\"0\" /><g transform=\"translate(0 8)\"><g transform=\"translate(14.000000000000002 14.000000000000002) scale(0.72)\"><g transform=\"translate(-3, 5) rotate(-1 50 70)\"><path d=\"M95 53.33C95 29.4 74.85 10 50 10S5 29.4 5 53.33V140h90V53.33Z\" fill=\"#5f7a76\"/><g transform=\"translate(29 33)\"><g transform=\"translate(-1, -3) rotate(-5 21 21)\"><g transform=\"translate(0 2)\"><path d=\"M9.86 7.5c0-1.42-4.14-2.85-4.82-4.98C4.34.4 14 5.37 14 7.5c0 2.13-9.65 7.11-8.96 4.98.68-2.13 4.82-3.56 4.82-4.98ZM32.14 7.5c0-1.42 4.14-2.85 4.82-4.98C37.66.4 28 5.37 28 7.5c0 2.13 9.65 7.11 8.96 4.98-.68-2.13-4.82-3.56-4.82-4.98Z\" fill=\"#18181b\"/></g><g transform=\"translate(6 26)\"><path d=\"M15 14C1.9 14-.72 1.29.15.23 1.03-.83 6.27 2.11 15 2.11S28.97-.83 29.85.23C30.72 1.3 28.1 14 15 14Z\" fill=\"#18181b\"/></g></g></g></g></g></g></g></svg>"},"all-mock-4":{"seed":"all-mock-4","name":"Orchard","svg":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\" fill=\"none\" shape-rendering=\"auto\"><metadata xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\"><rdf:RDF><rdf:Description><dc:title>Thumbs</dc:title><dc:creator>DiceBear</dc:creator><dc:source xsi:type=\"dcterms:URI\">https://www.dicebear.com</dc:source><dcterms:license xsi:type=\"dcterms:URI\">https://creativecommons.org/publicdomain/zero/1.0/</dcterms:license><dc:rights>„Thumbs” (https://www.dicebear.com) by „DiceBear”, licensed under „CC0 1.0” (https://creativecommons.org/publicdomain/zero/1.0/)</dc:rights></rdf:Description></rdf:RDF></metadata><mask id=\"83gqws5u\"><rect width=\"100\" height=\"100\" rx=\"50\" ry=\"50\" x=\"0\" y=\"0\" fill=\"#fff\" /></mask><g mask=\"url(#83gqws5u)\"><rect fill=\"#dbccc5\" width=\"100\" height=\"100\" x=\"0\" y=\"0\" /><g transform=\"translate(0 8)\"><g transform=\"translate(14.000000000000002 14.000000000000002) scale(0.72)\"><g transform=\"translate(-3, 0) rotate(-1 50 70)\"><path d=\"M95 53.33C95 29.4 74.85 10 50 10S5 29.4 5 53.33V140h90V53.33Z\" fill=\"#9c6b58\"/><g transform=\"translate(29 33)\"><g transform=\"translate(7, 13) rotate(-8 21 21)\"><g transform=\"translate(0 5)\"><path d=\"M14 8c0 2.2-1.34 4-3 4s-3-1.8-3-4 1.34-4 3-4 3 1.8 3 4ZM28.5 5C25.29 5 24 6.36 24 7.04c0 3.4 1.29 1.35 4.5 1.35S33 10.43 33 7.04C33 6.36 31.71 5 28.5 5Z\" fill=\"#18181b\"/></g><g transform=\"translate(6 23)\"><path d=\"M15 11C4.52 11 2.42 2.82 3.12 2.14 3.82 1.46 8.02 3.5 15 3.5c6.99 0 11.18-2.04 11.88-1.36.7.68-1.4 8.86-11.88 8.86Z\" fill=\"#18181b\"/></g></g></g></g></g></g></g></svg>"}}"###;

const KONE: &str = "/review/kone";
const NOVA: &str = "/review/nova";
const ATLAS: &str = "/review/atlas";
const DAY: i64 = 86_400_000;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

#[allow(clippy::too_many_arguments)]
fn row(
    id: &str,
    title: &str,
    provider: &str,
    branch: &str,
    added: i64,
    removed: i64,
    tokens: i64,
    cost: f64,
    updated: i64,
    pinned: bool,
) -> Value {
    let identities: Value = serde_json::from_str(IDENTITIES).expect("valid review identities");
    json!({"identity": identities[id], "threadId": id, "title": title, "provider": provider, "branch": branch,
        "added": added, "removed": removed, "tokens": tokens, "costUsd": cost,
        "updatedAt": updated, "isPinned": pinned})
}

/// Populate either review scene without starting the bridge or touching persistent data.
pub fn populate(s: &mut AppState, page: Page) {
    let now = now_ms();
    s.page = page;
    s.projects = [("kone", KONE)]
        .into_iter()
        .map(|(name, path)| Project {
            name: name.into(),
            path: path.into(),
        })
        .collect();
    s.selected_project = Some(0);
    s.project_data.metadata.clear();
    s.project_data.summaries.clear();
    for (index, path) in [KONE, NOVA, ATLAS].into_iter().enumerate() {
        s.project_data.summaries.insert(path.into(), Value::Null);
        s.project_data.metadata.insert(
            path.into(),
            ProjectMeta {
                pinned: false,
                last_opened_at: now - index as i64 * DAY,
            },
        );
    }
    s.project_data.overview = json!({"workingTree": null});
    s.project_data.sessions = parse_sessions(
        &json!([
            row(
                "mock-1",
                "Wire up the Droid bridge protocol",
                "claudeAgent",
                "main",
                410,
                88,
                3_200_000,
                15.36,
                now - 7 * DAY,
                true
            ),
            row(
                "mock-2",
                "Design system tokens + main.css",
                "codex",
                "main",
                256,
                40,
                1_900_000,
                6.65,
                now - 7 * DAY,
                true
            ),
            row(
                "mock-6",
                "Wire the droid ACP turn params",
                "droid",
                "droid-bridge",
                118,
                31,
                740_000,
                2.59,
                now - DAY * 6 / 10,
                false
            ),
            row(
                "mock-3",
                "Fix structuredClone crash on re-open",
                "claudeAgent",
                "calm-agent-ui",
                128,
                34,
                1_240_000,
                5.95,
                now - 2 * DAY,
                false
            )
        ]),
        KONE,
    );
    s.project_data.home_sessions = parse_sessions(
        &json!([
            row(
                "all-mock-1",
                "Wire up the Droid bridge protocol",
                "claudeAgent",
                "main",
                410,
                88,
                3_200_000,
                15.36,
                now - DAY / 5,
                true
            ),
            row(
                "all-mock-3",
                "Fix structuredClone crash on re-open",
                "claudeAgent",
                "calm-agent-ui",
                128,
                34,
                1_240_000,
                5.95,
                now - 2 * DAY,
                false
            )
        ]),
        KONE,
    );
    s.project_data.home_sessions.extend(parse_sessions(
        &json!([row(
            "all-mock-2",
            "Token-usage parsing fix",
            "codex",
            "dev",
            76,
            22,
            620_000,
            2.17,
            now - DAY * 9 / 10,
            false
        )]),
        NOVA,
    ));
    s.project_data.home_sessions.extend(parse_sessions(
        &json!([row(
            "all-mock-4",
            "Model catalog real-shape pass",
            "codex",
            "main",
            342,
            96,
            2_100_000,
            7.35,
            now - 3 * DAY,
            false
        )]),
        ATLAS,
    ));
    s.project_data.home_sessions.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then_with(|| b.updated_at.cmp(&a.updated_at))
    });
}

/// Deterministic greeting states for visual review.
pub fn overview_greeting(s: &mut AppState, variant: &str) {
    populate(s, Page::Overview);
    let changes = match variant {
        "cards" => json!([
            {"path":"src/main.rs", "added":42, "removed":12, "staged":true},
            {"path":"README.md", "added":8, "removed":3, "modifiedAt":6, "staged":false},
            {"path":"app.ts", "added":12, "removed":0, "modifiedAt":5, "status":"added", "staged":false},
            {"path":"empty.css", "added":0, "removed":0, "modifiedAt":4, "status":"untracked", "staged":false},
            {"path":"old.js", "added":0, "removed":9, "modifiedAt":3, "status":"deleted", "staged":false},
            {"path":"other.md", "added":4, "removed":1, "modifiedAt":2, "staged":false},
            {"path":"last.json", "added":2, "removed":0, "modifiedAt":1, "staged":false}
        ]),
        "dirty" | "fresh-dirty" => json!([
            {"path":"src/main.rs", "added":42, "removed":12, "staged":true},
            {"path":"README.md", "added":8, "removed":3, "staged":false}
        ]),
        "fresh-unstaged" => json!([{ "path":"README.md", "staged":false }]),
        "staged" => json!([{"path":"README.md", "added":3, "removed":0, "staged":true}]),
        "dirty-no-stat" => json!([{"path":"image.png", "staged":false}]),
        _ => json!([]),
    };
    s.project_data.overview = match variant {
        "loading" => Value::Null,
        "nonrepo" => json!({"workingTree":null, "repository":null}),
        _ => json!({"repository":{}, "workingTree":{
            "head": if variant.starts_with("fresh") { Value::Null } else { json!("abc123") },
            "branch":"main", "changes":changes,
            "ahead": if variant == "ahead" || variant == "diverged" { 2 } else { 0 },
            "behind": if variant == "behind" || variant == "diverged" { 1 } else { 0 }
        }}),
    };
}

/// Deterministic away-thread examples for parity captures.
pub fn overview_pills(s: &mut AppState) {
    populate(s, Page::Overview);
    s.studio.thread_id = "running".into();
    s.studio.turn_title = "Build the overview".into();
    s.studio.turn_started = Some(std::time::SystemTime::now() - std::time::Duration::from_secs(72));
    s.studio.busy = true;
    let settled = crate::state::StudioState {
        thread_id: "settled".into(),
        turn_title: "Review the changes".into(),
        turn_started: Some(std::time::SystemTime::now() - std::time::Duration::from_secs(120)),
        ..Default::default()
    };
    s.studio_threads.insert("settled".into(), settled);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scenes_are_populated_and_isolated() {
        for page in [Page::Projects, Page::Overview] {
            let mut s = AppState::default();
            populate(&mut s, page);
            assert_eq!(s.page, page);
            assert!(s.bridge.is_none());
            assert_eq!(s.projects.len(), 1);
            assert_eq!(s.project_data.home_sessions.len(), 4);
            assert_eq!(s.project_data.sessions.len(), 4);
            assert!(s.project_data.home_sessions[0].pinned);
            assert!(
                s.project_data
                    .sessions
                    .iter()
                    .all(|session| session.project_path == KONE)
            );
        }
    }
}
