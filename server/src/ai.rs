// AI TEAMMATE (all server AI code lives in this file)
//
// - ai_config: private table holding the Gemini API key (clients can't read it).
// - set_ai_key: stores the key. The first identity to set it is the only one that can change it.
// - ask_ai(scene_id, prompt): asks Gemini for simple shapes and inserts them into the existing
//   `object` table in one transaction, so everyone sees them through the normal subscription.
//
// The Gemini request and checks are the same as ai-proto/src/main.rs.

use serde_json::{json, Value};
use spacetimedb::http::{Request, Timeout};
use spacetimedb::{Identity, ProcedureContext, ReducerContext, Table, TimeDuration};

use crate::math::Vec3;
use crate::tables::{object, scene_member, Object};

const GEMINI_URL: &str = "https://generativelanguage.googleapis.com/v1beta/interactions";
const MODEL: &str = "gemini-3.5-flash-lite"; // fast (~3s)
const KINDS: [&str; 4] = ["box", "sphere", "cylinder", "plane"];
const MAX_OBJECTS: usize = 20;
const MAX_POS: f64 = 5.0;
const MIN_SIZE: f64 = 0.1;
const MAX_SIZE: f64 = 10.0;
const DEFAULT_COLOR: &str = "#888888";
const MAX_PROMPT_CHARS: usize = 300;

#[spacetimedb::table(accessor = ai_config)]
pub struct AiConfig {
    #[primary_key]
    pub id: u32, // always 0: there is one row
    pub api_key: String,
    pub owner: Identity, // who first set the key; only they can change it
}

#[spacetimedb::reducer]
pub fn set_ai_key(ctx: &ReducerContext, api_key: String) -> Result<(), String> {
    let api_key = api_key.trim().to_string();
    if api_key.is_empty() {
        return Err("the API key is empty".to_string());
    }
    match ctx.db.ai_config().id().find(0) {
        Some(cfg) if cfg.owner != ctx.sender() => {
            Err("only the identity that first set the AI key can change it".to_string())
        }
        Some(mut cfg) => {
            cfg.api_key = api_key;
            ctx.db.ai_config().id().update(cfg);
            Ok(())
        }
        None => {
            ctx.db.ai_config().insert(AiConfig { id: 0, api_key, owner: ctx.sender() });
            Ok(())
        }
    }
}

/// One validated shape, already converted to what an `object` row needs.
struct Shape {
    kind: String,
    color: String,
    position: Vec3,
    rotation: Vec3,
    scale: Vec3,
}

/// Returns how many objects were added.
#[spacetimedb::procedure]
pub fn ask_ai(ctx: &mut ProcedureContext, scene_id: u64, prompt: String) -> Result<u32, String> {
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("type something for the AI to build".to_string());
    }
    if prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err(format!("keep the prompt under {MAX_PROMPT_CHARS} characters"));
    }

    // 1. Short transaction: check the caller is in the scene and read the key.
    let sender = ctx.sender();
    let key = ctx.try_with_tx(|tx| {
        let member = tx
            .db
            .scene_member()
            .scene_id()
            .filter(scene_id)
            .any(|m| m.identity == sender);
        if !member {
            return Err("not a member of this scene".to_string());
        }
        tx.db
            .ai_config()
            .id()
            .find(0)
            .map(|cfg| cfg.api_key)
            .ok_or_else(|| "the AI key is not set yet (call set_ai_key)".to_string())
    })?;

    // 2. Call Gemini outside any transaction (procedures can't make HTTP calls inside one).
    let shapes = call_gemini(ctx, &key, &prompt)?;

    // 3. One transaction: insert every shape into the existing object table.
    ctx.with_tx(|tx| {
        for s in &shapes {
            tx.db.object().insert(Object {
                id: 0,
                scene_id,
                kind: s.kind.clone(),
                color: s.color.clone(),
                position: s.position,
                rotation: s.rotation,
                scale: s.scale,
                locked_by: None,
                lock_expires_at: None,
                lock_seq: 0,
            });
        }
    });

    spacetimedb::log::info!("ask_ai: added {} objects to scene {scene_id} for {prompt:?}", shapes.len());
    Ok(shapes.len() as u32)
}

fn call_gemini(ctx: &mut ProcedureContext, key: &str, prompt: &str) -> Result<Vec<Shape>, String> {
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
        "You are an AI teammate in a shared 3D editor. Build this using simple shapes: \"{prompt}\"
Rules:
- Y is up. The ground is y = 0. Units are meters.
- Each object has a kind (box, sphere, cylinder, plane), a color (#rrggbb), a center position (px, py, pz) and a size (sx, sy, sz).
- Size 1 means a 1 meter shape. Rest objects on the ground: a box 1 m tall has py = 0.5.
- A plane is a flat horizontal surface lying on the ground.
- Keep every position between -{MAX_POS} and {MAX_POS}. Use at most {MAX_OBJECTS} objects."
    );

    let body = json!({
        "model": MODEL,
        "input": instructions,
        "response_format": { "type": "text", "mime_type": "application/json", "schema": schema },
    });

    let request = Request::builder()
        .uri(GEMINI_URL)
        .method("POST")
        .header("x-goog-api-key", key)
        .header("Content-Type", "application/json")
        .header("Api-Revision", "2026-05-20")
        .extension(Timeout::from(TimeDuration::from(std::time::Duration::from_secs(60))))
        .body(body.to_string())
        .map_err(|_| "could not build the Gemini request".to_string())?;

    let response = ctx
        .http
        .send(request)
        .map_err(|e| format!("could not reach Gemini: {e}"))?;
    let (parts, body) = response.into_parts();
    let raw = body.into_string_lossy();
    if !parts.status.is_success() {
        return Err(format!("Gemini returned HTTP {}: {}", parts.status.as_u16(), short(&raw)));
    }

    let data: Value = serde_json::from_str(&raw).map_err(|_| "Gemini's response was not JSON".to_string())?;
    let text = get_text(&data).ok_or_else(|| "could not find the JSON text in Gemini's response".to_string())?;
    let parsed: Value = serde_json::from_str(&text).map_err(|_| "Gemini's text was not valid JSON".to_string())?;
    Ok(validate(&parsed["actions"]))
}

// The model's text lives in steps[] -> { type: "model_output", content: [ { type: "text", text } ] }.
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

// Keep only allowed kinds, fix bad colors, clamp every number, cap the count,
// then convert sizes (meters) into the row's rotation and scale.
fn validate(actions: &Value) -> Vec<Shape> {
    let Some(list) = actions.as_array() else {
        return Vec::new();
    };
    list.iter()
        .filter(|a| a["kind"].as_str().is_some_and(|k| KINDS.contains(&k)))
        .take(MAX_OBJECTS)
        .map(|a| {
            let kind = a["kind"].as_str().unwrap_or("box");
            let p = |k: &str| clamp(&a[k], -MAX_POS, MAX_POS);
            let s = |k: &str| clamp(&a[k], MIN_SIZE, MAX_SIZE);
            let (rotation, scale) = to_rotation_scale(kind, s("sx"), s("sy"), s("sz"));
            Shape {
                kind: kind.to_string(),
                color: color(&a["color"]),
                position: vec3(p("px"), p("py"), p("pz")),
                rotation,
                scale,
            }
        })
        .collect()
}

// The client (client/src/multiplayer.js KINDS) builds: box 1x1x1, sphere radius 1,
// cylinder radius 1 height 1, plane 1x1 standing upright. So spheres and cylinders get
// half scale across, and planes are rotated to lie flat. Same as to_row in ai-proto.
fn to_rotation_scale(kind: &str, sx: f64, sy: f64, sz: f64) -> (Vec3, Vec3) {
    match kind {
        "sphere" => (vec3(0.0, 0.0, 0.0), vec3(sx / 2.0, sy / 2.0, sz / 2.0)),
        "cylinder" => (vec3(0.0, 0.0, 0.0), vec3(sx / 2.0, sy, sz / 2.0)),
        "plane" => (vec3(-std::f64::consts::FRAC_PI_2, 0.0, 0.0), vec3(sx, sz, 1.0)),
        _ => (vec3(0.0, 0.0, 0.0), vec3(sx, sy, sz)),
    }
}

fn vec3(x: f64, y: f64, z: f64) -> Vec3 {
    Vec3 { x: x as f32, y: y as f32, z: z as f32 }
}

// Missing or non-number values become 0 before clamping.
fn clamp(v: &Value, min: f64, max: f64) -> f64 {
    v.as_f64().filter(|x| x.is_finite()).unwrap_or(0.0).clamp(min, max)
}

// Same "#rrggbb" rule as validate_color in reducers/objects.rs.
fn color(v: &Value) -> String {
    let c = v.as_str().unwrap_or("").to_lowercase();
    let valid = c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|ch| ch.is_ascii_hexdigit());
    if valid {
        c
    } else {
        DEFAULT_COLOR.to_string()
    }
}

// Keeps error messages short (Gemini error bodies can be long).
fn short(s: &str) -> String {
    s.chars().take(300).collect()
}
