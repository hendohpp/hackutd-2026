// Shared helpers for the site pages (landing, login, servers): names, sign-in state, icons, toasts.
// The database connection is in connection.js (only the servers page needs it). The editor uses multiplayer.js.

import { signedInToken } from '../auth.js';

// Same key as src/multiplayer.js: the name this browser uses as a guest.
const NAME_KEY = 'coscene/name';

export const MAX_NAME_CHARS = 24; // same limit as the server's set_name

// sessionStorage: after signing in from the login page, the landing page sends you to the servers page
export const AFTER_SIGN_IN_KEY = 'coscene/after-sign-in';

// ---------------------------------------------------------------------------------------------
// Pages and names

export const sceneUrl = ( id ) => `editor.html?scene=${id}`;

export function cleanName( raw ) {

	return Array.from( raw.replace( /\p{Cc}/gu, '' ).trim() ).slice( 0, MAX_NAME_CHARS ).join( '' ).trim();

}

export const readSavedName = () => storageGet( localStorage, NAME_KEY );
export const saveName = ( name ) => storageSet( localStorage, NAME_KEY, name );

// True if this browser has either a sign-in or a guest name, so "Log in" can be skipped.
export async function hasIdentity() {

	return ( await safeSignedInToken() ) !== undefined || readSavedName() !== undefined;

}

export async function safeSignedInToken() {

	try {

		return await signedInToken();

	} catch {

		return undefined;

	}

}

// ---------------------------------------------------------------------------------------------
// Small UI helpers

// <i data-icon="arrow-right"></i> becomes the matching inline SVG (paths from Lucide, ISC license).
const ICONS = {
	'arrow-right': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
	box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
	radio: '<path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"/>',
	lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
	users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
	copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
	'external-link': '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
	home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
	'log-out': '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
	plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
	ticket: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/>',
	crown: '<path d="m2 4 3 12h14l3-12-6 7-4-7-4 7-6-7zm3 16h14"/>',
};

export function icon( name ) {

	return `<svg class="icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[ name ] ?? ''}</svg>`;

}

export function hydrateIcons( root = document ) {

	for ( const el of root.querySelectorAll( 'i[data-icon]' ) ) el.outerHTML = icon( el.dataset.icon );

}

export function toast( message, kind = 'info' ) {

	let box = document.querySelector( '.toasts' );

	if ( box === null ) {

		box = document.createElement( 'div' );
		box.className = 'toasts';
		box.setAttribute( 'role', 'status' );
		document.body.append( box );

	}

	const el = document.createElement( 'div' );
	el.className = `toast toast-${kind}`;
	el.textContent = message;
	box.append( el );
	setTimeout( () => el.remove(), 4000 );

}

export function escapeHtml( text ) {

	return String( text ).replace( /[&<>"']/g, ( c ) => ( { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ c ] ) );

}

// ---------------------------------------------------------------------------------------------

export function storageGet( store, key ) {

	try {

		return store.getItem( key ) || undefined;

	} catch {

		return undefined;

	}

}

export function storageSet( store, key, value ) {

	try {

		store.setItem( key, value );

	} catch { /* storage unavailable */ }

}

export function storageRemove( store, key ) {

	try {

		store.removeItem( key );

	} catch { /* ignore */ }

}
