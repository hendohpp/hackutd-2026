// AI teammate prompt bubble. All AI client code lives in this file.
//
// Type what to build ("a campfire") and press Enter or the arrow. This calls the server's ask_ai
// procedure (server/src/ai.rs), which asks Gemini and inserts the shapes into the shared `object`
// table. The new objects then arrive through the normal subscription in multiplayer.js, for
// everyone, so this file never touches the three.js scene. There is no API key here: the key
// lives only in the server's private ai_config table.
//
// ask_ai is called over SpacetimeDB's HTTP API with this tab's own login token, so the server
// sees the same user who joined the scene. That way the generated module_bindings don't change.
//
// The bubble can be dragged anywhere by its orb or edge; double-click the orb to put it back.
// Its position is remembered in this browser.

// Same ?scene=N rule as multiplayer.js (default 1).
const sceneParam = new URLSearchParams( location.search ).get( 'scene' );
const SCENE_ID = /^\d+$/.test( sceneParam || '' ) ? Number( sceneParam ) : 1;

const DEFAULT_POSITION = { left: 284, top: 46 }; // to the right of the multiplayer panel
const MIN_TOP = 36; // stay below the editor's menu bar
const POSITION_KEY = 'ai-panel-position';

const panel = document.createElement( 'form' );
panel.className = 'ai-panel';
panel.innerHTML = `
	<div class="ai-orb" title="AI teammate · drag to move, double-click to reset"></div>
	<div class="ai-body">
		<div class="ai-row">
			<input id="ai-prompt" type="text" maxlength="300" autocomplete="off"
				aria-label="Ask the AI teammate to build something" placeholder="Ask AI to build… e.g. a campfire">
			<button type="submit" aria-label="Build" title="Build">
				<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
					<path d="M12 19V5M5 12l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</button>
		</div>
		<div class="ai-status" aria-live="polite"></div>
	</div>
`;

const orb = panel.querySelector( '.ai-orb' );
const input = panel.querySelector( 'input' );
const button = panel.querySelector( 'button' );
const status = panel.querySelector( '.ai-status' );

// The editor handles keys on the whole page (Delete removes the selection, Backspace is blocked).
// Keep typing in this box to the box, like the editor's own text fields do.
input.addEventListener( 'keydown', ( event ) => event.stopPropagation() );

// ---------------------------------------------------------------------------------------------
// Asking the AI

panel.addEventListener( 'submit', async ( event ) => {

	event.preventDefault();

	const prompt = input.value.trim();
	if ( prompt === '' ) return;

	const multiplayer = window.editor && window.editor.multiplayer;
	const login = multiplayer && multiplayer.connected ? findLogin( multiplayer.conn ) : null;
	if ( login === null ) return show( 'Not connected to the database yet.', true );

	input.disabled = button.disabled = true;
	panel.classList.add( 'busy' );
	show( 'Building…' );

	try {

		const response = await fetch( `${login.http}/v1/database/${encodeURIComponent( login.db )}/call/ask_ai`, {
			method: 'POST',
			headers: { 'Authorization': `Bearer ${login.token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify( [ SCENE_ID, prompt ] ),
		} );

		if ( ! response.ok ) {

			show( `The AI isn't available on this database (HTTP ${response.status}).`, true );
			return;

		}

		// ask_ai returns Result<u32, String>: [0, count] on success, [1, "message"] on error.
		const [ tag, value ] = await response.json();
		if ( tag === 0 ) {

			show( `Added ${value} object${value === 1 ? '' : 's'} for “${prompt}”.` );
			input.value = '';

		} else {

			show( value, true );

		}

	} catch ( error ) {

		show( `Couldn't reach the AI: ${error.message}`, true );

	} finally {

		panel.classList.remove( 'busy' );
		input.disabled = button.disabled = false;
		input.focus();

	}

} );

function show( text, isError = false ) {

	status.textContent = text;
	status.classList.toggle( 'error', isError );

}

// multiplayer.js saves this tab's login token in sessionStorage under "<server uri>/<database>/auth_token".
// Find the entry holding the current connection's token and read the server and database from its key,
// so this file follows whatever database the editor is connected to.
function findLogin( conn ) {

	try {

		for ( let i = 0; i < sessionStorage.length; i ++ ) {

			const key = sessionStorage.key( i );
			const match = key.match( /^(wss?:\/\/.+)\/([^/]+)\/auth_token$/ );
			if ( match && conn.token && sessionStorage.getItem( key ) === conn.token ) {

				return { http: match[ 1 ].replace( /^ws/, 'http' ), db: match[ 2 ], token: conn.token };

			}

		}

	} catch { /* storage unavailable */ }

	return null;

}

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
		position: fixed;
		left: ${DEFAULT_POSITION.left}px;
		top: ${DEFAULT_POSITION.top}px;
		z-index: 1; /* same layer as the editor's menus, which are added later and draw on top */
		box-sizing: border-box;
		width: 340px;
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

	/* the orb: a spinning rainbow sphere with a glossy highlight */
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

	.ai-panel .ai-body { flex: 1; min-width: 0; }
	.ai-panel .ai-row { display: flex; gap: 6px; }
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
	.ai-panel button {
		flex: none;
		display: grid;
		place-items: center;
		width: 34px;
		height: 34px;
		margin: 0;
		padding: 0;
		border: 0;
		border-radius: 50%;
		background: linear-gradient( 135deg, #ff375f, #bf5af2 50%, #64d2ff );
		color: #fff;
		cursor: pointer;
		box-shadow: 0 2px 10px rgba( 191, 90, 242, 0.45 );
		transition: transform 0.15s;
	}
	.ai-panel button:hover:not( :disabled ) { transform: scale( 1.08 ); }
	.ai-panel button:disabled, .ai-panel input:disabled { opacity: 0.55; cursor: default; }
	.ai-panel .ai-status { margin: 6px 6px 2px; color: var( --ai-muted ); font-size: 11.5px; }
	.ai-panel .ai-status:empty { display: none; }
	.ai-panel .ai-status.error { color: #ff6b81; }

	/* while the AI is building: faster rim and glow, pulsing orb, shimmering text */
	.ai-panel.busy { animation-duration: 1.6s; }
	.ai-panel.busy::before { animation-duration: 1.2s; }
	.ai-panel.busy .ai-orb { animation: ai-pulse 0.9s ease-in-out infinite; }
	.ai-panel.busy .ai-orb::before { animation-duration: 0.9s; }
	.ai-panel.busy .ai-status {
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
	}

	@media ( prefers-reduced-motion: reduce ) {
		.ai-panel, .ai-panel::before, .ai-panel .ai-orb, .ai-panel .ai-orb::before, .ai-panel .ai-status { animation: none !important; }
	}
`;

document.head.appendChild( style );
document.body.appendChild( panel );

const saved = loadPosition();
place( saved.left, saved.top );
