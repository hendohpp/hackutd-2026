// Optional sign-in with SpacetimeAuth (OpenID Connect). Guests can do everything without it; signing in
// gives you the same identity on every device, and your account's name.
//
// "Sign in" sends you to SpacetimeAuth, which sends you back to this page with ?code=…&state=…. The code
// is traded for tokens (PKCE, no secret in the page), and the ID token becomes the SpacetimeDB connection
// token. The server counts it as signed in only if SpacetimeAuth issued it for SPACETIMEAUTH_CLIENT_ID
// (server/src/auth.rs).

import { UserManager, WebStorageStateStore } from 'oidc-client-ts';

// From the SpacetimeAuth dashboard (Maincloud > coscene-hackutd > SpacetimeAuth > Clients). Client IDs
// are public, so it's fine to commit. Keep it in sync with SPACETIMEAUTH_CLIENT_ID in server/src/auth.rs.
// While empty, the sign-in option is hidden. VITE_SPACETIMEAUTH_CLIENT_ID overrides it for testing.
const SPACETIMEAUTH_CLIENT_ID = import.meta.env.VITE_SPACETIMEAUTH_CLIENT_ID || '';
const AUTHORITY = 'https://auth.spacetimedb.com/oidc';

// SpacetimeAuth sends you back to the page itself. Register these exact URLs on the client, as both
// Redirect URIs and Post Logout Redirect URIs: http://localhost:5173/ and https://hackutd-2026.vercel.app/
const REDIRECT_URI = `${location.origin}/`;

// sessionStorage: the ?scene=… you were on, restored after the sign-in round trip
const RETURN_KEY = 'coscene/sign-in-return';

export const signInAvailable = SPACETIMEAUTH_CLIENT_ID !== '';

let manager = null;

function getManager() {

	if ( manager === null ) {

		manager = new UserManager( {
			authority: AUTHORITY,
			client_id: SPACETIMEAUTH_CLIENT_ID,
			redirect_uri: REDIRECT_URI,
			post_logout_redirect_uri: REDIRECT_URI,
			response_type: 'code',
			scope: 'openid profile email',
			userStore: new WebStorageStateStore( { store: window.localStorage } ), // stay signed in across tabs and visits
			automaticSilentRenew: false, // when the sign-in expires you continue as a guest and can sign in again
		} );

	}

	return manager;

}

// Coming back from SpacetimeAuth: put the address back the way it was (e.g. ?scene=2) right away, before
// multiplayer.js reads ?scene, and keep the callback URL for completeSignIn().
let callbackUrl = null;

{

	const params = new URLSearchParams( location.search );

	if ( signInAvailable && params.has( 'state' ) && ( params.has( 'code' ) || params.has( 'error' ) ) ) {

		callbackUrl = location.href;

		let back = '';

		try {

			back = sessionStorage.getItem( RETURN_KEY ) || '';
			sessionStorage.removeItem( RETURN_KEY );

		} catch { /* storage unavailable: come back to the default scene */ }

		history.replaceState( null, '', location.pathname + back + location.hash );

	}

}

// Finishes a sign-in if this page load is the return from SpacetimeAuth. Throws if the sign-in failed
// (cancelled, or an invalid response); the caller continues as a guest.
export async function completeSignIn() {

	if ( callbackUrl === null ) return;

	const url = callbackUrl;
	callbackUrl = null;
	await getManager().signinRedirectCallback( url );

}

// The ID token to connect with, or undefined if not signed in. An expired sign-in is dropped.
export async function signedInToken() {

	if ( signInAvailable === false ) return undefined;

	const user = await getManager().getUser();
	if ( user === null ) return undefined;

	if ( user.expired ) {

		await getManager().removeUser();
		return undefined;

	}

	return user.id_token;

}

export async function signIn() {

	try {

		sessionStorage.setItem( RETURN_KEY, location.search );

	} catch { /* storage unavailable: you come back to the default scene */ }

	await getManager().signinRedirect();

}

// Forget the sign-in in this browser (the SpacetimeAuth session itself stays).
export async function forgetSignIn() {

	if ( signInAvailable ) await getManager().removeUser();

}

// Signs out here and at SpacetimeAuth, then comes back to this page as a guest.
export async function signOut() {

	const user = await getManager().getUser();
	await getManager().removeUser();

	try {

		await getManager().signoutRedirect( { id_token_hint: user?.id_token } );

	} catch {

		location.reload(); // SpacetimeAuth unreachable: at least continue as a guest here

	}

}
