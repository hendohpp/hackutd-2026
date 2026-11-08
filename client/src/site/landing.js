// Landing page (/). Also where SpacetimeAuth sends you back after signing in or out, because the
// registered redirect URL is the site root (see src/auth.js).

import { completeSignIn, noteSignInFailed } from '../auth.js';
import { hydrateIcons, hasIdentity, toast, AFTER_SIGN_IN_KEY } from './common.js';

hydrateIcons();

// auth.js has already cleaned ?code=…&state=… out of the address bar, so look at the original request.
const firstUrl = new URL( performance.getEntriesByType( 'navigation' )[ 0 ]?.name ?? location.href );
const isSignInReturn = firstUrl.searchParams.has( 'state' ) && ( firstUrl.searchParams.has( 'code' ) || firstUrl.searchParams.has( 'error' ) );

if ( isSignInReturn ) {

	await returnFromSignIn();

} else if ( await hasIdentity() ) {

	// Already signed in or named: skip the login page.
	for ( const link of document.querySelectorAll( '[data-start]' ) ) link.href = 'servers.html';
	const header = document.querySelector( '#header-action' );
	header.innerHTML = 'Your servers <i data-icon="arrow-right"></i>';
	header.classList.replace( 'btn-outline', 'btn-primary' );
	hydrateIcons( header.parentElement );

}

async function returnFromSignIn() {

	let fromLobby = false;

	try {

		fromLobby = sessionStorage.getItem( AFTER_SIGN_IN_KEY ) === 'servers';
		sessionStorage.removeItem( AFTER_SIGN_IN_KEY );

	} catch { /* storage unavailable */ }

	try {

		await completeSignIn();

	} catch ( error ) {

		console.warn( '[collab3d] sign-in failed:', error );

		if ( fromLobby ) {

			toast( 'Sign-in didn\'t complete. Try again, or continue as a guest.', 'error' );
			return;

		}

		noteSignInFailed(); // the editor says so when you get back

	}

	// Signed in from the login page: on to the servers. Signed in from the editor: back to its scene
	// (auth.js has put the editor's ?scene=… back into the address).
	location.replace( fromLobby ? 'servers.html' : `editor.html${location.search}` );

}
