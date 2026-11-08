use spacetimedb::ReducerContext;

use crate::tables::{user, User};

const MAX_NAME_CHARS: usize = 24;

/// Sets the sender's display name, shown on lock labels, camera labels and the online list.
#[spacetimedb::reducer]
pub fn set_name(ctx: &ReducerContext, name: String) -> Result<(), String> {
    let name: String = name.chars().filter(|c| !c.is_control()).collect();
    let name = name.trim().to_string();

    if name.is_empty() {
        return Err("name can't be empty".to_string());
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(format!("name must be at most {MAX_NAME_CHARS} characters"));
    }

    let user = ctx
        .db
        .user()
        .identity()
        .find(ctx.sender())
        .ok_or_else(|| "unknown user".to_string())?;
    ctx.db.user().identity().update(User { name, ..user });
    Ok(())
}
