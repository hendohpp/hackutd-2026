use spacetimedb::{Identity, ScheduleAt, Timestamp};

use crate::math::Vec3;
use crate::reducers::objects::expire_lock;

#[spacetimedb::table(accessor = user, public)]
pub struct User {
    #[primary_key]
    pub identity: Identity,
    pub name: String,
    pub color: String,
}

#[spacetimedb::table(accessor = scene, public)]
pub struct Scene {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub name: String,
    pub owner: Identity,
}

#[spacetimedb::table(accessor = scene_member, public)]
pub struct SceneMember {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub scene_id: u64,
    pub identity: Identity,
}

#[spacetimedb::table(accessor = object, public)]
pub struct Object {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub scene_id: u64,
    pub kind: String,
    pub color: String, // "#rrggbb"
    pub position: Vec3,
    pub rotation: Vec3,
    pub scale: Vec3,
    pub locked_by: Option<Identity>,
    pub lock_expires_at: Option<Timestamp>,
    pub lock_seq: u64,
}

#[spacetimedb::table(accessor = presence, public)]
pub struct Presence {
    #[primary_key]
    pub identity: Identity,
    pub scene_id: u64,
    pub cursor: Vec3,
    pub updated_at: Timestamp,
}

/// Each connected person's camera, so everyone can see where the others are looking.
/// Written by update_viewer (several times a second while the camera moves), deleted on disconnect.
#[spacetimedb::table(accessor = viewer, public)]
pub struct Viewer {
    #[primary_key]
    pub identity: Identity,
    #[index(btree)]
    pub scene_id: u64,
    pub position: Vec3,
    pub rotation: Vec3, // camera Euler angles, XYZ order, radians
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = lock_expiry, scheduled(expire_lock))]
pub struct LockExpiry {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
    pub object_id: u64,
    pub lock_seq: u64,
}
