use spacetimedb::rand::Rng;
use spacetimedb::{ReducerContext, Table};

use crate::reducers::objects::release_user_locks;
use crate::tables::{presence, user, viewer, User};

const COLORS: [&str; 10] = [
    "#e53935", "#d81b60", "#8e24aa", "#5e35b1", "#3949ab",
    "#1e88e5", "#00897b", "#43a047", "#f4511e", "#6d4c41",
];

const OLD_PLACEHOLDER_COLOR: &str = "#888888";

#[spacetimedb::reducer(client_connected)]
pub fn client_connected(ctx: &ReducerContext) {
    let auth_ctx = ctx.sender_auth();
    
    // Extract the name or subject from the JWT if available
    let name = match auth_ctx.jwt() {
        Some(jwt) => {
            // You can trim the subject string for a clean default display name
            let sub = jwt.subject();
            let short_sub = &sub[..6.min(sub.len())];
            format!("User_{short_sub}")
        }
        None => "Guest".to_string(),
    };

    match ctx.db.user().identity().find(ctx.sender()) {
        None => {
            let color = pick_color(ctx);
            ctx.db.user().insert(User {
                identity: ctx.sender(),
                name,
                color,
            });
        }
        Some(user) if user.color == OLD_PLACEHOLDER_COLOR => {
            let color = pick_color(ctx);
            ctx.db.user().identity().update(User { color, ..user });
        }
        Some(mut user) => {
            // If they reconnect with an authenticated token and were previously a Guest, upgrade them
            if auth_ctx.jwt().is_some() && user.name == "Guest" {
                user.name = name;
                ctx.db.user().identity().update(user);
            }
        }
    }
}

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
