use spacetimedb::{Identity, ReducerContext, ScheduleAt, Table, TimeDuration};

use crate::math::Vec3;
use crate::reducers::scenes::is_member;
use crate::tables::{lock_expiry, object, LockExpiry, Object};

fn lock_duration() -> TimeDuration {
    TimeDuration::from_micros(30_000_000) // 30 seconds
}

/// Returns Ok if the sender holds an unexpired lock on the object.
fn require_lock(ctx: &ReducerContext, obj: &Object) -> Result<(), String> {
    let held = obj.locked_by == Some(ctx.sender)
        && obj.lock_expires_at.map_or(false, |exp| exp > ctx.timestamp);
    if held {
        Ok(())
    } else {
        Err("you do not hold an active lock on this object".to_string())
    }
}

/// Releases every lock held by the given user. Used on disconnect.
pub fn release_user_locks(ctx: &ReducerContext, who: Identity) {
    let held: Vec<Object> = ctx
        .db
        .object()
        .iter()
        .filter(|o| o.locked_by == Some(who))
        .collect();
    for mut obj in held {
        obj.locked_by = None;
        obj.lock_expires_at = None;
        ctx.db.object().id().update(obj);
    }
}

#[spacetimedb::reducer]
pub fn create_object(
    ctx: &ReducerContext,
    scene_id: u64,
    kind: String,
    position: Vec3,
    rotation: Vec3,
    scale: Vec3,
) -> Result<(), String> {
    if !is_member(ctx, scene_id) {
        return Err("not a member of this scene".to_string());
    }
    ctx.db.object().insert(Object {
        id: 0,
        scene_id,
        kind,
        position,
        rotation,
        scale,
        locked_by: None,
        lock_expires_at: None,
        lock_seq: 0,
    });
    Ok(())
}

#[spacetimedb::reducer]
pub fn lock_object(ctx: &ReducerContext, object_id: u64) -> Result<(), String> {
    let mut obj = ctx
        .db
        .object()
        .id()
        .find(object_id)
        .ok_or_else(|| "object not found".to_string())?;

    if !is_member(ctx, obj.scene_id) {
        return Err("not a member of this scene".to_string());
    }

    let now = ctx.timestamp;
    let locked_by_other = match (obj.locked_by, obj.lock_expires_at) {
        (Some(who), Some(exp)) => who != ctx.sender && exp > now,
        _ => false,
    };
    if locked_by_other {
        return Err("object is locked by another user".to_string());
    }

    obj.lock_seq += 1;
    let expires_at = now + lock_duration();
    obj.locked_by = Some(ctx.sender);
    obj.lock_expires_at = Some(expires_at);
    let seq = obj.lock_seq;
    ctx.db.object().id().update(obj);

    ctx.db.lock_expiry().insert(LockExpiry {
        scheduled_id: 0,
        scheduled_at: ScheduleAt::Time(expires_at),
        object_id,
        lock_seq: seq,
    });
    Ok(())
}

#[spacetimedb::reducer]
pub fn unlock_object(ctx: &ReducerContext, object_id: u64) -> Result<(), String> {
    let mut obj = ctx
        .db
        .object()
        .id()
        .find(object_id)
        .ok_or_else(|| "object not found".to_string())?;

    if obj.locked_by != Some(ctx.sender) {
        return Err("you do not hold this lock".to_string());
    }
    obj.locked_by = None;
    obj.lock_expires_at = None;
    ctx.db.object().id().update(obj);
    Ok(())
}

#[spacetimedb::reducer]
pub fn update_object_transform(
    ctx: &ReducerContext,
    object_id: u64,
    position: Vec3,
    rotation: Vec3,
    scale: Vec3,
) -> Result<(), String> {
    let mut obj = ctx
        .db
        .object()
        .id()
        .find(object_id)
        .ok_or_else(|| "object not found".to_string())?;

    require_lock(ctx, &obj)?;
    obj.position = position;
    obj.rotation = rotation;
    obj.scale = scale;
    ctx.db.object().id().update(obj);
    Ok(())
}

#[spacetimedb::reducer]
pub fn delete_object(ctx: &ReducerContext, object_id: u64) -> Result<(), String> {
    let obj = ctx
        .db
        .object()
        .id()
        .find(object_id)
        .ok_or_else(|| "object not found".to_string())?;

    if !is_member(ctx, obj.scene_id) {
        return Err("not a member of this scene".to_string());
    }
    require_lock(ctx, &obj)?;
    ctx.db.object().id().delete(object_id);
    Ok(())
}

/// Scheduled reducer. Clears the lock only if the sequence still matches,
/// so a stale timer cannot release a lock that was re-acquired later.
#[spacetimedb::reducer]
pub fn expire_lock(ctx: &ReducerContext, timer: LockExpiry) {
    if let Some(mut obj) = ctx.db.object().id().find(timer.object_id) {
        if obj.lock_seq == timer.lock_seq {
            obj.locked_by = None;
            obj.lock_expires_at = None;
            ctx.db.object().id().update(obj);
        }
    }
}
