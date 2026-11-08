// Servers. A server is a scene (one shared 3D scene) with an owner, members and an invite code.
//   - create_scene: a signed-in user creates a server and gets its invite code
//   - join_with_code: anyone joins a server with its code
//   - join_scene: the editor opening ?scene=N; members get in, invite-only servers need the code first
//   - my_servers: a per-user view of the servers you belong to, with their invite codes

use spacetimedb::rand::Rng;
use spacetimedb::{Identity, ReducerContext, SpacetimeType, Table, ViewContext};

use crate::auth::require_auth;
use crate::reducers::users::clean_name;
use crate::tables::{scene, scene_invite, scene_member, Scene, SceneInvite, SceneMember};
// read-only table access inside views
use crate::tables::{scene__view, scene_invite__view, scene_member__view};

const MAX_SERVER_NAME_CHARS: usize = 40;

/// Invite codes: 6 characters, without look-alikes (no 0/O, 1/I/L).
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH: usize = 6;

/// Creates a server: a scene owned by the sender, with the sender as its first member and a new
/// invite code. Needs a sign-in, so the server stays with its owner on every device.
#[spacetimedb::reducer]
pub fn create_scene(ctx: &ReducerContext, name: String) -> Result<(), String> {
    require_auth(ctx)?;

    let name = clean_name(&name);
    if name.is_empty() {
        return Err("give your server a name".to_string());
    }
    if name.chars().count() > MAX_SERVER_NAME_CHARS {
        return Err(format!("server names are at most {MAX_SERVER_NAME_CHARS} characters"));
    }

    let scene = ctx.db.scene().insert(Scene {
        id: 0,
        name,
        owner: ctx.sender(),
    });
    add_member(ctx, scene.id);
    let code = new_invite_code(ctx);
    ctx.db.scene_invite().insert(SceneInvite {
        scene_id: scene.id,
        code,
    });
    Ok(())
}

/// Joins the server with this invite code. Case, spaces and dashes don't matter.
#[spacetimedb::reducer]
pub fn join_with_code(ctx: &ReducerContext, code: String) -> Result<(), String> {
    let code = normalize_code(&code);
    let invite = ctx
        .db
        .scene_invite()
        .code()
        .find(&code)
        .ok_or_else(|| "no server has that invite code".to_string())?;
    add_member(ctx, invite.scene_id);
    Ok(())
}

/// The editor calls this when it opens a scene. Members get in. Open scenes (no invite code, like
/// the shared scene 1) let anyone in. Invite-only servers need join_with_code first.
#[spacetimedb::reducer]
pub fn join_scene(ctx: &ReducerContext, scene_id: u64) -> Result<(), String> {
    if ctx.db.scene().id().find(scene_id).is_none() {
        return Err("scene not found".to_string());
    }
    if is_member(ctx, scene_id) {
        return Ok(());
    }
    if ctx.db.scene_invite().scene_id().find(scene_id).is_some() {
        return Err("this server is invite-only: join it with its invite code first".to_string());
    }
    add_member(ctx, scene_id);
    Ok(())
}

pub fn is_member(ctx: &ReducerContext, scene_id: u64) -> bool {
    ctx.db
        .scene_member()
        .scene_id()
        .filter(scene_id)
        .any(|m| m.identity == ctx.sender())
}

fn add_member(ctx: &ReducerContext, scene_id: u64) {
    if !is_member(ctx, scene_id) {
        ctx.db.scene_member().insert(SceneMember {
            id: 0,
            scene_id,
            identity: ctx.sender(),
        });
    }
}

fn normalize_code(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

/// A random code that no other server has. (ctx.rng() is seeded from the call's timestamp: fine
/// for invite codes, not for secrets.)
fn new_invite_code(ctx: &ReducerContext) -> String {
    loop {
        let code: String = (0..CODE_LENGTH)
            .map(|_| CODE_ALPHABET[ctx.rng().gen_range(0..CODE_ALPHABET.len())] as char)
            .collect();
        if ctx.db.scene_invite().code().find(&code).is_none() {
            return code;
        }
    }
}

/// A server you belong to, as the servers page lists it.
#[derive(SpacetimeType)]
pub struct MyServer {
    pub scene_id: u64,
    pub name: String,
    pub owner: Identity,
    /// Empty for open scenes (like the shared scene 1).
    pub invite_code: String,
    pub members: u32,
}

/// The servers the caller belongs to, with their invite codes. Codes live in the private
/// scene_invite table, and this per-user view is the only way to read them, so only a server's
/// members ever see its code.
#[spacetimedb::view(accessor = my_servers, public)]
pub fn my_servers(ctx: &ViewContext) -> Vec<MyServer> {
    ctx.db
        .scene_member()
        .identity()
        .filter(&ctx.sender())
        .filter_map(|member| {
            let scene = ctx.db.scene().id().find(member.scene_id)?;
            let invite_code = ctx
                .db
                .scene_invite()
                .scene_id()
                .find(member.scene_id)
                .map(|invite| invite.code)
                .unwrap_or_default();
            let members = ctx.db.scene_member().scene_id().filter(member.scene_id).count() as u32;
            Some(MyServer {
                scene_id: scene.id,
                name: scene.name,
                owner: scene.owner,
                invite_code,
                members,
            })
        })
        .collect()
}
