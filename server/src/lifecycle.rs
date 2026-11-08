use spacetimedb::rand::Rng;
use spacetimedb::{ReducerContext, Table};

use crate::reducers::objects::release_user_locks;
use crate::tables::{presence, user, viewer, User};

/// Colors for people: saturated enough to stand out on the grey viewport, dark enough for the
/// white text on lock and camera labels.
const COLORS: [&str; 10] = [
    "#e53935", "#d81b60", "#8e24aa", "#5e35b1", "#3949ab",
    "#1e88e5", "#00897b", "#43a047", "#f4511e", "#6d4c41",
];

/// The placeholder color users had before colors were assigned.
const OLD_PLACEHOLDER_COLOR: &str = "#888888";

#[spacetimedb::reducer(client_connected)]
pub fn client_connected(ctx: &ReducerContext) {
    match ctx.db.user().identity().find(ctx.sender()) {
        None => {
            let color = pick_color(ctx);
            ctx.db.user().insert(User {
                identity: ctx.sender(),
                name: "Guest".to_string(),
                color,
            });
        }
        Some(user) if user.color == OLD_PLACEHOLDER_COLOR => {
            let color = pick_color(ctx);
            ctx.db.user().identity().update(User { color, ..user });
        }
        Some(_) => {}
    }
}

/// A random palette color, preferring ones nobody currently in a scene is using.
fn pick_color(ctx: &ReducerContext) -> String {
    let in_use: Vec<String> = ctx
        .db
        .presence()
        .iter()
        .filter_map(|p| ctx.db.user().identity().find(p.identity))
        .map(|u| u.color)
        .collect();
    let free: Vec<&str> = COLORS
        .iter()
        .copied()
        .filter(|c| !in_use.iter().any(|used| used == c))
        .collect();
    let choices = if free.is_empty() { COLORS.to_vec() } else { free };
    choices[ctx.rng().gen_range(0..choices.len())].to_string()
}

#[spacetimedb::reducer(client_disconnected)]
pub fn client_disconnected(ctx: &ReducerContext) {
    release_user_locks(ctx, ctx.sender());
    ctx.db.presence().identity().delete(ctx.sender());
    ctx.db.viewer().identity().delete(ctx.sender());
}
