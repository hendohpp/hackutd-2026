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

    let actions = validate(&parsed["actions"]);
    println!("{}", json!({ "actions": actions }));

    // Also save a three.js scene file for previewing the build. It uses the same shapes as
    // client/src/multiplayer.js, so it looks like what the shared editor will show.
    // (The multiplayer editor has import turned off, so this is for previews only.)
    let scene_path = concat!(env!("CARGO_MANIFEST_DIR"), "/scene.json");
    match std::fs::write(scene_path, to_threejs(user_prompt, &actions).to_string()) {
        Ok(()) => eprintln!("Saved ai-proto/scene.json (preview)."),
        Err(e) => eprintln!("Could not save {scene_path}: {e}"),
    }
}

// Converts one action (sizes in meters) into the position / rotation / scale an `object` row needs.
// The client (multiplayer.js KINDS) builds: box 1x1x1, sphere radius 1, cylinder radius 1 height 1,
// plane 1x1 standing upright. So spheres and cylinders get half scale across, and planes are laid flat.
// server/src/ai.rs will do exactly this when it inserts rows.
fn to_row(a: &Value) -> ([f64; 3], [f64; 3], [f64; 3]) {
    let f = |k: &str| a[k].as_f64().unwrap_or(0.0);
    let (sx, sy, sz) = (f("sx"), f("sy"), f("sz"));
    let position = [f("px"), f("py"), f("pz")];
    match a["kind"].as_str().unwrap_or("box") {
        "sphere" => (position, [0.0; 3], [sx / 2.0, sy / 2.0, sz / 2.0]),
        "cylinder" => (position, [0.0; 3], [sx / 2.0, sy, sz / 2.0]),
        "plane" => (position, [-std::f64::consts::FRAC_PI_2, 0.0, 0.0], [sx, sz, 1.0]),
        _ => (position, [0.0; 3], [sx, sy, sz]),
    }
}

// Turns the actions into a three.js "Object" JSON file, using to_row and the client's shapes.
// Two lights are included so the colors show up.
fn to_threejs(prompt: &str, actions: &[Value]) -> Value {
    let id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let uuid = |name: &str| format!("ai-{id}-{name}");

    let geometries = json!([
        { "uuid": uuid("box"), "type": "BoxGeometry", "width": 1, "height": 1, "depth": 1 },
        { "uuid": uuid("sphere"), "type": "SphereGeometry", "radius": 1, "widthSegments": 32, "heightSegments": 16 },
        { "uuid": uuid("cylinder"), "type": "CylinderGeometry", "radiusTop": 1, "radiusBottom": 1, "height": 1, "radialSegments": 32 },
        { "uuid": uuid("plane"), "type": "PlaneGeometry", "width": 1, "height": 1 },
    ]);

    let mut materials = Vec::new();
    let mut children = vec![
        json!({ "uuid": uuid("sky"), "type": "HemisphereLight", "name": "AI light (sky)",
                "color": 0xffffff, "groundColor": 0x444444, "intensity": 2, "position": [0, 10, 0] }),
        json!({ "uuid": uuid("sun"), "type": "DirectionalLight", "name": "AI light (sun)",
                "color": 0xffffff, "intensity": 2, "position": [5, 10, 7.5] }),
    ];

    for (i, a) in actions.iter().enumerate() {
        let kind = a["kind"].as_str().unwrap_or("box");
        let hex = a["color"].as_str().unwrap_or(DEFAULT_COLOR);
        let color = u32::from_str_radix(&hex[1..], 16).unwrap_or(0x888888);
        let (position, rotation, scale) = to_row(a);

        let material = uuid(&format!("mat{i}"));
        materials.push(json!({ "uuid": material, "type": "MeshStandardMaterial", "color": color, "side": 2 }));
        children.push(json!({
            "uuid": uuid(&format!("obj{i}")),
            "type": "Mesh",
            "name": format!("{kind} {}", i + 1),
            "geometry": uuid(kind),
            "material": material,
            "position": position,
            "rotation": rotation,
            "scale": scale,
        }));
    }

    json!({
        "metadata": { "version": 4.6, "type": "Object", "generator": "ai-proto" },
        "geometries": geometries,
        "materials": materials,
        "object": { "uuid": uuid("group"), "type": "Group", "name": format!("AI: {prompt}"), "children": children },
    })
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
