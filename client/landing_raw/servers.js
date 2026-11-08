// Servers page: the scenes you're a member of, with create (signed in only), join by invite code,
// and open. A server is a row in the scene table; its invite code is its id, the same number the
// editor takes as ?scene=. Membership is the scene_member table.

import { signIn, signOut, signInAvailable } from '../auth.js';
import { connect } from './connection.js';
import {
	hydrateIcons, icon, toast, escapeHtml, readSavedName, saveName, cleanName,
	safeSignedInToken, sceneUrl, MAX_NAME_CHARS, AFTER_SIGN_IN_KEY,
} from './common.js';

const MAX_SERVER_NAME = 40;

const $ = ( selector ) => document.querySelector( selector );
const grid = $( '#server-grid' );
const meButton = $( '#me' );
const authButton = $( '#auth' );

let conn = null;
let me = null; // my identity, hex
let signedIn = false;

hydrateIcons();

// Guests pick a name on the login page first.
if ( ( await safeSignedInToken() ) === undefined && readSavedName() === undefined ) location.replace( 'login.html' );

connect( {
	onReady( connection, identity, isSignedIn ) {

		conn = connection;
		me = identity;
		signedIn = isSignedIn;
		ensureName();
		renderHeader();
		render();

	},
	onChange() {

		if ( conn !== null ) {

			renderHeader();
			render();

		}

	},
	onFail( message ) {

		grid.innerHTML = `<div class="panel-message panel-error">${escapeHtml( message )}</div>`;

	},
	onNotice: ( message ) => toast( message ),
} );

// ---------------------------------------------------------------------------------------------
// People

function findUser( hex ) {

	for ( const user of conn.db.user.iter() ) if ( user.identity.toHexString() === hex ) return user;
	return undefined;

}

function displayName( hex ) {

	if ( hex === me ) return 'You';
	const user = findUser( hex );
	return user && user.name && user.name !== 'Guest' ? user.name : `Guest ${hex.slice( - 4 )}`;

}

// Same rule as the editor: an account's name wins; a guest sends the name saved in this browser.
function ensureName() {

	const user = findUser( me );
	const saved = readSavedName();

	if ( user && user.name && user.name !== 'Guest' ) {

		if ( saved === undefined && signedIn === false ) saveName( user.name );
		return;

	}

	if ( saved !== undefined ) sendName( saved );
	else openNameDialog();

}

function sendName( name ) {

	conn.reducers.setName( { name } ).catch( ( error ) => toast( `Couldn't save your name: ${error.message}`, 'error' ) );

}

function renderHeader() {

	const user = findUser( me );
	const name = user && user.name !== 'Guest' ? user.name : ( readSavedName() ?? 'Set your name' );
	meButton.innerHTML = `<span class="dot" style="background:${escapeHtml( user?.color ?? '#888' )}"></span><span class="truncate">${escapeHtml( name )}</span>`;
	meButton.hidden = false;

	if ( signedIn ) {

		authButton.innerHTML = `${icon( 'log-out' )}<span>Sign out</span>`;
		authButton.hidden = false;

	} else {

		authButton.textContent = 'Sign in';
		authButton.hidden = signInAvailable === false;

	}

	$( '#guest-note' ).hidden = signedIn;

}

authButton.addEventListener( 'click', () => {

	if ( signedIn ) {

		signOut();

	} else {

		startSignIn();

	}

} );

function startSignIn() {

	try {

		sessionStorage.setItem( AFTER_SIGN_IN_KEY, 'servers' );

	} catch { /* storage unavailable */ }

	signIn();

}

// ---------------------------------------------------------------------------------------------
// Server list

function render() {

	const mine = new Set();
	const memberCount = new Map();

	for ( const member of conn.db.sceneMember.iter() ) {

		const id = member.sceneId.toString();
		memberCount.set( id, ( memberCount.get( id ) ?? 0 ) + 1 );
		if ( member.identity.toHexString() === me ) mine.add( id );

	}

	const servers = [ ...conn.db.scene.iter() ]
		.filter( ( scene ) => mine.has( scene.id.toString() ) )
		.sort( ( a, b ) => ( b.id > a.id ? 1 : - 1 ) ); // newest first

	if ( servers.length === 0 ) {

		grid.innerHTML = `
			<div class="panel-message">
				<p>You haven't joined any servers yet. Join one with an invite code${signedIn ? ', create your own,' : ''} or open the shared scene everyone can use.</p>
				<a class="btn btn-outline" href="${sceneUrl( 1 )}">Open the shared scene ${icon( 'external-link' )}</a>
			</div>`;
		return;

	}

	grid.innerHTML = servers.map( ( scene ) => {

		const id = scene.id.toString();
		const owner = scene.owner.toHexString();

		return `
			<article class="server-card">
				<div class="server-card-top">
					<h2>${escapeHtml( scene.name )}</h2>
					${owner === me ? `<span class="owner-badge" title="You own this server">${icon( 'crown' )}</span>` : ''}
				</div>
				<p class="server-meta">
					<span>Owner: <strong>${escapeHtml( displayName( owner ) )}</strong></span>
					<span class="members">${icon( 'users' )}${memberCount.get( id ) ?? 0}</span>
				</p>
				<div class="server-card-actions">
					<button class="code-chip" type="button" data-copy="${id}" aria-label="Copy invite code ${id}">Code ${id} ${icon( 'copy' )}</button>
					<a class="btn btn-primary btn-sm" href="${sceneUrl( id )}">Open ${icon( 'external-link' )}</a>
				</div>
			</article>`;

	} ).join( '' );

}

grid.addEventListener( 'click', ( event ) => {

	const button = event.target.closest( '[data-copy]' );
	if ( button ) copyCode( button.dataset.copy );

} );

function copyCode( code ) {

	navigator.clipboard.writeText( code ).then(
		() => toast( `Invite code ${code} copied` ),
		() => toast( `Invite code: ${code}` ),
	);

}

// ---------------------------------------------------------------------------------------------
// Dialogs

const nameDialog = $( '#name-dialog' );
const createDialog = $( '#create-dialog' );
const joinDialog = $( '#join-dialog' );
const createdDialog = $( '#created-dialog' );

for ( const dialog of document.querySelectorAll( 'dialog' ) ) {

	for ( const button of dialog.querySelectorAll( '[data-close]' ) ) button.addEventListener( 'click', () => dialog.close() );
	dialog.addEventListener( 'close', () => dialog.querySelectorAll( '.field-error' ).forEach( ( el ) => ( el.textContent = '' ) ) );

}

// Name

function openNameDialog() {

	const input = nameDialog.querySelector( 'input' );
	input.maxLength = MAX_NAME_CHARS;
	input.value = readSavedName() ?? '';
	nameDialog.showModal();

}

meButton.addEventListener( 'click', openNameDialog );

nameDialog.querySelector( 'form' ).addEventListener( 'submit', ( event ) => {

	event.preventDefault();
	const name = cleanName( nameDialog.querySelector( 'input' ).value );

	if ( name === '' ) {

		nameDialog.querySelector( '.field-error' ).textContent = 'Enter a name.';
		return;

	}

	saveName( name );
	if ( conn !== null ) sendName( name );
	nameDialog.close();

} );

// Create

$( '#open-create' ).addEventListener( 'click', () => {

	createDialog.querySelector( '#create-form' ).hidden = signedIn === false;
	createDialog.querySelector( '#create-needs-sign-in' ).hidden = signedIn;
	createDialog.querySelector( 'input' ).value = '';
	createDialog.showModal();

} );

createDialog.querySelector( '#create-sign-in' ).addEventListener( 'click', startSignIn );

createDialog.querySelector( '#create-form' ).addEventListener( 'submit', async ( event ) => {

	event.preventDefault();
	const form = event.currentTarget;
	const name = form.querySelector( 'input' ).value.trim().slice( 0, MAX_SERVER_NAME );

	if ( name === '' ) {

		form.querySelector( '.field-error' ).textContent = 'Give your server a name.';
		return;

	}

	await busy( form, async () => {

		const scene = await createServer( name );
		createDialog.close();
		showCreated( scene );

	} );

} );

async function createServer( name ) {

	const before = new Set( [ ...conn.db.scene.iter() ].map( ( scene ) => scene.id.toString() ) );
	await conn.reducers.createScene( { name } );

	// Reducers don't return the new row, so find it: the newest server with this name that I own.
	for ( let i = 0; i < 30; i ++ ) {

		const scene = [ ...conn.db.scene.iter() ].find( ( s ) => ! before.has( s.id.toString() ) && s.owner.toHexString() === me && s.name === name );
		if ( scene ) return scene;
		await new Promise( ( resolve ) => setTimeout( resolve, 100 ) );

	}

	throw new Error( 'The server was created but hasn\'t shown up yet. Refresh the page to see it.' );

}

function showCreated( scene ) {

	const id = scene.id.toString();
	createdDialog.querySelector( '#created-name' ).textContent = scene.name;
	createdDialog.querySelector( '#created-code' ).textContent = id;
	createdDialog.querySelector( '#created-copy' ).onclick = () => copyCode( id );
	createdDialog.querySelector( '#created-open' ).href = sceneUrl( id );
	createdDialog.showModal();

}

// Join

$( '#open-join' ).addEventListener( 'click', () => {

	joinDialog.querySelector( 'input' ).value = '';
	joinDialog.showModal();

} );

joinDialog.querySelector( 'form' ).addEventListener( 'submit', async ( event ) => {

	event.preventDefault();
	const form = event.currentTarget;
	const code = form.querySelector( 'input' ).value.trim().replace( /^#/, '' );

	if ( ! /^\d+$/.test( code ) ) {

		form.querySelector( '.field-error' ).textContent = 'Invite codes are numbers, like 12.';
		return;

	}

	await busy( form, async () => {

		try {

			await conn.reducers.joinScene( { sceneId: BigInt( code ) } );

		} catch ( error ) {

			throw /scene not found/.test( error.message ) ? new Error( `No server has the invite code ${code}.` ) : error;

		}

		const scene = conn.db.scene.id?.find( BigInt( code ) ) ?? [ ...conn.db.scene.iter() ].find( ( s ) => s.id.toString() === code );
		joinDialog.close();
		toast( `Joined ${scene?.name ?? `server ${code}`}` );

	} );

} );

// Disables the form's buttons while the work runs; shows any error under the form.
async function busy( form, work ) {

	if ( conn === null ) {

		form.querySelector( '.field-error' ).textContent = 'Still connecting. Try again in a moment.';
		return;

	}

	const buttons = form.querySelectorAll( 'button' );
	buttons.forEach( ( b ) => ( b.disabled = true ) );

	try {

		await work();

	} catch ( error ) {

		form.querySelector( '.field-error' ).textContent = error.message;

	} finally {

		buttons.forEach( ( b ) => ( b.disabled = false ) );

	}

}
