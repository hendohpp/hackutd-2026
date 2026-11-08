// AI teammate prompt box. All AI client code lives in this file.
//
// Type what to build or change ("a campfire", "make the fire bigger", "delete the tree", "turn this into
// a sphere", "make the car drive around") and press Enter or the arrow. This calls the server's ask_ai procedure (server/src/ai.rs),
// which asks the AI model and adds, changes or removes objects in the shared `object` table around the
// spot you're looking at (and the objects you have selected: "this" means them). The objects then arrive
// through the normal subscription in multiplayer.js, for everyone, so this file never touches the
// three.js scene. There is no API key here: the key stays on the server.
//
// ask_ai runs over the editor's existing SpacetimeDB connection (editor.multiplayer.askAi), so it
// uses this tab's identity and scene. (A separate HTTP call would count as its own visit, and the
// server releases a user's locks and presence when a visit ends.)
//
// It's one line, styled like the editor's other panels (light and dark): an "AI" label, the prompt,
// send, and a bell that mutes notices when someone else uses the AI. Every request uses the detailed
// model. After a change, the line below offers Undo. Drag the box by its label or edge; double-click
// the label to put it back. Position and mute are remembered in this browser.

import { tables } from './module_bindings';

// Same ?scene=N rule as multiplayer.js (default 1).
const sceneParam = new URLSearchParams( location.search ).get( 'scene' );
const SCENE_ID = /^\d+$/.test( sceneParam || '' ) ? BigInt( sceneParam ) : 1n;

const DEFAULT_POSITION = { left: 284, top: 46 }; // to the right of the multiplayer panel
const MIN_TOP = 36; // stay below the editor's menu bar
const POSITION_KEY = 'ai-panel-position';
const MUTED_KEY = 'ai-panel-muted';
const NOTICE_SECONDS = 7;
const PLACEHOLDER = 'Ask AI to build, change or delete…';

const panel = document.createElement( 'form' );
panel.className = 'ai-panel';
panel.innerHTML = `
	<div class="ai-row">
		<span class="ai-handle" title="AI teammate · drag to move, double-click to put it back">AI</span>
		<input id="ai-prompt" type="text" maxlength="300" autocomplete="off"
			aria-label="Ask the AI teammate to build, change or delete something" placeholder="${PLACEHOLDER}">
		<button type="submit" class="ai-send" aria-label="Send" title="Send">
			<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
				<path d="M12 19V5M5 12l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
			</svg>
		</button>
		<button type="button" class="ai-mute" aria-pressed="false" title="Mute notices when others use the AI">
			<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
				<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path class="slash" d="M3 3l18 18"/>
			</svg>
		</button>
	</div>
	<div class="ai-status" aria-live="polite" hidden><span class="ai-status-text"></span><button type="button" class="ai-undo" hidden>Undo</button></div>
	<div class="ai-notice" aria-live="polite"></div>
`;

const handle = panel.querySelector( '.ai-handle' );
const input = panel.querySelector( 'input' );
const status = panel.querySelector( '.ai-status' );
const statusText = panel.querySelector( '.ai-status-text' );
const undoButton = panel.querySelector( '.ai-undo' );
const muteButton = panel.querySelector( '.ai-mute' );
const notice = panel.querySelector( '.ai-notice' );

let muted = loadFlag( MUTED_KEY );
muteButton.setAttribute( 'aria-pressed', String( muted ) );

// The editor handles keys on the whole page (Delete removes the selection, Backspace is blocked).
// Keep typing in this box to the box, like the editor's own text fields do.
input.addEventListener( 'keydown', ( event ) => event.stopPropagation() );

// ---------------------------------------------------------------------------------------------
// Asking the AI

panel.addEventListener( 'submit', async ( event ) => {

	event.preventDefault();

	const prompt = input.value.trim();
	if ( prompt === '' ) return;

	const multiplayer = connectedMultiplayer();
	if ( multiplayer === null ) return show( 'Not connected to the database yet.', true );

	setBusy( true );

	// A live count, so a long build reads as progress rather than a hang. (A ring marks the spot: askAi.)
	const started = performance.now();
	const tick = () => show( `Claude is building… ${Math.floor( ( performance.now() - started ) / 1000 )}s` );
	tick();
	const ticker = setInterval( tick, 1000 );

	try {

		const result = await multiplayer.askAi( prompt, true ); // always the detailed model
		clearInterval( ticker );
		const done = result.added + result.changed + result.removed > 0;
		show( describe( result, prompt ) );
		undoButton.hidden = ! done;
		if ( done ) input.value = '';

	} catch ( error ) {

		clearInterval( ticker );
		show( error.message, true );

	} finally {

		clearInterval( ticker );
		setBusy( false );
		input.focus();

	}

} );

// "Added 12 · changed 2 for “a campfire”."
function describe( r, prompt ) {

	const parts = [];
	if ( r.added ) parts.push( `added ${r.added}` );
	if ( r.changed ) parts.push( `changed ${r.changed}` );
	if ( r.removed ) parts.push( `removed ${r.removed}` );

	let text = parts.length
		? `${parts.join( ' · ' ).replace( /^./, ( c ) => c.toUpperCase() )} for “${prompt}”.`
		: `The AI didn't change anything for “${prompt}”. Try rephrasing.`;
	if ( r.skipped ) text += ` Skipped ${r.skipped} that someone else is editing.`;
	if ( r.note ) text += ` ${r.note}`;
	return text;

}

undoButton.addEventListener( 'click', async () => {

	const multiplayer = connectedMultiplayer();
	if ( multiplayer === null ) return show( 'Not connected to the database yet.', true );

	setBusy( true );
	try {

		// Over this tab's connection, like askAi. Objects others changed since are left alone.
		const result = await multiplayer.conn.procedures.undoAi( { sceneId: SCENE_ID } );
		if ( 'err' in result ) throw new Error( result.err );
		const kept = result.ok.skipped;
		show( kept ? `Undone. Left ${kept} alone that someone else changed or is editing.` : 'Undone.' );
		undoButton.hidden = true;

	} catch ( error ) {

		show( error.message, true );

	} finally {

		setBusy( false );

	}

} );

function connectedMultiplayer() {

	const multiplayer = window.editor && window.editor.multiplayer;
	return multiplayer && multiplayer.connected ? multiplayer : null;

}

// While the AI works, everything but the mute bell waits.
function setBusy( busy ) {

	panel.classList.toggle( 'busy', busy );
	for ( const control of panel.querySelectorAll( 'input, button:not(.ai-mute)' ) ) control.disabled = busy;

}

function show( text, isError = false ) {

	statusText.textContent = text;
	status.classList.toggle( 'error', isError );
	status.hidden = text === '';
	if ( isError ) undoButton.hidden = true;

}

// With objects selected, the AI edits those ("make it a sphere", "delete these"): say so in the box.
function updatePlaceholder() {

	const selection = ( window.editor && window.editor.selector && window.editor.selector.selection ) || [];
	const count = selection.filter( ( object ) => object.userData && object.userData.id !== undefined ).length; // synced objects
	input.placeholder = count === 0 ? PLACEHOLDER
		: count === 1 ? 'Change this… e.g. make it spin'
			: `Change these ${count}… e.g. delete them`;

}

// ---------------------------------------------------------------------------------------------
// Notices when someone else uses the AI (the server's public ai_event table)

let watchedConnection = null;
let watchingSelection = false;
let noticeTimer = null;

// The editor is created after this file loads: hook into it once it exists, subscribe once it's
// connected, and again if it ever gets a new connection.
setInterval( watchEditor, 1000 );

function watchEditor() {

	if ( watchingSelection === false && window.editor && window.editor.signals ) {

		window.editor.signals.objectSelected.add( updatePlaceholder );
		watchingSelection = true;
		updatePlaceholder();

	}

	const multiplayer = connectedMultiplayer();
	if ( multiplayer === null || multiplayer.conn === watchedConnection ) return;

	const conn = watchedConnection = multiplayer.conn;

	// Only notices newer than the ones that already existed when we subscribed. (The SDK delivers
	// those existing rows right after onApplied, so a plain "ready" flag isn't enough; ids only grow.)
	let newestOld = null;

	conn.db.aiEvent.onInsert( ( _ctx, row ) => {

		if ( newestOld === null || row.id <= newestOld ) return;
		if ( row.sceneId === SCENE_ID && row.who.toHexString() !== multiplayer.identity ) showNotice( row, multiplayer );

	} );

	// Its own subscription, so a server without the ai_event table can't break anything else.
	conn.subscriptionBuilder()
		.onApplied( () => {

			newestOld = 0n;
			for ( const event of conn.db.aiEvent.iter() ) if ( event.id > newestOld ) newestOld = event.id;

		} )
		.onError( ( _ctx, error ) => console.warn( '[ai] notices are unavailable:', error ) )
		.subscribe( [ tables.aiEvent.where( ( r ) => r.sceneId.eq( SCENE_ID ) ) ] );

}

function showNotice( row, multiplayer ) {

	if ( muted ) return;

	const name = multiplayer.userName( row.who.toHexString() );
	const counts = [ row.added && `${row.added} added`, row.changed && `${row.changed} changed`, row.removed && `${row.removed} removed` ]
		.filter( Boolean ).join( ', ' );
	notice.textContent = row.undo ? `${name} undid an AI change` : `${name} asked the AI for “${row.prompt}” (${counts})`;
	notice.classList.add( 'show' );

	clearTimeout( noticeTimer );
	noticeTimer = setTimeout( () => notice.classList.remove( 'show' ), NOTICE_SECONDS * 1000 );

}

muteButton.addEventListener( 'click', () => {

	muted = ! muted;
	muteButton.setAttribute( 'aria-pressed', String( muted ) );
	muteButton.title = muted ? 'Unmute notices when others use the AI' : 'Mute notices when others use the AI';
	saveFlag( MUTED_KEY, muted );
	if ( muted ) notice.classList.remove( 'show' );

} );

// ---------------------------------------------------------------------------------------------
// Dragging the box around

let drag = null; // { dx, dy }: where inside the box it was grabbed
let pressedHandle = false; // was the last press on the "AI" label? (for double-click to reset)

panel.addEventListener( 'pointerdown', ( event ) => {

	if ( event.button !== 0 || event.target.closest( 'input, button' ) ) return;
	pressedHandle = handle.contains( event.target );
	const rect = panel.getBoundingClientRect();
	drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
	panel.setPointerCapture( event.pointerId );
	panel.classList.add( 'dragging' );
	event.preventDefault();

} );

panel.addEventListener( 'pointermove', ( event ) => {

	if ( drag ) place( event.clientX - drag.dx, event.clientY - drag.dy );

} );

panel.addEventListener( 'pointerup', endDrag );
panel.addEventListener( 'pointercancel', endDrag );

// While dragging, the box captures the pointer, so the browser reports the double-click on the box
// itself rather than the label: check where the press started instead.
panel.addEventListener( 'dblclick', () => {

	if ( ! pressedHandle ) return;
	place( DEFAULT_POSITION.left, DEFAULT_POSITION.top );
	savePosition();

} );

// Keep it on screen when the window gets smaller.
window.addEventListener( 'resize', () => {

	const rect = panel.getBoundingClientRect();
	place( rect.left, rect.top );

} );

function endDrag() {

	if ( drag === null ) return;
	drag = null;
	panel.classList.remove( 'dragging' );
	savePosition();

}

function place( left, top ) {

	const maxLeft = Math.max( 0, window.innerWidth - panel.offsetWidth );
	const maxTop = Math.max( MIN_TOP, window.innerHeight - panel.offsetHeight );
	panel.style.left = `${Math.round( Math.min( Math.max( 0, left ), maxLeft ) )}px`;
	panel.style.top = `${Math.round( Math.min( Math.max( MIN_TOP, top ), maxTop ) )}px`;

}

function loadPosition() {

	try {

		const saved = JSON.parse( localStorage.getItem( POSITION_KEY ) );
		if ( saved && Number.isFinite( saved.left ) && Number.isFinite( saved.top ) ) return saved;

	} catch { /* storage unavailable or a bad value */ }

	return DEFAULT_POSITION;

}

function savePosition() {

	try {

		const rect = panel.getBoundingClientRect();
		localStorage.setItem( POSITION_KEY, JSON.stringify( { left: Math.round( rect.left ), top: Math.round( rect.top ) } ) );

	} catch { /* storage unavailable: the position just isn't remembered */ }

}

function loadFlag( key ) {

	try {

		return localStorage.getItem( key ) === '1';

	} catch {

		return false;

	}

}

function saveFlag( key, on ) {

	try {

		localStorage.setItem( key, on ? '1' : '0' );

	} catch { /* storage unavailable: the choice just isn't remembered */ }

}

// ---------------------------------------------------------------------------------------------
// Styles: the same look as the multiplayer panel (client/src/multiplayer.css), light and dark,
// following the editor's theme.

const style = document.createElement( 'style' );
style.textContent = `
	.ai-panel {
		--ai-bg: rgba( 255, 255, 255, 0.92 );
		--ai-fg: #333;
		--ai-muted: #777;
		--ai-border: rgba( 0, 0, 0, 0.12 );
		--ai-field: #fff;
		--ai-hover: rgba( 0, 0, 0, 0.06 );
		--ai-accent: #08f;
		--ai-error: #e74c3c;
		position: fixed;
		left: ${DEFAULT_POSITION.left}px;
		top: ${DEFAULT_POSITION.top}px;
		z-index: 1; /* same layer as the editor's menus, which are added later and draw on top */
		box-sizing: border-box;
		width: 340px;
		margin: 0;
		padding: 6px 8px;
		border: 1px solid var( --ai-border );
		border-radius: 8px;
		background: var( --ai-bg );
		color: var( --ai-fg );
		font-family: Helvetica, Arial, sans-serif;
		font-size: 12px;
		line-height: 1.4;
		cursor: grab;
		-webkit-user-select: none;
		user-select: none;
		touch-action: none;
	}
	@media ( prefers-color-scheme: dark ) {
		.ai-panel {
			--ai-bg: rgba( 34, 34, 34, 0.92 );
			--ai-fg: #ddd;
			--ai-muted: #999;
			--ai-border: rgba( 255, 255, 255, 0.12 );
			--ai-field: #111;
			--ai-hover: rgba( 255, 255, 255, 0.08 );
		}
	}
	.ai-panel.dragging, .ai-panel.dragging .ai-handle { cursor: grabbing; }

	.ai-panel .ai-row { display: flex; align-items: center; gap: 6px; }
	.ai-panel .ai-handle { flex: none; padding: 0 2px; font-weight: bold; cursor: grab; }
	.ai-panel input {
		flex: 1;
		min-width: 0;
		box-sizing: border-box;
		height: 26px;
		margin: 0;
		padding: 0 7px;
		border: 1px solid var( --ai-border );
		border-radius: 5px;
		background: var( --ai-field );
		color: var( --ai-fg );
		font: inherit;
		outline: none;
		cursor: text;
		-webkit-user-select: text;
		user-select: text;
	}
	.ai-panel input::placeholder { color: var( --ai-muted ); }
	.ai-panel input:focus { border-color: var( --ai-accent ); }
	.ai-panel button { margin: 0; font: inherit; }
	.ai-panel .ai-send, .ai-panel .ai-mute {
		flex: none;
		display: grid;
		place-items: center;
		height: 26px;
		padding: 0;
		border: 0;
		border-radius: 5px;
		cursor: pointer;
	}
	.ai-panel .ai-send { width: 28px; background: var( --ai-accent ); color: #fff; }
	.ai-panel .ai-send:hover:not( :disabled ) { filter: brightness( 1.1 ); }
	.ai-panel .ai-mute { width: 26px; background: none; color: var( --ai-muted ); }
	.ai-panel .ai-mute:hover { background: var( --ai-hover ); color: var( --ai-fg ); }
	.ai-panel .ai-mute .slash { display: none; }
	.ai-panel .ai-mute[aria-pressed="true"] { color: var( --ai-error ); }
	.ai-panel .ai-mute[aria-pressed="true"] .slash { display: inline; }
	.ai-panel button:disabled, .ai-panel input:disabled { opacity: 0.6; cursor: default; }

	/* status line with Undo, and notices about other people's AI use */
	.ai-panel .ai-status { margin-top: 6px; color: var( --ai-muted ); }
	.ai-panel .ai-status[hidden] { display: none; }
	.ai-panel .ai-status.error { color: var( --ai-error ); }
	.ai-panel .ai-undo {
		margin-left: 6px;
		padding: 0;
		border: 0;
		background: none;
		color: var( --ai-accent );
		font-weight: bold;
		text-decoration: underline;
		cursor: pointer;
	}
	.ai-panel .ai-notice {
		max-height: 0;
		overflow: hidden;
		opacity: 0;
		color: var( --ai-muted );
		transition: opacity 0.3s, max-height 0.3s, margin 0.3s;
	}
	.ai-panel .ai-notice.show { max-height: 48px; margin-top: 6px; opacity: 1; }
`;

document.head.appendChild( style );
document.body.appendChild( panel );

const saved = loadPosition();
place( saved.left, saved.top );
