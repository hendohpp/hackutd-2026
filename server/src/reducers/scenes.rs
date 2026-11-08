use spacetimedb::{ReducerContext, Table};

use crate::tables::{scene, scene_member, Scene, SceneMember};

pub fn is_member(ctx: &ReducerContext, scene_id: u64) -> bool {
    ctx.db
        .scene_member()
        .scene_id()
        .filter(scene_id)
        .any(|m| m.identity == ctx.sender)
}

#[spacetimedb::reducer]
pub fn create_scene(ctx: &ReducerContext, name: String) -> Result<(), String> {
    let scene = ctx.db.scene().insert(Scene {
        id: 0,
        name,
        owner: ctx.sender,
    });
    ctx.db.scene_member().insert(SceneMember {
        id: 0,
        scene_id: scene.id,
        identity: ctx.sender,
    });
    Ok(())
}

#[spacetimedb::reducer]
pub fn join_scene(ctx: &ReducerContext, scene_id: u64) -> Result<(), String> {
    if ctx.db.scene().id().find(scene_id).is_none() {
        return Err("scene not found".to_string());
    }
    if is_member(ctx, scene_id) {
        return Ok(());
    }
    ctx.db.scene_member().insert(SceneMember {
        id: 0,
        scene_id,
        identity: ctx.sender,
    });
    Ok(())
}
