// Standalone Gemini test for the AI teammate. Not used by the app.
//
//   cargo run --manifest-path ai-proto/Cargo.toml -- "build a campfire"
//
// Reads GEMINI_API_KEY (and optional GEMINI_MODEL) from ai-proto/.env (git-ignored).
// Uses the Gemini Interactions API with a JSON schema (structured output).

use serde_json::{json, Value};
use std::time::Duration;

const URL: &str = "https://generativelanguage.googleapis.com/v1beta/interactions";
const DEFAULT_MODEL: &str = "gemini-3.5-flash-lite"; // fast (~3s); override in .env
const KINDS: [&str; 4] = ["box", "sphere", "cylinder", "plane"];
const MAX_OBJECTS: usize = 20;
const MAX_POS: f64 = 5.0;
const MIN_SIZE: f64 = 0.1;
const MAX_SIZE: f64 = 10.0;
const DEFAULT_COLOR: &str = "#888888";

fn main() {
    load_env_file(concat!(env!("CARGO_MANIFEST_DIR"), "/.env"));

    let user_prompt = std::env::args().skip(1).collect::<Vec<_>>().join(" ");
    let user_prompt = user_prompt.trim();
    if user_prompt.is_empty() {
        fail("usage: cargo run --manifest-path ai-proto/Cargo.toml -- \"build a campfire\"");
    }
    let key = std::env::var("GEMINI_API_KEY").unwrap_or_default();
    if key.trim().is_empty() {
        fail("GEMINI_API_KEY is missing. Put it in ai-proto/.env (see ai-proto/.env.example).");
    }
    let model = std::env::var("GEMINI_MODEL")
        .ok()
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());

    // The schema Gemini must follow. We still re-check everything below,
    // because the model's output is untrusted.
    let num = |min: f64, max: f64| json!({ "type": "number", "minimum": min, "maximum": max });
    let schema = json!({
        "type": "object",
        "properties": {
            "actions": {
                "type": "array",
                "maxItems": MAX_OBJECTS,
                "items": {
                    "type": "object",
                    "properties": {
                        "kind": { "type": "string", "enum": KINDS },
                        "color": { "type": "string", "description": "hex color like #ff8800" },
                        "px": num(-MAX_POS, MAX_POS),
                        "py": num(-MAX_POS, MAX_POS),
                        "pz": num(-MAX_POS, MAX_POS),
                        "sx": num(MIN_SIZE, MAX_SIZE),
                        "sy": num(MIN_SIZE, MAX_SIZE),
                        "sz": num(MIN_SIZE, MAX_SIZE),
                    },
                    "required": ["kind", "color", "px", "py", "pz", "sx", "sy", "sz"],
                },
            },
        },
        "required": ["actions"],
    });

    let instructions = format!(
        "You are an AI teammate in a shared 3D editor. Build this using simple shapes: \"{user_prompt}\"
Rules:
- Y is up. The ground is y = 0. Units are meters.
- Each object has a kind (box, sphere, cylinder, plane), a color (#rrggbb), a center position (px, py, pz) and a size (sx, sy, sz).
- Size 1 means a 1 meter shape. Rest objects on the ground: a box 1 m tall has py = 0.5.
- A plane is a flat horizontal surface lying on the ground.
- Keep every position between -{MAX_POS} and {MAX_POS}. Use at most {MAX_OBJECTS} objects."
    );

    let body = json!({
        "model": model,
        "input": instructions,
        "response_format": { "type": "text", "mime_type": "application/json", "schema": schema },
    });

    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(60))
        .build();
    let result = agent
        .post(URL)
        .set("x-goog-api-key", key.trim())
        .set("Content-Type", "application/json")
        .set("Api-Revision", "2026-05-20")
        .send_string(&body.to_string());

    let raw = match result {
        Ok(resp) => resp
            .into_string()
            .unwrap_or_else(|e| fail(&format!("Could not read Gemini's response: {e}"))),
        Err(ureq::Error::Status(code, resp)) => fail(&format!(
            "Gemini returned HTTP {code}:\n{}",
            resp.into_string().unwrap_or_default()
        )),
        Err(ureq::Error::Transport(err)) => fail(&format!(
            "Could not reach Gemini ({model}): {err}\nIf it timed out after 60s, the model may be overloaded: try again, or set GEMINI_MODEL in ai-proto/.env."
        )),
    };

    let data: Value = serde_json::from_str(&raw)
        .unwrap_or_else(|_| fail(&format!("Gemini's response was not JSON:\n{raw}")));
    let text = get_text(&data)
        .unwrap_or_else(|| fail(&format!("Could not find the JSON text in Gemini's response:\n{raw}")));
    let parsed: Value = serde_json::from_str(&text)
        .unwrap_or_else(|_| fail(&format!("Gemini's text was not valid JSON:\n{text}")));

    println!("{}", json!({ "actions": validate(&parsed["actions"]) }));
}

// The model's text lives in steps[] -> { type: "model_output", content: [ { type: "text", text } ] }.
// (Other steps, like type "thought", are skipped.)
fn get_text(data: &Value) -> Option<String> {
    for step in data["steps"].as_array()? {
        if step["type"] != "model_output" {
            continue;
        }
        for part in step["content"].as_array().into_iter().flatten() {
            if part["type"] == "text" {
                if let Some(text) = part["text"].as_str() {
                    return Some(text.to_string());
                }
            }
        }
    }
    None
}

// Keep only allowed kinds, fix bad colors, clamp every number, cap the count.
fn validate(actions: &Value) -> Vec<Value> {
    let Some(list) = actions.as_array() else {
        return Vec::new();
    };
    list.iter()
        .filter(|a| a["kind"].as_str().is_some_and(|k| KINDS.contains(&k)))
        .take(MAX_OBJECTS)
        .map(|a| {
            json!({
                "kind": a["kind"],
                "color": color(&a["color"]),
                "px": clamp(&a["px"], -MAX_POS, MAX_POS),
                "py": clamp(&a["py"], -MAX_POS, MAX_POS),
                "pz": clamp(&a["pz"], -MAX_POS, MAX_POS),
                "sx": clamp(&a["sx"], MIN_SIZE, MAX_SIZE),
                "sy": clamp(&a["sy"], MIN_SIZE, MAX_SIZE),
                "sz": clamp(&a["sz"], MIN_SIZE, MAX_SIZE),
            })
        })
        .collect()
}

// Missing or non-number values become 0 before clamping.
fn clamp(v: &Value, min: f64, max: f64) -> f64 {
    v.as_f64().filter(|x| x.is_finite()).unwrap_or(0.0).clamp(min, max)
}

// Same "#rrggbb" rule as the server's validate_color.
fn color(v: &Value) -> String {
    let c = v.as_str().unwrap_or("").to_lowercase();
    let valid = c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|ch| ch.is_ascii_hexdigit());
    if valid {
        c
    } else {
        DEFAULT_COLOR.to_string()
    }
}

// Minimal .env reader: KEY=value lines, '#' comments. Shell variables win.
fn load_env_file(path: &str) {
    let Ok(contents) = std::fs::read_to_string(path) else {
        return; // no .env file: fall back to the shell environment
    };
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            if std::env::var(k.trim()).is_err() {
                std::env::set_var(k.trim(), v.trim());
            }
        }
    }
}

fn fail(message: &str) -> ! {
    eprintln!("{message}");
    std::process::exit(1);
}
