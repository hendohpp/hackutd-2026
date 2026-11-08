// Login page: sign in with SpacetimeAuth (an account you can use on any device), or continue as a
// guest with just a name. Guests can join servers; creating one needs a sign-in (see create_scene).

import { signIn, signInAvailable } from '../auth.js';
import { hydrateIcons, safeSignedInToken, readSavedName, saveName, cleanName, MAX_NAME_CHARS, AFTER_SIGN_IN_KEY } from './common.js';

hydrateIcons();

if ( ( await safeSignedInToken() ) !== undefined ) location.replace( 'servers.html' );

const signInButton = document.querySelector( '#sign-in' );
const divider = document.querySelector( '#divider' );
const form = document.querySelector( '#guest-form' );
const input = form.querySelector( 'input' );
const error = form.querySelector( '.field-error' );

input.maxLength = MAX_NAME_CHARS;
input.value = readSavedName() ?? '';

if ( signInAvailable ) {

	signInButton.addEventListener( 'click', async () => {

		signInButton.disabled = true;

		try {

			sessionStorage.setItem( AFTER_SIGN_IN_KEY, 'servers' ); // the landing page finishes the sign-in, then sends you to servers

		} catch { /* storage unavailable: you land on the home page instead */ }

		await signIn();

	} );

} else {

	signInButton.hidden = true;
	divider.hidden = true;

}

form.addEventListener( 'submit', ( event ) => {

	event.preventDefault();
	const name = cleanName( input.value );

	if ( name === '' ) {

		error.textContent = 'Enter a name so others know who\'s editing.';
		input.focus();
		return;

	}

	saveName( name ); // the editor and servers page send it to the database when you connect
	location.href = 'servers.html';

} );

input.addEventListener( 'input', () => ( error.textContent = '' ) );
