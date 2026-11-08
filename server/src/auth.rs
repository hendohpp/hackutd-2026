use spacetimedb::ReducerContext;

pub fn require_auth(ctx: &ReducerContext) -> Result<(), String> {
    let auth = ctx.sender_auth();
    if auth.is_internal() {
        return Ok(());
    }
    
    if auth.jwt().is_none() {
        return Err("unauthorized: authentication token is required".to_string());
    }
    
    Ok(())
}

pub fn get_token_subject(ctx: &ReducerContext) -> Option<String> {
    ctx.sender_auth().jwt().map(|jwt| jwt.subject().to_string())
}