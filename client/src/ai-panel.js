// AI teammate prompt bubble. All AI client code lives in this file.
//
// Type what to build or change ("a campfire", "make the fire bigger") and press Enter or the arrow.
// This calls the server's ask_ai procedure (server/src/ai.rs), which asks Gemini and adds, changes or
// removes shapes in the shared `object` table around the spot you're looking at. The objects then
// arrive through the normal subscription in multiplayer.js, for everyone, so this file never touches
// the three.js scene. There is no API key here: the key stays on the server.
//
// ask_ai runs over the editor's existing SpacetimeDB connection (editor.multiplayer.askAi), so it
// uses this tab's identity and scene. (A separate HTTP call would count as its own visit, and the
// server releases a user's locks and presence when a visit ends.)
//
// It's one line: orb, prompt, send, and a bell that mutes notices when someone else uses the AI.
// Every request uses the detailed model (the server falls back to the fast one when it's busy).
// After a change, the line below offers Undo. Drag the bubble by its orb or edge; double-click the
// orb to put it back. Position and mute are remembered in this browser.

import { tables } from './module_bindings';

// Same ?scene=N rule as multiplayer.js (default 1).
const sceneParam = new URLSearchParams( location.search ).get( 'scene' );
const SCENE_ID = /^\d+$/.test( sceneParam || '' ) ? BigInt( sceneParam ) : 1n;

const DEFAULT_POSITION = { left: 284, top: 46 }; // to the right of the multiplayer panel
const MIN_TOP = 36; // stay below the editor's menu bar
const POSITION_KEY = 'ai-panel-position';
const MUTED_KEY = 'ai-panel-muted';
const NOTICE_SECONDS = 7;

const panel = document.createElement( 'form' );
panel.className = 'ai-panel';
panel.innerHTML = `
	<div class="ai-orb" title="AI teammate · drag to move, double-click to reset"></div>
	<div class="ai-body">
		<div class="ai-row">
			<input id="ai-prompt" type="text" maxlength="300" autocomplete="off"
				aria-label="Ask the AI teammate to build or change something" placeholder="Ask AI to build… e.g. a campfire">
			<button type="submit" class="ai-send" aria-label="Build" title="Build">
				<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
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
	</div>
`;

const orb = panel.querySelector( '.ai-orb' );
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
	show( 'Building… (this can take up to a minute)' );

	try {

		const result = await multiplayer.askAi( prompt, true ); // always the detailed model
		const done = result.added + result.changed + result.removed > 0;
		show( describe( result, prompt ) );
		undoButton.hidden = ! done;
		if ( done ) input.value = '';

	} catch ( error ) {

		show( error.message, true );

	} finally {

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

// ---------------------------------------------------------------------------------------------
// Notices when someone else uses the AI (the server's public ai_event table)

let watchedConnection = null;
let noticeTimer = null;

// Subscribe once the editor is connected, and again if it ever gets a new connection.
setInterval( watchAiEvents, 1000 );

function watchAiEvents() {

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
	notice.textContent = row.undo ? `✨ ${name} undid an AI build` : `✨ ${name} asked the AI for “${row.prompt}” (${counts})`;
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
// Dragging the bubble around

let drag = null; // { dx, dy }: where inside the bubble it was grabbed
let pressedOrb = false; // was the last press on the orb? (for double-click to reset)

panel.addEventListener( 'pointerdown', ( event ) => {

	if ( event.button !== 0 || event.target.closest( 'input, button' ) ) return;
	pressedOrb = orb.contains( event.target );
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

// While dragging, the bubble captures the pointer, so the browser reports the double-click on the
// bubble itself rather than the orb: check where the press started instead.
panel.addEventListener( 'dblclick', () => {

	if ( ! pressedOrb ) return;
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
// Styles: a frosted-glass bubble with a flowing rainbow rim and glow, and a Siri-like orb.

const style = document.createElement( 'style' );
style.textContent = `
	.ai-panel {
		--ai-glass: rgba( 28, 28, 36, 0.72 );
		--ai-fg: #f5f5f7;
		--ai-muted: rgba( 235, 235, 245, 0.62 );
		--ai-field: rgba( 255, 255, 255, 0.09 );
		--ai-rainbow: linear-gradient( 90deg, #ff375f, #ff9f0a, #ffd60a, #30d158, #64d2ff, #5e5ce6, #bf5af2, #ff375f );
		--ai-gradient: linear-gradient( 135deg, #ff375f, #bf5af2 50%, #64d2ff );
		position: fixed;
		left: ${DEFAULT_POSITION.left}px;
		top: ${DEFAULT_POSITION.top}px;
		z-index: 1; /* same layer as the editor's menus, which are added later and draw on top */
		box-sizing: border-box;
		width: 360px;
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 8px;
		border-radius: 26px;
		background: var( --ai-glass );
		-webkit-backdrop-filter: blur( 18px ) saturate( 1.6 );
		backdrop-filter: blur( 18px ) saturate( 1.6 );
		color: var( --ai-fg );
		font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', Helvetica, Arial, sans-serif;
		font-size: 12px;
		line-height: 1.35;
		cursor: grab;
		-webkit-user-select: none;
		user-select: none;
		touch-action: none;
		animation: ai-glow 5s ease-in-out infinite;
	}
	.ai-panel.dragging, .ai-panel.dragging .ai-orb { cursor: grabbing; }

	/* rainbow rim: the gradient is masked down to a 2px ring around the edge */
	.ai-panel::before {
		content: '';
		position: absolute;
		inset: 0;
		padding: 2px;
		border-radius: inherit;
		background: var( --ai-rainbow );
		background-size: 300% 100%;
		animation: ai-flow 6s ease-in-out infinite alternate;
		-webkit-mask: linear-gradient( #000 0 0 ) content-box, linear-gradient( #000 0 0 );
		-webkit-mask-composite: xor;
		mask: linear-gradient( #000 0 0 ) content-box, linear-gradient( #000 0 0 );
		mask-composite: exclude;
		pointer-events: none;
	}

	.ai-panel button { margin: 0; font: inherit; }
	.ai-panel button:disabled, .ai-panel input:disabled { opacity: 0.55; cursor: default; }

	/* the orb (also the drag handle) */
	.ai-panel .ai-orb {
		position: relative;
		flex: none;
		width: 34px;
		height: 34px;
		border-radius: 50%;
		cursor: grab;
	}
	.ai-panel .ai-orb::before {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: 50%;
		background: conic-gradient( #ff375f, #ff9f0a, #ffd60a, #30d158, #64d2ff, #5e5ce6, #bf5af2, #ff375f );
		animation: ai-spin 6s linear infinite;
	}
	.ai-panel .ai-orb::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: 50%;
		background:
			radial-gradient( circle at 35% 30%, rgba( 255, 255, 255, 0.95 ), rgba( 255, 255, 255, 0.25 ) 28%, transparent 60% ),
			radial-gradient( circle, transparent 55%, rgba( 0, 0, 0, 0.22 ) 100% );
		box-shadow: inset 0 0 6px rgba( 255, 255, 255, 0.5 ), 0 0 14px rgba( 191, 90, 242, 0.6 );
	}
	.ai-panel .ai-mute {
		flex: none;
		display: grid;
		place-items: center;
		width: 30px;
		height: 30px;
		padding: 0;
		border: 0;
		border-radius: 50%;
		background: var( --ai-field );
		color: var( --ai-muted );
		cursor: pointer;
	}
	.ai-panel .ai-mute:hover { color: var( --ai-fg ); }
	.ai-panel .ai-mute .slash { display: none; }
	.ai-panel .ai-mute[aria-pressed="true"] { color: #ff6b81; }
	.ai-panel .ai-mute[aria-pressed="true"] .slash { display: inline; }

	.ai-panel .ai-body { flex: 1; min-width: 0; }
	.ai-panel .ai-row { display: flex; align-items: center; gap: 6px; }
	.ai-panel input {
		flex: 1;
		min-width: 0;
		height: 34px;
		margin: 0;
		padding: 0 14px;
		border: 0;
		border-radius: 17px;
		background: var( --ai-field );
		color: var( --ai-fg );
		font: inherit;
		font-size: 13px;
		outline: none;
		cursor: text;
		-webkit-user-select: text;
		user-select: text;
	}
	.ai-panel input::placeholder { color: var( --ai-muted ); }
	.ai-panel input:focus { box-shadow: 0 0 0 2px rgba( 100, 210, 255, 0.6 ); }
	.ai-panel .ai-send {
		flex: none;
		display: grid;
		place-items: center;
		width: 34px;
		height: 34px;
		padding: 0;
		border: 0;
		border-radius: 50%;
		background: var( --ai-gradient );
		color: #fff;
		cursor: pointer;
		box-shadow: 0 2px 10px rgba( 191, 90, 242, 0.45 );
		transition: transform 0.15s;
	}
	.ai-panel .ai-send:hover:not( :disabled ) { transform: scale( 1.08 ); }

	/* status line with Undo, and notices about other people's AI use */
	.ai-panel .ai-status { margin: 6px 6px 2px; color: var( --ai-muted ); font-size: 11.5px; }
	.ai-panel .ai-status[hidden] { display: none; }
	.ai-panel .ai-status.error { color: #ff6b81; }
	.ai-panel .ai-undo {
		margin-left: 6px;
		padding: 0;
		border: 0;
		background: none;
		color: #64d2ff;
		font-size: 11.5px;
		font-weight: 600;
		text-decoration: underline;
		cursor: pointer;
	}
	.ai-panel .ai-notice {
		max-height: 0;
		margin: 0 6px;
		overflow: hidden;
		opacity: 0;
		font-size: 11.5px;
		background: var( --ai-rainbow );
		background-size: 300% 100%;
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
		animation: ai-flow 3s linear infinite alternate;
		transition: opacity 0.3s, max-height 0.3s, margin 0.3s;
	}
	.ai-panel .ai-notice.show { max-height: 48px; margin: 5px 6px 1px; opacity: 1; }

	/* while the AI is building: faster rim and glow, pulsing orb, shimmering text */
	.ai-panel.busy { animation-duration: 1.6s; }
	.ai-panel.busy::before { animation-duration: 1.2s; }
	.ai-panel.busy .ai-orb { animation: ai-pulse 0.9s ease-in-out infinite; }
	.ai-panel.busy .ai-orb::before { animation-duration: 0.9s; }
	.ai-panel.busy .ai-status-text {
		background: var( --ai-rainbow );
		background-size: 300% 100%;
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
		animation: ai-flow 1.5s linear infinite alternate;
	}

	@keyframes ai-flow { from { background-position: 0% 50%; } to { background-position: 100% 50%; } }
	@keyframes ai-spin { to { rotate: 360deg; } }
	@keyframes ai-pulse { 50% { scale: 1.14; } }
	@keyframes ai-glow {
		0%, 100% { box-shadow: -10px 0 24px -8px rgba( 255, 55, 95, 0.6 ), 10px 0 24px -8px rgba( 100, 210, 255, 0.6 ), 0 12px 28px -10px rgba( 191, 90, 242, 0.55 ); }
		33% { box-shadow: -10px 0 24px -8px rgba( 255, 159, 10, 0.6 ), 10px 0 24px -8px rgba( 94, 92, 230, 0.6 ), 0 12px 28px -10px rgba( 48, 209, 88, 0.5 ); }
		66% { box-shadow: -10px 0 24px -8px rgba( 100, 210, 255, 0.6 ), 10px 0 24px -8px rgba( 255, 55, 95, 0.6 ), 0 12px 28px -10px rgba( 255, 214, 10, 0.5 ); }
	}

	@media ( prefers-color-scheme: light ) {
		.ai-panel {
			--ai-glass: rgba( 255, 255, 255, 0.78 );
			--ai-fg: #1c1c1e;
			--ai-muted: rgba( 60, 60, 67, 0.65 );
			--ai-field: rgba( 0, 0, 0, 0.055 );
		}
		.ai-panel .ai-status.error { color: #e0263f; }
		.ai-panel .ai-undo { color: #0a84ff; }
	}

	@media ( prefers-reduced-motion: reduce ) {
		.ai-panel, .ai-panel::before, .ai-panel .ai-orb, .ai-panel .ai-orb::before, .ai-panel .ai-status-text, .ai-panel .ai-notice { animation: none !important; }
	}
`;

document.head.appendChild( style );
document.body.appendChild( panel );

const saved = loadPosition();
place( saved.left, saved.top );
