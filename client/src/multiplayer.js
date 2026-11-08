// CoScene multiplayer: the only place the client talks to SpacetimeDB.
//
// The database is the single source of truth for every synced object:
//   - Rows arrive through the subscription. applyRow() / removeRow() are the ONLY code that adds,
//     updates or removes synced objects in editor.scene.
//   - Local edits are sent as reducer calls. Transforms and colors are picked up from the editor's own
//     signals (objectChanged / materialChanged), so the gizmo, the sidebar fields, Reset and Center all
//     sync without changes to those files.
//   - Selecting an object locks it (lock_object); deselecting unlocks it. Objects locked by someone else
//     get an outline + name label in that user's color and can't be selected.
//
// The editor calls into this file through editor.multiplayer. Search the editor for "#SPACETIME".

import * as THREE from 'three';
import { DbConnection, tables } from './module_bindings';
import './multiplayer.css';

// ---------------------------------------------------------------------------------------------
// Config. Defaults: local server in `npm run dev`, Maincloud in the production build.
// Override with VITE_SPACETIME_URI / VITE_SPACETIME_DB (see client/.env.example).

const URI = import.meta.env.VITE_SPACETIME_URI || ( import.meta.env.PROD ? 'wss://maincloud.spacetimedb.com' : 'ws://localhost:3000' );
const DB_NAME = import.meta.env.VITE_SPACETIME_DB || ( import.meta.env.PROD ? 'coscene-hackutd' : 'coscene' );

// Everyone on the same link edits the same scene: ?scene=N, default 1.
const sceneParam = new URLSearchParams( location.search ).get( 'scene' );
const SCENE_ID = /^\d+$/.test( sceneParam || '' ) ? BigInt( sceneParam ) : 1n;

// sessionStorage: every tab is its own user (so two tabs can test locking), and a refresh keeps the identity.
const TOKEN_KEY = `${URI}/${DB_NAME}/auth_token`;

const SEND_INTERVAL = 66; // ms between updates while dragging or scrubbing a color (~15 per second)
const LOCK_RENEW_INTERVAL = 10_000; // the server expires locks after 30 s
const PRESENCE_INTERVAL = 1_000;
const EPSILON = 1e-4;

// The kinds the database knows, built exactly like the editor's Add menu builds them.
const KINDS = {
	box: () => mesh( 'Box', new THREE.BoxGeometry( 1, 1, 1, 1, 1, 1 ) ),
	sphere: () => mesh( 'Sphere', new THREE.SphereGeometry( 1, 32, 16, 0, Math.PI * 2, 0, Math.PI ) ),
	cylinder: () => mesh( 'Cylinder', new THREE.CylinderGeometry( 1, 1, 1, 32, 1, false, 0, Math.PI * 2 ) ),
	plane: () => mesh( 'Plane', new THREE.PlaneGeometry( 1, 1, 1, 1 ) ),
	pointlight: () => named( new THREE.PointLight( 0xffffff, 1, 0 ), 'PointLight' ),
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
		this.selectedIds = new Set(); // synced objects in my selection (I hold, or am acquiring, their locks)
		this.pendingAdds = 0;

		// Floating panel (top-left of the viewport): connection badge + who's here.
		this.badge = createElement( 'div', 'coscene-badge', '<span class="dot"></span><span class="text">Connecting…</span>' );
		this.people = createElement( 'div', 'coscene-people' );
		this.panel = createElement( 'div', 'coscene-panel' );
		this.panel.append( this.badge, this.people );
		this.toastBox = createElement( 'div', 'coscene-toasts' );
		document.body.append( this.panel, this.toastBox );

		this.listenToEditor();

	}

	// -------------------------------------------------------------------------------------------
	// Connection

	connect() {

		const token = readToken();

		this.setStatus( 'connecting' );

		this.conn = DbConnection.builder()
			.withUri( URI )
			.withDatabaseName( DB_NAME )
			.withToken( token )
			.withAutomaticReconnect()
			.onConnect( ( _conn, identity, newToken ) => {

				writeToken( newToken );
				this.identity = identity.toHexString();
				this.connected = true;
				this.setStatus( 'live' );
				this.onConnected();

			} )
			.onDisconnect( ( _ctx, error, nextAttempt ) => {

				this.connected = false;
				this.setStatus( nextAttempt !== undefined ? 'reconnecting' : 'offline' );
				if ( error ) console.warn( '[coscene] disconnected:', error );

			} )
			.onConnectError( ( _ctx, error, nextAttempt ) => {

				this.connected = false;
				console.error( '[coscene] connection failed:', error );

				if ( nextAttempt !== undefined ) {

					this.setStatus( 'reconnecting' );

				} else if ( token !== undefined && this.triedWithoutToken === false ) {

					// A stale token (e.g. the database was recreated) can't connect: start over as a new user.
					this.triedWithoutToken = true;
					clearToken();
					this.connect();

				} else {

					this.setStatus( 'offline' );
					this.toast( `Can't reach the database "${DB_NAME}". Check your connection and refresh.` );

				}

			} )
			.build();

		const db = this.conn.db;

		// Row callbacks and the subscription are registered once; the SDK replays them after reconnecting.
		db.object.onInsert( ( ctx, row ) => {

			this.applyRow( row );
			this.selectIfMyNewObject( ctx, row );

		} );
		db.object.onUpdate( ( _ctx, _oldRow, row ) => this.applyRow( row ) );
		db.object.onDelete( ( _ctx, row ) => this.removeRow( row ) );

		for ( const table of [ db.user, db.presence ] ) {

			table.onInsert( () => this.refreshPeople() );
			table.onUpdate( () => this.refreshPeople() );
			table.onDelete( () => this.refreshPeople() );

		}

		this.conn.subscriptionBuilder()
			.onApplied( () => this.syncAll() )
			.onError( ( _ctx, error ) => {

				console.error( '[coscene] subscription failed:', error );
				this.toast( 'Subscription failed, see the console.' );

			} )
			.subscribe( [
				tables.object.where( ( r ) => r.sceneId.eq( SCENE_ID ) ),
				tables.presence.where( ( r ) => r.sceneId.eq( SCENE_ID ) ),
				tables.user,
			] );

		if ( this.renewTimer === undefined ) this.renewTimer = setInterval( () => this.renewLocks(), LOCK_RENEW_INTERVAL );

	}

	async onConnected() {

		try {

			await this.joinScene();

		} catch ( error ) {

			this.toast( `Couldn't join scene ${SCENE_ID}: ${error.message}` );
			return;

		}

		this.sendPresence( true );

		// After a reconnect the server has released our locks: take them again.
		for ( const id of this.selectedIds ) this.acquire( id );

	}

	async joinScene() {

		try {

			await this.conn.reducers.joinScene( { sceneId: SCENE_ID } );

		} catch ( error ) {

			if ( SCENE_ID !== 1n || ! /scene not found/.test( error.message ) ) throw error;

			// Fresh database: create the shared scene. The first scene gets id 1, and its creator is a member.
			await this.conn.reducers.createScene( { name: 'Main' } );
			await this.conn.reducers.joinScene( { sceneId: SCENE_ID } );

		}

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

		this.applying ++;

		try {

			let changed = false;

			if ( s === undefined ) {

				const make = Object.hasOwn( KINDS, row.kind ) ? KINDS[ row.kind ] : unknownKind( row.kind );
				const object = make();
				object.userData.id = id;

				s = { id, object, row, transformTimer: null, colorTimer: null, transformsInFlight: 0, colorsInFlight: 0, lastTransformSent: 0, lastColorSent: 0, lock: null };
				this.byId.set( id, s );
				this.byObject.set( object, s );

				setTransform( object, row );
				setColor( object, row.color );
				this.editor.addObject( object );
				changed = true;

			}

			s.row = row;
			const object = s.object;

			// Don't fight local edits that haven't round-tripped yet (a drag, or a send still in flight);
			// reconcile() catches up afterwards.
			if ( object.userData.dragging !== true && s.transformsInFlight === 0 && s.transformTimer === null && sameTransform( object, row ) === false ) {

				setTransform( object, row );
				changed = true;

			}

			let colorChanged = false;

			if ( s.colorsInFlight === 0 && s.colorTimer === null ) {

				colorChanged = setColor( object, row.color );

			}

			if ( this.updateLockVisual( s ) ) changed = true;

			// Only signal real changes: echoes of my own edits must not touch the editor mid-drag
			// (objectChanged re-anchors a multi-selection's pivot).
			if ( changed || colorChanged ) this.editor.signals.objectChanged.dispatch( object ); // re-render, refresh sidebar and helpers
			if ( colorChanged && object.material ) this.editor.signals.materialChanged.dispatch( object, 0 );

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
			this.editor.removeObject( s.object );
			disposeObject( s.object );

		} finally {

			this.applying --;

		}

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

		} );

		// Material color picker.
		signals.materialChanged.add( ( object ) => {

			if ( this.applying > 0 || object === undefined || object === null ) return;

			const s = this.byObject.get( object );
			if ( s !== undefined ) this.queueColor( s );

		} );

		signals.objectSelected.add( () => this.onSelectionChanged() );

		signals.cameraChanged.add( () => this.sendPresence() );

	}

	queueTransform( s ) {

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

	}

	toast( message ) {

		const toast = createElement( 'div', 'coscene-toast' );
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
