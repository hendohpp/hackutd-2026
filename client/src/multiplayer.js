import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DbConnection, tables } from './module_bindings';
import { signInAvailable, takeSignInFailed, signedInToken, renewedSignInToken, signIn, signOut, forgetSignIn } from './auth.js';
import './multiplayer.css';

// ---------------------------------------------------------------------------------------------
// Config. Defaults: local server in `npm run dev`, Maincloud in the production build.
// Override with VITE_SPACETIME_URI / VITE_SPACETIME_DB (see client/.env.example).

const URI = import.meta.env.VITE_SPACETIME_URI || ( import.meta.env.PROD ? 'wss://maincloud.spacetimedb.com' : 'ws://localhost:3000' );
const DB_NAME = import.meta.env.VITE_SPACETIME_DB || ( import.meta.env.PROD ? 'collab3d' : 'collab3d' );

// Everyone on the same link edits the same scene: ?scene=N, default 1.
const sceneParam = new URLSearchParams( location.search ).get( 'scene' );
const SCENE_ID = /^\d+$/.test( sceneParam || '' ) ? BigInt( sceneParam ) : 1n;

// sessionStorage: every tab is its own user (so two tabs can test locking), and a refresh keeps the identity.
const TOKEN_KEY = `${URI}/${DB_NAME}/auth_token`;

const SEND_INTERVAL = 66; // ms between updates while dragging or scrubbing a color (~15 per second)
const LOCK_RENEW_INTERVAL = 10_000; // the server expires locks after 30 s
const PRESENCE_INTERVAL = 1_000;
const VIEWER_INTERVAL = 100; // ms between camera updates while your camera moves (~10 per second)
const VIEWER_HIDE_DISTANCE = 0.75; // hide someone whose camera is right where yours is (everyone starts at the same spot)
const GAZE_LENGTH = 4; // length of the gaze line when it doesn't hit anything
const MAX_NAME_CHARS = 24; // same limit as the server's set_name
const NAME_KEY = 'collab3d/name'; // localStorage: the browser remembers your name, so new tabs reuse it
const EPSILON = 1e-4;

// New objects pop in (scale up with a little overshoot). Objects that arrive together (an AI build) start
// one after another, POP_STAGGER apart, so the build assembles in the order the AI planned it.
const POP_DURATION = 380; // ms
const POP_STAGGER = 8; // ms
const POP_MAX_DELAY = 1000; // ms

// Where ask_ai builds: the spot on the ground the camera looks at. Same math and limits as looking_at in
// server/src/ai.rs (LOOK_DISTANCE, MAX_LOOK_DISTANCE, WORLD_LIMIT): keep them in sync.
const AI_LOOK_DISTANCE = 8;
const AI_MAX_LOOK_DISTANCE = 150;
const AI_WORLD_LIMIT = 1000;

// The kinds the database knows, built exactly like the editor's Add menu builds them.
const KINDS = {
	box: () => mesh( 'Box', new THREE.BoxGeometry( 1, 1, 1, 1, 1, 1 ) ),
	sphere: () => mesh( 'Sphere', new THREE.SphereGeometry( 1, 32, 16, 0, Math.PI * 2, 0, Math.PI ) ),
	cylinder: () => mesh( 'Cylinder', new THREE.CylinderGeometry( 1, 1, 1, 32, 1, false, 0, Math.PI * 2 ) ),
	plane: () => mesh( 'Plane', new THREE.PlaneGeometry( 1, 1, 1, 1 ) ),
	pointlight: () => named( new THREE.PointLight( 0xffffff, 1, 0 ), 'PointLight' ),
	// AI teammate shapes (server/src/ai.rs base_size must match these sizes)
	cone: () => mesh( 'Cone', new THREE.ConeGeometry( 1, 1, 32 ) ),
	capsule: () => mesh( 'Capsule', new THREE.CapsuleGeometry( 1, 1, 4, 8, 1 ) ),
	torus: () => mesh( 'Torus', new THREE.TorusGeometry( 1, 0.4, 12, 48, Math.PI * 2 ) ),
	icosahedron: () => mesh( 'Icosahedron', new THREE.IcosahedronGeometry( 1, 0 ) ),
};

// ---------------------------------------------------------------------------------------------

class Multiplayer {

	constructor( editor ) {

		this.editor = editor;
		this.conn = null;
		this.connected = false;
		this.identity = null; // my identity, hex
		this.triedWithoutToken = false;

		this.byId = new Map(); // row id (string) -> sync state { id, object, row, ... }
		this.byObject = new WeakMap(); // THREE.Object3D -> sync state
		this.applying = 0; // > 0 while applying database rows: ignore the editor signals they cause
		this.sceneRefresh = null; // objects added/removed since the editor last heard (see queueSceneRefresh)
		this.ready = false; // the scene has loaded once; from then on, new objects pop in
		this.pops = new Map(); // THREE.Object3D -> { start, scale }: objects popping in (see updateMotion)
		this.popBatch = { at: 0, count: 0 }; // objects started popping within the same moment, for the stagger
		this.buildMarker = null; // the ring showing where the AI is building
		this.animations = new Map(); // object id (string) -> animation row (server/src/animation.rs), played in updateMotion
		this.pausedAnimations = new Set(); // object ids whose animation waits while I have them selected
		this.serverClockOffset = null; // ms to add to Date.now() for the server's clock (see sampleClock)
		this.selectedIds = new Set(); // synced objects in my selection (I hold, or am acquiring, their locks)
		this.pendingAdds = 0;
		this.viewers = new Map(); // identity hex -> camera marker for someone else's view
		this.lastViewerSent = 0;
		this.nameDialog = null;
		this.nameSkipped = false; // "Not now" on the name dialog: don't ask again this visit
		this.signedIn = false; // connected with a SpacetimeAuth sign-in (auth.js) rather than as a guest

		// Floating panel (top-left of the viewport): back to your servers + this server's name, connection
		// badge, a notice (e.g. not a member), who's here, sign in/out.
		this.server = createElement( 'div', 'collab3d-server', '<a href="servers.html" title="Your servers">← Servers</a><span class="name"></span>' );
		this.serverName = this.server.querySelector( '.name' );
		this.badge = createElement( 'div', 'collab3d-badge', '<span class="dot"></span><span class="text">Connecting…</span>' );
		this.notice = createElement( 'div', 'collab3d-notice' );
		this.notice.hidden = true;
		this.people = createElement( 'div', 'collab3d-people' );
		this.account = createElement( 'div', 'collab3d-account' );
		this.account.hidden = true;
		this.panel = createElement( 'div', 'collab3d-panel' );
		this.panel.append( this.server, this.badge, this.notice, this.people, this.account );
		this.toastBox = createElement( 'div', 'collab3d-toasts' );
		document.body.append( this.panel, this.toastBox );

		this.listenToEditor();

	}

	// -------------------------------------------------------------------------------------------
	// Connection

	async connect() {

		this.setStatus( 'connecting' );

		// Sign-ins finish on the landing page (SpacetimeAuth's redirect URL), which notes it if one started here failed.
		if ( takeSignInFailed() ) this.pendingNotice = 'Sign-in didn\'t complete. You\'re continuing as a guest.'; // shown once connected

		let signInToken;

		try {

			signInToken = await signedInToken();

		} catch ( error ) {

			console.warn( '[collab3d] couldn\'t read the sign-in:', error );

		}

		// Signed in: connect with the account's token (same identity on every device). Guest: this tab's token.
		this.signedIn = signInToken !== undefined;
		const token = signInToken ?? readToken();
		this.refreshAccount();

		const builder = DbConnection.builder()
			.withUri( URI )
			.withDatabaseName( DB_NAME )
			.withToken( token )
			.withAutomaticReconnect()
			.onConnect( ( _conn, identity, newToken ) => {

				// Guests keep the token SpacetimeDB issued them; a sign-in brings its own.
				if ( this.signedIn === false ) writeToken( newToken );
				this.identity = identity.toHexString();
				this.connected = true;
				this.setStatus( 'live' );
				this.onConnected();

			} )
			.onDisconnect( ( _ctx, error, nextAttempt ) => {

				this.connected = false;
				this.setStatus( nextAttempt !== undefined ? 'reconnecting' : 'offline' );
				if ( error ) console.warn( '[collab3d] disconnected:', error );

			} )
			.onConnectError( ( _ctx, error, nextAttempt ) => {

				this.connected = false;
				console.error( '[collab3d] connection failed:', error );

				if ( nextAttempt !== undefined ) {

					this.setStatus( 'reconnecting' );

				} else if ( this.signedIn ) {

					// The sign-in was refused (e.g. it expired): continue as a guest.
					this.signedIn = false;
					this.toast( 'Your sign-in expired. You\'re continuing as a guest; sign in again from the panel.' );
					forgetSignIn().finally( () => this.connect() );

				} else if ( token !== undefined && this.triedWithoutToken === false ) {

					// A stale token (e.g. the database was recreated) can't connect: start over as a new user.
					this.triedWithoutToken = true;
					clearToken();
					this.connect();

				} else {

					this.setStatus( 'offline' );
					this.toast( `Can't reach the database "${DB_NAME}". Check your connection and refresh.` );

				}

			} );

		// Signed in: reconnects ask for a current token (sign-in tokens last 15 minutes; auth.js renews them).
		if ( this.signedIn ) builder.withTokenProvider( renewedSignInToken );
		this.conn = builder.build();

		const db = this.conn.db;

		// Row callbacks and the subscription are registered once; the SDK replays them after reconnecting.
		db.object.onInsert( ( ctx, row ) => {

			this.applyRow( row );
			this.selectIfMyNewObject( ctx, row );

		} );
		db.object.onUpdate( ( _ctx, _oldRow, row ) => this.applyRow( row ) );
		db.object.onDelete( ( _ctx, row ) => this.removeRow( row ) );

		db.scene.onInsert( () => this.refreshServerName() );
		db.scene.onUpdate( () => this.refreshServerName() );

		for ( const table of [ db.user, db.presence ] ) {

			table.onInsert( () => this.refreshPeople() );
			table.onUpdate( () => this.refreshPeople() );
			table.onDelete( () => this.refreshPeople() );

		}

		this.conn.subscriptionBuilder()
			.onApplied( () => this.syncAll() )
			.onError( ( _ctx, error ) => {

				console.error( '[collab3d] subscription failed:', error );
				this.toast( 'Subscription failed, see the console.' );

			} )
			.subscribe( [
				tables.object.where( ( r ) => r.sceneId.eq( SCENE_ID ) ),
				tables.presence.where( ( r ) => r.sceneId.eq( SCENE_ID ) ),
				tables.scene.where( ( r ) => r.id.eq( SCENE_ID ) ), // this server's name
				tables.user,
			] );

		db.viewer.onInsert( ( _ctx, row ) => this.applyViewer( row ) );
		db.viewer.onUpdate( ( _ctx, _oldRow, row ) => this.applyViewer( row ) );
		db.viewer.onDelete( ( _ctx, row ) => this.removeViewer( row.identity.toHexString() ) );

		// Cameras have their own subscription, so a server without the viewer table can't break the scene.
		this.conn.subscriptionBuilder()
			.onApplied( () => this.syncViewers() )
			.onError( ( _ctx, error ) => console.warn( '[collab3d] other people\'s cameras are unavailable:', error ) )
			.subscribe( [ tables.viewer.where( ( r ) => r.sceneId.eq( SCENE_ID ) ) ] );

		// Animations too.
		db.animation.onInsert( ( _ctx, row ) => this.applyAnimation( row ) );
		db.animation.onUpdate( ( _ctx, _oldRow, row ) => this.applyAnimation( row ) );
		db.animation.onDelete( ( _ctx, row ) => this.removeAnimation( row ) );

		// The server's clock, to play animations in step: changes from my own calls say when they ran there.
		for ( const table of [ db.object, db.presence, db.viewer, db.animation ] ) {

			table.onInsert( ( ctx ) => this.sampleClock( ctx ) );
			table.onUpdate( ( ctx ) => this.sampleClock( ctx ) );

		}

		this.conn.subscriptionBuilder()
			.onError( ( _ctx, error ) => console.warn( '[collab3d] animations are unavailable:', error ) )
			.subscribe( [ tables.animation.where( ( r ) => r.sceneId.eq( SCENE_ID ) ) ] );

		if ( this.renewTimer === undefined ) this.renewTimer = setInterval( () => this.renewLocks(), LOCK_RENEW_INTERVAL );

	}

	async onConnected() {

		if ( this.pendingNotice ) {

			this.toast( this.pendingNotice );
			this.pendingNotice = null;

		}

		try {

			await this.conn.reducers.joinScene( { sceneId: SCENE_ID } );
			this.showNotice( null );

		} catch ( error ) {

			// Invite-only server you haven't joined, or no such scene: say so in the panel (it stays up).
			if ( /invite-only/.test( error.message ) ) this.showNotice( 'You\'re not a member of this server. Join it with its invite code on <a href="servers.html">your servers page</a>.' );
			else if ( /scene not found/.test( error.message ) ) this.showNotice( 'This server doesn\'t exist. Pick one on <a href="servers.html">your servers page</a>.' );
			else this.toast( `Couldn't join scene ${SCENE_ID}: ${error.message}` );
			return;

		}

		this.sendPresence( true );
		this.sendViewer( true );

		// A few more calls early on give the server-clock estimate (sampleClock, for animations) good samples
		// even if this tab just watches.
		for ( const delay of [ 1000, 2000, 3500 ] ) setTimeout( () => this.sendPresence( true ), delay );

		// After a reconnect the server has released our locks: take them again.
		for ( const id of this.selectedIds ) this.acquire( id );

	}

	// A message at the top of the panel (HTML, our own text only), or null to hide it.
	showNotice( html ) {

		this.notice.hidden = html === null;
		this.notice.innerHTML = html ?? '';

	}

	// The server's name in the panel and the tab title (scene table, this scene only).
	refreshServerName() {

		const row = this.conn?.db.scene.id.find( SCENE_ID );
		const name = row ? row.name : '';
		this.serverName.textContent = name;
		document.title = name ? `${name} · collab3d` : 'collab3d';

	}

	setStatus( status ) {

		this.status = status;
		this.badge.dataset.status = status;
		this.refreshPeople();

	}

	// -------------------------------------------------------------------------------------------
	// Database -> scene. The ONLY place synced objects are added, changed or removed.

	applyRow( row ) {

		if ( row.sceneId !== SCENE_ID ) return;

		const id = row.id.toString();
		let s = this.byId.get( id );
		const isNew = s === undefined;

		this.applying ++;

		try {

			let changed = false;

			if ( isNew ) {

				const make = Object.hasOwn( KINDS, row.kind ) ? KINDS[ row.kind ]
					: ASSET_KIND.test( row.kind ) ? assetKind( row.kind, this.editor ) : unknownKind( row.kind );
				const object = make();
				object.userData.id = id;

				s = { id, object, row, transformTimer: null, colorTimer: null, transformsInFlight: 0, colorsInFlight: 0, lastTransformSent: 0, lastColorSent: 0, lock: null };
				this.byId.set( id, s );
				this.byObject.set( object, s );

				setTransform( object, row );
				setColor( object, row.color );
				this.addQuietly( object );
				if ( this.ready ) this.startPop( object ); // not when the scene first loads
				changed = true;

			}

			s.row = row;
			const object = s.object;

			// Don't fight local edits that haven't round-tripped yet (a drag, or a send still in flight);
			// reconcile() catches up afterwards.
			// A popping object shows less than its real size: compare (and set) the real one.
			const pop = this.pops.get( object );
			if ( pop !== undefined ) object.scale.copy( pop.scale );

			if ( this.animations.has( id ) && this.pausedAnimations.has( id ) === false ) {

				// Animated: updateMotion places it every frame from this row. Only its size comes from here.
				if ( object.scale.x !== row.scale.x || object.scale.y !== row.scale.y || object.scale.z !== row.scale.z ) {

					object.scale.set( row.scale.x, row.scale.y, row.scale.z );
					changed = true;

				}

			} else if ( object.userData.dragging !== true && s.transformsInFlight === 0 && s.transformTimer === null && sameTransform( object, row ) === false ) {

				setTransform( object, row );
				changed = true;

			}

			if ( pop !== undefined ) {

				pop.scale.copy( object.scale ); // keep popping, to the (possibly new) real size
				applyPop( object, pop, performance.now() );

			}

			let colorChanged = false;

			if ( s.colorsInFlight === 0 && s.colorTimer === null ) {

				colorChanged = setColor( object, row.color );

			}

			if ( this.updateLockVisual( s ) ) changed = true;

			// New objects: the editor hears about them in queueSceneRefresh's once-per-frame update instead.
			if ( isNew === false ) {

				// Objects moved: gaze lines may now hit something else.
				if ( changed && this.viewers.size > 0 ) this.refreshGazes();

				// Only signal real changes: echoes of my own edits must not touch the editor mid-drag
				// (objectChanged re-anchors a multi-selection's pivot).
				if ( changed || colorChanged ) this.editor.signals.objectChanged.dispatch( object ); // re-render, refresh sidebar and helpers
				if ( colorChanged && object.material ) this.editor.signals.materialChanged.dispatch( object, 0 );

			}

		} finally {

			this.applying --;

		}

	}

	removeRow( row ) {

		const id = row.id.toString();
		const s = this.byId.get( id );
		if ( s === undefined ) return;

		this.byId.delete( id );
		this.selectedIds.delete( id );
		clearTimeout( s.transformTimer );
		clearTimeout( s.colorTimer );

		this.applying ++;

		try {

			const selection = this.editor.selector.selection;
			if ( selection.includes( s.object ) ) this.editor.selector.setSelection( selection.filter( ( o ) => o !== s.object ) );

			this.removeLockVisual( s );
			this.pops.delete( s.object );
			this.removeQuietly( s.object );
			disposeObject( s.object );

		} finally {

			this.applying --;

		}

	}

	// An AI build arrives as one transaction with up to hundreds of rows. Telling the editor about each
	// object (editor.addObject / removeObject) redraws the viewport and rebuilds the outliner once per
	// object, which froze the page for seconds. Rows are added and removed quietly instead, and the
	// editor hears about them once per frame.
	addQuietly( object ) {

		const editor = this.editor;

		object.traverse( ( child ) => { // as editor.addObject does

			if ( child.geometry !== undefined ) editor.addGeometry( child.geometry );
			if ( child.material !== undefined ) editor.addMaterial( child.material );
			editor.addCamera( child );
			editor.addHelper( child );

		} );
		editor.scene.add( object );
		this.queueSceneRefresh( 'added', object );

	}

	removeQuietly( object ) {

		const editor = this.editor;
		if ( object.parent === null ) return;

		object.traverse( ( child ) => { // as editor.removeObject does

			editor.removeCamera( child );
			editor.removeHelper( child );
			if ( child.material !== undefined ) editor.removeMaterial( child.material );

		} );
		object.parent.remove( object );
		this.queueSceneRefresh( 'removed', object );

	}

	// change: 'added' / 'removed' (with the object), or nothing (e.g. a 3D model finished loading).
	queueSceneRefresh( change, object ) {

		if ( this.sceneRefresh === null ) {

			this.sceneRefresh = { added: null, removed: null };
			requestAnimationFrame( () => this.flushSceneRefresh() );

		}

		if ( change !== undefined ) this.sceneRefresh[ change ] = object;

	}

	flushSceneRefresh() {

		const { added, removed } = this.sceneRefresh;
		this.sceneRefresh = null;
		const signals = this.editor.signals;

		this.applying ++;

		try {

			// Their listeners (object counts, animation list) recount the whole scene, so once each is enough.
			if ( added !== null ) signals.objectAdded.dispatch( added );
			if ( removed !== null ) signals.objectRemoved.dispatch( removed );
			signals.sceneGraphChanged.dispatch(); // outliner + redraw

		} finally {

			this.applying --;

		}

		if ( ( added !== null || removed !== null ) && this.viewers.size > 0 ) {

			this.refreshGazes(); // objects came or went: gaze lines may now hit something else
			this.requestRender();

		}

	}

	// -------------------------------------------------------------------------------------------
	// Motion: new objects pop in, and a ring marks where the AI is building. The viewport's animation
	// loop calls updateMotion() every frame and redraws while it returns true (editor/js/Viewport.js, #SPACETIME).

	startPop( object ) {

		const now = performance.now();
		if ( now - this.popBatch.at > 50 ) this.popBatch.count = 0; // a new batch
		this.popBatch.at = now;

		const delay = Math.min( this.popBatch.count ++ * POP_STAGGER, POP_MAX_DELAY );
		const pop = { start: now + delay, scale: object.scale.clone() };
		this.pops.set( object, pop );
		applyPop( object, pop, now );

	}

	// Straight to the real size (before its transform is sent, or when it's removed).
	finishPop( object ) {

		const pop = this.pops.get( object );
		if ( pop === undefined ) return;

		object.scale.copy( pop.scale );
		this.pops.delete( object );

	}

	updateMotion() {

		const now = performance.now();
		let moving = false;

		for ( const [ object, pop ] of this.pops ) {

			moving = true;

			if ( object.parent === null || now >= pop.start + POP_DURATION ) {

				this.finishPop( object );
				if ( this.editor.selector.selection.includes( object ) ) this.requestRender( object ); // its selection box, at the real size

			} else {

				applyPop( object, pop, now );

			}

		}

		if ( this.animations.size > 0 ) {

			const seconds = this.serverNow() / 1000;

			for ( const [ id, anim ] of this.animations ) {

				const s = this.byId.get( id );
				if ( s === undefined ) continue;

				// Mine to edit right now: show where it really is (its row), so the gizmo and my edits use that.
				if ( this.selectedIds.has( id ) || s.object.userData.dragging === true ) {

					if ( this.pausedAnimations.has( id ) === false ) {

						this.pausedAnimations.add( id );
						restPose( s.object, s.row );
						this.requestRender( s.object ); // the selection box, around where it really is

					}

					continue;

				}

				this.pausedAnimations.delete( id );
				animatePose( s.object, s.row, anim, seconds );
				moving = true;

			}

		}

		const marker = this.buildMarker;

		if ( marker !== null ) {

			moving = true;
			const fade = marker.end === null ? 1 : Math.max( 0, 1 - ( now - marker.end ) / 400 );

			// A steady ring, and a second one that keeps spreading out from it and fading.
			const wave = ( ( now - marker.start ) % 1400 ) / 1400;
			marker.ring.material.opacity = 0.85 * fade;
			marker.wave.scale.setScalar( 1 + wave * 1.6 );
			marker.wave.material.opacity = 0.6 * ( 1 - wave ) * fade;

			if ( fade === 0 ) this.removeBuildMarker();

		}

		return moving;

	}

	applyAnimation( row ) {

		if ( row.sceneId !== SCENE_ID ) return;
		this.animations.set( row.objectId.toString(), row );

	}

	removeAnimation( row ) {

		const id = row.objectId.toString();
		this.animations.delete( id );
		this.pausedAnimations.delete( id );

		// Back to where it really is.
		const s = this.byId.get( id );

		if ( s !== undefined ) {

			restPose( s.object, s.row );
			this.requestRender( s.object );

		}

	}

	// A change from one of my own reducer calls carries the server's time when the call ran, and reaches me
	// a little later: the smallest gap seen is the best guess of the clock difference. (Rows from a
	// subscription snapshot, or from other people's calls, don't say when they ran.) Animations play on the
	// server's clock, so everyone sees the same moment of the same motion.
	sampleClock( ctx ) {

		if ( ctx.event?.tag !== 'Reducer' ) return;

		const sample = Number( ctx.event.value.timestamp.microsSinceUnixEpoch / 1000n ) - Date.now();
		this.serverClockOffset = this.serverClockOffset === null ? sample : Math.max( this.serverClockOffset, sample );

	}

	serverNow() {

		return Date.now() + ( this.serverClockOffset ?? 0 );

	}

	// Where ask_ai will build: the spot on the ground the camera looks at (looking_at in server/src/ai.rs).
	lookSpot() {

		const camera = this.editor.viewportCamera || this.editor.camera;
		const eye = camera.getWorldPosition( new THREE.Vector3() );
		const dir = camera.getWorldDirection( new THREE.Vector3() );
		const flat = Math.max( Math.hypot( dir.x, dir.z ), 1e-6 );
		const along = dir.y < - 0.05 ? - eye.y / dir.y * flat : AI_LOOK_DISTANCE;
		const d = THREE.MathUtils.clamp( along, 0, AI_MAX_LOOK_DISTANCE );
		const limit = ( v ) => THREE.MathUtils.clamp( v, - AI_WORLD_LIMIT, AI_WORLD_LIMIT );
		return new THREE.Vector3( limit( eye.x + dir.x / flat * d ), 0, limit( eye.z + dir.z / flat * d ) );

	}

	showBuildMarker() {

		this.removeBuildMarker();

		const material = () => new THREE.MeshBasicMaterial( { color: 0x8b5cf6, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide } );
		const ring = new THREE.Mesh( new THREE.RingGeometry( 1.7, 2, 64 ), material() );
		const wave = new THREE.Mesh( new THREE.RingGeometry( 1.85, 2, 64 ), material() );
		const group = new THREE.Group();
		group.name = 'AI build marker';

		for ( const mesh of [ ring, wave ] ) {

			mesh.rotation.x = - Math.PI / 2; // lie flat on the ground
			group.add( mesh );

		}

		const spot = this.lookSpot();
		const camera = this.editor.viewportCamera || this.editor.camera;
		group.position.set( spot.x, 0.03, spot.z );
		group.scale.setScalar( Math.max( 1, camera.getWorldPosition( new THREE.Vector3() ).distanceTo( spot ) / 12 ) ); // readable from afar
		this.editor.sceneHelpers.add( group );
		this.buildMarker = { group, ring, wave, start: performance.now(), end: null };

	}

	// Fades out (updateMotion removes it).
	hideBuildMarker() {

		if ( this.buildMarker !== null && this.buildMarker.end === null ) this.buildMarker.end = performance.now();

	}

	removeBuildMarker() {

		if ( this.buildMarker === null ) return;

		this.editor.sceneHelpers.remove( this.buildMarker.group );
		disposeObject( this.buildMarker.group );
		this.buildMarker = null;

	}

	// Subscription (re)applied: make the scene match the cache exactly.
	syncAll() {

		const live = new Set();

		for ( const row of this.conn.db.object.iter() ) {

			live.add( row.id.toString() );
			this.applyRow( row );

		}

		for ( const s of [ ...this.byId.values() ] ) {

			if ( live.has( s.id ) === false ) this.removeRow( s.row );

		}

		this.refreshPeople();
		this.refreshServerName();
		this.ensureName(); // my user row is in the cache now
		this.ready = true;

	}

	// After my own updates finish, show exactly what the database holds.
	reconcile( s ) {

		if ( this.byId.get( s.id ) !== s ) return; // deleted meanwhile
		if ( s.object.userData.dragging === true || s.transformsInFlight > 0 || s.colorsInFlight > 0 ) return;
		if ( s.transformTimer !== null || s.colorTimer !== null ) return;

		this.applyRow( s.row );

	}

	// -------------------------------------------------------------------------------------------
	// Scene -> database

	listenToEditor() {

		const editor = this.editor;
		const signals = editor.signals;

		// Gizmo, sidebar position/rotation/scale, Reset, Center, light color: all dispatch objectChanged.
		signals.objectChanged.add( ( object ) => {

			if ( this.applying > 0 || object === undefined || object === null ) return;

			const targets = object === editor.selector.group ? editor.selector.selection : [ object ];

			for ( const target of targets ) {

				const s = this.byObject.get( target );
				if ( s === undefined ) continue;

				this.queueTransform( s );
				if ( target.isLight ) this.queueColor( s );

			}

			// My own edits move objects too: keep other people's gaze lines on target.
			if ( this.viewers.size > 0 ) this.refreshGazes();

		} );

		// Material color picker.
		signals.materialChanged.add( ( object ) => {

			if ( this.applying > 0 || object === undefined || object === null ) return;

			const s = this.byObject.get( object );
			if ( s !== undefined ) this.queueColor( s );

		} );

		signals.objectSelected.add( () => this.onSelectionChanged() );

		// My camera moved: tell the others, and re-check which markers sit right at my eye.
		// (Runs before the viewport's own cameraChanged render, so the frame shows the result.)
		signals.cameraChanged.add( () => {

			this.sendPresence();
			this.sendViewer();
			for ( const v of this.viewers.values() ) this.placeViewer( v );

		} );

		signals.viewportCameraChanged.add( () => this.sendViewer() );

	}

	queueTransform( s ) {

		this.finishPop( s.object ); // only ever send the real size, never a popping one
		if ( sameTransform( s.object, s.row ) && s.transformTimer === null ) return;
		if ( s.transformTimer !== null ) return; // already scheduled; it reads the latest values

		const wait = Math.max( 0, SEND_INTERVAL - ( performance.now() - s.lastTransformSent ) );
		s.transformTimer = setTimeout( () => this.sendTransform( s ), wait );

	}

	sendTransform( s ) {

		clearTimeout( s.transformTimer );
		s.transformTimer = null;

		if ( this.byId.get( s.id ) !== s ) return Promise.resolve();
		if ( sameTransform( s.object, s.row ) || this.offline() ) {

			this.reconcile( s );
			return Promise.resolve();

		}

		const o = s.object;
		s.lastTransformSent = performance.now();
		s.transformsInFlight ++;

		return this.conn.reducers.updateObjectTransform( {
			objectId: s.row.id,
			position: { x: o.position.x, y: o.position.y, z: o.position.z },
			rotation: { x: o.rotation.x, y: o.rotation.y, z: o.rotation.z },
			scale: { x: o.scale.x, y: o.scale.y, z: o.scale.z },
		} ).catch( ( error ) => {

			this.toast( `Move rejected: ${error.message}` );

		} ).finally( () => {

			s.transformsInFlight --;
			this.reconcile( s );

		} );

	}

	queueColor( s ) {

		if ( getColor( s.object ) === s.row.color && s.colorTimer === null ) return;
		if ( s.colorTimer !== null ) return;

		const wait = Math.max( 0, SEND_INTERVAL - ( performance.now() - s.lastColorSent ) );
		s.colorTimer = setTimeout( () => this.sendColor( s ), wait );

	}

	sendColor( s ) {

		clearTimeout( s.colorTimer );
		s.colorTimer = null;

		if ( this.byId.get( s.id ) !== s ) return Promise.resolve();

		const color = getColor( s.object );

		if ( color === s.row.color || this.offline() ) {

			this.reconcile( s );
			return Promise.resolve();

		}

		s.lastColorSent = performance.now();
		s.colorsInFlight ++;

		return this.conn.reducers.updateObjectColor( { objectId: s.row.id, color } ).catch( ( error ) => {

			this.toast( `Color change rejected: ${error.message}` );

		} ).finally( () => {

			s.colorsInFlight --;
			this.reconcile( s );

		} );

	}

	// While disconnected, edits can't be saved: they snap back (reconcile) with one message.
	offline() {

		if ( this.connected ) return false;

		const now = performance.now();

		if ( ! ( now - ( this.lastOfflineToast || 0 ) < 4000 ) ) {

			this.lastOfflineToast = now;
			this.toast( 'Offline: changes can\'t be saved until the connection is back.' );

		}

		return true;

	}

	// Send anything still waiting in a throttle timer (before unlocking or deleting).
	flush( s ) {

		const pending = [];
		if ( s.transformTimer !== null ) pending.push( this.sendTransform( s ) );
		if ( s.colorTimer !== null ) pending.push( this.sendColor( s ) );
		return Promise.all( pending );

	}

	// ---- hooks called by the editor ----

	// Viewport: TransformControls mouseDown / mouseUp.
	dragStart( objects ) {

		for ( const object of objects ) {

			if ( this.byObject.has( object ) ) object.userData.dragging = true;

		}

	}

	dragEnd( objects ) {

		for ( const object of objects ) {

			const s = this.byObject.get( object );
			if ( s === undefined ) continue;

			// Keep ignoring echoes until the final position has been stored, then show the database state.
			this.sendTransform( s ).finally( () => {

				object.userData.dragging = false;
				this.reconcile( s );

			} );

		}

	}

	// Add menu.
	addObject( kind ) {

		this.create( kind, '#ffffff', ZERO, ZERO, ONE );

	}

	// AI helper (ai-panel.js): runs the server's ask_ai procedure over this tab's connection, so the
	// call doesn't count as a separate visit (which would release my locks and presence on the way out).
	// Resolves to what the AI did ({ added, changed, removed, skipped, note }); rejects with the server's message.
	// `detailed` asks for the slower, better model.
	async askAi( prompt, detailed = false ) {

		if ( this.connected === false ) throw new Error( 'Not connected to the database yet.' );

		this.showBuildMarker();

		try {

			const result = await this.conn.procedures.askAi( { sceneId: SCENE_ID, prompt, detailed } );
			if ( 'err' in result ) throw new Error( result.err );
			return result.ok;

		} finally {

			this.hideBuildMarker();

		}

	}

	// Edit > Clone. Returns false for objects the database doesn't know.
	cloneObject( object ) {

		const s = this.byObject.get( object );
		if ( s === undefined ) return false;

		const o = s.object;
		this.create( s.row.kind, getColor( o ), vec( o.position ), vec( o.rotation ), vec( o.scale ) );
		return true;

	}

	create( kind, color, position, rotation, scale ) {

		if ( this.connected === false ) {

			this.toast( 'Not connected to the database yet.' );
			return;

		}

		this.pendingAdds ++;

		this.conn.reducers.createObject( { sceneId: SCENE_ID, kind, color, position, rotation, scale } ).catch( ( error ) => {

			this.pendingAdds = Math.max( 0, this.pendingAdds - 1 );
			this.toast( `Couldn't add ${kind}: ${error.message}` );

		} );

	}

	// Like the editor does after Add: select the object my own create_object call just inserted.
	selectIfMyNewObject( ctx, row ) {

		if ( this.pendingAdds === 0 || ctx.event.tag !== 'Reducer' ) return;
		if ( ctx.event.value.reducer.name !== 'create_object' ) return;

		this.pendingAdds --;

		const s = this.byId.get( row.id.toString() );
		if ( s !== undefined ) this.editor.select( s.object );

	}

	// Edit > Delete and the Delete key. Returns the objects the database doesn't know, which the
	// editor still deletes locally.
	deleteObjects( objects ) {

		const unsynced = [];

		for ( const object of objects ) {

			const s = this.byObject.get( object );

			if ( s === undefined ) {

				unsynced.push( object );
				continue;

			}

			this.flush( s ).then( () => this.conn.reducers.deleteObject( { objectId: s.row.id } ) ).catch( ( error ) => {

				this.toast( `Couldn't delete: ${error.message}` );

			} );

		}

		return unsynced;

	}

	// Selector.setSelection: objects someone else is editing can't be selected.
	filterSelectable( objects ) {

		return objects.filter( ( object ) => {

			const s = this.byObject.get( object );
			const holder = s?.row.lockedBy?.toHexString();

			if ( holder === undefined || holder === this.identity ) return true;

			this.toast( `${this.userName( holder )} is editing this ${s.row.kind}.` );
			return false;

		} );

	}

	// -------------------------------------------------------------------------------------------
	// Locks: selecting locks, deselecting unlocks.

	onSelectionChanged() {

		const current = new Set();

		for ( const object of this.editor.selector.selection ) {

			const s = this.byObject.get( object );
			if ( s !== undefined ) current.add( s.id );

		}

		const previous = this.selectedIds;
		this.selectedIds = current;

		for ( const id of previous ) if ( current.has( id ) === false ) this.release( id );
		for ( const id of current ) if ( previous.has( id ) === false ) this.acquire( id );

	}

	acquire( id ) {

		const s = this.byId.get( id );
		if ( s === undefined || this.connected === false ) return;

		this.conn.reducers.lockObject( { objectId: s.row.id } ).catch( ( error ) => {

			if ( this.selectedIds.has( id ) === false ) return; // deselected meanwhile

			this.toast( /locked by another user/.test( error.message ) ? `Someone else is editing this ${s.row.kind}.` : `Couldn't select: ${error.message}` );
			this.deselect( s.object );

		} );

	}

	release( id ) {

		const s = this.byId.get( id );
		if ( s === undefined || this.connected === false ) return; // deleted, or the server already released it

		// Pending updates must reach the server while we still hold the lock.
		this.flush( s ).then( () => this.conn.reducers.unlockObject( { objectId: s.row.id } ) ).catch( () => {} );

	}

	renewLocks() {

		if ( this.connected === false ) return;

		for ( const id of this.selectedIds ) {

			const s = this.byId.get( id );
			if ( s === undefined ) continue;

			this.conn.reducers.lockObject( { objectId: s.row.id } ).catch( ( error ) => {

				if ( this.selectedIds.has( id ) === false ) return;

				this.toast( `Lost the lock on this ${s.row.kind}: ${error.message}` );
				this.deselect( s.object );

			} );

		}

	}

	deselect( object ) {

		const selection = this.editor.selector.selection;
		if ( selection.includes( object ) ) this.editor.selector.setSelection( selection.filter( ( o ) => o !== object ) );

	}

	// -------------------------------------------------------------------------------------------
	// Lock visuals: outline + name label in the lock holder's color.

	// Returns true if anything visible changed.
	updateLockVisual( s ) {

		const holder = s.row.lockedBy?.toHexString();

		if ( holder === undefined || holder === this.identity ) {

			return this.removeLockVisual( s );

		}

		const name = this.userName( holder );
		const color = this.userColor( holder );

		if ( s.lock !== null && ( s.lock.name !== name || s.lock.color !== color ) ) this.removeLockVisual( s );

		if ( s.lock === null ) {

			const box = new THREE.Box3();
			const outline = new THREE.Box3Helper( box, new THREE.Color( color ) );
			outline.material.depthTest = false;
			outline.material.transparent = true;
			outline.renderOrder = 998;

			const label = makeLabel( name, color );

			this.editor.sceneHelpers.add( outline, label );
			s.lock = { name, color, box, outline, label };

		}

		const { box, label } = s.lock;
		s.object.updateWorldMatrix( true, true );
		box.setFromObject( s.object, true );

		if ( box.isEmpty() ) box.setFromCenterAndSize( s.object.getWorldPosition( new THREE.Vector3() ), new THREE.Vector3( 0.5, 0.5, 0.5 ) );

		box.expandByScalar( 0.02 );
		const center = box.getCenter( new THREE.Vector3() );
		label.position.set( center.x, box.max.y, center.z );
		return true;

	}

	// Returns true if there was a visual to remove.
	removeLockVisual( s ) {

		if ( s.lock === null ) return false;

		this.editor.sceneHelpers.remove( s.lock.outline, s.lock.label );
		s.lock.outline.geometry.dispose();
		s.lock.outline.material.dispose();
		s.lock.label.material.map.dispose();
		s.lock.label.material.dispose();
		s.lock = null;
		return true;

	}

	// -------------------------------------------------------------------------------------------
	// People: names, colors, presence (who is in this scene right now).

	userName( hex ) {

		const user = this.findUser( hex );
		if ( user && user.name && user.name !== 'Guest' ) return user.name;
		return `Guest ${hex.slice( - 4 )}`;

	}

	userColor( hex ) {

		const user = this.findUser( hex );
		if ( user && /^#[0-9a-f]{6}$/i.test( user.color ) && user.color.toLowerCase() !== '#888888' ) return user.color;
		return colorFromIdentity( hex );

	}

	findUser( hex ) {

		if ( this.conn === null ) return undefined;

		for ( const user of this.conn.db.user.iter() ) {

			if ( user.identity.toHexString() === hex ) return user;

		}

		return undefined;

	}

	// Presence (update_cursor) marks me as present in this scene; the server removes it when I disconnect.
	sendPresence( now = false ) {

		if ( this.connected === false ) return;

		if ( now === false ) {

			if ( this.presenceTimer ) return;
			this.presenceTimer = setTimeout( () => {

				this.presenceTimer = null;
				this.sendPresence( true );

			}, PRESENCE_INTERVAL );
			return;

		}

		const p = this.editor.camera.position;
		this.conn.reducers.updateCursor( { sceneId: SCENE_ID, cursor: { x: p.x, y: p.y, z: p.z } } ).catch( () => {} );

	}

	refreshPeople() {

		if ( this.people === undefined ) return;

		const present = this.conn ? [ ...this.conn.db.presence.iter() ].map( ( p ) => p.identity.toHexString() ) : [];
		if ( this.identity && present.includes( this.identity ) === false && this.connected ) present.unshift( this.identity );

		// me first, then everyone else in a stable order
		present.sort( ( a, b ) => ( b === this.identity ) - ( a === this.identity ) || a.localeCompare( b ) );

		this.people.replaceChildren( ...present.map( ( hex ) => {

			const row = createElement( 'div', 'person' );
			const dot = createElement( 'span', 'dot' );
			dot.style.background = this.userColor( hex );
			row.append( dot, document.createTextNode( this.userName( hex ) + ( hex === this.identity ? ' (you)' : '' ) ) );

			if ( hex === this.identity ) {

				// my own row opens the name dialog
				row.classList.add( 'me' );
				row.title = 'Change your name';
				row.append( createElement( 'span', 'edit', 'edit' ) );
				row.addEventListener( 'click', () => this.showNameDialog() );

			}

			return row;

		} ) );

		const text = this.badge.querySelector( '.text' );

		if ( this.status === 'live' ) text.textContent = `Live · ${present.length} online`;
		else if ( this.status === 'reconnecting' ) text.textContent = 'Reconnecting…';
		else if ( this.status === 'offline' ) text.textContent = 'Offline';
		else text.textContent = 'Connecting…';

		this.badge.title = `SpacetimeDB ${URI} · database "${DB_NAME}" · scene ${SCENE_ID}`;

		// Names or colors may have changed: refresh lock labels.
		for ( const s of this.byId.values() ) {

			if ( s.lock !== null ) {

				this.applying ++;
				try {

					this.updateLockVisual( s );
					this.editor.signals.objectChanged.dispatch( s.object );

				} finally {

					this.applying --;

				}

			}

		}

		this.refreshViewerStyles();

	}

	// -------------------------------------------------------------------------------------------
	// Names: shown on lock labels, camera labels and the online list.

	// Once my user row is loaded: keep the name the server has, else use the one this browser
	// remembers (a new tab is a new identity), else ask.
	ensureName() {

		if ( this.identity === null ) return;

		const me = this.findUser( this.identity );
		if ( me === undefined ) return;

		const saved = readSavedName();

		if ( me.name && me.name !== 'Guest' ) {

			// (an account's name isn't this browser's guest name)
			if ( saved === undefined && this.signedIn === false ) saveName( me.name );
			return;

		}

		if ( saved !== undefined ) this.setName( saved );
		else if ( this.nameSkipped === false ) this.showNameDialog();

	}

	// Returns false if the name is empty after cleanup.
	setName( name ) {

		const clean = Array.from( name.replace( /\p{Cc}/gu, '' ).trim() ).slice( 0, MAX_NAME_CHARS ).join( '' ).trim();
		if ( clean === '' ) return false;

		saveName( clean );

		// While offline the name is only saved locally; ensureName() sends it after reconnecting.
		if ( this.connected ) {

			this.conn.reducers.setName( { name: clean } ).catch( ( error ) => this.toast( `Couldn't save your name: ${error.message}` ) );

		}

		return true;

	}

	showNameDialog() {

		if ( this.nameDialog !== null ) return;

		const current = this.identity !== null ? this.findUser( this.identity ) : undefined;
		const renaming = current !== undefined && current.name !== 'Guest';

		const backdrop = createElement( 'div', 'collab3d-dialog-backdrop' );
		const form = createElement( 'form', 'collab3d-dialog', `
			<h2 id="collab3d-name-title"></h2>
			<p></p>
			<input id="collab3d-name" name="name" maxlength="${MAX_NAME_CHARS}" autocomplete="nickname" placeholder="Your name" aria-labelledby="collab3d-name-title">
			<p class="sign-in" hidden>Have an account? <button type="button" class="link">Sign in</button> to use its name.</p>
			<div class="actions"><button type="button" class="secondary"></button><button type="submit"></button></div>` );

		form.querySelector( 'h2' ).textContent = renaming ? 'Change your name' : 'What should we call you?';
		form.querySelector( 'p' ).textContent = 'Others see it on what you\'re editing and next to your camera.';
		form.querySelector( '.secondary' ).textContent = renaming ? 'Cancel' : 'Not now';
		form.querySelector( '[type="submit"]' ).textContent = renaming ? 'Save' : 'Join';

		// Optional sign-in (SpacetimeAuth) instead of a guest name
		if ( signInAvailable && renaming === false && this.signedIn === false ) {

			form.querySelector( '.sign-in' ).hidden = false;
			form.querySelector( '.sign-in .link' ).addEventListener( 'click', () => signIn() );

		}

		const input = form.querySelector( 'input' );
		input.value = renaming ? current.name : ( readSavedName() || '' );

		// Keep typing out of the editor's shortcuts (Backspace deletes the selection, W/E/R switch tools).
		form.addEventListener( 'keydown', ( event ) => {

			event.stopPropagation();
			if ( event.key === 'Escape' ) this.closeNameDialog( true );

		} );

		form.addEventListener( 'submit', ( event ) => {

			event.preventDefault();

			if ( this.setName( input.value ) ) this.closeNameDialog( false );
			else input.focus();

		} );

		form.querySelector( '.secondary' ).addEventListener( 'click', () => this.closeNameDialog( true ) );

		backdrop.append( form );
		document.body.append( backdrop );
		this.nameDialog = backdrop;

		input.focus();
		input.select();

	}

	// The panel's last row: "Sign in to use your account" for guests, "Signed in · Sign out" otherwise.
	// Hidden until a SpacetimeAuth client ID is set (auth.js).
	refreshAccount() {

		this.account.hidden = signInAvailable === false;
		if ( this.account.hidden ) return;

		const button = createElement( 'button', 'link' );
		button.type = 'button';

		if ( this.signedIn ) {

			button.textContent = 'Sign out';
			button.addEventListener( 'click', () => signOut() );
			this.account.replaceChildren( document.createTextNode( 'Signed in · ' ), button );

		} else {

			button.textContent = 'Sign in';
			button.addEventListener( 'click', () => signIn() );
			this.account.replaceChildren( button, document.createTextNode( ' to use your account' ) );

		}

	}

	closeNameDialog( skipped ) {

		if ( this.nameDialog === null ) return;

		this.nameDialog.remove();
		this.nameDialog = null;
		if ( skipped ) this.nameSkipped = true;

	}

	// -------------------------------------------------------------------------------------------
	// Cameras: everyone sees where the others are looking (viewer table).

	// Send my camera's position and rotation, at most every VIEWER_INTERVAL ms.
	sendViewer( now = false ) {

		if ( this.connected === false ) return;

		if ( now === false ) {

			if ( this.viewerTimer ) return;

			const wait = Math.max( 0, VIEWER_INTERVAL - ( performance.now() - this.lastViewerSent ) );
			this.viewerTimer = setTimeout( () => {

				this.viewerTimer = null;
				this.sendViewer( true );

			}, wait );
			return;

		}

		this.lastViewerSent = performance.now();

		const camera = this.editor.viewportCamera || this.editor.camera;
		camera.updateMatrixWorld();
		const p = camera.getWorldPosition( _position );
		const r = _euler.setFromQuaternion( camera.getWorldQuaternion( _quaternion ) );

		this.conn.reducers.updateViewer( {
			sceneId: SCENE_ID,
			position: { x: p.x, y: p.y, z: p.z },
			rotation: { x: r.x, y: r.y, z: r.z },
		} ).catch( () => {} ); // a server without update_viewer: cameras just don't show

	}

	applyViewer( row ) {

		const hex = row.identity.toHexString();
		if ( hex === this.identity || row.sceneId !== SCENE_ID ) return; // never draw my own camera

		let v = this.viewers.get( hex );

		if ( v === undefined ) {

			v = this.createViewer( hex );
			v.group.position.set( row.position.x, row.position.y, row.position.z );
			v.group.rotation.set( row.rotation.x, row.rotation.y, row.rotation.z );

		}

		v.targetPosition.set( row.position.x, row.position.y, row.position.z );
		v.targetQuaternion.setFromEuler( _euler.set( row.rotation.x, row.rotation.y, row.rotation.z ) );
		this.animateViewers();

	}

	createViewer( hex ) {

		const name = this.userName( hex );
		const color = this.userColor( hex );
		const marker = makeCameraMarker( color );
		const label = makeLabel( name, color );
		const gaze = makeGaze( color );

		this.editor.sceneHelpers.add( marker, label, gaze.line, gaze.dot );

		const v = { hex, name, color, group: marker, label, line: gaze.line, dot: gaze.dot, targetPosition: new THREE.Vector3(), targetQuaternion: new THREE.Quaternion() };
		this.viewers.set( hex, v );
		return v;

	}

	removeViewer( hex ) {

		const v = this.viewers.get( hex );
		if ( v === undefined ) return;

		this.viewers.delete( hex );
		this.disposeViewer( v );
		this.requestRender( v.group );

	}

	disposeViewer( v ) {

		this.editor.sceneHelpers.remove( v.group, v.label, v.line, v.dot );

		v.group.traverse( ( child ) => {

			child.geometry?.dispose();
			child.material?.dispose();

		} );
		v.label.material.map.dispose(); // (sprites share one geometry: don't dispose it)
		v.label.material.dispose();
		v.line.geometry.dispose();
		v.line.material.dispose();
		v.dot.geometry.dispose();
		v.dot.material.dispose();

	}

	// Subscription (re)applied: match the cache exactly.
	syncViewers() {

		const live = new Set();

		for ( const row of this.conn.db.viewer.iter() ) {

			live.add( row.identity.toHexString() );
			this.applyViewer( row );

		}

		for ( const hex of [ ...this.viewers.keys() ] ) {

			if ( live.has( hex ) === false ) this.removeViewer( hex );

		}

	}

	// Updates arrive ~10 times a second; glide each marker toward its latest pose in between.
	animateViewers() {

		if ( this.viewerFrame ) return;

		const step = () => {

			this.viewerFrame = null;
			let moving = false;

			for ( const v of this.viewers.values() ) {

				const g = v.group;
				const settled = g.position.distanceToSquared( v.targetPosition ) < 1e-6 && 1 - Math.abs( g.quaternion.dot( v.targetQuaternion ) ) < 1e-7;

				if ( settled ) {

					g.position.copy( v.targetPosition );
					g.quaternion.copy( v.targetQuaternion );

				} else {

					g.position.lerp( v.targetPosition, 0.3 );
					g.quaternion.slerp( v.targetQuaternion, 0.3 );
					moving = true;

				}

				this.placeViewer( v );

			}

			this.requestRender();
			if ( moving ) this.viewerFrame = requestAnimationFrame( step );

		};

		this.viewerFrame = requestAnimationFrame( step );

	}

	// Position the label and gaze line, and hide a marker that sits right at my own eye.
	placeViewer( v ) {

		const eye = ( this.editor.viewportCamera || this.editor.camera ).getWorldPosition( _position );
		const distance = v.group.position.distanceTo( eye );
		const visible = distance > VIEWER_HIDE_DISTANCE;

		// Grow with distance so a far-away camera stays about the same size on screen.
		const scale = THREE.MathUtils.clamp( distance * 0.15, 0.6, 6 );

		v.group.visible = visible;
		v.label.visible = visible;
		v.line.visible = visible;
		v.group.scale.setScalar( scale );
		v.group.updateMatrixWorld();
		v.label.position.copy( v.group.position ).add( _offset.set( 0, 0.32 * scale, 0 ) );

		this.updateGaze( v );

	}

	// Dashed line along the view direction, ending on the first synced object it hits.
	updateGaze( v ) {

		const origin = v.group.position;
		const direction = _direction.set( 0, 0, - 1 ).applyQuaternion( v.group.quaternion );

		const targets = [];

		for ( const s of this.byId.values() ) {

			if ( s.object.isMesh ) {

				s.object.updateMatrixWorld();
				targets.push( s.object );

			}

		}

		_raycaster.set( origin, direction );
		const hit = _raycaster.intersectObjects( targets, false )[ 0 ];
		const end = hit ? hit.point : _end.copy( direction ).multiplyScalar( GAZE_LENGTH ).add( origin );

		const positions = v.line.geometry.attributes.position;
		positions.setXYZ( 0, origin.x, origin.y, origin.z );
		positions.setXYZ( 1, end.x, end.y, end.z );
		positions.needsUpdate = true;
		v.line.computeLineDistances();

		v.dot.position.copy( end );
		v.dot.visible = v.group.visible && hit !== undefined;

	}

	refreshGazes() {

		for ( const v of this.viewers.values() ) this.updateGaze( v );

	}

	// A name or color changed (user table): rebuild those markers in place.
	refreshViewerStyles() {

		let changed = false;

		for ( const v of [ ...this.viewers.values() ] ) {

			if ( v.name === this.userName( v.hex ) && v.color === this.userColor( v.hex ) ) continue;

			const fresh = this.createViewer( v.hex ); // replaces v in the map
			fresh.group.position.copy( v.group.position );
			fresh.group.quaternion.copy( v.group.quaternion );
			fresh.targetPosition.copy( v.targetPosition );
			fresh.targetQuaternion.copy( v.targetQuaternion );

			this.disposeViewer( v );
			this.placeViewer( fresh );
			changed = true;

		}

		if ( changed ) this.requestRender();

	}

	// The viewport renders on editor signals; objectChanged on a marker re-renders without side effects.
	requestRender( object ) {

		const target = object || this.viewers.values().next().value?.group;
		if ( target === undefined ) return;

		this.applying ++;

		try {

			this.editor.signals.objectChanged.dispatch( target );

		} finally {

			this.applying --;

		}

	}

	toast( message ) {

		const toast = createElement( 'div', 'collab3d-toast' );
		toast.textContent = message;
		this.toastBox.append( toast );
		setTimeout( () => toast.classList.add( 'hide' ), 2600 );
		setTimeout( () => toast.remove(), 3000 );

	}

}

// ---------------------------------------------------------------------------------------------
// helpers

const ZERO = { x: 0, y: 0, z: 0 };
const ONE = { x: 1, y: 1, z: 1 };

// scratch objects for camera markers
const _position = new THREE.Vector3();
const _direction = new THREE.Vector3();
const _end = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _raycaster = new THREE.Raycaster();

// A small camera in the person's color. Like a three.js camera it looks down its local -Z axis:
// body behind, lens in front, and a wireframe view frustum pointing where they look.
function makeCameraMarker( color ) {

	const group = new THREE.Group();
	const solid = new THREE.MeshBasicMaterial( { color } );

	const body = new THREE.Mesh( new THREE.BoxGeometry( 0.36, 0.26, 0.3 ), solid );
	body.position.z = 0.15;

	const lens = new THREE.Mesh( new THREE.CylinderGeometry( 0.08, 0.12, 0.14, 20 ), solid );
	lens.rotation.x = Math.PI / 2; // cylinder axis Y -> Z; the wider end faces forward
	lens.position.z = - 0.07;

	const depth = 0.75;
	const halfWidth = 0.4;
	const halfHeight = 0.225; // 16:9
	const corners = [ [ - 1, 1 ], [ 1, 1 ], [ 1, - 1 ], [ - 1, - 1 ] ].map( ( [ x, y ] ) => new THREE.Vector3( x * halfWidth, y * halfHeight, - depth ) );
	const apex = new THREE.Vector3( 0, 0, - 0.14 );
	const points = [];

	for ( let i = 0; i < 4; i ++ ) points.push( apex, corners[ i ], corners[ i ], corners[ ( i + 1 ) % 4 ] );

	const frustum = new THREE.LineSegments(
		new THREE.BufferGeometry().setFromPoints( points ),
		new THREE.LineBasicMaterial( { color, transparent: true, opacity: 0.8 } )
	);

	group.add( body, lens, frustum );
	return group;

}

// Dashed gaze line (two points, updated in place) and a dot where it hits an object.
function makeGaze( color ) {

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( new Float32Array( 6 ), 3 ) );

	const line = new THREE.Line( geometry, new THREE.LineDashedMaterial( { color, dashSize: 0.18, gapSize: 0.12, transparent: true, opacity: 0.85 } ) );
	line.frustumCulled = false; // its bounds change every update

	const dot = new THREE.Mesh( new THREE.SphereGeometry( 0.06, 16, 8 ), new THREE.MeshBasicMaterial( { color } ) );

	return { line, dot };

}

function mesh( name, geometry ) {

	return named( new THREE.Mesh( geometry, new THREE.MeshStandardMaterial() ), name );

}

function named( object, name ) {

	object.name = name;
	return object;

}

function unknownKind( kind ) {

	return () => mesh( `Unknown (${kind})`, new THREE.BoxGeometry( 0.5, 0.5, 0.5 ) );

}

// AI teammate models: kind "asset:<kit>/<name>" shows client/public/assets/kenney/<kit>/<name>.glb
// (low-poly Kenney.nl kits, CC0; server/src/ai.rs MODELS lists them with their sizes).
// The model is centered on the object, so position and scale work like the other kinds, and each part
// points at the object (userData.object), so clicking any part selects the whole model.
const ASSET_KIND = /^asset:([a-z0-9-]+\/[A-Za-z0-9_-]+)$/;
const assetModels = new Map(); // path -> Promise of the loaded, centered model (loaded once, copied per object)
let gltfLoader = null;

function assetKind( kind, editor ) {

	const path = kind.match( ASSET_KIND )[ 1 ];
	const name = path.split( '/' )[ 1 ].replace( /[-_]/g, ' ' ).replace( /^./, ( c ) => c.toUpperCase() );

	return () => {

		const group = named( new THREE.Group(), name );

		loadAsset( path ).then( ( model ) => {

			const copy = model.clone( true );
			copy.traverse( ( child ) => {

				if ( child.isMesh !== true ) return;
				// Own copies, so removing this object (disposeObject) doesn't break other copies.
				child.geometry = child.geometry.clone();
				child.material = Array.isArray( child.material ) ? child.material.map( ( m ) => m.clone() ) : child.material.clone();
				child.userData.object = group;

			} );
			group.add( copy );
			// Redraw, and make the new parts clickable. Once per frame: many copies of one model finish together.
			if ( editor.multiplayer ) editor.multiplayer.queueSceneRefresh();
			else editor.signals.sceneGraphChanged.dispatch();

		} ).catch( ( error ) => console.warn( `[coscene] couldn't load model ${path}:`, error ) );

		return group;

	};

}

function loadAsset( path ) {

	if ( assetModels.has( path ) === false ) {

		gltfLoader ??= new GLTFLoader();
		assetModels.set( path, gltfLoader.loadAsync( `assets/kenney/${path}.glb` ).then( ( gltf ) => {

			const model = gltf.scene;
			model.position.sub( new THREE.Box3().setFromObject( model, true ).getCenter( new THREE.Vector3() ) );
			return new THREE.Group().add( model );

		} ) );

	}

	return assetModels.get( path );

}

function vec( v ) {

	return { x: v.x, y: v.y, z: v.z };

}

function setTransform( object, row ) {

	object.position.set( row.position.x, row.position.y, row.position.z );
	object.rotation.set( row.rotation.x, row.rotation.y, row.rotation.z );
	object.scale.set( row.scale.x, row.scale.y, row.scale.z );
	object.updateMatrixWorld( true );

}

function sameTransform( object, row ) {

	const close = ( a, b ) => Math.abs( a.x - b.x ) < EPSILON && Math.abs( a.y - b.y ) < EPSILON && Math.abs( a.z - b.z ) < EPSILON;
	return close( object.position, row.position ) && close( object.rotation, row.rotation ) && close( object.scale, row.scale );

}

function colorTarget( object ) {

	return object.isLight ? object.color : object.material?.color;

}

function getColor( object ) {

	const color = colorTarget( object );
	return color ? '#' + color.getHexString() : '#ffffff';

}

// Returns true if the color changed.
function setColor( object, hex ) {

	const color = colorTarget( object );
	if ( color === undefined || '#' + color.getHexString() === hex ) return false;

	color.set( hex );
	return true;

}

function disposeObject( object ) {

	object.traverse( ( child ) => {

		child.geometry?.dispose();
		child.material?.dispose?.();
		child.dispose?.(); // lights

	} );

}

// A popping object's size: its real size times an ease-out with a little overshoot (nothing -> ~1.1 -> 1).
function applyPop( object, pop, now ) {

	const t = THREE.MathUtils.clamp( ( now - pop.start ) / POP_DURATION, 0, 1 );
	object.scale.copy( pop.scale ).multiplyScalar( Math.max( easeOutBack( t ), 1e-3 ) );

}

function easeOutBack( t ) {

	const c1 = 1.70158;
	const c3 = c1 + 1;
	return 1 + c3 * Math.pow( t - 1, 3 ) + c1 * Math.pow( t - 1, 2 );

}

// Animations (server/src/animation.rs): where an object is `seconds` (server clock) into its animation,
// worked out from its row (where it rests) every frame. Its size isn't touched (it may be popping in).

const _animRest = new THREE.Vector3();
const _animRestQuaternion = new THREE.Quaternion();
const _animTurn = new THREE.Quaternion();
const _animAxis = new THREE.Vector3();
const _animPivot = new THREE.Vector3();
const _animEuler = new THREE.Euler();
const ANIM_UP = new THREE.Vector3( 0, 1, 0 );

function restPose( object, row ) {

	object.position.set( row.position.x, row.position.y, row.position.z );
	object.rotation.set( row.rotation.x, row.rotation.y, row.rotation.z );

}

function animatePose( object, row, anim, seconds ) {

	const started = Number( anim.startedAt.microsSinceUnixEpoch / 1000n ) / 1000;
	const cycle = ( seconds - started ) / anim.period + anim.phase; // turns, swings or loops since it started
	_animRest.set( row.position.x, row.position.y, row.position.z );
	_animRestQuaternion.setFromEuler( _animEuler.set( row.rotation.x, row.rotation.y, row.rotation.z ) );
	_animAxis.set( anim.axis.x, anim.axis.y, anim.axis.z );

	switch ( anim.kind ) {

		case 'spin':
		case 'orbit':
		case 'sway': {

			const angle = anim.kind === 'sway'
				? THREE.MathUtils.degToRad( anim.amount ) * Math.sin( cycle * Math.PI * 2 )
				: cycle * Math.PI * 2 * ( anim.amount < 0 ? - 1 : 1 );
			_animTurn.setFromAxisAngle( _animAxis, angle );
			_animPivot.set( _animRest.x + anim.pivot.x, _animRest.y + anim.pivot.y, _animRest.z + anim.pivot.z );
			object.position.copy( _animRest ).sub( _animPivot ).applyQuaternion( _animTurn ).add( _animPivot );
			if ( anim.kind === 'orbit' ) object.quaternion.copy( _animRestQuaternion ); // keeps facing the same way
			else object.quaternion.copy( _animTurn ).multiply( _animRestQuaternion );
			break;

		}

		case 'bob':

			object.position.copy( _animRest ).addScaledVector( _animAxis, anim.amount * Math.sin( cycle * Math.PI * 2 ) );
			object.quaternion.copy( _animRestQuaternion );
			break;

		case 'path':

			followPath( object, anim.path, cycle );
			break;

	}

}

// Along the loop through the path's points (offsets from where it rests), at constant speed, facing where
// it's going: turned from its resting rotation by how much the current leg turns from the first one
// (it was placed facing the first leg).
function followPath( object, offsets, cycle ) {

	const n = offsets.length;
	const point = ( i, target ) => target.set( _animRest.x + offsets[ i % n ].x, _animRest.y + offsets[ i % n ].y, _animRest.z + offsets[ i % n ].z );
	const a = new THREE.Vector3();
	const b = new THREE.Vector3();
	const legs = [];
	let total = 0;

	for ( let i = 0; i < n; i ++ ) {

		const length = point( i, a ).distanceTo( point( i + 1, b ) );
		legs.push( length );
		total += length;

	}

	if ( total < 1e-6 ) return void point( 0, object.position );

	let along = ( ( cycle % 1 ) + 1 ) % 1 * total;
	let leg = 0;

	while ( leg < n - 1 && along > legs[ leg ] ) {

		along -= legs[ leg ];
		leg ++;

	}

	point( leg, a );
	point( leg + 1, b );
	object.position.copy( a ).lerp( b, legs[ leg ] > 0 ? along / legs[ leg ] : 0 );

	const heading = ( from, to ) => Math.atan2( to.x - from.x, to.z - from.z );
	const turn = heading( a, b ) - heading( point( 0, new THREE.Vector3() ), point( 1, new THREE.Vector3() ) );
	object.quaternion.setFromAxisAngle( ANIM_UP, turn ).multiply( _animRestQuaternion );

}

function colorFromIdentity( hex ) {

	let hash = 0;
	for ( let i = 0; i < hex.length; i ++ ) hash = ( hash * 31 + hex.charCodeAt( i ) ) >>> 0;
	return '#' + new THREE.Color().setHSL( ( hash % 360 ) / 360, 0.75, 0.5 ).getHexString();

}

function makeLabel( text, color ) {

	const font = 'bold 28px system-ui, sans-serif';
	const canvas = document.createElement( 'canvas' );
	const context = canvas.getContext( '2d' );
	context.font = font;

	const width = Math.ceil( context.measureText( text ).width ) + 28;
	const height = 44;
	canvas.width = width;
	canvas.height = height;

	context.font = font;
	context.fillStyle = color;
	context.beginPath();
	context.roundRect( 0, 0, width, height, 10 );
	context.fill();
	context.fillStyle = '#ffffff';
	context.textBaseline = 'middle';
	context.fillText( text, 14, height / 2 + 1 );

	const texture = new THREE.CanvasTexture( canvas );
	texture.colorSpace = THREE.SRGBColorSpace;

	const sprite = new THREE.Sprite( new THREE.SpriteMaterial( { map: texture, depthTest: false, transparent: true, sizeAttenuation: false } ) );
	const size = 0.035; // fraction of the viewport height (sizeAttenuation off)
	sprite.scale.set( size * width / height, size, 1 );
	sprite.center.set( 0.5, - 0.25 ); // sit just above the anchor point
	sprite.renderOrder = 999;
	return sprite;

}

function createElement( tag, className, html ) {

	const element = document.createElement( tag );
	element.className = className;
	if ( html !== undefined ) element.innerHTML = html;
	return element;

}

function readSavedName() {

	try {

		return localStorage.getItem( NAME_KEY ) || undefined;

	} catch {

		return undefined;

	}

}

function saveName( name ) {

	try {

		localStorage.setItem( NAME_KEY, name );

	} catch { /* storage unavailable: we just ask again next visit */ }

}

function readToken() {

	try {

		return sessionStorage.getItem( TOKEN_KEY ) || undefined;

	} catch {

		return undefined;

	}

}

function writeToken( token ) {

	try {

		sessionStorage.setItem( TOKEN_KEY, token );

	} catch { /* storage unavailable: we just get a new identity next time */ }

}

function clearToken() {

	try {

		sessionStorage.removeItem( TOKEN_KEY );

	} catch { /* ignore */ }

}

export { Multiplayer };
