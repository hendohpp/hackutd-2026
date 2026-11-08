// ANIMATIONS: objects that keep moving (spin, orbit, bob, sway, or follow a path).
//
// A row says how an object moves, not where it is each frame. Every browser plays it from the object's
// own position and the server clock (started_at), so everyone sees the same motion without the server
// sending positions 60 times a second. The pivot and path are offsets from the object's position (world
// axes), so moving an object takes its animation along.
//
// - set_animation / clear_animation: start or stop an animation on an object in a scene you're in.
// - The AI (ai.rs) starts animations through an "anim" field on new objects and an "animate" action on
//   existing ones: parse_ai / AiAnim below, then put / forget.
// - Deleting an object deletes its animation (forget, from delete_object and the AI's deletes).

use serde_json::Value;
use spacetimedb::{ReducerContext, Table, Timestamp};

use crate::math::Vec3;
use crate::reducers::scenes::is_member;
use crate::tables::object;

pub const KINDS: [&str; 5] = ["spin", "orbit", "bob", "sway", "path"];
const MAX_PATH_POINTS: usize = 32;
const MAX_OFFSET: f32 = 1000.0; // meters

#[spacetimedb::table(accessor = animation, public)]
pub struct Animation {
    #[primary_key]
    pub object_id: u64,
    #[index(btree)]
    pub scene_id: u64,
    pub kind: String,    // spin | orbit | bob | sway | path
    pub axis: Vec3,      // unit vector: what it turns around (spin, orbit, sway), or which way it bobs
    pub period: f32,     // seconds for one turn, one back-and-forth, one lap, or one loop of the path
    pub amount: f32,     // bob: meters each way; sway: degrees each way; spin and orbit: 1 or -1 (direction)
    pub pivot: Vec3,     // spin, orbit, sway: the point it turns around, as an offset from the object
    pub path: Vec<Vec3>, // path: the points it travels through, looping, as offsets from the object
    pub phase: f32,      // 0..1: where in its cycle it starts (copies needn't move in lockstep)
    pub started_at: Timestamp,
}

/// Starts (or replaces) an animation on an object in a scene you're in.
#[spacetimedb::reducer]
#[allow(clippy::too_many_arguments)]
pub fn set_animation(
    ctx: &ReducerContext,
    object_id: u64,
    kind: String,
    axis: Vec3,
    period: f32,
    amount: f32,
    pivot: Vec3,
    path: Vec<Vec3>,
    phase: f32,
) -> Result<(), String> {
    let scene_id = check_object(ctx, object_id)?;
    let row = Animation { object_id, scene_id, kind, axis, period, amount, pivot, path, phase, started_at: ctx.timestamp };
    put(ctx, checked(row)?);
    Ok(())
}

/// Stops an object's animation (it rests at its own position).
#[spacetimedb::reducer]
pub fn clear_animation(ctx: &ReducerContext, object_id: u64) -> Result<(), String> {
    check_object(ctx, object_id)?;
    forget(ctx, object_id);
    Ok(())
}

/// The object's scene, if the sender is in it and nobody else is editing the object.
fn check_object(ctx: &ReducerContext, object_id: u64) -> Result<u64, String> {
    let obj = ctx.db.object().id().find(object_id).ok_or_else(|| "object not found".to_string())?;
    if !is_member(ctx, obj.scene_id) {
        return Err("not a member of this scene".to_string());
    }
    let locked_by_other = matches!((obj.locked_by, obj.lock_expires_at), (Some(who), Some(exp)) if who != ctx.sender() && exp > ctx.timestamp);
    if locked_by_other {
        return Err("object is locked by another user".to_string());
    }
    Ok(obj.scene_id)
}

/// Refuses unknown kinds and paths without two points; clamps every number into a sane range.
pub fn checked(mut a: Animation) -> Result<Animation, String> {
    if !KINDS.contains(&a.kind.as_str()) {
        return Err(format!("unknown animation \"{}\" (use spin, orbit, bob, sway or path)", a.kind));
    }
    let finite = |v: f32, default: f32| if v.is_finite() { v } else { default };
    let length = (a.axis.x * a.axis.x + a.axis.y * a.axis.y + a.axis.z * a.axis.z).sqrt();
    a.axis = if length.is_finite() && length > 1e-6 {
        Vec3 { x: a.axis.x / length, y: a.axis.y / length, z: a.axis.z / length }
    } else {
        Vec3 { x: 0.0, y: 1.0, z: 0.0 }
    };
    a.period = finite(a.period, 4.0).clamp(0.2, 600.0);
    a.amount = match a.kind.as_str() {
        "bob" => finite(a.amount, 0.5).clamp(-50.0, 50.0),
        "sway" => finite(a.amount, 10.0).clamp(-90.0, 90.0),
        _ => {
            if a.amount < 0.0 {
                -1.0
            } else {
                1.0
            }
        }
    };
    let offset = |v: Vec3| Vec3 {
        x: finite(v.x, 0.0).clamp(-MAX_OFFSET, MAX_OFFSET),
        y: finite(v.y, 0.0).clamp(-MAX_OFFSET, MAX_OFFSET),
        z: finite(v.z, 0.0).clamp(-MAX_OFFSET, MAX_OFFSET),
    };
    a.pivot = offset(a.pivot);
    a.path = a.path.into_iter().take(MAX_PATH_POINTS).map(offset).collect();
    if a.kind == "path" && a.path.len() < 2 {
        return Err("a path needs at least 2 points".to_string());
    }
    a.phase = finite(a.phase, 0.0).rem_euclid(1.0);
    Ok(a)
}

/// Starts or replaces the object's animation.
pub fn put(ctx: &ReducerContext, a: Animation) {
    ctx.db.animation().object_id().delete(a.object_id);
    ctx.db.animation().insert(a);
}

/// Stops the object's animation, if it has one.
pub fn forget(ctx: &ReducerContext, object_id: u64) {
    ctx.db.animation().object_id().delete(object_id);
}

// ---------------------------------------------------------------------------------------------
// The AI's side (ai.rs)

/// An animation as the AI writes it. Points are in the build's coordinates (meters from the spot, like
/// positions), so the copy tools can carry them along with a copy.
#[derive(Clone)]
pub struct AiAnim {
    kind: String,
    axis: [f64; 3],
    period: f64,
    amount: f64,
    pivot: Option<[f64; 3]>, // None: the object turns around its own center
    path: Vec<[f64; 3]>,
    phase: f64,
}

/// How an object at world `position` moves, the way the AI writes it (points relative to the spot at
/// `center`, like positions), so it can resend it with a change ("faster", "the other way").
pub fn describe(a: &Animation, position: Vec3, center: (f64, f64)) -> Value {
    let cm = |v: f64| (v * 100.0).round() / 100.0;
    let point = |p: &Vec3| {
        let x = position.x as f64 + p.x as f64 - center.0;
        let y = position.y as f64 + p.y as f64;
        let z = position.z as f64 + p.z as f64 - center.1;
        serde_json::json!([cm(x), cm(y), cm(z)])
    };
    let mut v = serde_json::json!({
        "type": a.kind,
        "axis": [cm(a.axis.x as f64), cm(a.axis.y as f64), cm(a.axis.z as f64)],
        "period": cm(a.period as f64),
        "amount": cm(a.amount as f64),
        "phase": cm(a.phase as f64),
    });
    if a.kind == "path" {
        v["path"] = Value::Array(a.path.iter().map(point).collect());
    } else {
        v["pivot"] = point(&a.pivot);
    }
    v
}

/// Reads {"type": "spin", "axis": "x" | "y" | "z" | [x, y, z], "period": 4, "amount": 1, "pivot": [x, y, z],
/// "path": [[x, y, z], ...], "phase": 0.25}. None for no animation (or "type": "none").
pub fn parse_ai(v: &Value) -> Option<AiAnim> {
    let kind = v["type"].as_str().filter(|k| KINDS.contains(k))?;
    let point = |p: &Value| -> Option<[f64; 3]> {
        let a = p.as_array()?;
        Some([a.first()?.as_f64()?, a.get(1)?.as_f64()?, a.get(2)?.as_f64()?])
    };
    let axis = match &v["axis"] {
        Value::String(s) if s == "x" => [1.0, 0.0, 0.0],
        Value::String(s) if s == "z" => [0.0, 0.0, 1.0],
        other => point(other).unwrap_or([0.0, 1.0, 0.0]),
    };
    let default_amount = match kind {
        "bob" => 0.5,
        "sway" => 10.0,
        _ => 1.0,
    };
    Some(AiAnim {
        kind: kind.to_string(),
        axis,
        period: v["period"].as_f64().unwrap_or(4.0),
        amount: v["amount"].as_f64().unwrap_or(default_amount),
        pivot: point(&v["pivot"]),
        path: v["path"].as_array().map(|ps| ps.iter().filter_map(point).collect()).unwrap_or_default(),
        phase: v["phase"].as_f64().unwrap_or(0.0),
    })
}

impl AiAnim {
    /// A copy moved by `d`: its pivot and path move with it.
    pub fn shift(&mut self, d: [f64; 3]) {
        let add = |p: &mut [f64; 3]| (0..3).for_each(|i| p[i] += d[i]);
        if let Some(p) = &mut self.pivot {
            add(p);
        }
        self.path.iter_mut().for_each(add);
    }

    /// A copy turned around the vertical line through `around` (as ai.rs turn_around does): its pivot,
    /// path and axis swing around with it.
    pub fn turn(&mut self, sin: f64, cos: f64, around: (f64, f64)) {
        let swing = |p: &mut [f64; 3]| {
            let (dx, dz) = (p[0] - around.0, p[2] - around.1);
            p[0] = around.0 + cos * dx + sin * dz;
            p[2] = around.1 - sin * dx + cos * dz;
        };
        if let Some(p) = &mut self.pivot {
            swing(p);
        }
        self.path.iter_mut().for_each(swing);
        let [x, y, z] = self.axis;
        self.axis = [cos * x + sin * z, y, -sin * x + cos * z];
    }

    /// The table row for an object now at world `position`, in a build centered at `center`.
    pub fn to_row(&self, object_id: u64, scene_id: u64, position: Vec3, center: (f64, f64), now: Timestamp) -> Option<Animation> {
        let offset = |p: &[f64; 3]| Vec3 {
            x: (center.0 + p[0] - position.x as f64) as f32,
            y: (p[1] - position.y as f64) as f32,
            z: (center.1 + p[2] - position.z as f64) as f32,
        };
        let row = Animation {
            object_id,
            scene_id,
            kind: self.kind.clone(),
            axis: Vec3 { x: self.axis[0] as f32, y: self.axis[1] as f32, z: self.axis[2] as f32 },
            period: self.period as f32,
            amount: self.amount as f32,
            pivot: self.pivot.as_ref().map(offset).unwrap_or_default(),
            path: self.path.iter().map(offset).collect(),
            phase: self.phase as f32,
            started_at: now,
        };
        checked(row).ok()
    }
}
