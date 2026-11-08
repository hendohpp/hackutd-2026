use spacetimedb::{ReducerContext, Table};

use crate::math::Vec3;
use crate::reducers::scenes::is_member;
use crate::tables::{presence, Presence};

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
