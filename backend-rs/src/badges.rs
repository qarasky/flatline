//! Shields-style SVG badges (`badge-maker` shapes).
//!
//! `badge-maker` is a Node package, so the flat and flat-square templates
//! are rendered here; other styles fall back to flat. Text width is
//! approximated for Verdana 11px — what matters is exact: the label, the
//! message and the colour.

use serde_json::Value;
use sqlx::SqlitePool;

/// One badge to render.
pub struct Badge<'a> {
    pub label: &'a str,
    pub message: &'a str,
    pub color: &'a str,
    pub label_color: &'a str,
    pub style: &'a str,
}

const LABEL_BG: &str = "#555";
const NA_COLOR: &str = "#999";

/// Render a flat-style badge (flat-square drops the gradient and radius).
/// An empty label renders a single-segment badge, like badge-maker.
pub fn render(badge: &Badge) -> String {
    let label = xml_escape(badge.label);
    let message = xml_escape(badge.message);
    let label_color = if badge.label_color.is_empty() {
        LABEL_BG
    } else {
        badge.label_color
    };
    let color = if badge.color.is_empty() {
        NA_COLOR
    } else {
        badge.color
    };
    let flat_square = badge.style == "flat-square";

    let label_width = if badge.label.is_empty() {
        0
    } else {
        text_width(badge.label) + 10
    };
    let message_width = text_width(badge.message) + 10;
    let total = label_width + message_width;
    let aria = if badge.label.is_empty() {
        badge.message.to_string()
    } else {
        format!("{}: {}", badge.label, badge.message)
    };
    let aria = xml_escape(&aria);

    let (clip, gradient) = if flat_square {
        (String::new(), String::new())
    } else {
        (
            format!("<clipPath id=\"r\"><rect width=\"{total}\" height=\"20\" rx=\"3\" fill=\"#fff\"/></clipPath>"),
            "<linearGradient id=\"s\" x2=\"0\" y2=\"100%\"><stop offset=\"0\" stop-color=\"#bbb\" stop-opacity=\".1\"/><stop offset=\"1\" stop-opacity=\".1\"/></linearGradient>".to_string(),
        )
    };
    let clip_open = if flat_square {
        ""
    } else {
        "<g clip-path=\"url(#r)\">"
    };
    let clip_close = if flat_square { "" } else { "</g>" };
    let overlay = if flat_square {
        String::new()
    } else {
        format!("<rect width=\"{total}\" height=\"20\" fill=\"url(#s)\"/>")
    };

    let label_segment = if label_width > 0 {
        let text_x = (label_width as f64 / 2.0 * 10.0) as i64;
        let text_length = ((label_width - 10) * 10).max(0);
        format!(
            "<rect width=\"{label_width}\" height=\"20\" fill=\"{label_color}\"/>\
<text aria-hidden=\"true\" x=\"{text_x}\" y=\"150\" fill=\"#010101\" fill-opacity=\".3\" transform=\"scale(.1)\" textLength=\"{text_length}\">{label}</text>\
<text x=\"{text_x}\" y=\"140\" transform=\"scale(.1)\" fill=\"#fff\" textLength=\"{text_length}\">{label}</text>"
        )
    } else {
        String::new()
    };

    let message_text_x = ((label_width as f64 + message_width as f64 / 2.0) * 10.0) as i64;
    let message_text_length = ((message_width - 10) * 10).max(0);

    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"{total}\" height=\"20\" role=\"img\" aria-label=\"{aria}\">\
<title>{aria}</title>\
{gradient}\
{clip}\
{clip_open}\
{label_segment}\
<rect x=\"{label_width}\" width=\"{message_width}\" height=\"20\" fill=\"{color}\"/>\
{overlay}\
{clip_close}\
<g fill=\"#fff\" text-anchor=\"middle\" font-family=\"Verdana,Geneva,DejaVu Sans,sans-serif\" text-rendering=\"geometricPrecision\" font-size=\"110\">\
<text aria-hidden=\"true\" x=\"{message_text_x}\" y=\"150\" fill=\"#010101\" fill-opacity=\".3\" transform=\"scale(.1)\" textLength=\"{message_text_length}\">{message}</text>\
<text x=\"{message_text_x}\" y=\"140\" transform=\"scale(.1)\" fill=\"#fff\" textLength=\"{message_text_length}\">{message}</text>\
</g>\
</svg>"
    )
}

/// Rough Verdana 11px width, close enough for badge geometry.
fn text_width(text: &str) -> i64 {
    text.chars()
        .map(|c| match c {
            'i' | 'l' | 'j' | 't' | 'f' | 'r' | 'I' | '1' | '.' | ',' | ':' | ';' | ' ' => 4,
            'm' | 'M' | 'W' | 'w' => 10,
            'A'..='Z' => 8,
            _ => 7,
        })
        .sum::<i64>()
        + 1
}

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// Uptime percentage to colour, the Node `percentageToColor`: hue from 10
/// (red) to 90 (green) at 90% saturation, 40% lightness.
pub fn percentage_to_color(percentage: f64) -> String {
    let hue = percentage.clamp(0.0, 1.0) * (90.0 - 10.0) + 10.0;
    hsl_to_hex(hue, 0.90, 0.40)
}

/// HSL (degrees, 0..1, 0..1) to `#rrggbb`.
fn hsl_to_hex(hue: f64, saturation: f64, lightness: f64) -> String {
    let c = (1.0 - (2.0 * lightness - 1.0).abs()) * saturation;
    let h = hue / 60.0;
    let x = c * (1.0 - (h % 2.0 - 1.0).abs());
    let (r, g, b) = match h as i32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = lightness - c / 2.0;
    let channel = |value: f64| ((value + m) * 255.0).round().clamp(0.0, 255.0) as u8;
    format!("#{:02x}{:02x}{:02x}", channel(r), channel(g), channel(b))
}

/// Parse a badge duration (`24`, `24h`, `30d`, `1w`, `1M`, `1y`) into
/// seconds. Digits alone mean hours, like the Node routes.
pub fn duration_seconds(duration: &str) -> Option<i64> {
    let raw = duration.trim();
    if raw.is_empty() {
        return None;
    }
    let (number, unit) = if raw.chars().all(|c| c.is_ascii_digit()) {
        (raw, "h")
    } else {
        raw.split_at(raw.len() - 1)
    };
    let number: i64 = number.parse().ok()?;
    let seconds = match unit {
        "m" => number * 60,
        "h" => number * 3600,
        "d" => number * 86_400,
        "w" => number * 7 * 86_400,
        "M" => number * 30 * 86_400,
        "y" => number * 365 * 86_400,
        _ => return None,
    };
    Some(seconds)
}

/// `(value * 100).toPrecision(4)` — four significant digits, like the Node
/// uptime badge.
pub fn to_precision4(value: f64) -> String {
    if value == 0.0 {
        return "0.000".to_string();
    }
    let magnitude = value.abs().log10().floor() as i32;
    let decimals = (3 - magnitude).max(0) as usize;
    format!("{value:.decimals$}")
}

/// `filterAndJoin(parts, "")` — drop empty parts.
pub fn join_parts(parts: &[String]) -> String {
    parts
        .iter()
        .filter(|part| !part.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join("")
}

/// Whether the monitor appears in any public status-page group. Badges for
/// non-public monitors answer "N/A", like the Node routes.
pub async fn is_monitor_public(pool: &SqlitePool, monitor_id: i64) -> bool {
    let found: Option<i64> = sqlx::query_scalar(
        "SELECT spm.monitor_id FROM status_page_monitors spm
         JOIN status_page_groups g ON g.id = spm.group_id
         WHERE spm.monitor_id = ? AND g.public = 1 LIMIT 1",
    )
    .bind(monitor_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    found.is_some()
}

/// Average non-null ping over a window, for the ping-style badges.
pub async fn average_ping(pool: &SqlitePool, monitor_id: i64, seconds: i64) -> Option<f64> {
    let cutoff =
        crate::metrics::sql_time_millis(chrono::Utc::now().timestamp_millis() - seconds * 1000);
    sqlx::query_scalar(
        "SELECT AVG(ping) FROM heartbeats
         WHERE monitor_id = ? AND time >= ? AND ping IS NOT NULL",
    )
    .bind(monitor_id)
    .bind(cutoff)
    .fetch_one(pool)
    .await
    .ok()
    .flatten()
}

/// Query parameters shared by every badge route.
pub fn query_string<'a>(
    params: &'a std::collections::HashMap<String, String>,
    key: &str,
) -> &'a str {
    params.get(key).map(String::as_str).unwrap_or("")
}

/// A parameter, with the Node default when absent.
pub fn query_or<'a>(
    params: &'a std::collections::HashMap<String, String>,
    key: &str,
    default: &'a str,
) -> &'a str {
    match params.get(key) {
        Some(value) => value,
        None => default,
    }
}

/// The `value` override, when numeric.
pub fn query_number(params: &std::collections::HashMap<String, String>, key: &str) -> Option<f64> {
    params.get(key).and_then(|value| value.parse::<f64>().ok())
}

/// A badge query parameter that may be absent or empty (`labelColor`).
pub fn json_string(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_a_flat_badge_with_exact_text() {
        let svg = render(&Badge {
            label: "Uptime (24h)",
            message: "99.99%",
            color: "#4c1",
            label_color: "",
            style: "flat",
        });
        assert!(svg.starts_with("<svg "));
        assert!(svg.contains("aria-label=\"Uptime (24h): 99.99%\""));
        assert!(svg.contains("fill=\"#4c1\""));
        assert!(svg.contains("fill=\"#555\""));
        assert!(svg.contains(">99.99%</text>"));
        assert!(svg.contains("url(#s)"));
    }

    #[test]
    fn flat_square_drops_the_gradient() {
        let svg = render(&Badge {
            label: "a",
            message: "b",
            color: "blue",
            label_color: "red",
            style: "flat-square",
        });
        assert!(!svg.contains("linearGradient"));
        assert!(svg.contains("fill=\"red\""));
        assert!(svg.contains("fill=\"blue\""));
    }

    #[test]
    fn escapes_xml() {
        let svg = render(&Badge {
            label: "<x>",
            message: "a & b",
            color: "#999",
            label_color: "",
            style: "flat",
        });
        assert!(svg.contains("&lt;x&gt;"));
        assert!(svg.contains("a &amp; b"));
    }

    #[test]
    fn percentage_colour_matches_the_hue_ramp() {
        // 0% is red-ish (hue 10), 100% is green-ish (hue 90).
        let low = percentage_to_color(0.0);
        let high = percentage_to_color(1.0);
        assert!(low.starts_with('#') && low.len() == 7);
        assert!(high.starts_with('#') && high.len() == 7);
        assert_ne!(low, high);
        // Node: percentageToColor(0.5) → chroma(hsl(50, 90%, 40%)) = #c2a30a
        assert_eq!(percentage_to_color(0.5), "#c2a30a");
        assert_eq!(percentage_to_color(0.0), "#c2290a");
        assert_eq!(percentage_to_color(1.0), "#66c20a");
    }

    #[test]
    fn durations_follow_the_node_rules() {
        assert_eq!(duration_seconds("24"), Some(24 * 3600));
        assert_eq!(duration_seconds("24h"), Some(24 * 3600));
        assert_eq!(duration_seconds("30d"), Some(30 * 86_400));
        assert_eq!(duration_seconds("1w"), Some(7 * 86_400));
        assert_eq!(duration_seconds("2M"), Some(60 * 86_400));
        assert_eq!(duration_seconds(""), None);
        assert_eq!(duration_seconds("24x"), None);
    }

    #[test]
    fn precision_matches_js_toprecision() {
        assert_eq!(to_precision4(100.0), "100.0");
        assert_eq!(to_precision4(99.98765), "99.99");
        assert_eq!(to_precision4(5.0), "5.000");
        assert_eq!(to_precision4(0.5), "0.5000");
        assert_eq!(to_precision4(0.0), "0.000");
    }
}
