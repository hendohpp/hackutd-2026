// Servers page: the servers you're a member of, with create (signed in only), join by invite code, share
// and open. A server is a scene (one shared 3D scene) with an owner, members and an invite code
// (server/src/reducers/scenes.rs). The list comes from the my_servers view, which is also the only way
// to see a server's invite code, so only members ever see it.
//
// A shared link (servers.html?join=CODE) joins you and opens the scene, after a stop at the login page
// or a sign-in if needed.

import { signIn, signOut, signInAvailable } from '../auth.js';
import { connect } from './connection.js';
import {
	hydrateIcons, icon, toast, escapeHtml, readSavedName, saveName, cleanName,
	safeSignedInToken, sceneUrl, storageGet, storageSet, storageRemove, MAX_NAME_CHARS, AFTER_SIGN_IN_KEY,
} from './common.js';

const MAX_SERVER_NAME = 40; // same limit as the server's create_scene
const CODE_LENGTH = 6;
const PENDING_JOIN_KEY = 'collab3d/pending-join'; // sessionStorage: a ?join= code waiting for a name or sign-in

const $ = ( selector ) => document.querySelector( selector );
const grid = $( '#server-grid' );
const meButton = $( '#me' );
const authButton = $( '#auth' );

let conn = null;
let me = null; // my identity, hex
let signedIn = false;

hydrateIcons();

// A shared link: remember the code until we're connected (survives the login page and a sign-in).
const linkCode = new URLSearchParams( location.search ).get( 'join' );
if ( linkCode ) storageSet( sessionStorage, PENDING_JOIN_KEY, linkCode );
if ( linkCode !== null ) history.replaceState( null, '', location.pathname );

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
		joinPendingCode();

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

	storageSet( sessionStorage, AFTER_SIGN_IN_KEY, 'servers' ); // the landing page finishes the sign-in, then sends you back here
	signIn();

}

// ---------------------------------------------------------------------------------------------
// Server list

const myServers = () => [ ...conn.db.myServers.iter() ];

function render() {

	const servers = myServers().sort( ( a, b ) => ( b.sceneId > a.sceneId ? 1 : - 1 ) ); // newest first

	if ( servers.length === 0 ) {

		grid.innerHTML = `
			<div class="panel-message">
				<p>You haven't joined any servers yet. Join one with an invite code${signedIn ? ', create your own,' : ''} or open the shared scene everyone can use.</p>
				<a class="btn btn-outline" href="${sceneUrl( 1 )}">Open the shared scene ${icon( 'external-link' )}</a>
			</div>`;
		return;

	}

	grid.innerHTML = servers.map( ( server ) => {

		const id = server.sceneId.toString();
		const owner = server.owner.toHexString();
		const code = server.inviteCode;

		const share = code
			? `<button class="code-chip" type="button" data-copy-code="${escapeHtml( code )}" aria-label="Copy invite code ${escapeHtml( code )}">${escapeHtml( code )} ${icon( 'copy' )}</button>
				<button class="btn btn-ghost btn-sm" type="button" data-copy-link="${escapeHtml( code )}" title="Copy a link that joins this server">Copy link</button>`
			: '<span class="code-chip code-chip-open" title="Anyone can open this scene">Open to everyone</span>';

		return `
			<article class="server-card" data-server="${id}">
				<div class="server-card-top">
					<h2>${escapeHtml( server.name )}</h2>
					${owner === me ? `<span class="owner-badge" title="You own this server">${icon( 'crown' )}</span>` : ''}
				</div>
				<p class="server-meta">
					<span>Owner: <strong>${escapeHtml( displayName( owner ) )}</strong></span>
					<span class="members" title="Members">${icon( 'users' )}${server.members}</span>
				</p>
				<div class="server-card-actions">
					${share}
					<a class="btn btn-primary btn-sm" href="${sceneUrl( id )}">Open ${icon( 'external-link' )}</a>
				</div>
			</article>`;

	} ).join( '' );

}

grid.addEventListener( 'click', ( event ) => {

	const code = event.target.closest( '[data-copy-code]' );
	if ( code ) copyText( code.dataset.copyCode, `Invite code ${code.dataset.copyCode} copied` );

	const link = event.target.closest( '[data-copy-link]' );
	if ( link ) copyText( inviteLink( link.dataset.copyLink ), 'Invite link copied' );

} );

function inviteLink( code ) {

	return new URL( `servers.html?join=${encodeURIComponent( code )}`, location.href ).href;

}

function copyText( text, done ) {

	navigator.clipboard.writeText( text ).then(
		() => toast( done ),
		() => toast( text ), // clipboard blocked: show it so it can be copied by hand
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
	const name = cleanServerName( form.querySelector( 'input' ).value );

	if ( name === '' ) {

		form.querySelector( '.field-error' ).textContent = 'Give your server a name.';
		return;

	}

	await busy( form, async () => {

		const server = await createServer( name );
		createDialog.close();
		showCreated( server );

	} );

} );

function cleanServerName( raw ) {

	return Array.from( raw.replace( /\p{Cc}/gu, '' ).trim() ).slice( 0, MAX_SERVER_NAME ).join( '' ).trim();

}

async function createServer( name ) {

	const before = new Set( myServers().map( ( server ) => server.sceneId.toString() ) );
	await conn.reducers.createScene( { name } );

	// Reducers don't return the new row, so find it: the new server with this name that I own.
	const server = await waitFor( () => myServers().find( ( s ) => ! before.has( s.sceneId.toString() ) && s.owner.toHexString() === me && s.name === name ) );
	if ( server === undefined ) throw new Error( 'The server was created but hasn\'t shown up yet. Refresh the page to see it.' );
	return server;

}

function showCreated( server ) {

	const id = server.sceneId.toString();
	createdDialog.querySelector( '#created-name' ).textContent = server.name;
	createdDialog.querySelector( '#created-code' ).textContent = server.inviteCode;
	createdDialog.querySelector( '#created-copy' ).onclick = () => copyText( server.inviteCode, `Invite code ${server.inviteCode} copied` );
	createdDialog.querySelector( '#created-copy-link' ).onclick = () => copyText( inviteLink( server.inviteCode ), 'Invite link copied' );
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
	const code = normalizeCode( form.querySelector( 'input' ).value );

	if ( code.length !== CODE_LENGTH ) {

		form.querySelector( '.field-error' ).textContent = `Invite codes are ${CODE_LENGTH} letters and numbers, like K7QM2X.`;
		return;

	}

	await busy( form, async () => {

		const server = await joinServer( code );
		joinDialog.close();
		toast( `Joined ${server.name}` );

	} );

} );

// Same rule as the server: case, spaces and dashes don't matter.
function normalizeCode( raw ) {

	return raw.replace( /[^a-z0-9]/gi, '' ).toUpperCase();

}

async function joinServer( code ) {

	try {

		await conn.reducers.joinWithCode( { code } );

	} catch ( error ) {

		throw /no server has that invite code/.test( error.message ) ? new Error( `No server has the invite code ${code}.` ) : error;

	}

	const server = await waitFor( () => myServers().find( ( s ) => s.inviteCode === code ) );
	if ( server === undefined ) throw new Error( 'Joined, but the server hasn\'t shown up yet. Refresh the page to see it.' );
	return server;

}

// A shared link's code: join, then open the scene.
async function joinPendingCode() {

	const code = normalizeCode( storageGet( sessionStorage, PENDING_JOIN_KEY ) ?? '' );
	storageRemove( sessionStorage, PENDING_JOIN_KEY );
	if ( code === '' ) return;

	try {

		const server = await joinServer( code );
		toast( `Joined ${server.name}. Opening it…` );
		location.href = sceneUrl( server.sceneId.toString() );

	} catch ( error ) {

		toast( error.message, 'error' );

	}

}

// ---------------------------------------------------------------------------------------------

// Polls until find() returns something (rows from a reducer arrive just after it returns), up to 3 s.
async function waitFor( find ) {

	for ( let i = 0; i < 30; i ++ ) {

		const found = find();
		if ( found ) return found;
		await new Promise( ( resolve ) => setTimeout( resolve, 100 ) );

	}

	return find();

}

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
