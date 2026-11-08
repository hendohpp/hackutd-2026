use spacetimedb::{ReducerContext, Table};

use crate::reducers::objects::release_user_locks;
use crate::tables::{presence, user, User};

#[spacetimedb::reducer(client_connected)]
pub fn client_connected(ctx: &ReducerContext) {
    if ctx.db.user().identity().find(ctx.sender).is_none() {
        ctx.db.user().insert(User {
            identity: ctx.sender,
            name: "Guest".to_string(),
            color: "#888888".to_string(),
        });
    }
}

#[spacetimedb::reducer(client_disconnected)]
pub fn client_disconnected(ctx: &ReducerContext) {
    release_user_locks(ctx, ctx.sender);
    ctx.db.presence().identity().delete(ctx.sender);
}
