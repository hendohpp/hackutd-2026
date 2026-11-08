// The servers page's connection to SpacetimeDB.
//
// Identity works exactly like in the editor, so the lobby and the editor are the same person:
//   - signed in with SpacetimeAuth: the sign-in's token (same identity on every device)
//   - guest: this tab's token in sessionStorage, under the same key multiplayer.js uses
// Opening a server goes to editor.html in the same tab, so the editor picks up that identity.

import { DbConnection, tables } from '../module_bindings';
import { forgetSignIn } from '../auth.js';
import { safeSignedInToken, storageGet, storageSet, storageRemove } from './common.js';

// Same database and storage key as src/multiplayer.js. Keep them in sync.
const URI = import.meta.env.VITE_SPACETIME_URI || ( import.meta.env.PROD ? 'wss://maincloud.spacetimedb.com' : 'ws://localhost:3000' );
const DB_NAME = import.meta.env.VITE_SPACETIME_DB || ( import.meta.env.PROD ? 'coscene-hackutd' : 'coscene' );
const TOKEN_KEY = `${URI}/${DB_NAME}/auth_token`;

// Connects, subscribes to servers, members and people, then calls onReady( conn, myHexIdentity, signedIn ).
// onChange runs whenever any of those rows change; onFail( message ) if the database can't be reached.
export async function connect( { onReady, onChange, onFail, onNotice } ) {

	let triedWithoutToken = false;
	let signInToken = await safeSignedInToken();

	const start = () => {

		const signedIn = signInToken !== undefined;
		const token = signInToken ?? storageGet( sessionStorage, TOKEN_KEY );

		const conn = DbConnection.builder()
			.withUri( URI )
			.withDatabaseName( DB_NAME )
			.withToken( token )
			.onConnect( ( conn, identity, newToken ) => {

				if ( signedIn === false ) storageSet( sessionStorage, TOKEN_KEY, newToken );

				conn.subscriptionBuilder()
					.onApplied( () => onReady( conn, identity.toHexString(), signedIn ) )
					.onError( ( _ctx, error ) => onFail( `Couldn't load your servers: ${error.message ?? error}` ) )
					.subscribe( [ tables.scene, tables.sceneMember, tables.user ] );

			} )
			.onConnectError( ( _ctx, error ) => {

				console.error( '[coscene] connection failed:', error );

				if ( signedIn ) {

					// The sign-in was refused (e.g. it expired): continue as a guest.
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

			} )
			.build();

		for ( const table of [ conn.db.scene, conn.db.sceneMember, conn.db.user ] ) {

			table.onInsert( () => onChange() );
			table.onUpdate?.( () => onChange() );
			table.onDelete( () => onChange() );

		}

	};

	start();

}
