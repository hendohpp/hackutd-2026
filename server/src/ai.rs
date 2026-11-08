// AI TEAMMATE (all server AI code lives in this file)
//
// - ai_config: private table with the shared API keys (clients can't read them): row 0 Gemini, row 1 Claude.
// - set_ai_key / set_claude_key: store a key. The first identity to set it is the only one that can change it.
// - ask_ai(scene_id, prompt, detailed): finds the spot the caller's camera is looking at and the
//   objects already around it, asks the model what to add, change or remove there, checks the answer,
//   and applies it to the existing `object` table in one transaction. Everyone sees the result
//   through the normal subscription. The model is Claude when its key is set (Gemini's fast model
//   steps in if Claude fails), otherwise Gemini.
// - ai_event: public notices of what the AI did, so other people's editors can show them.
// - undo_ai(scene_id): undoes the caller's last AI change (ai_undo remembers it).
//
// With Gemini we talk in meters relative to the spot the caller is looking at, sizes as bounding
// boxes and rotations in degrees. to_row / from_row convert that to an object row's position,
// rotation and scale, which depend on how the client builds each shape (multiplayer.js KINDS).

use std::f64::consts::FRAC_PI_2;

use serde_json::{json, Value};
use spacetimedb::http::{Request, Timeout};
use spacetimedb::{Identity, ProcedureContext, ReducerContext, SpacetimeType, Table, TimeDuration, Timestamp};

use crate::math::Vec3;
use crate::tables::{object, scene_member, viewer, Object};

const GEMINI_URL: &str = "https://generativelanguage.googleapis.com/v1beta/interactions";
const FAST_MODEL: &str = "gemini-3.5-flash-lite"; // a few seconds
const DETAILED_MODEL: &str = "gemini-3.6-flash"; // better builds, up to a minute; falls back to FAST_MODEL
const CLAUDE_URL: &str = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODEL: &str = "claude-opus-5-5";
const CLAUDE_EFFORT: &str = "low"; // how hard Claude thinks: "low" answers in ~10-25 s; "medium" thinks ~15-20 s longer first
const CLAUDE_MAX_TOKENS: u32 = 16000; // thinking + the JSON answer
const CLAUDE_TIMEOUT_SECS: u64 = 120;
const CLAUDE_KEY_ROW: u32 = 1; // ai_config row of the Claude key (row 0 is Gemini's)
const KINDS: [&str; 8] = ["box", "sphere", "cylinder", "cone", "capsule", "torus", "icosahedron", "plane"];
const MAX_CREATE: usize = 500; // new objects per request, after repeats are expanded
const MAX_ACTIONS: usize = 80; // actions in Gemini's answer (one action can repeat into many objects)
const MAX_COPIES: i64 = 60; // "times" and "times2" limits for one repeat
const MAX_DELETES: usize = 15; // limits the damage if Gemini misreads a request in a shared scene
const MAX_POS: f64 = 100.0; // x and z: meters from the spot the caller is looking at (a 200 x 200 m build)
const MIN_Y: f64 = -1.0;
const MAX_Y: f64 = 150.0;
const MIN_SIZE: f64 = 0.05;
const MAX_SIZE: f64 = 200.0; // one ground plane can cover a whole build
const NEARBY_RADIUS: f64 = 50.0; // objects this close to the spot are shown to the model and can be edited
const NEARBY_MAX: usize = 150;
const LOOK_DISTANCE: f64 = 8.0; // where to build when the camera looks at the horizon
const MAX_LOOK_DISTANCE: f64 = 150.0; // keep in sync with client/src/multiplayer.js
const WORLD_LIMIT: f64 = 1000.0; // keep in sync with client/src/multiplayer.js
const FREE_SPACE_GAP: f64 = 1.0; // meters kept between a standalone build and what's already there
const FREE_SPACE_STEP: f64 = 1.0; // search rings are this far apart
const FREE_SPACE_RADIUS: f64 = 60.0; // how far from the asked-for spot to look for room (more for big builds)
const MAX_PROMPT_CHARS: usize = 300;
const EVENTS_KEPT: usize = 20; // AI notices kept per scene
const DEFAULT_COLOR: &str = "#888888";

#[spacetimedb::table(accessor = ai_config)]
pub struct AiConfig {
    #[primary_key]
    pub id: u32, // 0: the Gemini key, CLAUDE_KEY_ROW: the Claude key
    pub api_key: String,
    pub owner: Identity, // who first set the key; only they can change it
}

/// Public: what the AI did, so other people's editors can show a notice.
#[spacetimedb::table(accessor = ai_event, public)]
pub struct AiEvent {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub scene_id: u64,
    pub who: Identity,
    pub prompt: String,
    pub added: u32,
    pub changed: u32,
    pub removed: u32,
    pub undo: bool, // true when `who` undid their last AI change
    pub at: Timestamp,
}

/// Private: each person's last AI change, so undo_ai can reverse it.
/// It keeps the AI's results too, so undo can leave alone anything someone changed since.
#[spacetimedb::table(accessor = ai_undo)]
pub struct AiUndo {
    #[primary_key]
    pub identity: Identity,
    pub scene_id: u64,
    pub prompt: String,
    pub created: Vec<ObjectState>,   // objects it added, as it added them
    pub changed: Vec<ObjectChange>,  // objects it changed, before and after
    pub removed: Vec<ObjectState>,   // objects it deleted
}

#[derive(SpacetimeType, Clone, PartialEq)]
pub struct ObjectState {
    pub id: u64,
    pub kind: String,
    pub color: String,
    pub position: Vec3,
    pub rotation: Vec3,
    pub scale: Vec3,
}

#[derive(SpacetimeType, Clone)]
pub struct ObjectChange {
    pub before: ObjectState,
    pub after: ObjectState,
}

/// What ask_ai and undo_ai report back to the caller.
#[derive(SpacetimeType)]
pub struct AiResult {
    pub added: u32,
    pub changed: u32,
    pub removed: u32,
    pub skipped: u32, // objects left alone: someone else is editing them (or, for undo, changed them since)
    pub note: String, // e.g. that the fast model stood in for the detailed one
}

/// The Gemini API key.
#[spacetimedb::reducer]
pub fn set_ai_key(ctx: &ReducerContext, api_key: String) -> Result<(), String> {
    store_key(ctx, 0, api_key)
}

/// The Claude API key. Once it's set, ask_ai uses Claude, with Gemini as the backup.
#[spacetimedb::reducer]
pub fn set_claude_key(ctx: &ReducerContext, api_key: String) -> Result<(), String> {
    store_key(ctx, CLAUDE_KEY_ROW, api_key)
}

fn store_key(ctx: &ReducerContext, id: u32, api_key: String) -> Result<(), String> {
    let api_key = api_key.trim().to_string();
    if api_key.is_empty() {
        return Err("the API key is empty".to_string());
    }
    match ctx.db.ai_config().id().find(id) {
        Some(cfg) if cfg.owner != ctx.sender() => {
            Err("only the identity that first set this key can change it".to_string())
        }
        Some(mut cfg) => {
            cfg.api_key = api_key;
            ctx.db.ai_config().id().update(cfg);
            Ok(())
        }
        None => {
            ctx.db.ai_config().insert(AiConfig { id, api_key, owner: ctx.sender() });
            Ok(())
        }
    }
}

// Rate limits: each request to Claude costs real money, and anyone on the site can ask.
const ASK_COOLDOWN_MICROS: i64 = 10_000_000; // one request per person every 10 seconds
const MAX_ASKS_PER_HOUR: u32 = 120; // for everyone together

/// Private: when each person last asked the AI (for the cooldown).
#[spacetimedb::table(accessor = ai_last_ask)]
pub struct AiLastAsk {
    #[primary_key]
    pub identity: Identity,
    pub at: Timestamp,
}

/// Private: how many AI requests everyone made since `hour_start` (one row, id 0).
#[spacetimedb::table(accessor = ai_hourly)]
pub struct AiHourly {
    #[primary_key]
    pub id: u32,
    pub hour_start: Timestamp,
    pub count: u32,
}

fn check_rate(ctx: &ReducerContext, sender: Identity) -> Result<(), String> {
    let now = ctx.timestamp;
    match ctx.db.ai_last_ask().identity().find(sender) {
        Some(last) if last.at + TimeDuration::from_micros(ASK_COOLDOWN_MICROS) > now => {
            return Err("give the AI a few seconds between requests".to_string());
        }
        Some(_) => {
            ctx.db.ai_last_ask().identity().update(AiLastAsk { identity: sender, at: now });
        }
        None => {
            ctx.db.ai_last_ask().insert(AiLastAsk { identity: sender, at: now });
        }
    }
    let hour = TimeDuration::from_micros(3_600_000_000);
    match ctx.db.ai_hourly().id().find(0) {
        Some(h) if h.hour_start + hour > now && h.count >= MAX_ASKS_PER_HOUR => {
            Err("the AI has had a busy hour; try again in a few minutes".to_string())
        }
        Some(h) if h.hour_start + hour > now => {
            ctx.db.ai_hourly().id().update(AiHourly { count: h.count + 1, ..h });
            Ok(())
        }
        Some(_) => {
            ctx.db.ai_hourly().id().update(AiHourly { id: 0, hour_start: now, count: 1 });
            Ok(())
        }
        None => {
            ctx.db.ai_hourly().insert(AiHourly { id: 0, hour_start: now, count: 1 });
            Ok(())
        }
    }
}

#[spacetimedb::procedure]
pub fn ask_ai(ctx: &mut ProcedureContext, scene_id: u64, prompt: String, detailed: bool) -> Result<AiResult, String> {
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("type something for the AI to build".to_string());
    }
    if prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err(format!("keep the prompt under {MAX_PROMPT_CHARS} characters"));
    }

    // 1. Look (short transaction): check the caller is in the scene and within the rate limits,
    //    read the key, and find where they're looking and what's already there.
    let sender = ctx.sender();
    let look = ctx.try_with_tx(|tx| {
        let look = look_around(tx, sender, scene_id)?;
        check_rate(tx, sender)?; // (an error here rolls back this transaction, so nothing is counted)
        Ok::<Look, String>(look)
    })?;

    // 2. Think: ask the model, outside any transaction (procedures can't make HTTP calls inside one).
    let (text, note) = ask_model(ctx, &look, &instructions(&prompt, &look.nearby), detailed)?;
    let plan = read_plan(&text, &look)?;
    spacetimedb::log::info!(
        "ask_ai: after checks {} create / {} update / {} delete; {} nearby objects shown, center {:?}",
        plan.creates.len(), plan.updates.len(), plan.deletes.len(), look.nearby.len(), look.center
    );

    // 3. Act (one transaction): find room for a standalone build, apply the changes, remember
    //    them for undo, post a notice.
    let mut result = ctx.with_tx(|tx| apply_plan(tx, sender, scene_id, &prompt, &plan));
    if !note.is_empty() {
        result.note = format!("{} {note}", result.note).trim().to_string();
    }
    spacetimedb::log::info!(
        "ask_ai {prompt:?} in scene {scene_id}: +{} ~{} -{} (skipped {})",
        result.added, result.changed, result.removed, result.skipped
    );
    Ok(result)
}

/// Undoes the caller's last AI change in this scene. In a shared scene other people may have
/// moved, recolored or locked those objects since; undo leaves those alone and counts them as skipped.
#[spacetimedb::procedure]
pub fn undo_ai(ctx: &mut ProcedureContext, scene_id: u64) -> Result<AiResult, String> {
    let me = ctx.sender();
    ctx.try_with_tx(|tx| undo_last(tx, me, scene_id))
}

fn undo_last(ctx: &ReducerContext, me: Identity, scene_id: u64) -> Result<AiResult, String> {
    let undo = ctx
        .db
        .ai_undo()
        .identity()
        .find(me)
        .filter(|u| u.scene_id == scene_id)
        .ok_or_else(|| "nothing to undo".to_string())?;

    let mut r = AiResult { added: 0, changed: 0, removed: 0, skipped: 0, note: String::new() };
    for s in &undo.created {
        // remove what the AI added, unless someone changed it since
        match editable(ctx, s.id, scene_id, me, &mut r.skipped) {
            Some(obj) if state_of(&obj) == *s => {
                ctx.db.object().id().delete(s.id);
                r.removed += 1;
            }
            Some(_) => r.skipped += 1,
            None => {} // already deleted, or locked (counted)
        }
    }
    for c in &undo.changed {
        // put back what it changed, unless someone changed it again since
        match editable(ctx, c.after.id, scene_id, me, &mut r.skipped) {
            Some(mut obj) if state_of(&obj) == c.after => {
                obj.kind = c.before.kind.clone();
                obj.color = c.before.color.clone();
                obj.position = c.before.position;
                obj.rotation = c.before.rotation;
                obj.scale = c.before.scale;
                ctx.db.object().id().update(obj);
                r.changed += 1;
            }
            Some(_) => r.skipped += 1,
            None => {}
        }
    }
    for s in &undo.removed {
        // bring back what it deleted (as new objects)
        ctx.db.object().insert(new_object(scene_id, s.kind.clone(), s.color.clone(), s.position, s.rotation, s.scale));
        r.added += 1;
    }
    ctx.db.ai_undo().identity().delete(me);
    log_event(ctx, me, scene_id, &undo.prompt, &r, true);
    Ok(r)
}

// ---------------------------------------------------------------------------------------------
// 1. Look

/// What ask_ai saw before calling the model.
struct Look {
    gemini_key: Option<String>,
    claude_key: Option<String>,
    center: (f64, f64), // world x, z of the spot the caller is looking at
    nearby: Vec<Nearby>, // objects around that spot, closest first
}

/// An existing object, as Gemini sees it.
struct Nearby {
    id: u64,
    shape: AiShape,
}

/// A shape in Gemini's terms: position relative to the spot (meters), bounding-box size, degrees.
#[derive(Clone)]
struct AiShape {
    kind: String,
    color: String,
    pos: [f64; 3],
    size: [f64; 3],
    rot: [f64; 3],
}

fn look_around(ctx: &ReducerContext, sender: Identity, scene_id: u64) -> Result<Look, String> {
    let member = ctx
        .db
        .scene_member()
        .scene_id()
        .filter(scene_id)
        .any(|m| m.identity == sender);
    if !member {
        return Err("not a member of this scene".to_string());
    }
    let key = |id: u32| ctx.db.ai_config().id().find(id).map(|cfg| cfg.api_key);
    let (gemini_key, claude_key) = (key(0), key(CLAUDE_KEY_ROW));
    if gemini_key.is_none() && claude_key.is_none() {
        return Err("the AI key is not set yet (call set_claude_key or set_ai_key)".to_string());
    }

    // The viewer table holds each person's camera (see reducers/presence.rs).
    let center = ctx
        .db
        .viewer()
        .identity()
        .find(sender)
        .filter(|v| v.scene_id == scene_id)
        .map(|v| looking_at(v.position, v.rotation))
        .unwrap_or((0.0, 0.0));

    let mut nearby: Vec<(f64, Nearby)> = ctx
        .db
        .object()
        .scene_id()
        .filter(scene_id)
        .filter(|o| known_kind(&o.kind))
        .map(|o| {
            let (dx, dz) = (o.position.x as f64 - center.0, o.position.z as f64 - center.1);
            ((dx * dx + dz * dz).sqrt(), Nearby { id: o.id, shape: from_row(&o, center) })
        })
        .filter(|(distance, _)| *distance <= NEARBY_RADIUS)
        .collect();
    nearby.sort_by(|a, b| a.0.total_cmp(&b.0));
    let nearby = nearby.into_iter().take(NEARBY_MAX).map(|(_, n)| n).collect();

    Ok(Look { gemini_key, claude_key, center, nearby })
}

/// The spot on the ground the camera is looking at. Viewer rows hold the camera's world position
/// and rotation (Euler XYZ, radians); a camera looks down its local -Z axis.
fn looking_at(p: Vec3, r: Vec3) -> (f64, f64) {
    let (rx, ry) = (r.x as f64, r.y as f64);
    let dir = [-ry.sin(), rx.sin() * ry.cos(), -rx.cos() * ry.cos()];
    let flat = (dir[0] * dir[0] + dir[2] * dir[2]).sqrt().max(1e-6);
    // How far along the ground until the view meets y = 0 (or a fixed distance at the horizon).
    let along_ground = if dir[1] < -0.05 { -(p.y as f64) / dir[1] * flat } else { LOOK_DISTANCE };
    let d = along_ground.clamp(0.0, MAX_LOOK_DISTANCE);
    let x = p.x as f64 + dir[0] / flat * d;
    let z = p.z as f64 + dir[2] / flat * d;
    (x.clamp(-WORLD_LIMIT, WORLD_LIMIT), z.clamp(-WORLD_LIMIT, WORLD_LIMIT))
}

// ---------------------------------------------------------------------------------------------
// 2. Think

fn instructions(prompt: &str, nearby: &[Nearby]) -> String {
    let nearby_text = if nearby.is_empty() {
        "none".to_string()
    } else {
        nearby.iter().map(|n| shape_json(Some(n.id), &n.shape).to_string()).collect::<Vec<_>>().join("\n")
    };
    let models_text = MODELS
        .iter()
        .map(|m| {
            let s = default_size(m);
            format!("{}: {} ({:.1} x {:.1} x {:.1} m)", m.0, m.2, s[0], s[1], s[2])
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        r##"You are an AI teammate in a shared 3D editor. A user asked: "{prompt}"

Work in meters, relative to the spot the user is looking at: x and z run along the ground, y is up, and the ground is y = 0. Keep x and z between -{MAX_POS} and {MAX_POS}, and y between {MIN_Y} and {MAX_Y}.

Objects already around that spot, closest first. Other people made them: leave them as they are unless the request explicitly asks to change, move, remove or replace them, and build new things around them:
{nearby_text}

Colors are hex strings like "#8b5a2b" (never color names).
Shapes. Position is the shape's center; size (sx, sy, sz) is its bounding box in meters:
- box: a block. Use thin boxes for walls, floors, roofs, boards and tilted panels.
- sphere: a ball or ellipsoid.
- cylinder: stands upright along y. Lay it along x with rz = 90, along z with rx = 90.
- cone: like a cylinder with its point at the top. Trees, roofs, carrots, hats, spikes.
- capsule: an upright pill. Arms, legs, bodies, rounded logs.
- torus: a ring standing upright, facing z; sx and sy are its outer diameter, sz its thickness. Lay it flat with rx = 90.
- icosahedron: a faceted ball. Rocks, gems, boulders.
- plane: a flat patch on the ground, sx by sz (only ry turns it).
Rotation rx, ry, rz is in degrees, applied around x, then y, then z. Positive rz raises a part's +x end; positive rx lowers its +z end; positive ry turns it counter-clockwise seen from above.
A peaked roof whose ridge runs along z at x = 0: the left panel (x < 0) uses rz = 30 and the right panel (x > 0) uses rz = -30, so both rise toward the middle.

Models: ready-made low-poly 3D models. They look far better than shapes, so use a model for anything this list has (trees, rocks, plants, houses, cars, furniture, castle parts, market stalls, holiday things), and shapes for everything else (ground, roads, water, custom objects, extra details).
Create one with "kind": "model" and "model": its id, e.g. {{"op":"create","kind":"model","model":"tree_oak","color":"#2e7d32","px":4,"py":3.07,"pz":-2,"ry":30}}.
A model's position is its center, so resting on the ground means py = its height / 2. It has the listed size (width x height x depth, in meters) unless you give "sy" (or "sx" or "sz"), which scales it evenly. Turn it with "ry". Models keep their own colors (color is required but ignored). The power tools work on models too: a row of trees, a parking lot of cars.
Castle towers stack: tower_base, then any number of tower_mid, then tower_top, each resting on the one below (round towers likewise).
{models_text}

How to build well:
1. First write "plan": the parts, their sizes, and what each one rests on or attaches to.
2. Use realistic proportions: a door is 2 m tall, a table 0.75 m, a person 1.8 m, a car 4.5 m long.
3. Every part touches or slightly overlaps the part it rests on or attaches to. Nothing floats. A part resting on a surface at height h has py = h + sy / 2.
   Only add a ground plane when the user asks for ground, grass, snow or a floor.
   Set "standalone" to true when the request is a new, self-contained thing (a campfire, a house, a tree): center it around x = 0, z = 0, and the editor moves it to free space so it doesn't overlap anything. Set "standalone" to false when adding parts onto, into or right around specific existing objects (a hat on the snowman, stones around the fire), and place those parts exactly.
4. Use enough parts for recognizable detail, natural colors, and rotations where they help. Small things need 10 to 30 parts; when the user asks for something big or epic (a castle, a village, a city, a stadium), go big: 100 or more parts, up to {MAX_CREATE}, using the power tools below.

Power tools (one action becomes many objects; use them for anything repeated):
- Repeat a shape: add "times" (how many copies, the first one included), "step_x", "step_y", "step_z" (meters from one copy to the next) and/or "turn" (degrees each copy turns around the point "turn_x", "turn_z", which defaults to 0, 0). Add "times2" with "step2_x", "step2_z" to repeat the whole line again, for a grid.
  Fence posts: {{"op":"create","kind":"box","color":"#8b5a2b","px":-6,"py":0.5,"pz":3,"sx":0.15,"sy":1,"sz":0.15,"step_x":1.2,"times":11}}
  8 columns in a ring of radius 5: {{"op":"create","kind":"cylinder","color":"#dddddd","px":5,"py":2,"pz":0,"sx":0.6,"sy":4,"sz":0.6,"times":8,"turn":45}}
  Spiral staircase around a pillar at 0, 0 (add the pillar too): {{"op":"create","kind":"box","color":"#777777","px":1,"py":0.1,"pz":0,"sx":1.4,"sy":0.15,"sz":0.5,"step_y":0.25,"times":24,"turn":20}}
  A 4 x 5 grid of trees: {{"op":"create","kind":"cone","color":"#2e7d32","px":-6,"py":1.5,"pz":-8,"sx":1.5,"sy":3,"sz":1.5,"step2_z":4,"step_x":4,"times":4,"times2":5}}
- Repeat a group: give parts the same "part_of" name when you create them, then {{"op":"copy_group","part_of":"house","color":"#ffffff","step_x":9,"times":4}} copies all of them together (the same repeat fields work). Use this for towers, houses, lamp posts, cars, trees made of several parts.
5. New objects use "op": "create". Only if the user explicitly asks to change or remove existing objects, set "edit_existing" to true and use "op": "update" with the id plus only the fields that change, or "op": "delete" with the id. Otherwise set "edit_existing" to false.
   Asking to make something that exists bigger, smaller, longer, wider, taller, extend or stretch it, move it, turn it, recolor it or remove it is an edit: update or delete that object instead of adding new pieces around it.
   Every action includes a color; when an update or delete doesn't change the color, repeat the object's current one.
   Recolor: {{"op":"update","id":7,"color":"#d62828"}}. Make taller: {{"op":"update","id":12,"color":"#8b4513","sy":1.5,"py":0.75}}. Remove: {{"op":"delete","id":9,"color":"#ffffff"}}.

Example answer for "a small table with a lamp" (it only shows the format and how parts attach; don't copy it):
{EXAMPLE}"##
    )
}

const EXAMPLE: &str = r##"{"plan":"Tabletop 1.2 x 0.8 m with its top at 0.75 m, on four legs at its corners. On top: a lamp (base, pole, cone shade) and a book turned 25 degrees.","edit_existing":false,"standalone":true,"actions":[
{"op":"create","kind":"box","color":"#8b5a2b","px":0,"py":0.72,"pz":0,"sx":1.2,"sy":0.06,"sz":0.8},
{"op":"create","kind":"cylinder","color":"#6b4423","px":-0.54,"py":0.345,"pz":-0.34,"sx":0.06,"sy":0.69,"sz":0.06,"step2_z":0.68,"step_x":1.08,"times":2,"times2":2},
{"op":"create","kind":"cylinder","color":"#333333","px":0.35,"py":0.765,"pz":0.15,"sx":0.16,"sy":0.03,"sz":0.16},
{"op":"create","kind":"cylinder","color":"#555555","px":0.35,"py":0.98,"pz":0.15,"sx":0.03,"sy":0.4,"sz":0.03},
{"op":"create","kind":"cone","color":"#f5deb3","px":0.35,"py":1.12,"pz":0.15,"sx":0.3,"sy":0.22,"sz":0.3},
{"op":"create","kind":"box","color":"#b03030","px":-0.3,"py":0.77,"pz":0.05,"sx":0.2,"sy":0.04,"sz":0.28,"ry":25}]}"##;

/// Asks Claude when its key is set, with Gemini's fast model as the backup; otherwise Gemini.
/// Returns the model's JSON text and a note for the user.
fn ask_model(ctx: &mut ProcedureContext, look: &Look, instructions: &str, detailed: bool) -> Result<(String, String), String> {
    let Some(claude_key) = &look.claude_key else {
        return ask_gemini(ctx, look.gemini_key.as_deref().unwrap_or_default(), instructions, detailed);
    };
    match call_claude(ctx, claude_key, instructions) {
        Ok(text) => Ok((text, String::new())),
        Err(e) => {
            spacetimedb::log::warn!("ask_ai: Claude failed: {e}");
            let Some(gemini_key) = &look.gemini_key else {
                return Err(e);
            };
            // The fast model only: Claude may already have used up much of the wait.
            let text = call_model(ctx, gemini_key, FAST_MODEL, instructions, 60)?;
            Ok((text, "Claude was unavailable, so Gemini's fast model built this.".to_string()))
        }
    }
}

/// Asks the fast model, or the detailed one with the fast one as a fallback.
/// Returns Gemini's JSON text and a note for the user.
fn ask_gemini(ctx: &mut ProcedureContext, key: &str, instructions: &str, detailed: bool) -> Result<(String, String), String> {
    if detailed {
        match call_model(ctx, key, DETAILED_MODEL, instructions, 120) {
            Ok(text) => return Ok((text, String::new())),
            Err(e) => {
                spacetimedb::log::warn!("ask_ai: {DETAILED_MODEL} failed, using {FAST_MODEL}: {e}");
                let text = call_model(ctx, key, FAST_MODEL, instructions, 60)?;
                // 429 = the key's quota (the free tier allows few detailed requests per day).
                let why = if e.contains("HTTP 429") { "hit its daily limit" } else { "was busy" };
                return Ok((text, format!("The detailed model {why}, so the fast one built this.")));
            }
        }
    }
    Ok((call_model(ctx, key, FAST_MODEL, instructions, 60)?, String::new()))
}

/// The shape of the model's answer (both Gemini and Claude).
fn plan_schema() -> Value {
    // Kept simple on purpose: Gemini rejects schemas with many constraints ("too many states").
    // The limits are in the instructions, and read_plan clamps every value and caps the count.
    let num = json!({ "type": "number" });
    json!({
        "type": "object",
        "properties": {
            "plan": { "type": "string" },
            "edit_existing": { "type": "boolean" },
            "standalone": { "type": "boolean" },
            "actions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "op": { "type": "string", "enum": ["create", "copy_group", "update", "delete"] },
                        "id": { "type": "integer" },
                        "kind": { "type": "string", "enum": KINDS.iter().copied().chain(["model"]).collect::<Vec<_>>() },
                        "model": { "type": "string" }, // a MODELS id, when kind is "model"
                        "color": { "type": "string", "description": "hex color like #ff8800" },
                        "px": num, "py": num, "pz": num,
                        "sx": num, "sy": num, "sz": num,
                        "rx": num, "ry": num, "rz": num,
                        // Gemini writes fields in alphabetical order, so the repeat fields have names that
                        // come after the shape's own fields: it decides on copies after describing the shape.
                        "part_of": { "type": "string" },
                        "step_x": num, "step_y": num, "step_z": num,
                        "step2_x": num, "step2_z": num,
                        "times": { "type": "integer" },
                        "times2": { "type": "integer" },
                        "turn": num, "turn_x": num, "turn_z": num,
                    },
                    // Gemini skips optional fields it should fill (colors came back missing), so color is required.
                    "required": ["op", "color"],
                },
            },
        },
        "required": ["plan", "edit_existing", "standalone", "actions"],
    })
}

fn call_model(ctx: &mut ProcedureContext, key: &str, model: &str, instructions: &str, timeout_secs: u64) -> Result<String, String> {
    let body = json!({
        "model": model,
        "input": instructions,
        "response_format": { "type": "text", "mime_type": "application/json", "schema": plan_schema() },
    });

    let request = Request::builder()
        .uri(GEMINI_URL)
        .method("POST")
        .header("x-goog-api-key", key)
        .header("Content-Type", "application/json")
        .header("Api-Revision", "2026-05-20")
        .extension(Timeout::from(TimeDuration::from(std::time::Duration::from_secs(timeout_secs))))
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
    let usage = &data["usage"];
    spacetimedb::log::info!(
        "ask_ai: {model} status={} output_tokens={} thought_tokens={}",
        data["status"], usage["total_output_tokens"], usage["total_thought_tokens"]
    );
    get_text(&data).ok_or_else(|| "could not find the JSON text in Gemini's response".to_string())
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

/// One request to Claude (Messages API) for the plan, as JSON text.
fn call_claude(ctx: &mut ProcedureContext, key: &str, instructions: &str) -> Result<String, String> {
    // No structured-output schema: Claude rejects plan_schema as "too complex". The instructions
    // describe the JSON, and read_plan checks and clamps everything anyway.
    let body = json!({
        "model": CLAUDE_MODEL,
        "max_tokens": CLAUDE_MAX_TOKENS,
        "system": "Reply with only the JSON object the instructions describe: no other text, no code fences.",
        "messages": [{ "role": "user", "content": instructions }],
        "output_config": { "effort": CLAUDE_EFFORT },
        // If a safety check declines the request, Anthropic retries it on a suitable other model.
        "fallbacks": "default",
    });

    let request = Request::builder()
        .uri(CLAUDE_URL)
        .method("POST")
        .header("x-api-key", key)
        .header("anthropic-version", "2026-10-21")
        .header("anthropic-beta", "server-side-fallback-2026-07-01")
        .header("content-type", "application/json")
        .extension(Timeout::from(TimeDuration::from(std::time::Duration::from_secs(CLAUDE_TIMEOUT_SECS))))
        .body(body.to_string())
        .map_err(|_| "could not build the Claude request".to_string())?;

    spacetimedb::log::info!("ask_ai: asking {CLAUDE_MODEL} (effort {CLAUDE_EFFORT})");
    let response = ctx
        .http
        .send(request)
        .map_err(|e| format!("could not reach Claude: {e}"))?;
    let (parts, body) = response.into_parts();
    let raw = body.into_string_lossy();
    if !parts.status.is_success() {
        // e.g. 429: rate or spend limit; 529: Anthropic is overloaded
        return Err(format!("Claude returned HTTP {}: {}", parts.status.as_u16(), short(&raw)));
    }

    let data: Value = serde_json::from_str(&raw).map_err(|_| "Claude's response was not JSON".to_string())?;
    let usage = &data["usage"];
    spacetimedb::log::info!(
        "ask_ai: {} stop_reason={} input_tokens={} output_tokens={}",
        data["model"], data["stop_reason"], usage["input_tokens"], usage["output_tokens"]
    );
    match data["stop_reason"].as_str() {
        Some("refusal") => return Err("Claude declined this request".to_string()),
        Some("max_tokens") => return Err("Claude's answer was too long and got cut off".to_string()),
        _ => {}
    }
    // The JSON is in the text block (thinking blocks come before it). Keep just the object, in case
    // Claude wraps it in a code fence or a sentence anyway.
    let text = data["content"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|block| block["type"] == "text")
        .and_then(|block| block["text"].as_str())
        .ok_or_else(|| "could not find the JSON text in Claude's response".to_string())?;
    match (text.find('{'), text.rfind('}')) {
        (Some(start), Some(end)) if start < end => Ok(text[start..=end].to_string()),
        _ => Err("Claude's answer had no JSON object".to_string()),
    }
}

/// Gemini's answer after checking: new shapes are clamped, and only objects it was shown can be
/// edited. Updates stay as Gemini's field changes ("patches"): they're applied to each object as
/// it is when the change is made, because someone may have moved or recolored it meanwhile.
struct Plan {
    center: (f64, f64),
    standalone: bool, // a self-contained new build: apply_plan moves it to free space
    creates: Vec<AiShape>,
    updates: Vec<(u64, Value)>,
    deletes: Vec<u64>,
}

fn read_plan(text: &str, look: &Look) -> Result<Plan, String> {
    let parsed: Value = serde_json::from_str(text).map_err(|_| "the AI's answer was not valid JSON".to_string())?;
    let mut plan = Plan {
        center: look.center,
        standalone: parsed["standalone"].as_bool() == Some(true),
        creates: Vec::new(),
        updates: Vec::new(),
        deletes: Vec::new(),
    };
    let Some(actions) = parsed["actions"].as_array() else {
        return Ok(plan);
    };
    // Other people's objects are only touched when the request explicitly asked for it.
    let may_edit = parsed["edit_existing"].as_bool() == Some(true);
    let ops = |op: &str| actions.iter().filter(|a| a["op"] == op).count();
    let first_edit = actions.iter().find(|a| a["op"] != "create").map(|a| a.to_string()).unwrap_or_default();
    spacetimedb::log::info!(
        "ask_ai: the model planned {:?}, edit_existing={may_edit}, {} create / {} update / {} delete {}",
        short(parsed["plan"].as_str().unwrap_or("")), ops("create"), ops("update"), ops("delete"), short(&first_edit)
    );
    let mut groups: Vec<(String, AiShape)> = Vec::new(); // shapes tagged "part_of" a group, for copy_group
    for a in actions.iter().take(MAX_ACTIONS) {
        match a["op"].as_str().unwrap_or("create") {
            "create" => {
                let shape = if a["kind"] == "model" {
                    let Some(m) = a["model"].as_str().and_then(model_by_id) else {
                        continue;
                    };
                    model_shape(m, a)
                } else {
                    let Some(kind) = a["kind"].as_str().filter(|k| KINDS.contains(k)) else {
                        continue;
                    };
                    let blank = AiShape { kind: kind.to_string(), color: DEFAULT_COLOR.to_string(), pos: [0.0; 3], size: [1.0; 3], rot: [0.0; 3] };
                    merge(blank, a)
                };
                if let Some(group) = a["part_of"].as_str() {
                    groups.push((group.to_string(), shape.clone()));
                }
                for copy in repeat(&[shape], a, true) {
                    if plan.creates.len() < MAX_CREATE {
                        plan.creates.push(copy);
                    }
                }
            }
            "copy_group" => {
                let name = a["part_of"].as_str().unwrap_or("");
                let members: Vec<AiShape> = groups.iter().filter(|(g, _)| g == name).map(|(_, s)| s.clone()).collect();
                for copy in repeat(&members, a, false) {
                    if plan.creates.len() < MAX_CREATE {
                        plan.creates.push(copy);
                    }
                }
            }
            "update" if may_edit => {
                if let Some(n) = shown(look, a) {
                    if !plan.deletes.contains(&n.id) {
                        plan.updates.retain(|(id, _)| *id != n.id);
                        plan.updates.push((n.id, a.clone()));
                    }
                }
            }
            "delete" if may_edit => {
                if let Some(n) = shown(look, a) {
                    plan.updates.retain(|(id, _)| *id != n.id);
                    if !plan.deletes.contains(&n.id) && plan.deletes.len() < MAX_DELETES {
                        plan.deletes.push(n.id);
                    }
                }
            }
            _ => {}
        }
    }
    Ok(plan)
}

/// Gemini's power tools: copies of `shapes` along a line ("times" + "step_*"), turning around a point
/// ("turn" + "turn_x", "turn_z"), and repeated in rows ("times2" + "step2_*"). With `include_original`,
/// the first copy is the shapes themselves (a repeated create); copy_group only adds the extra copies.
fn repeat(shapes: &[AiShape], a: &Value, include_original: bool) -> Vec<AiShape> {
    let int = |k: &str| a[k].as_i64().or_else(|| number(&a[k]).map(|f| f.round() as i64));
    let num = |k: &str| number(&a[k]).unwrap_or(0.0);
    let (turn, pivot) = (num("turn"), (num("turn_x"), num("turn_z")));
    // A turn without a number of copies means one full circle.
    let full_circle = if turn.abs() >= 1.0 { (360.0 / turn.abs()).round() as i64 } else { 1 };
    let step = [num("step_x"), num("step_y"), num("step_z")];
    let row = [num("step2_x"), 0.0, num("step2_z")];
    // Copies that wouldn't move (no step and no turn) would just stack up invisibly: make one.
    let moves = step.iter().any(|v| v.abs() > 1e-6) || turn.abs() > 1e-6;
    let count = if moves { int("times").unwrap_or(full_circle).clamp(1, MAX_COPIES) as usize } else { 1 };
    let rows = if row.iter().any(|v| v.abs() > 1e-6) { int("times2").unwrap_or(1).clamp(1, MAX_COPIES) as usize } else { 1 };

    let mut out = Vec::new();
    for r in 0..rows {
        for k in 0..count {
            if (r, k) == (0, 0) && !include_original {
                continue;
            }
            for s in shapes {
                let mut c = s.clone();
                for i in 0..3 {
                    c.pos[i] += step[i] * k as f64 + row[i] * r as f64;
                }
                if turn != 0.0 {
                    turn_around(&mut c, turn * k as f64, pivot);
                }
                c.pos = [c.pos[0].clamp(-MAX_POS, MAX_POS), c.pos[1].clamp(MIN_Y, MAX_Y), c.pos[2].clamp(-MAX_POS, MAX_POS)];
                out.push(c);
            }
            if out.len() >= MAX_CREATE {
                return out;
            }
        }
    }
    out
}

/// Turns a shape `degrees` counter-clockwise (seen from above) around the vertical line through
/// `pivot`: its position swings around, and its own rotation turns with it.
fn turn_around(s: &mut AiShape, degrees: f64, pivot: (f64, f64)) {
    let (sin, cos) = degrees.to_radians().sin_cos();
    let (dx, dz) = (s.pos[0] - pivot.0, s.pos[2] - pivot.1);
    s.pos[0] = pivot.0 + cos * dx + sin * dz;
    s.pos[2] = pivot.1 - sin * dx + cos * dz;
    if s.kind == "plane" {
        s.rot[1] += degrees; // planes only turn around y
        return;
    }
    // Apply the turn on top of the shape's own rotation (Euler XYZ, like three.js), then convert back.
    let m = euler_to_matrix(s.rot.map(f64::to_radians));
    let yaw = [[cos, 0.0, sin], [0.0, 1.0, 0.0], [-sin, 0.0, cos]];
    let mut turned = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            turned[i][j] = (0..3).map(|k| yaw[i][k] * m[k][j]).sum();
        }
    }
    s.rot = matrix_to_euler(&turned).map(f64::to_degrees);
}

/// Rotation matrix (rows) for Euler angles in XYZ order, the same as three.js Matrix4.makeRotationFromEuler.
fn euler_to_matrix([x, y, z]: [f64; 3]) -> [[f64; 3]; 3] {
    let (b, a) = x.sin_cos();
    let (d, c) = y.sin_cos();
    let (f, e) = z.sin_cos();
    [
        [c * e, -c * f, d],
        [a * f + b * e * d, a * e - b * f * d, -b * c],
        [b * f - a * e * d, b * e + a * f * d, a * c],
    ]
}

/// Euler angles in XYZ order from a rotation matrix, the same as three.js Euler.setFromRotationMatrix.
fn matrix_to_euler(m: &[[f64; 3]; 3]) -> [f64; 3] {
    let y = m[0][2].clamp(-1.0, 1.0).asin();
    if m[0][2].abs() < 0.999_999_9 {
        [(-m[1][2]).atan2(m[2][2]), y, (-m[0][1]).atan2(m[0][0])]
    } else {
        [m[2][1].atan2(m[1][1]), y, 0.0]
    }
}

/// The nearby object an update or delete points at (ids Gemini wasn't shown are ignored).
fn shown<'a>(look: &'a Look, a: &Value) -> Option<&'a Nearby> {
    let v = &a["id"]; // normally 112, but accept 112.0 and "112" too
    let id = v.as_u64().or_else(|| v.as_f64().map(|f| f as u64)).or_else(|| v.as_str()?.trim().parse().ok())?;
    look.nearby.iter().find(|n| n.id == id)
}

/// Copies the fields Gemini gave onto a shape, clamping each one. Missing fields stay as they were.
fn merge(mut s: AiShape, a: &Value) -> AiShape {
    if let Some(c) = a["color"].as_str().and_then(color) {
        s.color = c;
    }
    for (i, k) in ["px", "py", "pz"].iter().enumerate() {
        if let Some(v) = number(&a[*k]) {
            s.pos[i] = if i == 1 { v.clamp(MIN_Y, MAX_Y) } else { v.clamp(-MAX_POS, MAX_POS) };
        }
    }
    for (i, k) in ["sx", "sy", "sz"].iter().enumerate() {
        if let Some(v) = number(&a[*k]) {
            s.size[i] = v.clamp(MIN_SIZE, MAX_SIZE);
        }
    }
    for (i, k) in ["rx", "ry", "rz"].iter().enumerate() {
        if let Some(v) = number(&a[*k]) {
            s.rot[i] = v.clamp(-180.0, 180.0);
        }
    }
    s
}

// ---------------------------------------------------------------------------------------------
// 3. Act

fn apply_plan(ctx: &ReducerContext, me: Identity, scene_id: u64, prompt: &str, plan: &Plan) -> AiResult {
    let mut undo = AiUndo {
        identity: me,
        scene_id,
        prompt: prompt.to_string(),
        created: Vec::new(),
        changed: Vec::new(),
        removed: Vec::new(),
    };
    let mut skipped = 0;

    for (id, patch) in &plan.updates {
        if let Some(mut obj) = editable(ctx, *id, scene_id, me, &mut skipped) {
            let before = state_of(&obj);
            patch_object(&mut obj, patch, plan.center);
            let after = state_of(&obj);
            if after != before {
                ctx.db.object().id().update(obj);
                undo.changed.push(ObjectChange { before, after });
            }
        }
    }
    for id in &plan.deletes {
        if let Some(obj) = editable(ctx, *id, scene_id, me, &mut skipped) {
            undo.removed.push(state_of(&obj));
            ctx.db.object().id().delete(*id);
        }
    }
    // A standalone build goes where the caller is looking if there's room, otherwise to the nearest
    // free spot. This runs inside the transaction, so it sees builds that just landed from others.
    let center = if plan.standalone { free_spot(ctx, scene_id, plan) } else { plan.center };
    for shape in &plan.creates {
        let (position, rotation, scale) = to_row(shape, center);
        let row = ctx.db.object().insert(new_object(scene_id, shape.kind.clone(), shape.color.clone(), position, rotation, scale));
        undo.created.push(state_of(&row));
    }
    let moved = (center.0 - plan.center.0).hypot(center.1 - plan.center.1);

    let result = AiResult {
        added: undo.created.len() as u32,
        changed: undo.changed.len() as u32,
        removed: undo.removed.len() as u32,
        skipped,
        note: if moved > 0.5 { format!("Placed it {moved:.0} m to the side, where there was room.") } else { String::new() },
    };
    if result.added + result.changed + result.removed > 0 {
        log_event(ctx, me, scene_id, prompt, &result, false);
        // Replace this person's previous undo with this change.
        if ctx.db.ai_undo().identity().find(me).is_some() {
            ctx.db.ai_undo().identity().update(undo);
        } else {
            ctx.db.ai_undo().insert(undo);
        }
    }
    result
}

/// Applies only the fields Gemini changed, on top of the object as it is now. Fields it didn't
/// mention (say, the position, when it only recolors) keep whatever value is there now.
fn patch_object(obj: &mut Object, patch: &Value, center: (f64, f64)) {
    let mentions = |keys: [&str; 3]| keys.iter().any(|k| number(&patch[*k]).is_some());
    let current = from_row(obj, center);
    let mut shape = merge(current.clone(), patch);
    if model_by_kind(&obj.kind).is_some() {
        shape.size = scaled_evenly(current.size, patch); // models resize without stretching
    }
    let (position, rotation, scale) = to_row(&shape, center);
    if patch["color"].as_str().and_then(color).is_some() {
        obj.color = shape.color;
    }
    if mentions(["px", "py", "pz"]) {
        obj.position = position;
    }
    if mentions(["sx", "sy", "sz"]) {
        obj.scale = scale;
    }
    if mentions(["rx", "ry", "rz"]) {
        obj.rotation = rotation;
    }
}

/// Where to center a standalone build so it doesn't overlap anything already in the scene: the spot
/// the caller is looking at if it's free, otherwise the closest free spot on rings around it.
/// The build counts as one box; flat planes (ground patches) and lights are ignored.
fn free_spot(ctx: &ReducerContext, scene_id: u64, plan: &Plan) -> (f64, f64) {
    let mut build: Option<([f64; 3], [f64; 3])> = None;
    for s in plan.creates.iter().filter(|s| s.kind != "plane") {
        let (lo, hi) = bounds(s, plan.center);
        build = Some(match build {
            None => (lo, hi),
            Some((a, b)) => ([a[0].min(lo[0]), a[1].min(lo[1]), a[2].min(lo[2])], [b[0].max(hi[0]), b[1].max(hi[1]), b[2].max(hi[2])]),
        });
    }
    let Some((lo, hi)) = build else {
        return plan.center;
    };

    // Big builds look further for room (in bigger steps, below): far enough to clear a neighbor as big
    // as themselves, so a second city doesn't land on the first. Small builds search as before.
    let radius = FREE_SPACE_RADIUS + (hi[0] - lo[0]).max(hi[2] - lo[2]) * 2.5;

    // Everything already within reach of any spot we might try.
    let reach = radius + FREE_SPACE_GAP;
    let others: Vec<([f64; 3], [f64; 3])> = ctx
        .db
        .object()
        .scene_id()
        .filter(scene_id)
        .filter(|o| o.kind != "plane" && known_kind(&o.kind))
        .map(|o| bounds(&from_row(&o, (0.0, 0.0)), (0.0, 0.0)))
        .filter(|(a, b)| b[0] >= lo[0] - reach && a[0] <= hi[0] + reach && b[2] >= lo[2] - reach && a[2] <= hi[2] + reach)
        .collect();

    // Free if, against every other box, the build is apart on x, on z (by the gap) or on y.
    let fits = |dx: f64, dz: f64| {
        others.iter().all(|(a, b)| {
            lo[0] + dx >= b[0] + FREE_SPACE_GAP
                || hi[0] + dx + FREE_SPACE_GAP <= a[0]
                || lo[2] + dz >= b[2] + FREE_SPACE_GAP
                || hi[2] + dz + FREE_SPACE_GAP <= a[2]
                || lo[1] >= b[1]
                || hi[1] <= a[1]
        })
    };
    let at = |dx: f64, dz: f64| {
        ((plan.center.0 + dx).clamp(-WORLD_LIMIT, WORLD_LIMIT), (plan.center.1 + dz).clamp(-WORLD_LIMIT, WORLD_LIMIT))
    };

    if fits(0.0, 0.0) {
        return plan.center;
    }
    // Bigger builds search in bigger steps (fewer spots to check, and they need the room anyway).
    let step = FREE_SPACE_STEP.max((hi[0] - lo[0]).max(hi[2] - lo[2]) / 4.0);
    let mut r = step;
    while r <= radius {
        let n = (std::f64::consts::TAU * r / step).ceil() as usize;
        for k in 0..n {
            let angle = std::f64::consts::TAU * k as f64 / n as f64;
            let (dx, dz) = (r * angle.cos(), r * angle.sin());
            if fits(dx, dz) {
                return at(dx, dz);
            }
        }
        r += step;
    }
    plan.center // no room nearby: build it where it was asked for
}

/// A shape's axis-aligned bounds (min, max) in world space. A rotated shape gets a cube that fits it.
fn bounds(s: &AiShape, center: (f64, f64)) -> ([f64; 3], [f64; 3]) {
    let half = if s.rot.iter().any(|r| r.abs() > 1.0) {
        let m = s.size[0].max(s.size[1]).max(s.size[2]) / 2.0;
        [m, m, m]
    } else {
        [s.size[0] / 2.0, s.size[1] / 2.0, s.size[2] / 2.0]
    };
    let c = [center.0 + s.pos[0], s.pos[1], center.1 + s.pos[2]];
    ([c[0] - half[0], c[1] - half[1], c[2] - half[2]], [c[0] + half[0], c[1] + half[1], c[2] + half[2]])
}

/// The object, if it's still in this scene and nobody else holds an active lock on it.
fn editable(ctx: &ReducerContext, id: u64, scene_id: u64, me: Identity, skipped: &mut u32) -> Option<Object> {
    let obj = ctx.db.object().id().find(id).filter(|o| o.scene_id == scene_id)?;
    let locked_by_other = match (obj.locked_by, obj.lock_expires_at) {
        (Some(who), Some(expires)) => who != me && expires > ctx.timestamp,
        _ => false,
    };
    if locked_by_other {
        *skipped += 1;
        return None;
    }
    Some(obj)
}

fn new_object(scene_id: u64, kind: String, color: String, position: Vec3, rotation: Vec3, scale: Vec3) -> Object {
    Object { id: 0, scene_id, kind, color, position, rotation, scale, locked_by: None, lock_expires_at: None, lock_seq: 0 }
}

fn state_of(o: &Object) -> ObjectState {
    ObjectState { id: o.id, kind: o.kind.clone(), color: o.color.clone(), position: o.position, rotation: o.rotation, scale: o.scale }
}

/// Posts a public notice and keeps only the newest EVENTS_KEPT per scene.
fn log_event(ctx: &ReducerContext, who: Identity, scene_id: u64, prompt: &str, r: &AiResult, undo: bool) {
    ctx.db.ai_event().insert(AiEvent {
        id: 0,
        scene_id,
        who,
        prompt: prompt.to_string(),
        added: r.added,
        changed: r.changed,
        removed: r.removed,
        undo,
        at: ctx.timestamp,
    });
    let mut ids: Vec<u64> = ctx.db.ai_event().scene_id().filter(scene_id).map(|e| e.id).collect();
    ids.sort_unstable();
    for id in &ids[..ids.len().saturating_sub(EVENTS_KEPT)] {
        ctx.db.ai_event().id().delete(*id);
    }
}

// ---------------------------------------------------------------------------------------------
// Converting between Gemini's shapes and object rows

/// Bounding-box size in meters of each kind at scale 1, as the client builds it
/// (client/src/multiplayer.js KINDS). Planes are handled separately: they lie flat.
fn base_size(kind: &str) -> [f64; 3] {
    if let Some(m) = model_by_kind(kind) {
        return m.3; // the model file's own size; the client centers it on the object
    }
    match kind {
        "sphere" | "icosahedron" => [2.0, 2.0, 2.0], // radius 1
        "cylinder" | "cone" => [2.0, 1.0, 2.0],      // radius 1, height 1
        "capsule" => [2.0, 3.0, 2.0],                // radius 1, middle section 1
        "torus" => [2.8, 2.8, 0.8],                  // radius 1, tube 0.4, facing z
        _ => [1.0, 1.0, 1.0],                        // box
    }
}

fn to_row(s: &AiShape, center: (f64, f64)) -> (Vec3, Vec3, Vec3) {
    let position = vec3(center.0 + s.pos[0], s.pos[1], center.1 + s.pos[2]);
    if s.kind == "plane" {
        // The client's plane stands upright: lay it flat, then turn it around y.
        return (position, vec3(-FRAC_PI_2, 0.0, s.rot[1].to_radians()), vec3(s.size[0], s.size[2], 1.0));
    }
    let b = base_size(&s.kind);
    let rotation = vec3(s.rot[0].to_radians(), s.rot[1].to_radians(), s.rot[2].to_radians());
    (position, rotation, vec3(s.size[0] / b[0], s.size[1] / b[1], s.size[2] / b[2]))
}

fn from_row(o: &Object, center: (f64, f64)) -> AiShape {
    let (s, r) = (o.scale, o.rotation);
    let (size, rot) = if o.kind == "plane" {
        ([s.x as f64, 0.02, s.y as f64], [0.0, (r.z as f64).to_degrees(), 0.0])
    } else {
        let b = base_size(&o.kind);
        (
            [s.x as f64 * b[0], s.y as f64 * b[1], s.z as f64 * b[2]],
            [(r.x as f64).to_degrees(), (r.y as f64).to_degrees(), (r.z as f64).to_degrees()],
        )
    };
    AiShape {
        kind: o.kind.clone(),
        color: o.color.clone(),
        pos: [o.position.x as f64 - center.0, o.position.y as f64, o.position.z as f64 - center.1],
        size,
        rot,
    }
}

/// A shape as JSON for the prompt, rounded to centimeters and whole degrees.
fn shape_json(id: Option<u64>, s: &AiShape) -> Value {
    let cm = |v: f64| (v * 100.0).round() / 100.0;
    let mut v = json!({
        "kind": s.kind, "color": s.color,
        "px": cm(s.pos[0]), "py": cm(s.pos[1]), "pz": cm(s.pos[2]),
        "sx": cm(s.size[0]), "sy": cm(s.size[1]), "sz": cm(s.size[2]),
        "rx": s.rot[0].round(), "ry": s.rot[1].round(), "rz": s.rot[2].round(),
    });
    if let Some(id) = id {
        v["id"] = json!(id);
    }
    if let Some(m) = model_by_kind(&s.kind) {
        v["kind"] = json!("model");
        v["model"] = json!(m.0);
    }
    v
}

fn vec3(x: f64, y: f64, z: f64) -> Vec3 {
    Vec3 { x: x as f32, y: y as f32, z: z as f32 }
}

fn number(v: &Value) -> Option<f64> {
    v.as_f64().filter(|x| x.is_finite())
}

// Same "#rrggbb" rule as validate_color in reducers/objects.rs.
fn color(c: &str) -> Option<String> {
    let c = c.to_lowercase();
    let valid = c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|ch| ch.is_ascii_hexdigit());
    valid.then_some(c)
}

// Keeps error messages short (Gemini error bodies can be long).
fn short(s: &str) -> String {
    s.chars().take(300).collect()
}

// ---------------------------------------------------------------------------------------------
// Models: low-poly Kenney.nl kits (CC0), in client/public/assets/kenney/<path>.glb.
// (id Gemini uses, path, description, size in the file's own units, meters per unit). The client
// centers each model on its object, so a model's object works like any other shape; its default
// size is its file size times meters-per-unit, and Gemini can scale it uniformly from there.

type Model = (&'static str, &'static str, &'static str, [f64; 3], f64);

fn model_by_id(id: &str) -> Option<&'static Model> {
    MODELS.iter().find(|m| m.0 == id)
}

/// The model an object shows: its kind is "asset:<path>".
fn model_by_kind(kind: &str) -> Option<&'static Model> {
    let path = kind.strip_prefix("asset:")?;
    MODELS.iter().find(|m| m.1 == path)
}

fn known_kind(kind: &str) -> bool {
    KINDS.contains(&kind) || model_by_kind(kind).is_some()
}

fn default_size(m: &Model) -> [f64; 3] {
    m.3.map(|v| v * m.4)
}

/// A model Gemini placed: its listed size, scaled evenly by "sy" (or "sx" or "sz") when given.
fn model_shape(m: &Model, a: &Value) -> AiShape {
    let size = default_size(m);
    let blank = AiShape { kind: format!("asset:{}", m.1), color: DEFAULT_COLOR.to_string(), pos: [0.0; 3], size, rot: [0.0; 3] };
    let mut s = merge(blank, a);
    s.size = scaled_evenly(size, a);
    s
}

/// `size` scaled by one factor, taken from the first of sy, sx, sz that Gemini gave.
fn scaled_evenly(size: [f64; 3], a: &Value) -> [f64; 3] {
    let factor = [("sy", 1), ("sx", 0), ("sz", 2)]
        .iter()
        .find_map(|(k, i)| number(&a[*k]).filter(|_| size[*i] > 1e-6).map(|v| v / size[*i]))
        .unwrap_or(1.0);
    let (smallest, largest) = (size.iter().cloned().fold(f64::MAX, f64::min), size.iter().cloned().fold(0.0, f64::max));
    let factor = factor.clamp(MIN_SIZE / smallest.max(1e-6), (MAX_SIZE / largest.max(1e-6)).max(MIN_SIZE / smallest.max(1e-6)));
    size.map(|v| v * factor)
}

const MODELS: &[Model] = &[
    ("tree_oak", "nature-kit/tree_oak", "leafy oak tree", [0.641, 1.226, 0.74], 5.0),
    ("tree_round", "nature-kit/tree_default", "round leafy tree", [0.755, 1.708, 0.654], 5.0),
    ("tree_tall", "nature-kit/tree_tall", "tall leafy tree", [0.4, 1.688, 0.461], 5.0),
    ("tree_wide", "nature-kit/tree_fat", "wide bushy tree", [0.755, 1.15, 0.654], 5.0),
    ("tree_autumn", "nature-kit/tree_default_fall", "orange autumn tree", [0.755, 1.708, 0.654], 5.0),
    ("pine_tall", "nature-kit/tree_pineTallA", "tall pine tree", [0.386, 1.53, 0.392], 5.0),
    ("pine_round", "nature-kit/tree_pineRoundA", "round pine tree", [0.617, 1.366, 0.712], 5.0),
    ("pine_small", "nature-kit/tree_pineSmallA", "small pine tree", [0.5, 0.967, 0.5], 5.0),
    ("palm_tree", "nature-kit/tree_palmTall", "tall palm tree", [1.034, 1.356, 1.034], 5.0),
    ("palm_tree_bent", "nature-kit/tree_palmBend", "bent palm tree", [0.935, 1.38, 1.013], 5.0),
    ("bush", "nature-kit/plant_bush", "small bush", [0.396, 0.244, 0.396], 5.0),
    ("bush_large", "nature-kit/plant_bushLarge", "large bush", [0.374, 0.243, 0.336], 5.0),
    ("rock_large", "nature-kit/rock_largeA", "large brown rock", [0.785, 0.26, 1.015], 5.0),
    ("rock_tall", "nature-kit/rock_tallA", "tall rock spire", [0.983, 0.996, 0.683], 5.0),
    ("rock_small", "nature-kit/rock_smallA", "small rock", [0.361, 0.191, 0.361], 2.5),
    ("stone_large", "nature-kit/stone_largeA", "large gray boulder", [0.785, 0.26, 1.015], 5.0),
    ("flowers_red", "nature-kit/flower_redA", "red flowers", [0.159, 0.292, 0.181], 2.0),
    ("flowers_yellow", "nature-kit/flower_yellowA", "yellow flowers", [0.159, 0.192, 0.181], 2.0),
    ("flowers_purple", "nature-kit/flower_purpleA", "purple flowers", [0.159, 0.242, 0.181], 2.0),
    ("grass_tuft", "nature-kit/grass_large", "tuft of tall grass", [0.409, 0.254, 0.408], 2.5),
    ("mushrooms", "nature-kit/mushroom_redGroup", "cluster of red mushrooms", [0.27, 0.25, 0.254], 2.5),
    ("log", "nature-kit/log", "fallen log", [0.234, 0.173, 0.71], 5.0),
    ("log_pile", "nature-kit/log_stack", "pile of firewood logs", [0.425, 0.346, 0.71], 5.0),
    ("stump", "nature-kit/stump_round", "tree stump", [0.321, 0.206, 0.371], 5.0),
    ("campfire", "nature-kit/campfire_stones", "campfire in a ring of stones", [0.541, 0.078, 0.516], 2.2),
    ("tent", "nature-kit/tent_detailedOpen", "camping tent, open", [0.875, 0.561, 0.666], 5.0),
    ("fence_wood", "nature-kit/fence_simple", "wooden fence section", [1.0, 0.345, 0.07], 5.0),
    ("fence_gate", "nature-kit/fence_gate", "wooden fence gate", [1.0, 0.345, 0.07], 5.0),
    ("signpost", "nature-kit/sign", "wooden signpost", [0.3, 0.409, 0.07], 5.0),
    ("footbridge", "nature-kit/bridge_wood", "wooden footbridge", [1.04, 0.4, 1.04], 5.0),
    ("canoe", "nature-kit/canoe", "canoe", [0.3, 0.183, 1.15], 5.0),
    ("cactus", "nature-kit/cactus_tall", "tall cactus", [0.396, 0.75, 0.339], 5.0),
    ("pumpkin", "nature-kit/crop_pumpkin", "pumpkin", [0.441, 0.334, 0.452], 3.0),
    ("stone_column", "nature-kit/statue_column", "stone column", [0.3, 1.0, 0.3], 5.0),
    ("obelisk", "nature-kit/statue_obelisk", "stone obelisk", [0.307, 0.875, 0.307], 5.0),
    ("tower_base", "castle-kit/tower-square-base", "square castle tower, bottom section (stack tower_mid and tower_top on it)", [1.0, 1.01, 1.0], 4.0),
    ("tower_mid", "castle-kit/tower-square-mid-windows", "square tower middle section with windows", [0.93, 1.01, 0.93], 4.0),
    ("tower_top", "castle-kit/tower-square-top-roof", "square tower top with a pointed roof", [1.0, 1.0, 1.0], 4.0),
    ("round_tower_base", "castle-kit/tower-hexagon-base", "round castle tower, bottom section", [0.9, 1.31, 0.779], 4.0),
    ("round_tower_mid", "castle-kit/tower-hexagon-mid", "round tower middle section", [0.952, 0.46, 0.825], 4.0),
    ("round_tower_roof", "castle-kit/tower-hexagon-roof", "round tower cone roof", [0.976, 0.83, 0.846], 4.0),
    ("castle_wall", "castle-kit/wall", "castle wall section", [1.0, 1.31, 1.0], 4.0),
    ("castle_wall_corner", "castle-kit/wall-corner", "castle wall corner", [1.0, 1.31, 1.0], 4.0),
    ("castle_wall_doorway", "castle-kit/wall-doorway", "castle wall with a doorway", [0.5, 1.31, 1.0], 4.0),
    ("castle_gate", "castle-kit/gate", "castle gatehouse", [0.152, 0.91, 0.662], 4.0),
    ("drawbridge", "castle-kit/bridge-draw", "drawbridge", [1.002, 0.1, 0.831], 4.0),
    ("banner", "castle-kit/flag-banner-long", "tall banner flag", [0.04, 2.17, 0.63], 4.0),
    ("catapult", "castle-kit/siege-catapult", "catapult", [1.735, 1.33, 1.21], 4.0),
    ("trebuchet", "castle-kit/siege-trebuchet", "trebuchet", [1.851, 1.959, 1.258], 4.0),
    ("stone_stairs", "castle-kit/stairs-stone", "stone stairs", [0.233, 0.675, 0.819], 4.0),
    ("cart", "fantasy-town-kit/cart", "wooden cart", [0.893, 0.536, 1.34], 2.5),
    ("market_stall_red", "fantasy-town-kit/stall-red", "market stall with a red awning", [1.0, 1.237, 1.0], 2.5),
    ("market_stall_green", "fantasy-town-kit/stall-green", "market stall with a green awning", [1.0, 1.237, 1.0], 2.5),
    ("fountain", "fantasy-town-kit/fountain-round-detail", "round stone fountain", [2.0, 0.48, 2.0], 2.5),
    ("street_lantern", "fantasy-town-kit/lantern", "street lantern on a post", [0.216, 1.556, 0.224], 2.5),
    ("windmill", "fantasy-town-kit/windmill", "windmill", [0.471, 3.113, 3.113], 2.5),
    ("watermill", "fantasy-town-kit/watermill", "watermill", [0.85, 1.799, 1.799], 2.5),
    ("red_banner", "fantasy-town-kit/banner-red", "red hanging banner", [0.05, 0.839, 0.5], 2.5),
    ("hedge", "fantasy-town-kit/hedge-large", "large hedge", [0.4, 0.6, 1.0], 2.5),
    ("tree_tall_round", "fantasy-town-kit/tree-high-round", "tall round tree", [1.019, 2.751, 1.019], 2.5),
    ("tree_crooked", "fantasy-town-kit/tree-crooked", "crooked tree", [1.023, 2.413, 1.023], 2.5),
    ("stone_pillar", "fantasy-town-kit/pillar-stone", "stone pillar", [0.16, 1.0, 0.16], 2.5),
    ("wooden_bench", "fantasy-town-kit/stall-bench", "wooden bench", [0.26, 0.226, 0.94], 2.5),
    ("house_a", "city-kit-suburban/building-type-a", "suburban house, style A", [1.3, 0.834, 1.028], 7.0),
    ("house_b", "city-kit-suburban/building-type-b", "suburban house, style B", [1.828, 1.138, 1.14], 7.0),
    ("house_c", "city-kit-suburban/building-type-c", "suburban house, style C", [1.286, 1.034, 1.028], 7.0),
    ("house_d", "city-kit-suburban/building-type-d", "suburban house, style D", [1.756, 1.238, 1.028], 7.0),
    ("house_e", "city-kit-suburban/building-type-e", "suburban house, style E", [1.3, 1.138, 1.028], 7.0),
    ("house_f", "city-kit-suburban/building-type-f", "suburban house, style F", [1.428, 1.138, 1.406], 7.0),
    ("house_g", "city-kit-suburban/building-type-g", "suburban house, style G", [1.45, 0.768, 1.178], 7.0),
    ("house_h", "city-kit-suburban/building-type-h", "suburban house, style H", [1.3, 0.737, 0.916], 7.0),
    ("house_i", "city-kit-suburban/building-type-i", "suburban house, style I", [1.286, 0.737, 1.028], 7.0),
    ("house_j", "city-kit-suburban/building-type-j", "suburban house, style J", [1.37, 1.038, 0.916], 7.0),
    ("garden_fence", "city-kit-suburban/fence-1x3", "garden fence", [1.275, 0.27, 0.438], 7.0),
    ("planter", "city-kit-suburban/planter", "flower planter box", [0.4, 0.177, 0.3], 7.0),
    ("car_sedan", "car-kit/sedan", "sedan car", [1.5, 1.3, 2.55], 1.8),
    ("car_sports", "car-kit/sedan-sports", "sports car", [1.3, 1.1, 2.55], 1.8),
    ("car_hatchback", "car-kit/hatchback-sports", "hatchback car", [1.3, 1.1, 2.85], 1.8),
    ("car_suv", "car-kit/suv", "SUV", [1.5, 1.3, 2.7], 1.8),
    ("taxi", "car-kit/taxi", "taxi", [1.5, 1.5, 2.75], 1.8),
    ("police_car", "car-kit/police", "police car", [1.5, 1.3, 3.1], 1.8),
    ("ambulance", "car-kit/ambulance", "ambulance", [1.5, 1.8, 3.25], 1.8),
    ("fire_truck", "car-kit/firetruck", "fire truck", [1.5, 1.7, 3.4], 1.8),
    ("truck", "car-kit/truck", "pickup truck", [1.5, 1.3, 2.95], 1.8),
    ("van", "car-kit/van", "van", [1.5, 1.35, 2.75], 1.8),
    ("delivery_truck", "car-kit/delivery", "delivery truck", [1.5, 1.65, 3.25], 1.8),
    ("garbage_truck", "car-kit/garbage-truck", "garbage truck", [1.6, 1.6, 3.45], 1.8),
    ("tractor", "car-kit/tractor", "farm tractor", [1.342, 1.602, 2.202], 1.8),
    ("race_car", "car-kit/race", "race car", [1.3, 0.733, 2.56], 1.8),
    ("traffic_cone", "car-kit/cone", "traffic cone", [0.476, 0.595, 0.476], 1.8),
    ("chair", "furniture-kit/chair", "wooden chair", [0.2, 0.47, 0.2], 2.0),
    ("dining_table", "furniture-kit/table", "dining table", [0.841, 0.327, 0.447], 2.0),
    ("round_table", "furniture-kit/tableRound", "round table", [0.693, 0.367, 0.8], 2.0),
    ("coffee_table", "furniture-kit/tableCoffee", "coffee table", [0.661, 0.23, 0.4], 2.0),
    ("desk", "furniture-kit/desk", "desk", [0.734, 0.384, 0.392], 2.0),
    ("sofa", "furniture-kit/loungeSofa", "sofa", [0.98, 0.46, 0.41], 2.0),
    ("armchair", "furniture-kit/loungeChair", "armchair", [0.49, 0.46, 0.41], 2.0),
    ("double_bed", "furniture-kit/bedDouble", "double bed", [0.956, 0.375, 1.125], 2.0),
    ("bookcase", "furniture-kit/bookcaseOpen", "bookcase", [0.4, 0.88, 0.25], 2.0),
    ("floor_lamp", "furniture-kit/lampSquareFloor", "floor lamp", [0.12, 0.86, 0.12], 2.0),
    ("potted_plant", "furniture-kit/pottedPlant", "potted plant", [0.212, 0.654, 0.241], 2.0),
    ("television", "furniture-kit/televisionModern", "flat-screen TV", [0.685, 0.455, 0.128], 2.0),
    ("fridge", "furniture-kit/kitchenFridge", "fridge", [0.43, 0.92, 0.292], 2.0),
    ("stove", "furniture-kit/kitchenStove", "kitchen stove", [0.43, 0.45, 0.45], 2.0),
    ("bathtub", "furniture-kit/bathtub", "bathtub", [1.19, 0.42, 0.56], 2.0),
    ("round_rug", "furniture-kit/rugRound", "round rug", [0.92, 0.01, 0.92], 2.0),
    ("bench", "furniture-kit/bench", "bench", [0.4, 0.47, 0.2], 2.0),
    ("snowman", "holiday-kit/snowman", "snowman", [1.103, 1.064, 0.688], 1.7),
    ("christmas_tree", "holiday-kit/tree-decorated", "decorated Christmas tree", [1.19, 2.29, 1.19], 1.7),
    ("snowy_pine", "holiday-kit/tree-snow-a", "snow-covered pine tree", [1.19, 1.92, 1.19], 1.7),
    ("present", "holiday-kit/present-a-cube", "wrapped present", [0.45, 0.571, 0.45], 1.7),
    ("present_round", "holiday-kit/present-b-round", "round wrapped present", [0.549, 0.471, 0.549], 1.7),
    ("candy_cane", "holiday-kit/candy-cane-red", "candy cane", [0.298, 0.452, 0.1], 1.7),
    ("sled", "holiday-kit/sled", "sled", [0.625, 0.375, 1.0], 1.7),
    ("reindeer", "holiday-kit/reindeer", "reindeer", [0.625, 1.122, 1.071], 1.7),
    ("gingerbread_man", "holiday-kit/gingerbread-man", "gingerbread man", [0.339, 0.376, 0.08], 1.7),
    ("nutcracker", "holiday-kit/nutcracker", "nutcracker soldier", [0.548, 1.078, 0.347], 1.7),
    ("toy_train", "holiday-kit/train-locomotive", "toy train locomotive", [0.67, 0.428, 0.265], 1.7),
    ("snow_pile", "holiday-kit/snow-pile", "pile of snow", [0.993, 0.2, 1.114], 1.7),
];
