// The servers page's connection to SpacetimeDB.
//
// Identity works exactly like in the editor, so the lobby and the editor are the same person:
//   - signed in with SpacetimeAuth: the sign-in's token (same identity on every device)
//   - guest: this tab's token in sessionStorage, under the same key multiplayer.js uses
// Opening a server goes to editor.html in the same tab, so the editor picks up that identity.
//
// It subscribes to my_servers (a per-user view: the servers you belong to, with their invite codes;
// codes are private to members) and user (names and colors).

import { DbConnection, tables } from '../module_bindings';
import { forgetSignIn, renewedSignInToken } from '../auth.js';
import { safeSignedInToken, storageGet, storageSet, storageRemove } from './common.js';

// Same database and storage key as src/multiplayer.js. Keep them in sync.
const URI = import.meta.env.VITE_SPACETIME_URI || ( import.meta.env.PROD ? 'wss://maincloud.spacetimedb.com' : 'ws://localhost:3000' );
const DB_NAME = import.meta.env.VITE_SPACETIME_DB || ( import.meta.env.PROD ? 'collab3d-hackutd' : 'collab3d' );
const TOKEN_KEY = `${URI}/${DB_NAME}/auth_token`;

// Connects, subscribes to your servers and to people, then calls onReady( conn, myHexIdentity, signedIn ).
// onChange runs whenever any of those rows change; onFail( message ) if the database can't be reached.
export async function connect( { onReady, onChange, onFail, onNotice } ) {

	let triedWithoutToken = false;
	let signInToken = await safeSignedInToken();

	const start = () => {

		const signedIn = signInToken !== undefined;
		const token = signInToken ?? storageGet( sessionStorage, TOKEN_KEY );

		const builder = DbConnection.builder()
			.withUri( URI )
			.withDatabaseName( DB_NAME )
			.withToken( token )
			.withAutomaticReconnect()
			.onConnect( ( _conn, identity, newToken ) => {

				me = identity.toHexString(); // arrives before the subscription does
				if ( signedIn === false ) storageSet( sessionStorage, TOKEN_KEY, newToken );

			} )
			.onConnectError( ( _ctx, error, nextAttempt ) => {

				console.error( '[collab3d] connection failed:', error );

				if ( nextAttempt !== undefined ) return; // the SDK is retrying

				if ( signedIn ) {

					// The sign-in was refused and couldn't be renewed: continue as a guest.
					signInToken = undefined;
					onNotice?.( 'Your sign-in expired. You\'re continuing as a guest.' );
					forgetSignIn().finally( start );

				} else if ( token !== undefined && triedWithoutToken === false ) {

					// A stale guest token (e.g. the database was recreated): start over as a new guest.
					triedWithoutToken = true;
					storageRemove( sessionStorage, TOKEN_KEY );
					start();

				} else {

					onFail( `Can't reach the database "${DB_NAME}". Check your connection and refresh.` );

				}

			} );

		// Signed in: reconnects get a renewed token (sign-in tokens last 15 minutes).
		if ( signedIn ) builder.withTokenProvider( renewedSignInToken );

		const conn = builder.build();
		let ready = false;
		let me = null;

		// Register once; the SDK replays the subscription after reconnecting.
		conn.subscriptionBuilder()
			.onApplied( () => {

				if ( ready === false ) {

					ready = true;
					onReady( conn, me, signedIn );

				} else {

					onChange();

				}

			} )
			.onError( ( _ctx, error ) => onFail( `Couldn't load your servers: ${error?.message ?? error}` ) )
			.subscribe( [ tables.myServers, tables.user ] );

		for ( const table of [ conn.db.myServers, conn.db.user ] ) {

			table.onInsert( () => onChange() );
			table.onUpdate?.( () => onChange() );
			table.onDelete( () => onChange() );

		}

	};

	start();

}
