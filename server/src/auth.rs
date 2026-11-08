use spacetimedb::{JwtClaims, ReducerContext};

use crate::reducers::users::{clean_name, MAX_NAME_CHARS};

/// Tokens from SpacetimeAuth have this issuer.
pub const SPACETIMEAUTH_ISSUER: &str = "https://auth.spacetimedb.com/oidc";

pub const SPACETIMEAUTH_CLIENT_ID: &str = "client_034tqgLZLkX9U3IhumuLUP";

pub fn signed_in(ctx: &ReducerContext) -> Option<&JwtClaims> {
    let jwt = ctx.sender_auth().jwt()?;
    let ours = !SPACETIMEAUTH_CLIENT_ID.is_empty()
        && jwt.issuer() == SPACETIMEAUTH_ISSUER
        && jwt.audience().iter().any(|aud| aud == SPACETIMEAUTH_CLIENT_ID);
    ours.then_some(jwt)
}

/// Allows signed-in users, and the database itself (scheduled reducers and procedures).
pub fn require_auth(ctx: &ReducerContext) -> Result<(), String> {
    if ctx.sender_auth().is_internal() || signed_in(ctx).is_some() {
        Ok(())
    } else {
        Err("sign in to do this".to_string())
    }
}

/// A display name from the sign-in token: the account's name, preferred_username or nickname,
/// else the part of the email before the @. None if the token has none of them.
pub fn account_name(jwt: &JwtClaims) -> Option<String> {
    let claims: serde_json::Value = serde_json::from_str(jwt.raw_payload()).ok()?;
    let text = |key: &str| claims.get(key).and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let email = text("email");
    let email_name = email.split('@').next().unwrap_or_default().to_string();

    [text("name"), text("preferred_username"), text("nickname"), email_name]
        .iter()
        .map(|raw| clean_name(raw).chars().take(MAX_NAME_CHARS).collect::<String>().trim().to_string())
        .find(|name| !name.is_empty())
}
