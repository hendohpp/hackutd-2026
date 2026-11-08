// Optional sign-in with SpacetimeAuth (OpenID Connect). Guests can join servers and edit without it; signing
// in lets you create servers, and gives you the same identity on every device, and your account's name.
//
// "Sign in" sends you to SpacetimeAuth, which sends you back to the site root (the landing page,
// src/site/landing.js) with ?code=…&state=…. The landing page trades the code for tokens (PKCE, no secret in
// the page), then sends you on to the editor or your servers. The ID token becomes the SpacetimeDB
// connection token. The server counts it as signed in only if SpacetimeAuth issued it for
// SPACETIMEAUTH_CLIENT_ID (server/src/auth.rs).

import { UserManager, WebStorageStateStore } from 'oidc-client-ts';

// From the SpacetimeAuth dashboard (Maincloud > coscene-hackutd > SpacetimeAuth > Clients). Client IDs
// are public, so it's fine to commit. Keep it in sync with SPACETIMEAUTH_CLIENT_ID in server/src/auth.rs.
// While empty, the sign-in option is hidden. VITE_SPACETIMEAUTH_CLIENT_ID overrides it for testing.
const SPACETIMEAUTH_CLIENT_ID = import.meta.env.VITE_SPACETIMEAUTH_CLIENT_ID || 'client_034tqgLZLkX9U3IhumuLUP';
const AUTHORITY = 'https://auth.spacetimedb.com/oidc';

// SpacetimeAuth sends you back to the landing page. Register these exact URLs on the client, as both
// Redirect URIs and Post Logout Redirect URIs: http://localhost:5173/ and https://hackutd-2026.vercel.app/
const REDIRECT_URI = `${location.origin}/`;

// sessionStorage: the ?scene=… you were on, restored after the sign-in round trip
const RETURN_KEY = 'coscene/sign-in-return';

// sessionStorage: a sign-in started in the editor failed on the landing page (see noteSignInFailed)
const FAILED_KEY = 'coscene/sign-in-failed';

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
			scope: 'openid profile email offline_access',
			userStore: new WebStorageStateStore( { store: window.localStorage } ), // stay signed in across tabs and visits
			// SpacetimeAuth tokens last 15 minutes. offline_access (in the scope above) gives a refresh token, which
			// renews them quietly while a page is open, and on the next visit (signedInToken).
			automaticSilentRenew: true,
		} );

	}

	return manager;

}

// Coming back from SpacetimeAuth (on the landing page): put back the address you signed in from (e.g.
// ?scene=2) right away, and keep the callback URL for completeSignIn(). landing.js then sends you on to
// editor.html with that ?scene, or to your servers.
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

// The landing page finishes every sign-in. When one started in the editor fails, it leaves a note here so the
// editor can say so once you're back (takeSignInFailed).
export function noteSignInFailed() {

	try {

		sessionStorage.setItem( FAILED_KEY, '1' );

	} catch { /* storage unavailable: no message */ }

}

// True once after noteSignInFailed().
export function takeSignInFailed() {

	try {

		const failed = sessionStorage.getItem( FAILED_KEY ) !== null;
		sessionStorage.removeItem( FAILED_KEY );
		return failed;

	} catch {

		return false;

	}

}

// The ID token to connect with, or undefined if not signed in. An expired one (they last 15 minutes) is
// renewed with the refresh token, and the sign-in is dropped only if that fails.
export async function signedInToken() {

	if ( signInAvailable === false ) return undefined;

	const manager = getManager();
	let user = await manager.getUser();
	if ( user === null ) return undefined;

	if ( user.expired ) {

		try {

			user = await manager.signinSilent(); // refresh token grant: no page change

		} catch ( error ) {

			console.warn( '[coscene] couldn\'t renew the sign-in:', error );
			user = null;

		}

		if ( user === null || user.expired ) {

			await manager.removeUser();
			return undefined;

		}

	}

	return user.id_token;

}

// For the SpacetimeDB SDK's token provider: a current token for the same account when it reconnects.
export async function renewedSignInToken() {

	const token = await signedInToken();
	if ( token === undefined ) throw new Error( 'the sign-in has expired' );
	return token;

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
