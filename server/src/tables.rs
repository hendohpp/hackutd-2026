use spacetimedb::{Identity, ScheduleAt, Timestamp};

use crate::math::Vec3;
use crate::reducers::objects::expire_lock;

#[spacetimedb::table(name = user, public)]
pub struct User {
    #[primary_key]
    pub identity: Identity,
    pub name: String,
    pub color: String,
}

#[spacetimedb::table(name = scene, public)]
pub struct Scene {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub name: String,
    pub owner: Identity,
}

#[spacetimedb::table(name = scene_member, public)]
pub struct SceneMember {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub scene_id: u64,
    pub identity: Identity,
}

#[spacetimedb::table(name = object, public)]
pub struct Object {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub scene_id: u64,
    pub kind: String,
    pub position: Vec3,
    pub rotation: Vec3,
    pub scale: Vec3,
    pub locked_by: Option<Identity>,
    pub lock_expires_at: Option<Timestamp>,
    pub lock_seq: u64,
}

#[spacetimedb::table(name = presence, public)]
pub struct Presence {
    #[primary_key]
    pub identity: Identity,
    pub scene_id: u64,
    pub cursor: Vec3,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(name = lock_expiry, scheduled(expire_lock))]
pub struct LockExpiry {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
    pub object_id: u64,
    pub lock_seq: u64,
}
