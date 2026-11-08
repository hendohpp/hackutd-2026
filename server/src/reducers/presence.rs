use spacetimedb::{ReducerContext, Table};

use crate::math::Vec3;
use crate::reducers::scenes::is_member;
use crate::tables::{presence, viewer, Presence, Viewer};

#[spacetimedb::reducer]
pub fn update_cursor(ctx: &ReducerContext, scene_id: u64, cursor: Vec3) -> Result<(), String> {
    if !is_member(ctx, scene_id) {
        return Err("not a member of this scene".to_string());
    }
    let row = Presence {
        identity: ctx.sender(),
        scene_id,
        cursor,
        updated_at: ctx.timestamp,
    };
    if ctx.db.presence().identity().find(ctx.sender()).is_some() {
        ctx.db.presence().identity().update(row);
    } else {
        ctx.db.presence().insert(row);
    }
    Ok(())
}

/// Stores where the sender's camera is and which way it points.
#[spacetimedb::reducer]
pub fn update_viewer(ctx: &ReducerContext, scene_id: u64, position: Vec3, rotation: Vec3) -> Result<(), String> {
    if !is_member(ctx, scene_id) {
        return Err("not a member of this scene".to_string());
    }
    let row = Viewer {
        identity: ctx.sender(),
        scene_id,
        position,
        rotation,
        updated_at: ctx.timestamp,
    };
    if ctx.db.viewer().identity().find(ctx.sender()).is_some() {
        ctx.db.viewer().identity().update(row);
    } else {
        ctx.db.viewer().insert(row);
    }
    Ok(())
}
